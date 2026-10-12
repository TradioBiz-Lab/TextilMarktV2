// Goods received notes: checking one, and posting it.
//
// A GRN is drafted (by a person, from a challan photo the AI read, or by Kriyaa), checked against the purchase
// order it is for, and posted. Posting is the one thing that moves stock, and it does four things in a fixed
// order so that a crash in the middle can be finished by simply posting again:
//
//   1. claim the GRN (draft to posting), so a double tap or two tabs cannot post it twice
//   2. write the stock ledger rows (each keyed by GRN and line, so a repeat writes nothing new)
//   3. give the purchase order its receipt (guarded by the GRN's id, so a repeat receives nothing twice)
//   4. bring the order's material lines in, store the PDF and mark the GRN posted
//
// Everything is scoped by the caller's own organization, taken from the session and never from a request.
import mongoose from 'mongoose'
import { Grn, PurchaseOrder, Supplier, InventoryItem, Document, Organization, AuditLog } from '../../db/index.js'
import { allocateGrnNumber } from '../counters.js'
import { syncOnReceive } from '../poSync.js'
import { renderGrnPdf } from '../pdf/grn.js'
import { stamp } from '../poDraft.js'
import { isId } from '../procurement.js'
import { itemFor, writeLedger, round3, STORE } from './stock.js'

export const RECEIVABLE = ['sent', 'acknowledged', 'partially_received']
// Receiving more than this over the ordered quantity is refused as a likely typo (cloth is measured, not counted).
export const OVER_RECEIPT = 1.1
const STALE_POSTING_MS = 2 * 60 * 1000
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MAX_LINES = 100

const bad = (status, error) => ({ ok: false, status, error })
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const finite = v => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : NaN)
const newLineId = () => String(new mongoose.Types.ObjectId())

/** Today in India, as YYYY-MM-DD. */
export const istToday = (now = new Date()) => new Date(now.getTime() + 330 * 60000).toISOString().slice(0, 10)

/** What went into stock from a line: what arrived less what was turned away. */
export const acceptedOf = l => round3(Math.max(0, (Number(l.qty) || 0) - (Number(l.rejectedQty) || 0)))

/** What a PO line still has to receive. */
export const outstandingOf = l => round3(Math.max(0, (l.qty || 0) - (l.receivedQty || 0)))

/** GRN lines for everything a purchase order is still waiting for, each at the quantity outstanding. */
export function linesFromPo(po) {
  return (po.lines || []).filter(l => outstandingOf(l) > 0).map(l => ({
    poLineId: l.lineId, description: l.description, unit: l.unit, orderedQty: l.qty, qty: outstandingOf(l),
    rate: round3((l.rate || 0) * (1 - (l.discountPct || 0) / 100)),
  }))
}

function cleanLine(raw, position, poLines, keepIds) {
  const at = `Line ${position}`
  if (!raw || typeof raw !== 'object') return bad(400, `${at}: is not valid`)
  const poLine = raw.poLineId ? poLines.find(l => l.lineId === raw.poLineId) : null
  if (raw.poLineId && !poLine) return bad(400, `${at}: that is not a line of the purchase order`)
  const description = text(raw.description, 300) || poLine?.description || ''
  if (!description) return bad(400, `${at}: say what was received`)
  const unit = text(raw.unit, 20) || poLine?.unit || 'pcs'
  const qty = finite(raw.qty) ?? 0
  if (!Number.isFinite(qty) || qty < 0 || qty > 1e8) return bad(400, `${at}: the quantity received must be a number from 0 up`)
  const rejectedQty = finite(raw.rejectedQty) ?? 0
  if (!Number.isFinite(rejectedQty) || rejectedQty < 0) return bad(400, `${at}: the quantity turned away must be a number from 0 up`)
  if (rejectedQty > qty) return bad(400, `${at}: more was turned away than arrived`)
  const rate = finite(raw.rate) ?? (poLine ? round3((poLine.rate || 0) * (1 - (poLine.discountPct || 0) / 100)) : 0)
  if (!Number.isFinite(rate) || rate < 0 || rate > 1e8) return bad(400, `${at}: the rate must be a number from 0 up`)
  const itemId = raw.itemId ? String(raw.itemId) : null
  if (itemId && !isId(itemId)) return bad(400, `${at}: that stock item is not valid`)
  return {
    ok: true,
    line: {
      lineId: typeof raw.lineId === 'string' && keepIds.has(raw.lineId) ? raw.lineId : newLineId(),
      poLineId: poLine ? poLine.lineId : null, description, itemId, unit,
      orderedQty: poLine ? poLine.qty : null, qty: round3(qty), rejectedQty: round3(rejectedQty),
      rejectReason: text(raw.rejectReason, 200), rate: round3(rate), lot: text(raw.lot, 60), note: text(raw.note, 300),
    },
  }
}

/**
 * Check a request and shape the GRN it describes. `existing` is the draft being edited: whatever the request
 * leaves out carries over.
 * @returns {Promise<{ok: true, data: object, po: object|null, supplier: object|null} | {ok: false, status: number, error: string}>}
 */
export async function prepareGrn(req, body, existing = null) {
  const mine = { ownerOrgId: req.user.orgId }
  const b = body && typeof body === 'object' ? body : {}

  const poId = b.poId !== undefined ? (b.poId || null) : (existing?.poId ?? null)
  let po = null
  if (poId) {
    po = typeof poId === 'string' ? await PurchaseOrder.findOne({ _id: poId, ...mine }).lean() : null
    if (!po) return bad(400, 'Choose one of your purchase orders')
    if (!RECEIVABLE.includes(po.status)) return bad(409, 'Goods can only be received against a PO that has been sent')
  }

  let supplier = null
  const supplierIn = b.supplierId !== undefined ? (b.supplierId || null) : (existing?.supplierId ?? po?.supplierId ?? null)
  if (supplierIn) {
    if (!isId(String(supplierIn))) return bad(400, 'Choose one of your suppliers')
    supplier = await Supplier.findOne({ _id: supplierIn, ...mine }).lean()
    if (!supplier) return bad(400, 'Choose one of your suppliers')
  }
  if (po && supplier && String(po.supplierId) !== String(supplier._id)) return bad(400, 'That supplier is not the one on the purchase order')

  const supplierName = supplier?.name || po?.supplierSnapshot?.name || text(b.supplierName ?? existing?.supplierName, 200)
  const supplierGstin = supplier?.gstin || po?.supplierSnapshot?.gstin || text(b.supplierGstin ?? existing?.supplierGstin, 15).toUpperCase()

  const date = (key, label) => {
    const v = b[key] === undefined ? existing?.[key] ?? null : (b[key] || null)
    if (v && !DATE_RE.test(v)) return { error: `${label} is not a valid date` }
    return { v }
  }
  const challanDate = date('challanDate', 'The challan date')
  const receivedOn = date('receivedOn', 'The date received')
  for (const d of [challanDate, receivedOn]) if (d.error) return bad(400, d.error)
  const today = istToday()
  const tomorrow = istToday(new Date(Date.now() + 86400000))
  if (receivedOn.v && receivedOn.v > tomorrow) return bad(400, 'Goods cannot be received on a date that has not come')
  const field = (key, max) => (b[key] === undefined ? existing?.[key] ?? '' : text(b[key], max))

  const poChanged = b.poId !== undefined && (b.poId || null) !== (existing?.poId ?? null)
  let raw = b.lines
  if (raw === undefined) raw = existing && !poChanged ? existing.lines : po ? linesFromPo(po) : []
  if (!Array.isArray(raw) || raw.length > MAX_LINES) return bad(400, `A goods received note can have at most ${MAX_LINES} lines`)
  const keepIds = new Set((existing?.lines || []).map(l => l.lineId))
  const lines = []
  for (const [i, r] of raw.entries()) {
    const c = cleanLine(r, i + 1, po?.lines || [], keepIds)
    if (!c.ok) return c
    lines.push(c.line)
  }

  const itemIds = [...new Set(lines.map(l => l.itemId).filter(Boolean))]
  if (itemIds.length) {
    const items = await InventoryItem.find({ _id: { $in: itemIds }, ...mine, isActive: true }, 'name unit').lean()
    if (items.length !== itemIds.length) return bad(400, 'A line names an item that is not in your stock list')
    const byId = new Map(items.map(i => [String(i._id), i]))
    for (const l of lines) if (l.itemId) l.unit = byId.get(l.itemId).unit
  }

  return {
    ok: true, po, supplier,
    data: {
      poId: po ? po._id : null, supplierId: supplier ? supplier._id : null, supplierName, supplierGstin,
      challanNo: field('challanNo', 60), challanDate: challanDate.v, vehicleNo: field('vehicleNo', 20).toUpperCase(),
      receivedOn: receivedOn.v || existing?.receivedOn || today, note: field('note', 1000), lines,
    },
  }
}

/** Start a draft GRN. */
export async function createGrn(req, body, { source = 'web', extra = {} } = {}) {
  const p = await prepareGrn(req, body)
  if (!p.ok) return p
  const grn = await Grn.create({ ownerOrgId: req.user.orgId, ...p.data, status: 'draft', source, createdBy: req.user.actorId, ...extra })
  return { ok: true, grn: grn.toObject(), po: p.po }
}

/**
 * Can this GRN be posted as it stands? The lines that arrived (quantity above zero) are the ones that count, and
 * against a purchase order no line may take it more than 10% over what was ordered.
 * @returns {{ok: true, active: object[]} | {ok: false, status: number, error: string}}
 */
export function checkPostable(grn, po) {
  const active = (grn.lines || []).filter(l => (l.qty || 0) > 0)
  if (active.length === 0) return bad(400, 'Nothing has been received yet. Enter the quantity that arrived on at least one line')
  if (grn.poId && po) {
    const asked = new Map()
    for (const l of active) if (l.poLineId) asked.set(l.poLineId, round3((asked.get(l.poLineId) || 0) + acceptedOf(l)))
    for (const [lineId, qty] of asked) {
      const line = po.lines.find(x => x.lineId === lineId)
      if (!line) return bad(400, 'A line is not on this purchase order any more')
      if ((line.receivedQty || 0) + qty > line.qty * OVER_RECEIPT)
        return bad(400, `"${line.description}": that would be more than 10% over the ${line.qty} ${line.unit} ordered. Check the quantity`)
    }
  }
  return { ok: true, active }
}

/** Give the purchase order this GRN's receipt, once, and say whether this call applied it. */
async function receiveIntoPo(req, grn, po, active, number) {
  const byLine = new Map()
  for (const l of active) {
    if (!l.poLineId) continue
    const a = acceptedOf(l)
    if (a > 0) byLine.set(l.poLineId, round3((byLine.get(l.poLineId) || 0) + a))
  }
  const received = [...byLine].map(([lineId, qty]) => ({ line: po.lines.find(x => x.lineId === lineId), qty }))
  if (received.length === 0) return { applied: false, po, unlinked: [] }

  const id = String(grn._id)
  const filters = received.map((r, i) => ({ [`l${i}.lineId`]: r.line.lineId }))
  const $inc = Object.fromEntries(received.map((r, i) => [`lines.$[l${i}].receivedQty`, r.qty]))
  const note = grn.note ? `${number}: ${grn.note}` : number
  const updated = await PurchaseOrder.findOneAndUpdate(
    { _id: grn.poId, ownerOrgId: req.user.orgId, status: { $in: RECEIVABLE }, 'receipts.grnId': { $ne: id } },
    { $inc, $push: { receipts: { at: new Date(), by: req.user.actorId, note: note.slice(0, 500), grnId: id, lines: received.map(r => ({ lineId: r.line.lineId, qty: r.qty })) }, timeline: stamp(req, 'Goods received', `${number}: ${received.length} line${received.length === 1 ? '' : 's'}`) } },
    { new: true, arrayFilters: filters },
  ).lean()
  if (!updated) {
    const already = await PurchaseOrder.exists({ _id: grn.poId, ownerOrgId: req.user.orgId, 'receipts.grnId': id })
    if (already) return { applied: false, po: await PurchaseOrder.findById(grn.poId).lean(), unlinked: [] }
    return { error: 'The purchase order changed while this was being posted. Open it and post again' }
  }
  const complete = updated.lines.every(l => (l.receivedQty || 0) >= l.qty)
  const final = await PurchaseOrder.findOneAndUpdate(
    { _id: grn.poId, ownerOrgId: req.user.orgId, status: { $in: RECEIVABLE } },
    { $set: { status: complete ? 'closed' : 'partially_received' }, ...(complete ? { $push: { timeline: stamp(req, 'Fully received') } } : {}) }, { new: true },
  ).lean() || updated
  const unlinked = await syncOnReceive({ partyId: req.user.id, po: updated, received })
  return { applied: true, po: final, unlinked }
}

/**
 * Post a draft GRN: stock goes up, the purchase order is brought forward and the PDF is kept.
 * @returns {Promise<{ok: true, grn: object, po: object|null, notice: object} | {ok: false, status: number, error: string}>}
 */
export async function postGrn(req, id) {
  const mine = { ownerOrgId: req.user.orgId }
  const own = await Grn.findOne({ _id: id, ...mine }).lean()
  if (!own) return bad(404, 'Goods received note not found')
  if (own.status === 'posted') return bad(409, 'This goods received note has already been posted')

  const po = own.poId ? await PurchaseOrder.findOne({ _id: own.poId, ...mine }).lean() : null
  // A note whose PO receipt was already written (a post that stopped part-way) is only being finished: the PO may
  // since have closed because of this very receipt, and its quantities already include it.
  const resumed = !!po?.receipts?.some(r => r.grnId === String(id))
  if (own.poId && !resumed) {
    if (!po) return bad(409, 'The purchase order for this note is gone')
    if (!RECEIVABLE.includes(po.status)) return bad(409, 'Goods can only be received against a PO that has been sent')
  }
  const ok = checkPostable(own, resumed ? null : po)
  if (!ok.ok) return ok

  // One request wins the right to post; a second (double tap, two tabs) is refused instead of posting twice.
  const grn = await Grn.findOneAndUpdate(
    { _id: id, ...mine, $or: [{ status: 'draft' }, { status: 'posting', postingAt: { $lt: new Date(Date.now() - STALE_POSTING_MS) } }] },
    { $set: { status: 'posting', postingAt: new Date() } }, { new: true },
  ).lean()
  if (!grn) return bad(409, 'This goods received note is already being posted')

  // Before any stock is written, a failure puts the note back to a draft. After it, the claim is made stale at once,
  // so the next attempt takes it over and finishes what is left (every step is safe to repeat).
  const release = () => Grn.updateOne({ _id: id, ...mine, status: 'posting' }, { $set: { status: 'draft', postingAt: null } }).catch(() => {})
  const resumable = () => Grn.updateOne({ _id: id, ...mine, status: 'posting' }, { $set: { postingAt: new Date(0) } }).catch(() => {})
  try {
    const org = await Organization.findById(req.user.orgId).lean()
    const now = new Date()

    let number = grn.number
    if (!number) {
      number = await allocateGrnNumber({ orgId: String(req.user.orgId), orgCode: org.code })
      await Grn.updateOne({ _id: id, ...mine, number: null }, { $set: { number } })
    }

    // Every received line books into an item: the one chosen, or the one its description and unit name.
    const lines = []
    for (const l of grn.lines) {
      if (!((l.qty || 0) > 0)) { lines.push(l); continue }                // a line nothing arrived on books nothing
      const item = l.itemId
        ? await InventoryItem.findOne({ _id: l.itemId, ...mine }).lean()
        : await itemFor({ orgId: req.user.orgId, name: l.description, unit: l.unit, supplierId: grn.supplierId, userId: req.user.actorId })
      if (!item) { await release(); return bad(400, `"${l.description}": that stock item is not in your stock list`) }
      lines.push({ ...l, itemId: item._id, unit: item.unit })
    }
    await Grn.updateOne({ _id: id, ...mine }, { $set: { lines } })

    const active = lines.filter(l => (l.qty || 0) > 0)
    const rows = active.filter(l => acceptedOf(l) > 0).map(l => ({
      ownerOrgId: req.user.orgId, itemId: l.itemId, location: STORE, type: 'receipt', qty: acceptedOf(l), unit: l.unit, unitCost: l.rate || 0,
      refType: 'grn', refId: String(id), refLineId: l.lineId, note: number, at: now, by: req.user.actorId, key: `grn:${id}:${l.lineId}`,
    }))
    await writeLedger(rows)

    let poAfter = po, unlinked = []
    if (po) {
      const r = await receiveIntoPo(req, grn, po, active, number)
      if (r.error) { await resumable(); return bad(409, r.error) }
      poAfter = r.po
      unlinked = r.unlinked
    }

    let documentId = grn.documentId
    if (!documentId) {
      const posted = { ...grn, lines, number, status: 'posted', postedAt: now }
      const pdf = await renderGrnPdf(posted, org, { receivedBy: req.user.name, poNumber: grn.poId })
      const doc = await Document.create({
        type: 'goods_receipt', name: `Goods received note ${number}`, mfrId: req.user.id, orderId: null, issueDate: now,
        uploadedBy: req.user.actorId, issuer: grn.supplierName || null, grnId: String(id),
        dataUrl: `data:application/pdf;base64,${pdf.toString('base64')}`, fileName: `${number}.pdf`, fileSize: pdf.length, mimeType: 'application/pdf',
      })
      documentId = doc._id
    }

    const done = await Grn.findOneAndUpdate({ _id: id, ...mine, status: 'posting' }, { $set: { status: 'posted', postedAt: now, postedBy: req.user.actorId, postingAt: null, documentId } }, { new: true }).lean()
    await AuditLog.create({ byUser: req.user.id, action: 'Goods Received', detail: `${number}${grn.poId ? ` against ${grn.poId}` : ''}: ${active.length} line(s) from ${grn.supplierName || 'a supplier'} posted by ${req.user.name}` }).catch(err => console.error('[grn] audit failed', err))
    return { ok: true, grn: done || { ...grn, lines, number, status: 'posted', documentId }, po: poAfter, notice: { unlinkedLines: unlinked.map(u => u.description) } }
  } catch (err) {
    console.error('[grn post]', err)
    await resumable()
    throw err
  }
}
