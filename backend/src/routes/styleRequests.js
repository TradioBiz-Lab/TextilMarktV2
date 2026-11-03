import { createHash } from 'node:crypto'
import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { requireAuth } from '../middleware/auth.js'
import { Order, MasterOrder, User, AuditLog, Document } from '../db/index.js'
import { StyleRequest } from '../models/StyleRequest.js'
import { MEASUREMENT_LABELS } from '../models/Document.js'
import { createReplenFrom, validateAndCreateOrder, stylePhotos, replenEligible, REPLEN_NOT_ELIGIBLE } from './orders.js'
import { isoDay } from '../lib/masterOrderDetails.js'
import { analyse, createRows } from './styleImports.js'
import { ImportError } from '../lib/styleImport.js'
import { cleanLink } from '../lib/links.js'
import { nextStyleId } from '../lib/ids.js'
import { getToday } from '../lib/stageMath.js'
import { notify, masterAdminIds } from '../lib/notify.js'

// The review queue for what a customer asks to add: a sheet of NPD/Replen styles, reorders (replens) of its styles in
// production, or new styles from the guided New Product Development form. A customer sends and can cancel its own requests;
// a master admin sees them all, chooses the master order the styles go under, and approves or declines. Nothing exists as a
// style until it is approved: approval creates it with the same code Tradio's own paths use.
const router = Router()
router.use(requireAuth)

const skipInTest = () => process.env.NODE_ENV === 'test'
const limiter = (max, message) => rateLimit({
  windowMs: 60 * 60 * 1000, max, keyGenerator: req => req.user?.id || req.ip,
  message: { error: message }, standardHeaders: true, legacyHeaders: false, validate: false, skip: skipInTest,
})
const readLimiter = limiter(240, 'Too many requests. Please wait.')
const decideLimiter = limiter(60, 'Too many decisions. Please wait.')
const sendLimiter = limiter(30, 'Too many requests sent. Please wait.')

const isMaster = u => u?.role === 'admin' && u?.adminType === 'master'
const fail = (res, status, error, extra) => res.status(status).json({ error, ...extra })
const dayLabel = n => `${n} style${n !== 1 ? 's' : ''}`
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i
const ORDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/
const MAX_ITEMS = { replen: 50, npd: 20 }

// What was just sent, so the same thing sent again within 30 seconds (a double click, a retry, two at once) is refused.
// In memory: the app runs as one process (see CLAUDE.md, "Single-instance assumption", which this joins).
const RECENT_MS = 30_000
const recent = new Map()   // key -> time it was claimed
/** Claims `key` for 30 seconds: true the first time, false while it is still claimed. */
function claimOnce(key) {
  const now = Date.now()
  for (const [k, at] of recent) if (now - at > RECENT_MS) recent.delete(k)
  if (recent.has(key)) return false
  recent.set(key, now)
  return true
}
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32)
// What a customer may attach to an item: the style's measurement sheets, tech pack and pattern.
const ITEM_DOC_TYPES = ['measurements', 'tech_pack', 'pattern']

/** The styles of a request: `items`, or the one style of an older replen request. */
const itemsOf = d => (d.items?.length ? d.items : d.kind === 'replen' && d.sourceOrderId ? [{ sourceOrderId: d.sourceOrderId, product: d.product, styleNumber: d.styleNumber, quantity: d.quantity, note: d.note, colours: [], docIds: [] }] : [])

// ── Checking what a customer sends ─────────────────────────────────────────────────────────────────────────────────────
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
function textField(item, key, label, max, errors, { required = false } = {}) {
  const v = item?.[key]
  if (v == null || v === '') { if (required) errors.push(`${label} is missing.`); return '' }
  if (typeof v !== 'string') { errors.push(`${label} must be text.`); return '' }
  if (v.trim().length > max) errors.push(`${label} is too long (${max} characters at most).`)
  if (required && !v.trim()) errors.push(`${label} is missing.`)
  return v.trim()
}
function linkField(item, key, label, errors) {
  const r = cleanLink(item?.[key], label)
  if (r.error) errors.push(r.error)
  return r.link || ''
}
function quantityField(item, errors) {
  const v = item?.quantity ?? item?.totalQty
  if (v == null || v === '') return null
  if (typeof v !== 'number' && typeof v !== 'string') { errors.push('Quantity must be a whole number.'); return null }
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1 || n > 10_000_000) { errors.push('Quantity must be a whole number from 1 to 1,00,00,000.'); return null }
  return n
}
/** The expected delivery date: a real calendar day (2026-02-31 is not), today or later in India. */
function deliveryField(item, errors) {
  const v = textField(item, 'delivery', 'Expected delivery date', 10, errors, { required: true })
  if (!v) return ''
  if (!isoDay(v)) errors.push('Expected delivery date is not a real date.')
  else if (v < getToday()) errors.push('Expected delivery date is in the past.')
  return v
}
function coloursField(item, errors) {
  const v = item?.colours
  if (v == null) return []
  if (!Array.isArray(v) || v.length > 40) { errors.push('Colours must be a list of 40 at most.'); return [] }
  const names = [...new Set(v.map(c => (typeof c === 'string' ? c : c?.name || '').trim()).filter(Boolean))]
  if (names.some(n => n.length > 60)) errors.push('A colour name is too long (60 characters at most).')
  return names
}
/** The files sent with an item: the sender's own, not yet on a style or another request, of a type an item can carry. */
async function docsField(item, user, errors, taken) {
  const ids = item?.docIds ?? []
  if (!Array.isArray(ids) || ids.length > 20 || !ids.every(id => typeof id === 'string' && OBJECT_ID_RE.test(id))) { errors.push('The attached files could not be read.'); return [] }
  if (!ids.length) return []
  const docs = await Document.find({ _id: { $in: ids } }, { uploadedBy: 1, orderId: 1, masterOrderId: 1, isActive: 1, styleRequestId: 1, type: 1, measurementLabel: 1 }).lean()
  const ok = docs.filter(d => String(d.uploadedBy) === String(user.id) && d.isActive && !d.orderId && !d.masterOrderId && !d.styleRequestId && ITEM_DOC_TYPES.includes(d.type)
    && (d.type !== 'measurements' || MEASUREMENT_LABELS.includes(d.measurementLabel)) && !taken.has(String(d._id)))
  if (ok.length !== ids.length) { errors.push('One of the attached files is not available any more. Attach it again.'); return [] }
  ok.forEach(d => taken.add(String(d._id)))
  return ids
}

/** One replen item, checked: a style of `ownerId` (the customer: the sender itself, or the one Tradio is adding for) in
 *  production, and what is wanted this time. Files must be the sender's own. */
async function replenItem(raw, user, taken, ownerId = user.id) {
  const errors = []
  const sourceOrderId = typeof raw?.sourceOrderId === 'string' && ORDER_ID_RE.test(raw.sourceOrderId) ? raw.sourceOrderId : null
  const src = sourceOrderId && await Order.findById(sourceOrderId, 'buyerId product styleNumber phase assignments').lean()
  if (!src || String(src.buyerId) !== String(ownerId)) return { errors: ['That style was not found.'] }
  if (!replenEligible(src)) errors.push(REPLEN_NOT_ELIGIBLE)
  const delivery = deliveryField(raw, errors)
  const item = {
    sourceOrderId, product: src.product, styleNumber: src.styleNumber || '',
    colours: coloursField(raw, errors), quantity: quantityField(raw, errors), delivery,
    ecommerceLink: linkField(raw, 'ecommerceLink', 'Product link', errors), techPackLink: linkField(raw, 'techPackLink', 'Tech pack link', errors),
    note: textField(raw, 'note', 'Note', 500, errors),
  }
  item.docIds = errors.length ? [] : await docsField(raw, user, errors, taken)
  return { item, errors }
}

/** One new style from the customer's short form: its own style number, colours, quantity (optional), expected delivery date
 *  and tech pack link. It is called "New product" with its colours until Tradio names it on the style page. */
async function npdItem(raw) {
  const errors = []
  const styleNumber = textField(raw, 'styleNumber', 'Your style no.', 60, errors, { required: true })
  const colours = coloursField(raw, errors)
  if (!errors.length && !colours.length) errors.push('Add at least one colour.')
  const delivery = deliveryField(raw, errors)
  const techPackLink = linkField(raw, 'techPackLink', 'Tech pack link', errors)
  if (!errors.length && !techPackLink) errors.push('The tech pack link is missing.')
  const item = {
    product: `New product${colours.length ? ` (${colours.join(', ')})` : ''}`.slice(0, 300),
    styleNumber, colours, quantity: quantityField(raw, errors), delivery, techPackLink, docIds: [],
  }
  return { item, errors }
}

// POST /api/style-requests  { kind: 'replen' | 'npd', items: [...] }   (a customer) -> a request waiting for review
router.post('/', sendLimiter, async (req, res) => {
  try {
    if (req.user.role !== 'buyer') return fail(res, 403, 'Only a customer sends style requests; Tradio creates styles directly')
    const { kind, items: raw } = req.body || {}
    if (!['replen', 'npd'].includes(kind)) return fail(res, 400, 'Unknown request')
    if (!Array.isArray(raw) || !raw.length) return fail(res, 400, kind === 'replen' ? 'Choose at least one style to reorder.' : 'Add at least one style.')
    if (raw.length > MAX_ITEMS[kind]) return fail(res, 400, `Too many styles in one request (${MAX_ITEMS[kind]} at most).`)
    if (kind === 'replen' && new Set(raw.map(r => r?.sourceOrderId)).size !== raw.length) return fail(res, 400, 'The same style is chosen twice.')
    const taken = new Set()
    const items = [], problems = []
    for (const [i, r] of raw.entries()) {
      const { item, errors } = await (kind === 'replen' ? replenItem : npdItem)(r, req.user, taken)
      if (errors.length) problems.push({ index: i, errors })
      else items.push(item)
    }
    if (problems.length) {
      const first = problems[0]
      return fail(res, 400, `${kind === 'replen' ? `Style ${first.index + 1}` : `Style ${first.index + 1}`}: ${first.errors[0]}`, { problems })
    }
    const sentKey = `send|${req.user.id}|${kind}|${fingerprint(items.map(({ docIds, ...it }) => it))}`
    if (!claimOnce(sentKey)) return fail(res, 409, 'This request was just sent.')
    let request
    try { request = await StyleRequest.create({ kind, buyerId: req.user.id, requestedBy: req.user.id, items }) }
    catch (err) { recent.delete(sentKey); throw err }
    const docIds = items.flatMap(i => i.docIds)
    if (docIds.length) await Document.updateMany({ _id: { $in: docIds } }, { $set: { styleRequestId: request._id } })
    const what = kind === 'replen' ? `a replen of ${dayLabel(items.length)}` : `${dayLabel(items.length)} for New Product Development`
    await AuditLog.create({ byUser: req.user.id, action: 'Style Request Sent', detail: `${what}, by the customer, waiting for review` })
    await notify(await masterAdminIds(), { type: 'order', msg: `${req.user.company || 'A customer'} asked for ${what}. It is waiting for your review.` })
    res.status(201).json({ pending: true, requestId: request._id, count: items.length })
  } catch (err) { console.error('[style requests send]', err); fail(res, 500, 'Server error') }
})

// POST /api/style-requests/direct-replen  { masterOrderId, items: [...] }   (Tradio) -> the replens, created at once
// The admin's Add replen: the same choices a customer makes (styles in production, colours, quantity, links, expected
// delivery date), but no review, and the admin picks the master order there and then. Every style has to
// belong to that master order's customer.
router.post('/direct-replen', sendLimiter, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return fail(res, 403, 'Only Tradio adds replens directly; a customer sends a request')
    const { masterOrderId, items: raw } = req.body || {}
    if (typeof masterOrderId !== 'string' || !ORDER_ID_RE.test(masterOrderId)) return fail(res, 400, 'Choose the master order the replens go under.')
    const mo = await MasterOrder.findById(masterOrderId).lean()
    if (!mo) return fail(res, 404, 'Master order not found.')
    if (!Array.isArray(raw) || !raw.length) return fail(res, 400, 'Choose at least one style to reorder.')
    if (raw.length > MAX_ITEMS.replen) return fail(res, 400, `Too many styles at once (${MAX_ITEMS.replen} at most).`)
    if (new Set(raw.map(r => r?.sourceOrderId)).size !== raw.length) return fail(res, 400, 'The same style is chosen twice.')
    const taken = new Set(), items = []
    for (const [i, r] of raw.entries()) {
      const { item, errors } = await replenItem(r, req.user, taken, mo.buyerId)
      if (errors.length) return fail(res, 400, `Style ${i + 1}: ${errors[0]}${errors[0] === 'That style was not found.' ? ' (it has to be this master order\'s customer\'s)' : ''}`)
      items.push(item)
    }
    // A double click must not add the replens twice (checked once the styles are known to be fine, so a corrected retry goes through).
    const sentKey = `direct|${req.user.id}|${mo._id}|${fingerprint(items.map(it => it.sourceOrderId).sort())}`
    if (!claimOnce(sentKey) || await Order.exists({ replenOf: { $in: items.map(it => it.sourceOrderId) }, masterOrderId: mo._id, createdAt: { $gt: new Date(Date.now() - RECENT_MS) } }))
      return fail(res, 409, 'A replen of one of these styles was just added.')
    const created = [], failed = []
    for (const [i, it] of items.entries()) {
      const src = await Order.findById(it.sourceOrderId).lean()
      const made = await createReplenFrom(src, { quantity: it.quantity, note: it.note, colourways: it.colours, ecommerceLink: it.ecommerceLink, techPackLink: it.techPackLink, delivery: it.delivery, masterOrderId: mo._id })
      if (!made.ok) { failed.push({ row: i + 1, styleNumber: it.styleNumber, error: `${it.product}: ${made.error}` }); continue }
      if (it.docIds.length) await Document.updateMany({ _id: { $in: it.docIds }, uploadedBy: req.user.id, orderId: null }, { $set: { orderId: made.order._id } })
      created.push({ row: i + 1, id: made.order._id, styleNumber: it.styleNumber, product: it.product })
    }
    if (created.length) {
      await AuditLog.create({ byUser: req.user.id, action: 'Replen Ordered', detail: `Replen of ${dayLabel(created.length)} under ${mo._id}: ${created.map(c => c.id).join(', ')}${failed.length ? `, ${failed.length} failed` : ''}` })
      await notify([mo.buyerId], { type: 'order', msg: `A replen of ${dayLabel(created.length)} was added for you under ${mo.orderName}`, orderId: created[0].id }, { exceptUserId: req.user.id })
    }
    res.status(created.length ? 201 : 400).json({ masterOrderId: mo._id, created, failed, ...(created.length ? {} : { error: failed[0]?.error || 'No replen could be created.' }) })
  } catch (err) { console.error('[style requests direct replen]', err); fail(res, 500, 'Server error') }
})

/** A request as the browser gets it: never the sheet bytes or photo data. */
async function itemsForList(docs) {
  const moIds = [...new Set(docs.map(d => d.masterOrderId).filter(Boolean))]
  const mos = moIds.length ? await MasterOrder.find({ _id: { $in: moIds } }, 'orderName season').lean() : []
  const moName = Object.fromEntries(mos.map(m => [m._id, m.orderName]))
  return docs.map(d => ({
    id: String(d._id), kind: d.kind, status: d.status === 'processing' ? 'pending' : d.status,
    masterOrderId: d.masterOrderId, masterOrderName: moName[d.masterOrderId] || '',
    buyerId: d.buyerId?._id ? String(d.buyerId._id) : String(d.buyerId || ''),
    buyerCompany: d.buyerId?.company || '', requestedByName: d.requestedBy?.name || '',
    filename: d.filename || '', summary: d.summary || null,
    sourceOrderId: d.sourceOrderId, product: d.product, styleNumber: d.styleNumber, quantity: d.quantity, note: d.note,
    items: itemsOf(d).map(({ photos, ...it }) => ({ ...it, photoCount: it.photoCount ?? (photos || []).length, docCount: (it.docIds || []).length })),
    decisionNote: d.decisionNote || '', decidedAt: d.decidedAt, decidedByName: d.decidedBy?.name || '',
    createdOrderIds: d.createdOrderIds || [], failedCount: d.failedCount || 0, createdAt: d.createdAt,
  }))
}
const populated = q => q.populate('buyerId', 'company').populate('requestedBy', 'name').populate('decidedBy', 'name')

async function load(req, res, { withData = false } = {}) {
  if (!OBJECT_ID_RE.test(req.params.id)) { fail(res, 404, 'Request not found.'); return null }
  const doc = await (withData ? StyleRequest.findById(req.params.id).select('+data') : StyleRequest.findById(req.params.id))
  // A customer only ever sees its own; another's reads as not found.
  if (!doc || (req.user.role === 'buyer' && String(doc.requestedBy) !== String(req.user.id)) || (req.user.role !== 'buyer' && !isMaster(req.user))) { fail(res, 404, 'Request not found.'); return null }
  return doc
}
const masterOnly = (req, res, next) => isMaster(req.user) ? next() : fail(res, 403, 'Master admin only')

/** The master order a request's styles go under: the one the master admin chose, else the request's own, else (a replen)
 *  the one its styles already share. It has to be the request's customer's. { mo, buyer } or { error }. */
async function targetFor(doc, chosen) {
  let id = typeof chosen === 'string' && chosen ? chosen : doc.masterOrderId
  if (!id && doc.kind === 'replen') {
    const srcIds = itemsOf(doc).map(i => i.sourceOrderId)
    const mos = [...new Set((await Order.find({ _id: { $in: srcIds } }, { masterOrderId: 1 }).lean()).map(o => o.masterOrderId).filter(Boolean))]
    if (mos.length === 1) id = mos[0]
  }
  if (!id) return { error: 'Choose the master order these styles go under.' }
  if (!ORDER_ID_RE.test(id)) return { error: 'Master order not found.' }
  const mo = await MasterOrder.findById(id).lean()
  if (!mo || String(mo.buyerId) !== String(doc.buyerId)) return { error: 'That master order is not this customer\'s.' }
  const buyer = await User.findById(mo.buyerId, 'code company role isActive').lean()
  if (!buyer || buyer.role !== 'buyer' || !buyer.isActive) return { error: 'The customer\'s account is not available.' }
  return { mo, buyer }
}

// GET /api/style-requests?status=pending|decided|all   (a customer: its own; a master admin: everyone's, pending by default)
router.get('/', readLimiter, async (req, res) => {
  try {
    if (req.user.role === 'buyer') {
      const docs = await populated(StyleRequest.find({ requestedBy: req.user.id }).select('-items.photos').sort({ createdAt: -1 }).limit(50))
      return res.json(await itemsForList(docs))
    }
    if (!isMaster(req.user)) return fail(res, 403, 'Master admin only')
    const status = req.query.status
    const filter = status === 'all' ? {} : status === 'decided' ? { status: { $in: ['approved', 'declined', 'cancelled'] } } : { status: { $in: ['pending', 'processing'] } }
    await releaseStale()
    // Everything waiting is listed (oldest first: first come, first decided); the decided list is the latest 100.
    const docs = await populated(StyleRequest.find(filter).select('-items.photos').sort(status === 'decided' ? { decidedAt: -1, createdAt: -1 } : { createdAt: 1 }).limit(status === 'decided' || status === 'all' ? 100 : 1000))
    res.json(await itemsForList(docs))
  } catch (err) { console.error('[style requests]', err); fail(res, 500, 'Server error') }
})

// POST /api/style-requests/:id/preview  { masterOrderId? }  -> everything in the request, to review it
router.post('/:id/preview', readLimiter, async (req, res) => {
  try {
    const doc = await load(req, res, { withData: true }); if (!doc) return
    const [item] = await itemsForList(await populated(StyleRequest.find({ _id: doc._id }).select('-items.photos')))
    const docIds = itemsOf(doc).flatMap(i => i.docIds || [])
    const files = docIds.length ? await Document.find({ _id: { $in: docIds } }, { name: 1, fileName: 1, type: 1, measurementLabel: 1 }).lean() : []
    const fileOf = id => files.find(f => String(f._id) === String(id))
    const withFiles = it => ({ ...it, files: (it.docIds || []).map(fileOf).filter(Boolean).map(f => ({ id: String(f._id), name: f.fileName || f.name, type: f.type, measurementLabel: f.measurementLabel || null })) })
    if (doc.kind === 'replen') {
      const srcs = await Order.find({ _id: { $in: itemsOf(doc).map(i => i.sourceOrderId) } }, 'product styleNumber totalQty brand phase masterOrderId imageDataUrl imageUrl photos colourways').lean()
      return res.json({ request: item, items: itemsOf(doc).map(it => {
        const s = srcs.find(x => x._id === it.sourceOrderId)
        return withFiles({ ...it, source: s ? { id: s._id, product: s.product, styleNumber: s.styleNumber || '', totalQty: s.totalQty ?? null, phase: s.phase || 'production', masterOrderId: s.masterOrderId || null, colours: (s.colourways || []).map(c => c.name), image: s.photos?.[0]?.image || s.imageDataUrl || s.imageUrl || null } : null })
      }) })
    }
    if (doc.kind === 'npd') return res.json({ request: item, items: itemsOf(doc).map(it => withFiles({ ...it, photos: (it.photos || []).slice(0, 1) })) })
    if (!doc.data) return res.json({ request: item, rows: null })
    const chosen = typeof req.body?.masterOrderId === 'string' && req.body.masterOrderId ? req.body.masterOrderId : doc.masterOrderId
    const mo = chosen && ORDER_ID_RE.test(chosen) ? await MasterOrder.findById(chosen).lean() : null
    const analysis = await analyse({ data: doc.data, filename: doc.filename }, mo && String(mo.buyerId) === String(doc.buyerId) ? mo : null, { requireTechPackForNpd: true, defaultPhase: doc.defaultPhase })
    res.json({ request: item, ...analysis, rows: analysis.rows.map(({ payload, ...row }) => row) })
  } catch (err) {
    if (err instanceof ImportError) return fail(res, 400, err.message)
    console.error('[style requests]', err); fail(res, 500, 'Server error')
  }
})

/** A declined or cancelled request lets go of its files, so they can be sent again. */
const releaseFiles = doc => Document.updateMany({ styleRequestId: doc._id, orderId: null }, { $set: { styleRequestId: null } })
/**
 * An approval that never finished (the server restarted in the middle) leaves its request "processing" for good. Ten
 * minutes on, it is put back in the queue; an approval takes seconds, so a live one is never touched.
 */
const releaseStale = () => StyleRequest.updateMany({ status: 'processing', updatedAt: { $lt: new Date(Date.now() - 10 * 60_000) } }, { $set: { status: 'pending' } }).catch(() => {})
/** Put a request that was being approved back in the queue after a failure. */
const release = id => StyleRequest.updateOne({ _id: id, status: 'processing' }, { $set: { status: 'pending' } }).catch(() => {})
/** Move the files sent with an item onto the style made from it. */
const fileOnto = (doc, item, orderId) => (item.docIds?.length
  ? Document.updateMany({ _id: { $in: item.docIds }, styleRequestId: doc._id, orderId: null }, { $set: { orderId } })
  : null)

// POST /api/style-requests/:id/approve  { masterOrderId? }   (master admin) -> creates the styles under that master order
router.post('/:id/approve', decideLimiter, masterOnly, async (req, res) => {
  if (!OBJECT_ID_RE.test(req.params.id)) return fail(res, 404, 'Request not found.')
  await releaseStale()
  const pending = await StyleRequest.findOne({ _id: req.params.id, status: 'pending' }).lean()
  if (!pending) return fail(res, 409, 'That request is not waiting for review (it may already be decided, or being approved).')
  const target = await targetFor(pending, req.body?.masterOrderId)
  if (target.error) return fail(res, 400, target.error)
  const { mo, buyer } = target
  // One approval at a time: a double click must not create the styles twice.
  const doc = await StyleRequest.findOneAndUpdate({ _id: req.params.id, status: 'pending' }, { $set: { status: 'processing' } }, { new: true }).select('+data')
  if (!doc) return fail(res, 409, 'That request is not waiting for review (it may already be decided, or being approved).')
  let done = false
  // A refusal puts the request back in the queue BEFORE answering, so whoever reads it next sees it waiting again.
  const refuse = async (status, error, extra) => { await release(doc._id); done = true; return fail(res, status, error, extra) }
  try {
    let created = [], failed = []
    if (doc.kind === 'import') {
      if (!doc.data) return refuse(409, 'The sheet is no longer kept for this request.')
      const analysis = await analyse({ data: doc.data, filename: doc.filename }, mo, { requireTechPackForNpd: true, defaultPhase: doc.defaultPhase })
      const { ok, errors, exists } = analysis.summary
      if (errors && !doc.skipInvalid) return refuse(409, `${errors} row${errors !== 1 ? 's' : ''} in the sheet now ${errors !== 1 ? 'have' : 'has'} problems (look at the preview), so nothing was created. Decline it and ask for a corrected sheet.`)
      if (!ok) return refuse(409, exists ? 'Every style in the sheet is already in this master order.' : 'There are no valid rows to create.')
      ;({ created, failed } = await createRows(analysis, { mo, buyer }))
    } else {
      for (const [i, it] of itemsOf(doc).entries()) {
        const label = it.product || `Style ${i + 1}`
        try {
          let made
          if (doc.kind === 'replen') {
            const src = await Order.findById(it.sourceOrderId).lean()
            if (!src || String(src.buyerId) !== String(doc.buyerId)) { failed.push({ row: i + 1, styleNumber: it.styleNumber, error: `${label}: the style it reorders no longer exists` }); continue }
            made = await createReplenFrom(src, { quantity: it.quantity, note: it.note, colourways: it.colours, ecommerceLink: it.ecommerceLink, techPackLink: it.techPackLink, delivery: it.delivery, masterOrderId: mo._id })
          } else {
            for (let attempt = 0; attempt < 4; attempt++) {
              const id = await nextStyleId(buyer.code, it.category, mo.season)
              made = await validateAndCreateOrder({
                id, buyerId: String(mo.buyerId), masterOrderId: mo._id, season: mo.season || undefined, phase: 'development',
                // The short form sends colours, quantity and delivery; requests from the earlier guided form carry the fuller shape.
                product: it.product, styleNumber: it.styleNumber, category: it.category, brand: it.brand, ...((it.totalQty ?? it.quantity) ? { totalQty: it.totalQty ?? it.quantity } : {}),
                colourways: it.colourways || (it.colours || []).map(name => ({ name })), fabricDetails: it.fabricDetails, ecommerceLink: it.ecommerceLink, techPackLink: it.techPackLink,
                photos: it.photos, delivery: it.delivery || undefined,
              })
              if (made.ok || made.error !== 'Order ID already exists') break
            }
          }
          if (!made.ok) { failed.push({ row: i + 1, styleNumber: it.styleNumber, error: `${label}: ${made.error}` }); continue }
          await fileOnto(doc, it, made.order._id)
          created.push({ row: i + 1, id: made.order._id, styleNumber: it.styleNumber, product: it.product })
        } catch (err) {
          console.error('[style requests approve item]', err)
          failed.push({ row: i + 1, styleNumber: it.styleNumber, error: `${label}: server error` })
        }
      }
    }
    if (!created.length) return refuse(409, failed[0]?.error || 'No style could be created.', { failed })
    await StyleRequest.updateOne({ _id: doc._id }, { $set: { status: 'approved', masterOrderId: mo._id, decidedBy: req.user.id, decidedAt: new Date(), createdOrderIds: created.map(c => c.id), failedCount: failed.length }, $unset: { data: 1 } })
    done = true
    const what = doc.kind === 'replen' ? `replen of ${dayLabel(created.length)}` : doc.kind === 'npd' ? `${dayLabel(created.length)} for New Product Development` : dayLabel(created.length)
    await AuditLog.create({ byUser: req.user.id, action: doc.kind === 'import' ? 'Style Import' : doc.kind === 'replen' ? 'Replen Ordered' : 'Order Created', detail: `${what} created under ${mo._id} (${created.map(c => c.id).join(', ')})${failed.length ? `, ${failed.length} failed` : ''}, requested by the customer and approved` })
    await notify([doc.requestedBy], { type: 'order', msg: `Your request was approved: ${what} added under ${mo.orderName}`, orderId: created[0].id })
    res.json({ approved: true, masterOrderId: mo._id, created, failed })
  } catch (err) {
    if (err instanceof ImportError) return refuse(409, err.message)
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
    const its = itemsOf(doc)
    const what = doc.kind === 'import' ? `Your request of ${doc.filename}` : doc.kind === 'npd' ? `Your New Product Development request (${dayLabel(its.length)})`
      : its.length === 1 ? `Your replen request for ${its[0].product}${its[0].styleNumber ? ` (${its[0].styleNumber})` : ''}` : `Your replen request (${dayLabel(its.length)})`
    await releaseFiles(doc)
    await AuditLog.create({ byUser: req.user.id, action: 'Style Request Declined', detail: `${doc.kind === 'import' ? doc.filename : `${doc.kind}: ${its.map(i => i.styleNumber || i.product).join(', ')}`}${reason ? `: ${reason}` : ''}` })
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
    await releaseFiles(doc)
    await AuditLog.create({ byUser: req.user.id, action: 'Style Request Cancelled', detail: doc.kind === 'import' ? doc.filename : `${doc.kind}: ${itemsOf(doc).map(i => i.styleNumber || i.product).join(', ')}` })
    res.json({ cancelled: true })
  } catch (err) { console.error('[style requests cancel]', err); fail(res, 500, 'Server error') }
})

export default router
