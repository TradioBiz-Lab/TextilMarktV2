import { Router } from 'express'
import mongoose from 'mongoose'
import rateLimit from 'express-rate-limit'
import { requireAuth } from '../middleware/auth.js'
import { Order, MasterOrder, User, AuditLog } from '../db/index.js'
import { StyleRequest } from '../models/StyleRequest.js'
import { createReplenFrom } from './orders.js'
import { analyse, createRows } from './styleImports.js'
import { ImportError } from '../lib/styleImport.js'
import { notify } from '../lib/notify.js'

// The review queue for what a customer asks to add (a sheet of NPD/Replen styles, or a replen of a style in production).
// A customer sees and can cancel its own requests; a master admin sees them all and approves or declines. Nothing exists
// as a style until it is approved: approval creates it with the same code Tradio's own import and replen use.
const router = Router()
router.use(requireAuth)

const skipInTest = () => process.env.NODE_ENV === 'test'
const limiter = (max, message) => rateLimit({
  windowMs: 60 * 60 * 1000, max, keyGenerator: req => req.user?.id || req.ip,
  message: { error: message }, standardHeaders: true, legacyHeaders: false, validate: false, skip: skipInTest,
})
const readLimiter = limiter(240, 'Too many requests. Please wait.')
const decideLimiter = limiter(60, 'Too many decisions. Please wait.')

const isMaster = u => u?.role === 'admin' && u?.adminType === 'master'
const fail = (res, status, error, extra) => res.status(status).json({ error, ...extra })
const dayLabel = n => `${n} style${n !== 1 ? 's' : ''}`

/** A request as the browser gets it: never the sheet bytes. */
async function items(docs) {
  const moIds = [...new Set(docs.map(d => d.masterOrderId).filter(Boolean))]
  const mos = moIds.length ? await MasterOrder.find({ _id: { $in: moIds } }, 'orderName season').lean() : []
  const moName = Object.fromEntries(mos.map(m => [m._id, m.orderName]))
  return docs.map(d => ({
    id: String(d._id), kind: d.kind, status: d.status === 'processing' ? 'pending' : d.status,
    masterOrderId: d.masterOrderId, masterOrderName: moName[d.masterOrderId] || '',
    buyerCompany: d.buyerId?.company || '', requestedByName: d.requestedBy?.name || '',
    filename: d.filename || '', summary: d.summary || null,
    sourceOrderId: d.sourceOrderId, product: d.product, styleNumber: d.styleNumber, quantity: d.quantity, note: d.note,
    decisionNote: d.decisionNote || '', decidedAt: d.decidedAt, decidedByName: d.decidedBy?.name || '',
    createdOrderIds: d.createdOrderIds || [], failedCount: d.failedCount || 0, createdAt: d.createdAt,
  }))
}
const populated = q => q.populate('buyerId', 'company').populate('requestedBy', 'name').populate('decidedBy', 'name')

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i
async function load(req, res, { withData = false } = {}) {
  if (!OBJECT_ID_RE.test(req.params.id)) { fail(res, 404, 'Request not found.'); return null }
  const doc = await (withData ? StyleRequest.findById(req.params.id).select('+data') : StyleRequest.findById(req.params.id))
  // A customer only ever sees its own; another's reads as not found.
  if (!doc || (req.user.role === 'buyer' && String(doc.requestedBy) !== String(req.user.id)) || (req.user.role !== 'buyer' && !isMaster(req.user))) { fail(res, 404, 'Request not found.'); return null }
  return doc
}
const masterOnly = (req, res, next) => isMaster(req.user) ? next() : fail(res, 403, 'Master admin only')

// GET /api/style-requests?status=pending|decided|all   (a customer: its own; a master admin: everyone's, pending by default)
router.get('/', readLimiter, async (req, res) => {
  try {
    if (req.user.role === 'buyer') {
      const docs = await populated(StyleRequest.find({ requestedBy: req.user.id }).sort({ createdAt: -1 }).limit(50))
      return res.json(await items(docs))
    }
    if (!isMaster(req.user)) return fail(res, 403, 'Master admin only')
    const status = req.query.status
    const filter = status === 'all' ? {} : status === 'decided' ? { status: { $in: ['approved', 'declined', 'cancelled'] } } : { status: { $in: ['pending', 'processing'] } }
    const docs = await populated(StyleRequest.find(filter).sort(status === 'decided' ? { decidedAt: -1, createdAt: -1 } : { createdAt: 1 }).limit(100))
    res.json(await items(docs))
  } catch (err) { console.error('[style requests]', err); fail(res, 500, 'Server error') }
})

// POST /api/style-requests/:id/preview  -> what would be created (an import: every row; a replen: the style and quantity)
router.post('/:id/preview', readLimiter, async (req, res) => {
  try {
    const doc = await load(req, res, { withData: true }); if (!doc) return
    const [item] = await items(await populated(StyleRequest.find({ _id: doc._id })))
    if (doc.kind === 'replen') {
      const src = await Order.findById(doc.sourceOrderId, 'product styleNumber totalQty brand phase imageDataUrl imageUrl photos').lean()
      return res.json({ request: item, source: src ? { id: src._id, product: src.product, styleNumber: src.styleNumber || '', totalQty: src.totalQty ?? null, brand: src.brand || '', phase: src.phase || 'production', image: src.photos?.[0]?.image || src.imageDataUrl || src.imageUrl || null } : null })
    }
    if (!doc.data) return res.json({ request: item, rows: null })
    const mo = await MasterOrder.findById(doc.masterOrderId).lean()
    if (!mo) return fail(res, 404, 'The master order no longer exists.')
    const analysis = await analyse({ data: doc.data, filename: doc.filename }, mo)
    res.json({ request: item, ...analysis, rows: analysis.rows.map(({ payload, ...row }) => row) })
  } catch (err) {
    if (err instanceof ImportError) return fail(res, 400, err.message)
    console.error('[style requests]', err); fail(res, 500, 'Server error')
  }
})

/** Put a request that was being approved back in the queue after a failure. */
const release = id => StyleRequest.updateOne({ _id: id, status: 'processing' }, { $set: { status: 'pending' } }).catch(() => {})

// POST /api/style-requests/:id/approve   (master admin) -> creates the styles
router.post('/:id/approve', decideLimiter, masterOnly, async (req, res) => {
  if (!OBJECT_ID_RE.test(req.params.id)) return fail(res, 404, 'Request not found.')
  // One approval at a time: a double click must not create the styles twice.
  const doc = await StyleRequest.findOneAndUpdate({ _id: req.params.id, status: 'pending' }, { $set: { status: 'processing' } }, { new: true }).select('+data')
  if (!doc) return fail(res, 409, 'That request is not waiting for review (it may already be decided, or being approved).')
  let done = false
  try {
    let created = [], failed = [], line = '', firstId = null
    if (doc.kind === 'replen') {
      const src = await Order.findById(doc.sourceOrderId).lean()
      if (!src) return fail(res, 409, 'The style it reorders no longer exists.')
      const made = await createReplenFrom(src, { quantity: doc.quantity, note: doc.note })
      if (!made.ok) return fail(res, 409, made.error)
      created = [{ id: made.order._id }]; firstId = made.order._id
      line = `Your replen of ${doc.product}${doc.styleNumber ? ` (${doc.styleNumber})` : ''}, ${doc.quantity.toLocaleString('en-IN')} pcs, was approved: ${made.order._id}`
      await AuditLog.create({ byUser: req.user.id, action: 'Replen Ordered', detail: `${made.order._id} - replen of ${src._id}, ${doc.quantity.toLocaleString('en-IN')} pcs, requested by the customer and approved` })
    } else {
      const mo = await MasterOrder.findById(doc.masterOrderId).lean()
      const buyer = mo && await User.findById(mo.buyerId, 'code company role isActive').lean()
      if (!mo || !buyer || buyer.role !== 'buyer' || !buyer.isActive) return fail(res, 409, 'The master order or its customer is no longer available.')
      if (!doc.data) return fail(res, 409, 'The sheet is no longer kept for this request.')
      const analysis = await analyse({ data: doc.data, filename: doc.filename }, mo)
      const { ok, errors, exists } = analysis.summary
      if (errors && !doc.skipInvalid) return fail(res, 409, `${errors} row${errors !== 1 ? 's' : ''} in the sheet now ${errors !== 1 ? 'have' : 'has'} problems (look at the preview), so nothing was created. Decline it and ask for a corrected sheet.`)
      if (!ok) return fail(res, 409, exists ? 'Every style in the sheet is already in this master order.' : 'There are no valid rows to create.')
      ;({ created, failed } = await createRows(analysis, { mo, buyer }))
      if (!created.length) return fail(res, 409, 'No style could be created.')
      firstId = created[0].id
      line = `Your request was approved: ${dayLabel(created.length)} added under ${mo.orderName}`
      await AuditLog.create({ byUser: req.user.id, action: 'Style Import', detail: `${dayLabel(created.length)} created from ${doc.filename} under ${mo._id}${failed.length ? `, ${failed.length} failed` : ''}, requested by the customer and approved` })
    }
    await StyleRequest.updateOne({ _id: doc._id }, { $set: { status: 'approved', decidedBy: req.user.id, decidedAt: new Date(), createdOrderIds: created.map(c => c.id), failedCount: failed.length }, $unset: { data: 1 } })
    done = true
    await notify([doc.requestedBy], { type: 'order', msg: line, orderId: firstId })
    res.json({ approved: true, created, failed })
  } catch (err) {
    if (err instanceof ImportError) return fail(res, 409, err.message)
    console.error('[style requests approve]', err); fail(res, 500, 'Server error')
  } finally { if (!done) await release(doc._id) }
})

// POST /api/style-requests/:id/decline  { reason? }   (master admin)
router.post('/:id/decline', decideLimiter, masterOnly, async (req, res) => {
  try {
    if (!OBJECT_ID_RE.test(req.params.id)) return fail(res, 404, 'Request not found.')
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : ''
    if (reason.length > 300) return fail(res, 400, 'The reason is too long (300 characters at most).')
    const doc = await StyleRequest.findOneAndUpdate({ _id: req.params.id, status: 'pending' },
      { $set: { status: 'declined', decidedBy: req.user.id, decidedAt: new Date(), decisionNote: reason }, $unset: { data: 1 } }, { new: true })
    if (!doc) return fail(res, 409, 'That request is not waiting for review (it may already be decided, or being approved).')
    const what = doc.kind === 'replen' ? `Your replen request for ${doc.product}${doc.styleNumber ? ` (${doc.styleNumber})` : ''}` : `Your request of ${doc.filename}`
    await AuditLog.create({ byUser: req.user.id, action: 'Style Request Declined', detail: `${doc.kind === 'replen' ? `Replen of ${doc.sourceOrderId}` : doc.filename}${reason ? `: ${reason}` : ''}` })
    await notify([doc.requestedBy], { type: 'order', msg: `${what} was declined${reason ? `: ${reason}` : '.'}` })
    res.json({ declined: true })
  } catch (err) { console.error('[style requests decline]', err); fail(res, 500, 'Server error') }
})

// POST /api/style-requests/:id/cancel   (the customer who sent it, while it is still waiting)
router.post('/:id/cancel', decideLimiter, async (req, res) => {
  try {
    if (req.user.role !== 'buyer') return fail(res, 403, 'Only the customer can cancel its own request')
    if (!OBJECT_ID_RE.test(req.params.id)) return fail(res, 404, 'Request not found.')
    const doc = await StyleRequest.findOneAndUpdate({ _id: req.params.id, requestedBy: req.user.id, status: 'pending' },
      { $set: { status: 'cancelled', decidedAt: new Date() }, $unset: { data: 1 } }, { new: true })
    if (!doc) return fail(res, 409, 'That request can no longer be cancelled.')
    await AuditLog.create({ byUser: req.user.id, action: 'Style Request Cancelled', detail: doc.kind === 'replen' ? `Replen of ${doc.sourceOrderId}` : doc.filename })
    res.json({ cancelled: true })
  } catch (err) { console.error('[style requests cancel]', err); fail(res, 500, 'Server error') }
})

export default router
