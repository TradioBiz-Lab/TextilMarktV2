// Purchase orders a manufacturer raises with its suppliers.
//
// A PO is drafted, sent (a PDF goes to the supplier by email), acknowledged, received in whole or in
// part, and closed. Every figure on it is computed here (lib/poMath.js), never taken from the browser;
// the supplier and company details are frozen at the moment it is sent, so the document the supplier
// holds cannot change underneath them. Sending also puts the order's linked material lines "on order",
// and receipts bring them in (lib/poSync.js).
//
// Private to the company: every query is scoped by the caller's own organization, and brands and
// Tradio staff cannot use these routes (requireProcurement). A PO that is not yours is a 404.
import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { PurchaseOrder, SupplierItem, Document, Grn, AuditLog } from '../db/index.js'
import { requireAuth } from '../middleware/auth.js'
import { userKey } from '../lib/limiterKey.js'
import { requireProcurement, isId } from '../lib/procurement.js'
import { prepare, createDraft, stamp } from '../lib/poDraft.js'
import { moqWarnings } from '../lib/poMath.js'
import { stateName } from '../lib/gst.js'
import { syncOnSend, syncOnCancel } from '../lib/poSync.js'
import { createGrn, postGrn } from '../lib/inventory/grn.js'
import { renderPurchaseOrderPdf } from '../lib/pdf/po.js'
import { sendEmailDetailed, emailPurchaseOrder } from '../lib/email.js'

const router = Router()
router.use(requireAuth, requireProcurement)

const skipInTest = () => process.env.NODE_ENV === 'test'
const limiter = (max, message) => rateLimit({
  windowMs: 60 * 60 * 1000, max, keyGenerator: userKey, skip: skipInTest, message: { error: message },
  standardHeaders: true, legacyHeaders: false, validate: false,
})
const writeLimiter = limiter(300, 'Too many changes. Please wait.')
const sendLimiter = limiter(60, 'Too many purchase orders sent. Please wait.')

const PO_ID = /^PO-[A-Z0-9]{1,5}-\d{4}-\d{4,}$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const STALE_SENDING_MS = 2 * 60 * 1000          // a "sending" claim older than this is a crashed send and may be retried
const OVER_RECEIPT = 1.1                         // receiving more than 10% over the ordered quantity is refused as a likely typo

const mine = req => ({ ownerOrgId: req.user.orgId })
const fail = (res, status, error, extra = {}) => res.status(status).json({ error, ...extra })
const round3 = n => Math.round(n * 1000) / 1000

// ── Views ─────────────────────────────────────────────────────────────────────

const lineView = l => ({
  lineId: l.lineId, description: l.description, itemId: l.itemId ? String(l.itemId) : null, hsnCode: l.hsnCode || '',
  unit: l.unit || 'pcs', qty: l.qty, rate: l.rate, discountPct: l.discountPct || 0, taxPct: l.taxPct || 0,
  amount: l.amount || 0, taxAmount: l.taxAmount || 0, lineTotal: l.lineTotal || 0,
  expectedDate: l.expectedDate || null, materialRef: l.materialRef || null, receivedQty: l.receivedQty || 0, note: l.note || '',
  bomRefs: (l.bomRefs || []).map(r => ({ orderId: r.orderId, colour: r.colour || '', qty: r.qty })),
})

const receivedPct = po => {
  const ordered = (po.lines || []).reduce((s, l) => s + (l.qty || 0), 0)
  if (!ordered) return 0
  const got = (po.lines || []).reduce((s, l) => s + Math.min(l.receivedQty || 0, l.qty || 0), 0)
  return Math.round((got / ordered) * 100)
}

const party = p => ({
  name: p?.name || '', email: p?.email || '', phone: p?.phone || '', gstin: p?.gstin || '', pan: p?.pan || '', stateCode: p?.stateCode || '',
  stateName: stateName(p?.stateCode), address: p?.address || '', city: p?.city || '', pincode: p?.pincode || '', contactName: p?.contactName || '',
})

export const poView = (po, extra = {}) => ({
  id: po._id, status: po.status, supplierId: String(po.supplierId),
  supplierName: po.supplierSnapshot?.name || '',
  supplier: party(po.supplierSnapshot), buyer: party(po.buyerSnapshot),
  lines: (po.lines || []).map(lineView), taxMode: po.taxMode, totals: po.totals,
  expectedDate: po.expectedDate || null, shipTo: po.shipTo || '', paymentTerms: po.paymentTerms || '', terms: po.terms || '',
  internalNote: po.internalNote || '', sentAt: po.sentAt || null, sentTo: po.sentTo || [], hasPdf: !!po.documentId,
  receipts: (po.receipts || []).map(r => ({ at: r.at, note: r.note || '', lines: r.lines || [], grnId: r.grnId || null })),
  timeline: (po.timeline || []).map(t => ({ at: t.at, byName: t.byName || '', action: t.action, note: t.note || '' })),
  cancelReason: po.cancelReason || '', closedReason: po.closedReason || '',
  receivedPct: receivedPct(po), createdAt: po.createdAt, updatedAt: po.updatedAt, ...extra,
})

const summaryView = po => ({
  id: po._id, status: po.status, supplierId: String(po.supplierId), supplierName: po.supplierSnapshot?.name || '',
  grandTotal: po.totals?.grandTotal || 0, expectedDate: po.expectedDate || null, lineCount: (po.lines || []).length,
  receivedPct: receivedPct(po), createdAt: po.createdAt, sentAt: po.sentAt || null,
  orderIds: [...new Set((po.lines || []).map(l => l.materialRef?.orderId).filter(Boolean))],
})

const idParam = (req, res) => {
  if (!PO_ID.test(req.params.id)) { fail(res, 404, 'Purchase order not found'); return null }
  return req.params.id
}

// ── Routes ───────────────────────────────────────────────────────────────────

// GET /api/purchase-orders - the company's POs, newest first. ?status= ?supplierId= ?orderId=
router.get('/', async (req, res) => {
  try {
    const filter = { ...mine(req) }
    if (req.query.status) filter.status = String(req.query.status)
    if (req.query.supplierId && isId(req.query.supplierId)) filter.supplierId = req.query.supplierId
    if (req.query.orderId) filter['lines.materialRef.orderId'] = String(req.query.orderId)
    const pos = await PurchaseOrder.find(filter, '-timeline -receipts').sort({ createdAt: -1 }).limit(500).lean()
    res.json(pos.map(summaryView))
  } catch (err) { console.error('[po]', err); fail(res, 500, 'Server error') }
})

// POST /api/purchase-orders - start a draft
router.post('/', writeLimiter, async (req, res) => {
  try {
    const made = await createDraft(req, req.body)
    if (!made.ok) return fail(res, made.status, made.error)
    const { po, supplier, warnings } = made
    await AuditLog.create({ byUser: req.user.id, action: 'Purchase Order Drafted', detail: `${po._id} to ${supplier.name} drafted by ${req.user.name}` })
    res.status(201).json(poView(po.toObject(), { warnings }))
  } catch (err) { console.error('[po]', err); fail(res, 500, 'Server error') }
})

// GET /api/purchase-orders/:id
router.get('/:id', async (req, res) => {
  try {
    const id = idParam(req, res); if (!id) return
    const po = await PurchaseOrder.findOne({ _id: id, ...mine(req) }).lean()
    if (!po) return fail(res, 404, 'Purchase order not found')
    const itemIds = po.lines.map(l => l.itemId).filter(Boolean)
    const items = itemIds.length ? await SupplierItem.find({ _id: { $in: itemIds }, ...mine(req) }).lean() : []
    res.json(poView(po, { warnings: moqWarnings(po.lines, new Map(items.map(i => [String(i._id), i]))) }))
  } catch (err) { console.error('[po]', err); fail(res, 500, 'Server error') }
})

// POST /api/purchase-orders/:id - change a draft (only the fields sent; sent lines replace the lines)
router.post('/:id', writeLimiter, async (req, res) => {
  try {
    const id = idParam(req, res); if (!id) return
    const existing = await PurchaseOrder.findOne({ _id: id, ...mine(req) }).lean()
    if (!existing) return fail(res, 404, 'Purchase order not found')
    if (existing.status !== 'draft') return fail(res, 409, 'Only a draft can be edited. Cancel it and start a new one to change what was sent')
    const p = await prepare(req, req.body || {}, existing)
    if (!p.ok) return fail(res, p.status, p.error)
    const po = await PurchaseOrder.findOneAndUpdate({ _id: id, ...mine(req), status: 'draft' }, { $set: p.data }, { new: true }).lean()
    if (!po) return fail(res, 409, 'This purchase order changed while you were editing. Reload it and try again')
    res.json(poView(po, { warnings: p.warnings }))
  } catch (err) { console.error('[po]', err); fail(res, 500, 'Server error') }
})

// POST /api/purchase-orders/:id/delete - throw a draft away (a sent PO is cancelled instead, never deleted)
router.post('/:id/delete', writeLimiter, async (req, res) => {
  try {
    const id = idParam(req, res); if (!id) return
    const own = await PurchaseOrder.findOne({ _id: id, ...mine(req) }, 'status').lean()
    if (!own) return fail(res, 404, 'Purchase order not found')
    if (own.status !== 'draft') return fail(res, 409, 'Only a draft can be deleted')
    const r = await PurchaseOrder.deleteOne({ _id: id, ...mine(req), status: 'draft' })
    if (r.deletedCount === 0) return fail(res, 409, 'This purchase order changed. Reload it and try again')
    await AuditLog.create({ byUser: req.user.id, action: 'Purchase Order Draft Deleted', detail: `${id} deleted by ${req.user.name}` })
    res.json({ ok: true })
  } catch (err) { console.error('[po]', err); fail(res, 500, 'Server error') }
})

// GET /api/purchase-orders/:id/pdf - { fileName, mimeType, dataUrl }: the PDF that was sent, or a preview of a draft
router.get('/:id/pdf', async (req, res) => {
  try {
    const id = idParam(req, res); if (!id) return
    const po = await PurchaseOrder.findOne({ _id: id, ...mine(req) }).lean()
    if (!po) return fail(res, 404, 'Purchase order not found')
    let buf
    if (po.documentId && po.status !== 'cancelled') {
      const d = await Document.findOne({ _id: po.documentId, poId: po._id }, 'dataUrl').lean()
      if (d?.dataUrl) buf = Buffer.from(d.dataUrl.split(',')[1] || '', 'base64')
    }
    if (!buf) {
      // A draft is previewed with the company's and supplier's details as they stand now.
      const p = po.status === 'draft' ? await prepare(req, {}, po) : null
      buf = await renderPurchaseOrderPdf(p?.ok ? { ...po, ...p.data } : po)
    }
    res.json({ fileName: `${po._id}.pdf`, mimeType: 'application/pdf', dataUrl: `data:application/pdf;base64,${buf.toString('base64')}` })
  } catch (err) { console.error('[po]', err); fail(res, 500, 'Server error') }
})

// POST /api/purchase-orders/:id/send { to?: [emails], message? }
router.post('/:id/send', sendLimiter, async (req, res) => {
  const id = idParam(req, res); if (!id) return
  let claimed = false
  const release = () => PurchaseOrder.updateOne({ _id: id, ...mine(req), status: 'sending' }, { $set: { status: 'draft', sendingAt: null } })
  try {
    const own = await PurchaseOrder.findOne({ _id: id, ...mine(req) }, 'status').lean()
    if (!own) return fail(res, 404, 'Purchase order not found')
    if (own.status !== 'draft' && own.status !== 'sending') return fail(res, 409, 'This purchase order has already been sent')

    // One request wins the right to send; a second (double click, two tabs) is refused instead of emailing twice.
    const po = await PurchaseOrder.findOneAndUpdate(
      { _id: id, ...mine(req), $or: [{ status: 'draft' }, { status: 'sending', sendingAt: { $lt: new Date(Date.now() - STALE_SENDING_MS) } }] },
      { $set: { status: 'sending', sendingAt: new Date() } }, { new: true },
    ).lean()
    if (!po) return fail(res, 409, 'This purchase order is already being sent')
    claimed = true

    const p = await prepare(req, {}, po, { dropStaleLinks: true })
    if (!p.ok) { await release(); return fail(res, p.status, p.error) }
    if (p.data.lines.length === 0) { await release(); return fail(res, 400, 'Add at least one item before sending') }

    const wanted = req.body?.to === undefined ? [p.supplier.email].filter(Boolean) : req.body.to
    if (!Array.isArray(wanted) || wanted.length > 5 || wanted.some(e => typeof e !== 'string' || !EMAIL_RE.test(e.trim())))
      { await release(); return fail(res, 400, 'Enter valid email addresses to send to (at most 5)') }
    const to = [...new Set(wanted.map(e => e.trim().toLowerCase()))]
    if (to.length === 0) { await release(); return fail(res, 400, 'This supplier has no email address. Add one to the supplier, or enter where to send it') }
    const message = typeof req.body?.message === 'string' ? req.body.message.trim().slice(0, 1000) : ''

    const sentAt = new Date()
    const sentView = { _id: po._id, status: 'sent', createdAt: po.createdAt, sentAt, ...p.data }
    const pdf = await renderPurchaseOrderPdf(sentView)
    const mail = emailPurchaseOrder({
      to, supplierName: p.data.supplierSnapshot.name, poNumber: po._id, buyerName: p.data.buyerSnapshot.name, message,
      expectedDate: p.data.expectedDate, total: p.data.totals.grandTotal, lineCount: p.data.lines.length, senderName: req.user.name,
    })
    const result = await sendEmailDetailed({
      ...mail, attachments: [{ filename: `${po._id}.pdf`, content: pdf }],
      replyTo: req.user.email || undefined, fromName: p.data.buyerSnapshot.name,
    })
    if (!result.skipped && result.sent.length === 0) {
      await release()
      return fail(res, 502, `The email could not be sent to ${to.join(', ')}. Check the address and try again`, { failed: result.failed })
    }

    const doc = await Document.create({
      type: 'supplier_po', name: `Purchase order ${po._id}`, mfrId: req.user.id, orderId: null, issueDate: sentAt,
      uploadedBy: req.user.actorId, issuer: p.data.buyerSnapshot.name, poId: po._id,
      dataUrl: `data:application/pdf;base64,${pdf.toString('base64')}`, fileName: `${po._id}.pdf`, fileSize: pdf.length, mimeType: 'application/pdf',
    })
    const note = result.skipped ? `Email not sent: no email service is configured here (${to.join(', ')})` : `Emailed to ${result.sent.join(', ')}`
    const sent = await PurchaseOrder.findOneAndUpdate(
      { _id: id, ...mine(req), status: 'sending' },
      { $set: { ...p.data, status: 'sent', sentAt, sentBy: req.user.actorId, sentTo: result.skipped ? [] : result.sent, sendingAt: null, documentId: doc._id }, $push: { timeline: stamp(req, 'Sent to supplier', note) } },
      { new: true },
    ).lean()
    claimed = false
    if (!sent) { console.error('[po send] CRITICAL: the PO was emailed but could not be marked sent', id); return fail(res, 500, 'The purchase order was emailed but could not be saved as sent. Do not send it again; contact support') }

    // The supplier has it and the PO is saved as sent. What follows must not turn that into an error.
    let unlinked = p.staleLinks.map(description => ({ description }))
    try { unlinked = [...unlinked, ...await syncOnSend({ partyId: req.user.id, po: sent, supplier: p.supplier })] } catch (err) { console.error('[po send] material sync failed', err) }
    await AuditLog.create({ byUser: req.user.id, action: 'Purchase Order Sent', detail: `${po._id} sent to ${p.supplier.name} by ${req.user.name} (${note})` }).catch(err => console.error('[po send] audit failed', err))
    res.json(poView(sent, {
      warnings: p.warnings,
      notice: { emailed: result.sent, emailSkipped: !!result.skipped, emailFailed: result.failed, unlinkedLines: unlinked.map(u => u.description) },
    }))
  } catch (err) {
    console.error('[po send]', err)
    if (claimed) await release().catch(() => {})
    fail(res, 500, 'Server error')
  }
})

async function move(req, res, { to, allowFrom, action, note, set = {}, extraGuard = {} }) {
  const id = idParam(req, res); if (!id) return null
  const po = await PurchaseOrder.findOneAndUpdate(
    { _id: id, ...mine(req), status: { $in: allowFrom }, ...extraGuard },
    { $set: { status: to, ...set }, $push: { timeline: stamp(req, action, note) } }, { new: true },
  ).lean()
  if (!po) {
    const exists = await PurchaseOrder.exists({ _id: id, ...mine(req) })
    fail(res, exists ? 409 : 404, exists ? `A purchase order in this state cannot be ${action.toLowerCase()}` : 'Purchase order not found')
    return null
  }
  return po
}

// POST /api/purchase-orders/:id/acknowledge { expectedDate? } - the supplier has confirmed it
router.post('/:id/acknowledge', writeLimiter, async (req, res) => {
  try {
    const expectedDate = req.body?.expectedDate
    if (expectedDate && !/^\d{4}-\d{2}-\d{2}$/.test(expectedDate)) return fail(res, 400, 'The delivery date is not a valid date')
    const po = await move(req, res, { to: 'acknowledged', allowFrom: ['sent'], action: 'Acknowledged by supplier', note: expectedDate ? `Delivery promised by ${expectedDate}` : '', set: expectedDate ? { expectedDate } : {} })
    if (po) res.json(poView(po))
  } catch (err) { console.error('[po]', err); fail(res, 500, 'Server error') }
})

// POST /api/purchase-orders/:id/close { reason? } - done with it (short supply accepted)
router.post('/:id/close', writeLimiter, async (req, res) => {
  try {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : ''
    const po = await move(req, res, { to: 'closed', allowFrom: ['sent', 'acknowledged', 'partially_received'], action: 'Closed', note: reason, set: { closedReason: reason } })
    if (po) res.json(poView(po))
  } catch (err) { console.error('[po]', err); fail(res, 500, 'Server error') }
})

// POST /api/purchase-orders/:id/cancel { reason } - before anything has arrived
router.post('/:id/cancel', writeLimiter, async (req, res) => {
  try {
    const id = idParam(req, res); if (!id) return
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : ''
    if (!reason) return fail(res, 400, 'Say why it is being cancelled')
    const before = await PurchaseOrder.findOne({ _id: id, ...mine(req) }).lean()
    if (!before) return fail(res, 404, 'Purchase order not found')
    if ((before.receipts || []).length) return fail(res, 409, 'Goods have already been received against this purchase order, so it can only be closed')
    const po = await move(req, res, { to: 'cancelled', allowFrom: ['draft', 'sent', 'acknowledged'], action: 'Cancelled', note: reason, set: { cancelReason: reason }, extraGuard: { 'receipts.0': { $exists: false } } })
    if (!po) return
    if (before.status !== 'draft') await syncOnCancel({ partyId: req.user.id, po })
    await AuditLog.create({ byUser: req.user.id, action: 'Purchase Order Cancelled', detail: `${po._id} cancelled by ${req.user.name}: ${reason}` })
    res.json(poView(po))
  } catch (err) { console.error('[po]', err); fail(res, 500, 'Server error') }
})

// POST /api/purchase-orders/:id/receive { lines: [{ lineId, qty }], note? } - goods have come in
router.post('/:id/receive', writeLimiter, async (req, res) => {
  try {
    const id = idParam(req, res); if (!id) return
    const po = await PurchaseOrder.findOne({ _id: id, ...mine(req) }).lean()
    if (!po) return fail(res, 404, 'Purchase order not found')
    if (!['sent', 'acknowledged', 'partially_received'].includes(po.status)) return fail(res, 409, 'Goods can only be received against a PO that has been sent')

    const rows = req.body?.lines
    if (!Array.isArray(rows) || rows.length === 0 || rows.length > 200) return fail(res, 400, 'Say what was received')
    const seen = new Set(), received = []
    for (const r of rows) {
      const line = po.lines.find(l => l.lineId === r?.lineId)
      const qty = Number(r?.qty)
      if (!line) return fail(res, 400, 'A received line is not on this purchase order')
      if (seen.has(line.lineId)) return fail(res, 400, 'List each line once')
      seen.add(line.lineId)
      if (!Number.isFinite(qty) || qty <= 0) return fail(res, 400, `Received quantity for "${line.description}" must be more than zero`)
      if ((line.receivedQty || 0) + qty > line.qty * OVER_RECEIPT)
        return fail(res, 400, `"${line.description}": that would be more than 10% over the ${line.qty} ${line.unit} ordered. Check the quantity`)
      received.push({ line, qty: round3(qty) })
    }
    const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) : ''

    // Receiving is a goods received note: the same path a note made in the stock screens takes, so every receipt
    // has a number, a PDF and a stock movement behind it.
    const made = await createGrn(req, { poId: id, note, lines: received.map(r => ({ poLineId: r.line.lineId, qty: r.qty })) }, { source: 'web' })
    if (!made.ok) return fail(res, made.status, made.error)
    const posted = await postGrn(req, made.grn._id)
    if (!posted.ok) {
      await Grn.deleteOne({ _id: made.grn._id, ownerOrgId: req.user.orgId, status: 'draft' })
      return fail(res, posted.status, posted.error)
    }
    res.json(poView(posted.po, { notice: posted.notice, grn: { id: String(posted.grn._id), number: posted.grn.number } }))
  } catch (err) { console.error('[po]', err); fail(res, 500, 'Server error') }
})

export default router
