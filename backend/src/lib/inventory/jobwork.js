// Goods sent to a job worker (a dyer, printer, embroiderer, washer) and what comes back.
//
// Sending moves stock from the store to the job worker's location in the ledger (still the factory's, now elsewhere) and
// makes the delivery challan. Each return takes the processed-out quantity off the job worker's location and puts what
// came back into the store (dyed cloth for grey, say), so the outstanding at every job worker is always the ledger's own
// figure. Written off (a loss agreed with the job worker) and cancelled (sent in error) are the other two ways a line
// ends. Everything is scoped by the organization of `req.user`.
import mongoose from 'mongoose'
import { JobWork, Supplier, InventoryItem, Order, Organization, Document, StockLedger, AuditLog } from '../../db/index.js'
import { allocateJobworkNumber } from '../counters.js'
import { renderJobworkChallanPdf } from '../pdf/jobwork.js'
import { isId } from '../procurement.js'
import { stateName } from '../gst.js'
import { itemFor, takeStock, round3, STORE, jobworkLocation } from './stock.js'
import { istToday } from './grn.js'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const bad = (status, error) => ({ ok: false, status, error })
const newId = () => new mongoose.Types.ObjectId()
const OPEN = ['open', 'partially_returned']

/** What of a sent line has not come back or been written off. */
export const outstandingOf = l => round3(Math.max(0, (l.qty || 0) - (l.returnedQty || 0) - (l.writtenOffQty || 0)))

const party = p => ({
  name: p?.legalName || p?.name || '', gstin: p?.gstin || '', stateCode: p?.stateCode || '', address: p?.address || '', city: p?.city || '',
  pincode: p?.pincode || '', phone: p?.phone || '', contactName: p?.contacts?.[0]?.name || p?.contactName || '',
})

export const jobView = (j, extra = {}) => {
  const today = istToday()
  const outstanding = (j.lines || []).reduce((t, l) => t + outstandingOf(l), 0)
  return {
    id: String(j._id), number: j.number, status: j.status, supplierId: String(j.supplierId), supplierName: j.supplierSnapshot?.name || '',
    supplier: { ...(j.supplierSnapshot || {}), stateName: stateName(j.supplierSnapshot?.stateCode) },
    process: j.process || '', orderId: j.orderId || null, sentOn: j.sentOn, expectedBack: j.expectedBack || null,
    overdue: OPEN.includes(j.status) && !!j.expectedBack && j.expectedBack < today && outstanding > 0,
    vehicleNo: j.vehicleNo || '', note: j.note || '',
    lines: (j.lines || []).map(l => ({
      lineId: l.lineId, itemId: String(l.itemId), name: l.name, unit: l.unit, hsnCode: l.hsnCode || '', qty: l.qty, rate: l.rate || 0,
      returnedQty: l.returnedQty || 0, writtenOffQty: l.writtenOffQty || 0, outstanding: outstandingOf(l),
    })),
    returns: (j.returns || []).map(r => ({
      at: r.at, note: r.note || '',
      lines: (r.lines || []).map(l => ({ lineId: l.lineId, inputQty: l.inputQty, outputs: (l.outputs || []).map(o => ({ itemId: o.itemId ? String(o.itemId) : null, name: o.name, unit: o.unit, qty: o.qty })) })),
    })),
    hasPdf: !!j.documentId, closedReason: j.closedReason || '', cancelReason: j.cancelReason || '', createdAt: j.createdAt, updatedAt: j.updatedAt, ...extra,
  }
}

export const jobSummary = j => {
  const v = jobView(j)
  return {
    id: v.id, number: v.number, status: v.status, supplierId: v.supplierId, supplierName: v.supplierName, process: v.process, orderId: v.orderId,
    sentOn: v.sentOn, expectedBack: v.expectedBack, overdue: v.overdue,
    lines: v.lines.map(l => ({ name: l.name, unit: l.unit, qty: l.qty, outstanding: l.outstanding })), createdAt: v.createdAt,
  }
}

/** Send goods to a job worker: stock leaves the store for the job worker's location, and the challan is made. */
export async function sendJobWork(req, body) {
  const mine = { ownerOrgId: req.user.orgId }
  const b = body && typeof body === 'object' ? body : {}
  if (!isId(b.supplierId)) return bad(400, 'Choose the job worker')
  const supplier = await Supplier.findOne({ _id: b.supplierId, ...mine, isActive: true }).lean()
  if (!supplier) return bad(400, 'Choose one of your suppliers as the job worker')
  const process = text(b.process, 80)
  if (!process) return bad(400, 'Say what work is to be done (dyeing, printing, embroidery...)')

  let orderId = null
  if (b.orderId) {
    const order = typeof b.orderId === 'string' ? await Order.findOne({ _id: b.orderId, 'assignments.mfrId': req.user.id }, '_id').lean() : null
    if (!order) return bad(400, 'Choose one of your orders')
    orderId = order._id
  }
  const sentOn = b.sentOn ? String(b.sentOn) : istToday()
  const expectedBack = b.expectedBack ? String(b.expectedBack) : null
  if (!DATE_RE.test(sentOn) || (expectedBack && !DATE_RE.test(expectedBack))) return bad(400, 'A date is not valid')
  if (expectedBack && expectedBack < sentOn) return bad(400, 'It cannot be due back before it is sent')

  if (!Array.isArray(b.lines) || b.lines.length === 0 || b.lines.length > 50) return bad(400, 'Say what is being sent')
  const merged = new Map()
  for (const l of b.lines) {
    if (!isId(l?.itemId)) return bad(400, 'Choose an item for every line')
    const qty = Number(l.qty)
    const rate = l.rate === undefined || l.rate === null || l.rate === '' ? 0 : Number(l.rate)
    if (!Number.isFinite(qty) || qty <= 0 || qty > 1e9) return bad(400, 'Each quantity must be more than zero')
    if (!Number.isFinite(rate) || rate < 0 || rate > 1e8) return bad(400, 'A rate must be a number from 0 up')
    const k = String(l.itemId)
    const prev = merged.get(k)
    merged.set(k, { qty: round3((prev?.qty || 0) + qty), rate: rate || prev?.rate || 0 })
  }
  const items = await InventoryItem.find({ _id: { $in: [...merged.keys()] }, ...mine, isActive: true }).lean()
  if (items.length !== merged.size) return bad(400, 'Choose items from your stock list')
  const byId = new Map(items.map(i => [String(i._id), i]))

  const org = await Organization.findById(req.user.orgId).lean()
  const id = newId()
  const now = new Date()
  const number = await allocateJobworkNumber({ orgId: String(req.user.orgId), orgCode: org.code })
  const lines = [...merged].map(([itemId, v]) => ({
    lineId: String(newId()), itemId, name: byId.get(itemId).name, unit: byId.get(itemId).unit, hsnCode: byId.get(itemId).hsnCode || '',
    qty: v.qty, rate: round3(v.rate), returnedQty: 0, writtenOffQty: 0,
  }))
  const at = jobworkLocation(supplier._id)
  const base = { ownerOrgId: req.user.orgId, type: 'jobwork_out', refType: 'jobwork', refId: String(id), orderId, note: `${number} to ${supplier.name}`.slice(0, 300), at: now, by: req.user.actorId }
  const rows = lines.flatMap(l => [
    { ...base, itemId: l.itemId, location: STORE, qty: -l.qty, unit: l.unit, refLineId: l.lineId, key: `jw:${id}:${l.lineId}:out` },
    { ...base, itemId: l.itemId, location: at, qty: l.qty, unit: l.unit, refLineId: l.lineId, key: `jw:${id}:${l.lineId}:at` },
  ])
  const taken = await takeStock(req.user.orgId, rows, byId)
  if (!taken.ok) return bad(400, taken.error)

  try {
    const job = await JobWork.create({
      _id: id, ...mine, number, status: 'open', supplierId: supplier._id, supplierSnapshot: party(supplier), consignorSnapshot: party({ ...(org.profile || {}), name: org.name }),
      process, orderId, sentOn, expectedBack, vehicleNo: text(b.vehicleNo, 20).toUpperCase(), note: text(b.note, 1000), lines, createdBy: req.user.actorId,
    })
    const pdf = await renderJobworkChallanPdf(job.toObject())
    const doc = await Document.create({
      type: 'job_challan', name: `Job work challan ${number}`, mfrId: req.user.id, orderId: null, issueDate: now, uploadedBy: req.user.actorId, issuer: supplier.name, jobworkId: String(id),
      dataUrl: `data:application/pdf;base64,${pdf.toString('base64')}`, fileName: `${number}.pdf`, fileSize: pdf.length, mimeType: 'application/pdf',
    })
    const done = await JobWork.findOneAndUpdate({ _id: id, ...mine }, { $set: { documentId: doc._id } }, { new: true }).lean()
    await AuditLog.create({ byUser: req.user.id, action: 'Goods Sent For Job Work', detail: `${number}: ${lines.length} item(s) sent to ${supplier.name} for ${process} by ${req.user.name}` }).catch(() => {})
    return { ok: true, job: done }
  } catch (err) {
    // The stock moved but the challan could not be made: put it back, so nothing is left at a job worker with no record.
    await StockLedger.deleteMany({ ownerOrgId: req.user.orgId, key: { $in: rows.map(r => r.key) } }).catch(() => {})
    await JobWork.deleteOne({ _id: id, ...mine }).catch(() => {})
    throw err
  }
}

/**
 * Goods have come back. `body.lines`: [{ lineId, inputQty, outputs: [{ itemId? | description, unit?, qty }] }]: how much of
 * each sent line this delivery accounts for, and what came back in its place. The job worker's balance is checked and
 * the figures go into the ledger first; the return is then recorded against the challan in a guarded update, so two
 * people submitting at once record it once.
 */
export async function returnJobWork(req, id, body) {
  const mine = { ownerOrgId: req.user.orgId }
  const job = await JobWork.findOne({ _id: id, ...mine }).lean()
  if (!job) return bad(404, 'Job work not found')
  if (!OPEN.includes(job.status)) return bad(409, 'Nothing more is expected back on this challan')
  const b = body && typeof body === 'object' ? body : {}
  if (!Array.isArray(b.lines) || b.lines.length === 0 || b.lines.length > 50) return bad(400, 'Say what came back')

  const n = (job.returns || []).length
  const seen = new Set()
  const prepared = []
  for (const r of b.lines) {
    const line = job.lines.find(l => l.lineId === r?.lineId)
    if (!line) return bad(400, 'A line is not on this challan')
    if (seen.has(line.lineId)) return bad(400, 'List each line once')
    seen.add(line.lineId)
    const inputQty = Number(r.inputQty)
    if (!Number.isFinite(inputQty) || inputQty <= 0) return bad(400, `"${line.name}": say how much of it this delivery accounts for`)
    if (inputQty > outstandingOf(line) + 1e-9) return bad(400, `"${line.name}": only ${outstandingOf(line)} ${line.unit} is still with the job worker`)
    const outs = Array.isArray(r.outputs) ? r.outputs : []
    if (outs.length === 0 || outs.length > 10) return bad(400, `"${line.name}": say what came back for it`)
    const outputs = []
    for (const o of outs) {
      const qty = Number(o?.qty)
      if (!Number.isFinite(qty) || qty <= 0 || qty > 1e9) return bad(400, `"${line.name}": each quantity that came back must be more than zero`)
      let item = null
      if (o.itemId) {
        if (!isId(o.itemId)) return bad(400, `"${line.name}": that stock item is not valid`)
        item = await InventoryItem.findOne({ _id: o.itemId, ...mine, isActive: true }).lean()
        if (!item) return bad(400, `"${line.name}": choose items from your stock list`)
      } else {
        const description = text(o?.description, 300)
        if (!description) return bad(400, `"${line.name}": say what came back`)
        item = await itemFor({ orgId: req.user.orgId, name: description, unit: text(o.unit, 20) || line.unit, supplierId: job.supplierId, userId: req.user.actorId })
      }
      outputs.push({ itemId: item._id, name: item.name, unit: item.unit, qty: round3(qty) })
    }
    prepared.push({ line, inputQty: round3(inputQty), outputs })
  }

  const at = jobworkLocation(job.supplierId)
  const now = new Date()
  // Every attempt writes rows under its own keys, so one that loses a race removes exactly what it wrote and never a winner's rows.
  const attempt = String(newId())
  const rows = []
  const names = new Map()
  for (const p of prepared) {
    names.set(String(p.line.itemId), { name: p.line.name, unit: p.line.unit })
    const base = { ownerOrgId: req.user.orgId, type: 'jobwork_in', refType: 'jobwork', refId: String(job._id), orderId: job.orderId || null, at: now, by: req.user.actorId, refLineId: p.line.lineId }
    rows.push({ ...base, itemId: p.line.itemId, location: at, qty: -p.inputQty, unit: p.line.unit, note: `${job.number}: back from ${job.supplierSnapshot?.name || 'the job worker'}`.slice(0, 300), key: `jw:${job._id}:r${n}:${attempt}:${p.line.lineId}:in` })
    p.outputs.forEach((o, k) => rows.push({ ...base, itemId: o.itemId, location: STORE, qty: o.qty, unit: o.unit, note: `${job.number}: ${p.line.name} processed`.slice(0, 300), key: `jw:${job._id}:r${n}:${attempt}:${p.line.lineId}:o${k}` }))
  }
  const taken = await takeStock(req.user.orgId, rows, names)
  if (!taken.ok) return bad(400, taken.error)

  const after = prepared.map(p => ({ ...p.line, returnedQty: round3((p.line.returnedQty || 0) + p.inputQty) }))
  const merged = job.lines.map(l => after.find(a => a.lineId === l.lineId) || l)
  const closed = merged.every(l => outstandingOf(l) <= 0)
  const filters = prepared.map((p, i) => ({ [`l${i}.lineId`]: p.line.lineId }))
  const $inc = Object.fromEntries(prepared.map((p, i) => [`lines.$[l${i}].returnedQty`, p.inputQty]))
  const updated = await JobWork.findOneAndUpdate(
    { _id: job._id, ...mine, status: { $in: OPEN }, returns: { $size: n } },
    {
      $inc, $set: { status: closed ? 'closed' : 'partially_returned' },
      $push: { returns: { at: now, by: req.user.actorId, note: text(b.note, 500), lines: prepared.map(p => ({ lineId: p.line.lineId, inputQty: p.inputQty, outputs: p.outputs })) } },
    },
    { new: true, arrayFilters: filters },
  ).lean()
  if (!updated) {
    await StockLedger.deleteMany({ ownerOrgId: req.user.orgId, key: { $in: rows.map(r => r.key) } }).catch(() => {})
    return bad(409, 'This challan changed while you were recording the return. Open it again and check what is still out')
  }
  await AuditLog.create({ byUser: req.user.id, action: 'Goods Back From Job Work', detail: `${job.number}: ${prepared.length} line(s) back from ${job.supplierSnapshot?.name || 'the job worker'}${closed ? ' (closed)' : ''} recorded by ${req.user.name}` }).catch(() => {})
  return { ok: true, job: updated }
}

/** What is still out is written off (a loss agreed with the job worker), with the reason, and the challan closes. */
export async function closeJobWork(req, id, reason) {
  const mine = { ownerOrgId: req.user.orgId }
  const job = await JobWork.findOne({ _id: id, ...mine }).lean()
  if (!job) return bad(404, 'Job work not found')
  if (!OPEN.includes(job.status)) return bad(409, 'This challan is already finished')
  const why = text(reason, 500)
  if (!why) return bad(400, 'Say why what is still out is being written off')
  const at = jobworkLocation(job.supplierId)
  const now = new Date()
  const attempt = String(newId())
  const left = job.lines.filter(l => outstandingOf(l) > 0)
  const rows = left.map(l => ({
    ownerOrgId: req.user.orgId, itemId: l.itemId, location: at, type: 'adjustment', qty: -outstandingOf(l), unit: l.unit, refType: 'jobwork', refId: String(job._id), refLineId: l.lineId,
    orderId: job.orderId || null, note: `${job.number} written off: ${why}`.slice(0, 300), at: now, by: req.user.actorId, key: `jw:${job._id}:close:${attempt}:${l.lineId}`,
  }))
  if (rows.length) {
    const taken = await takeStock(req.user.orgId, rows, new Map(left.map(l => [String(l.itemId), { name: l.name, unit: l.unit }])))
    if (!taken.ok) return bad(400, taken.error)
  }
  const filters = left.map((l, i) => ({ [`l${i}.lineId`]: l.lineId }))
  const $inc = Object.fromEntries(left.map((l, i) => [`lines.$[l${i}].writtenOffQty`, outstandingOf(l)]))
  const update = { ...(left.length ? { $inc } : {}), $set: { status: 'closed', closedReason: why } }
  const updated = await JobWork.findOneAndUpdate({ _id: job._id, ...mine, status: { $in: OPEN } }, update, { new: true, ...(filters.length ? { arrayFilters: filters } : {}) }).lean()
  if (!updated) {
    await StockLedger.deleteMany({ ownerOrgId: req.user.orgId, key: { $in: rows.map(r => r.key) } }).catch(() => {})
    return bad(409, 'This challan changed. Open it again and try once more')
  }
  await AuditLog.create({ byUser: req.user.id, action: 'Job Work Written Off', detail: `${job.number} closed by ${req.user.name}: ${why}` }).catch(() => {})
  return { ok: true, job: updated }
}

/** Sent in error: only before anything has come back. The goods go back to the store. */
export async function cancelJobWork(req, id, reason) {
  const mine = { ownerOrgId: req.user.orgId }
  const job = await JobWork.findOne({ _id: id, ...mine }).lean()
  if (!job) return bad(404, 'Job work not found')
  if (job.status !== 'open' || (job.returns || []).length) return bad(409, 'Goods have already come back on this challan, so it can only be closed')
  const why = text(reason, 500)
  if (!why) return bad(400, 'Say why it is being cancelled')
  const at = jobworkLocation(job.supplierId)
  const now = new Date()
  const attempt = String(newId())
  const base = { ownerOrgId: req.user.orgId, type: 'jobwork_in', refType: 'jobwork', refId: String(job._id), orderId: job.orderId || null, note: `${job.number} cancelled: ${why}`.slice(0, 300), at: now, by: req.user.actorId }
  const rows = job.lines.flatMap(l => [
    { ...base, itemId: l.itemId, location: at, qty: -l.qty, unit: l.unit, refLineId: l.lineId, key: `jw:${job._id}:${attempt}:${l.lineId}:undo-at` },
    { ...base, itemId: l.itemId, location: STORE, qty: l.qty, unit: l.unit, refLineId: l.lineId, key: `jw:${job._id}:${attempt}:${l.lineId}:undo-out` },
  ])
  const taken = await takeStock(req.user.orgId, rows, new Map(job.lines.map(l => [String(l.itemId), { name: l.name, unit: l.unit }])))
  if (!taken.ok) return bad(400, taken.error)
  const updated = await JobWork.findOneAndUpdate({ _id: job._id, ...mine, status: 'open', returns: { $size: 0 } }, { $set: { status: 'cancelled', cancelReason: why } }, { new: true }).lean()
  if (!updated) {
    await StockLedger.deleteMany({ ownerOrgId: req.user.orgId, key: { $in: rows.map(r => r.key) } }).catch(() => {})
    return bad(409, 'This challan changed. Open it again and try once more')
  }
  await AuditLog.create({ byUser: req.user.id, action: 'Job Work Cancelled', detail: `${job.number} cancelled by ${req.user.name}: ${why}` }).catch(() => {})
  return { ok: true, job: updated }
}

/** Who holds what of the factory's: every job worker with goods still out, its open challans and how many are overdue. */
export async function outstandingByJobWorker(req) {
  const jobs = await JobWork.find({ ownerOrgId: req.user.orgId, status: { $in: OPEN } }).lean()
  const by = new Map()
  for (const j of jobs) {
    const v = jobView(j)
    const g = by.get(v.supplierId) || { supplierId: v.supplierId, supplierName: v.supplierName, jobs: 0, overdue: 0, items: new Map() }
    g.jobs += 1
    if (v.overdue) g.overdue += 1
    for (const l of v.lines) {
      if (l.outstanding <= 0) continue
      const k = `${l.itemId}|${l.unit}`
      const e = g.items.get(k) || { itemId: l.itemId, name: l.name, unit: l.unit, qty: 0 }
      e.qty = round3(e.qty + l.outstanding)
      g.items.set(k, e)
    }
    by.set(v.supplierId, g)
  }
  return [...by.values()].map(g => ({ ...g, items: [...g.items.values()] })).sort((a, b) => b.overdue - a.overdue || a.supplierName.localeCompare(b.supplierName))
}
