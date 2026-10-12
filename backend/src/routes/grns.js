// Goods received notes: what came in from a supplier, checked against its purchase order, with the photos
// that prove it. Posting a GRN is what adds to stock (lib/inventory/grn.js).
//
// Private to the company: every query is scoped by the caller's own organization (taken from the session),
// brands and Tradio staff cannot use these routes (requireInventory), and a GRN that is not yours is a 404.
import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { Grn, PurchaseOrder, Document, Attachment, Organization, AuditLog } from '../db/index.js'
import { requireAuth } from '../middleware/auth.js'
import { userKey } from '../lib/limiterKey.js'
import { requireInventory } from '../lib/procurement.js'
import { createGrn, prepareGrn, postGrn, acceptedOf, outstandingOf } from '../lib/inventory/grn.js'
import { renderGrnPdf } from '../lib/pdf/grn.js'
import { checkPhoto } from '../lib/imageUpload.js'
import { ATTACHMENT_KINDS } from '../models/Attachment.js'
import { poView } from './purchaseOrders.js'

const router = Router()
router.use(requireAuth, requireInventory)

const skipInTest = () => process.env.NODE_ENV === 'test'
const limiter = (max, message) => rateLimit({
  windowMs: 60 * 60 * 1000, max, keyGenerator: userKey, skip: skipInTest, message: { error: message },
  standardHeaders: true, legacyHeaders: false, validate: false,
})
const writeLimiter = limiter(400, 'Too many changes. Please wait.')
const postLimiter = limiter(120, 'Too many goods received notes posted. Please wait.')
const photoLimiter = limiter(240, 'Too many photos. Please wait.')

const OBJECT_ID = /^[a-f0-9]{24}$/
const MAX_PHOTOS = 12
const mine = req => ({ ownerOrgId: req.user.orgId })
const fail = (res, status, error, extra = {}) => res.status(status).json({ error, ...extra })
const idOk = (req, res, key = 'id') => {
  if (!OBJECT_ID.test(req.params[key] || '')) { fail(res, 404, key === 'id' ? 'Goods received note not found' : 'Photo not found'); return false }
  return true
}

const lineView = l => ({
  lineId: l.lineId, poLineId: l.poLineId || null, description: l.description, itemId: l.itemId ? String(l.itemId) : null, unit: l.unit || 'pcs',
  orderedQty: l.orderedQty ?? null, qty: l.qty || 0, rejectedQty: l.rejectedQty || 0, rejectReason: l.rejectReason || '',
  acceptedQty: acceptedOf(l), rate: l.rate || 0, lot: l.lot || '', note: l.note || '',
})

export const grnView = (g, extra = {}) => ({
  id: String(g._id), number: g.number || null, status: g.status, source: g.source, poId: g.poId || null,
  supplierId: g.supplierId ? String(g.supplierId) : null, supplierName: g.supplierName || '', supplierGstin: g.supplierGstin || '',
  challanNo: g.challanNo || '', challanDate: g.challanDate || null, vehicleNo: g.vehicleNo || '', receivedOn: g.receivedOn || null,
  note: g.note || '', lines: (g.lines || []).map(lineView), hasPdf: !!g.documentId,
  postedAt: g.postedAt || null, createdAt: g.createdAt, updatedAt: g.updatedAt, ...extra,
})

const summaryView = (g, photos = 0) => ({
  id: String(g._id), number: g.number || null, status: g.status, source: g.source, poId: g.poId || null, supplierName: g.supplierName || '',
  challanNo: g.challanNo || '', receivedOn: g.receivedOn || null, lineCount: (g.lines || []).length,
  preview: (g.lines || []).slice(0, 2).map(l => l.description), photoCount: photos, postedAt: g.postedAt || null, createdAt: g.createdAt,
})

const photoView = a => ({ id: String(a._id), kind: a.kind, name: a.name || '', caption: a.caption || '', mimeType: a.mimeType, size: a.size || 0, createdAt: a.createdAt })

/** What the purchase order still waits for on each line, so the person sees "100 ordered, 60 already in, 40 to come". */
async function poContext(req, poId) {
  if (!poId) return null
  const po = await PurchaseOrder.findOne({ _id: poId, ...mine(req) }, 'status supplierSnapshot lines.lineId lines.description lines.qty lines.receivedQty lines.unit').lean()
  if (!po) return null
  return { id: po._id, status: po.status, supplierName: po.supplierSnapshot?.name || '', lines: po.lines.map(l => ({ lineId: l.lineId, description: l.description, unit: l.unit, ordered: l.qty, received: l.receivedQty || 0, outstanding: outstandingOf(l) })) }
}

// GET /api/grns - the company's goods received notes, newest first. ?status= ?poId=
router.get('/', async (req, res) => {
  try {
    const filter = { ...mine(req) }
    if (['draft', 'posting', 'posted'].includes(req.query.status)) filter.status = req.query.status
    if (typeof req.query.poId === 'string' && req.query.poId) filter.poId = req.query.poId
    const grns = await Grn.find(filter, '-extraction').sort({ createdAt: -1 }).limit(300).lean()
    const counts = grns.length ? await Attachment.aggregate([
      { $match: { ownerOrgId: grns[0].ownerOrgId, refType: 'grn', refId: { $in: grns.map(g => String(g._id)) } } },
      { $group: { _id: '$refId', n: { $sum: 1 } } },
    ]) : []
    const byId = new Map(counts.map(c => [c._id, c.n]))
    res.json(grns.map(g => summaryView(g, byId.get(String(g._id)) || 0)))
  } catch (err) { console.error('[grn]', err); fail(res, 500, 'Server error') }
})

// POST /api/grns - start a note ({ poId?, lines?, ... }); { post: true } posts it in the same step
router.post('/', writeLimiter, async (req, res) => {
  try {
    const made = await createGrn(req, req.body, { source: 'web' })
    if (!made.ok) return fail(res, made.status, made.error)
    await AuditLog.create({ byUser: req.user.id, action: 'Goods Received Note Drafted', detail: `A goods received note${made.grn.poId ? ` against ${made.grn.poId}` : ''} was started by ${req.user.name}` }).catch(() => {})
    if (req.body?.post === true) {
      const posted = await postGrn(req, made.grn._id)
      if (!posted.ok) return fail(res, posted.status, posted.error, { grnId: String(made.grn._id) })
      return res.status(201).json(grnView(posted.grn, { po: posted.po ? poView(posted.po) : null, notice: posted.notice }))
    }
    res.status(201).json(grnView(made.grn, { po: await poContext(req, made.grn.poId) }))
  } catch (err) { console.error('[grn]', err); fail(res, 500, 'Server error') }
})

// GET /api/grns/:id
router.get('/:id', async (req, res) => {
  try {
    if (!idOk(req, res)) return
    const g = await Grn.findOne({ _id: req.params.id, ...mine(req) }, '-extraction').lean()
    if (!g) return fail(res, 404, 'Goods received note not found')
    const photos = await Attachment.find({ ownerOrgId: req.user.orgId, refType: 'grn', refId: String(g._id) }, '-dataUrl').sort({ createdAt: 1 }).lean()
    res.json(grnView(g, { po: await poContext(req, g.poId), photos: photos.map(photoView) }))
  } catch (err) { console.error('[grn]', err); fail(res, 500, 'Server error') }
})

// POST /api/grns/:id - change a draft (only the fields sent; sent lines replace the lines)
router.post('/:id', writeLimiter, async (req, res) => {
  try {
    if (!idOk(req, res)) return
    const existing = await Grn.findOne({ _id: req.params.id, ...mine(req) }).lean()
    if (!existing) return fail(res, 404, 'Goods received note not found')
    if (existing.status !== 'draft') return fail(res, 409, existing.status === 'posted' ? 'A posted goods received note cannot be edited' : 'This note is being posted')
    const p = await prepareGrn(req, req.body, existing)
    if (!p.ok) return fail(res, p.status, p.error)
    const g = await Grn.findOneAndUpdate({ _id: existing._id, ...mine(req), status: 'draft' }, { $set: p.data }, { new: true, projection: '-extraction' }).lean()
    if (!g) return fail(res, 409, 'This note changed while you were editing. Reload it and try again')
    res.json(grnView(g, { po: await poContext(req, g.poId) }))
  } catch (err) { console.error('[grn]', err); fail(res, 500, 'Server error') }
})

// POST /api/grns/:id/delete - throw a draft away (a posted note is a record and stays)
router.post('/:id/delete', writeLimiter, async (req, res) => {
  try {
    if (!idOk(req, res)) return
    const own = await Grn.findOne({ _id: req.params.id, ...mine(req) }, 'status').lean()
    if (!own) return fail(res, 404, 'Goods received note not found')
    if (own.status !== 'draft') return fail(res, 409, 'Only a draft can be deleted')
    const r = await Grn.deleteOne({ _id: own._id, ...mine(req), status: 'draft' })
    if (r.deletedCount === 0) return fail(res, 409, 'This note changed. Reload it and try again')
    await Attachment.deleteMany({ ownerOrgId: req.user.orgId, refType: 'grn', refId: String(own._id) })
    res.json({ ok: true })
  } catch (err) { console.error('[grn]', err); fail(res, 500, 'Server error') }
})

// POST /api/grns/:id/post - the goods are in: stock goes up, the PO moves on, the PDF is kept
router.post('/:id/post', postLimiter, async (req, res) => {
  try {
    if (!idOk(req, res)) return
    const r = await postGrn(req, req.params.id)
    if (!r.ok) return fail(res, r.status, r.error)
    res.json(grnView(r.grn, { po: r.po ? poView(r.po) : null, notice: r.notice }))
  } catch (err) { console.error('[grn]', err); fail(res, 500, 'The note could not be posted. Try again: nothing is lost and it will carry on from where it stopped') }
})

// GET /api/grns/:id/pdf - { fileName, mimeType, dataUrl }: the posted PDF, or a preview of a draft
router.get('/:id/pdf', async (req, res) => {
  try {
    if (!idOk(req, res)) return
    const g = await Grn.findOne({ _id: req.params.id, ...mine(req) }).lean()
    if (!g) return fail(res, 404, 'Goods received note not found')
    let buf
    if (g.documentId) {
      const d = await Document.findOne({ _id: g.documentId, grnId: String(g._id) }, 'dataUrl').lean()
      if (d?.dataUrl) buf = Buffer.from(d.dataUrl.split(',')[1] || '', 'base64')
    }
    if (!buf) buf = await renderGrnPdf(g, await Organization.findById(req.user.orgId).lean(), { receivedBy: req.user.name, poNumber: g.poId })
    res.json({ fileName: `${g.number || 'goods-received-note-draft'}.pdf`, mimeType: 'application/pdf', dataUrl: `data:application/pdf;base64,${buf.toString('base64')}` })
  } catch (err) { console.error('[grn]', err); fail(res, 500, 'Server error') }
})

// ── Photos ──

// GET /api/grns/:id/photos
router.get('/:id/photos', async (req, res) => {
  try {
    if (!idOk(req, res)) return
    if (!await Grn.exists({ _id: req.params.id, ...mine(req) })) return fail(res, 404, 'Goods received note not found')
    const photos = await Attachment.find({ ownerOrgId: req.user.orgId, refType: 'grn', refId: req.params.id }, '-dataUrl').sort({ createdAt: 1 }).lean()
    res.json(photos.map(photoView))
  } catch (err) { console.error('[grn]', err); fail(res, 500, 'Server error') }
})

// POST /api/grns/:id/photos { dataUrl, kind?, name?, caption? } - a photo of the challan, the goods or damage
router.post('/:id/photos', photoLimiter, async (req, res) => {
  try {
    if (!idOk(req, res)) return
    const g = await Grn.findOne({ _id: req.params.id, ...mine(req) }, 'status').lean()
    if (!g) return fail(res, 404, 'Goods received note not found')
    const checked = checkPhoto(req.body?.dataUrl, req.body?.mimeType)
    if (!checked.ok) return fail(res, 400, checked.error)
    const kind = ATTACHMENT_KINDS.includes(req.body?.kind) ? req.body.kind : 'other'
    const have = await Attachment.countDocuments({ ownerOrgId: req.user.orgId, refType: 'grn', refId: req.params.id })
    if (have >= MAX_PHOTOS) return fail(res, 400, `A goods received note can have at most ${MAX_PHOTOS} photos`)
    const a = await Attachment.create({
      ownerOrgId: req.user.orgId, refType: 'grn', refId: req.params.id, kind,
      name: typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 200) : '',
      caption: typeof req.body?.caption === 'string' ? req.body.caption.trim().slice(0, 300) : '',
      mimeType: checked.mimeType, size: checked.size, dataUrl: req.body.dataUrl, uploadedBy: req.user.actorId,
    })
    res.status(201).json(photoView(a.toObject()))
  } catch (err) { console.error('[grn]', err); fail(res, 500, 'Server error') }
})

// GET /api/grns/:id/photos/:photoId - { id, mimeType, name, dataUrl }
router.get('/:id/photos/:photoId', async (req, res) => {
  try {
    if (!idOk(req, res) || !idOk(req, res, 'photoId')) return
    const a = await Attachment.findOne({ _id: req.params.photoId, ownerOrgId: req.user.orgId, refType: 'grn', refId: req.params.id }).lean()
    if (!a) return fail(res, 404, 'Photo not found')
    res.json({ ...photoView(a), dataUrl: a.dataUrl })
  } catch (err) { console.error('[grn]', err); fail(res, 500, 'Server error') }
})

// POST /api/grns/:id/photos/:photoId/delete - only while the note is a draft: a posted note's evidence stays
router.post('/:id/photos/:photoId/delete', writeLimiter, async (req, res) => {
  try {
    if (!idOk(req, res) || !idOk(req, res, 'photoId')) return
    const g = await Grn.findOne({ _id: req.params.id, ...mine(req) }, 'status').lean()
    if (!g) return fail(res, 404, 'Goods received note not found')
    if (g.status !== 'draft') return fail(res, 409, 'The photos of a posted goods received note are kept as evidence')
    const r = await Attachment.deleteOne({ _id: req.params.photoId, ownerOrgId: req.user.orgId, refType: 'grn', refId: req.params.id })
    if (r.deletedCount === 0) return fail(res, 404, 'Photo not found')
    res.json({ ok: true })
  } catch (err) { console.error('[grn]', err); fail(res, 500, 'Server error') }
})

export default router
