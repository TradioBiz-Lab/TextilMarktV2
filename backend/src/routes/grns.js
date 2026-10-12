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
import { checkDocumentFile } from '../lib/imageUpload.js'
import { mountPhotoRoutes, photoView } from '../lib/photoRoutes.js'
import { draftFromDocument } from '../lib/inventory/ingest.js'
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
const scanLimiter = limiter(40, 'Too many documents read. Please wait.')

const OBJECT_ID = /^[a-f0-9]{24}$/
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
  read: g.extraction ? { confidence: g.extraction.confidence ?? null, docType: g.extraction.docType || null, matchReason: g.extraction.matchReason || null, warnings: g.extraction.warnings || [] } : null,
  postedAt: g.postedAt || null, createdAt: g.createdAt, updatedAt: g.updatedAt, ...extra,
})

const summaryView = (g, photos = 0) => ({
  id: String(g._id), number: g.number || null, status: g.status, source: g.source, poId: g.poId || null, supplierName: g.supplierName || '',
  challanNo: g.challanNo || '', receivedOn: g.receivedOn || null, lineCount: (g.lines || []).length,
  preview: (g.lines || []).slice(0, 2).map(l => l.description), photoCount: photos, postedAt: g.postedAt || null, createdAt: g.createdAt,
})

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
    const grns = await Grn.find(filter, '-extraction.printed').sort({ createdAt: -1 }).limit(300).lean()
    const counts = grns.length ? await Attachment.aggregate([
      { $match: { ownerOrgId: grns[0].ownerOrgId, refType: 'grn', refId: { $in: grns.map(g => String(g._id)) } } },
      { $group: { _id: '$refId', n: { $sum: 1 } } },
    ]) : []
    const byId = new Map(counts.map(c => [c._id, c.n]))
    res.json(grns.map(g => summaryView(g, byId.get(String(g._id)) || 0)))
  } catch (err) { console.error('[grn]', err); fail(res, 500, 'Server error') }
})

// POST /api/grns/scan { dataUrl } - a photo or PDF of the supplier's challan or invoice: it is read and a DRAFT note is made
// from it (matched to a purchase order when it can be). Nothing is posted: the factory checks the draft first.
router.post('/scan', scanLimiter, async (req, res) => {
  try {
    const file = checkDocumentFile(req.body?.dataUrl)
    if (!file.ok) return fail(res, 400, file.error)
    const made = await draftFromDocument(req, { buffer: file.buffer, mimeType: file.mimeType, source: 'ai_review', photoDataUrl: file.mimeType.startsWith('image/') ? req.body.dataUrl : null })
    if (!made.ok) return fail(res, made.status, made.error)
    await AuditLog.create({ byUser: req.user.id, action: 'Goods Received Note Read From A Document', detail: `A draft goods received note was read from a document by ${req.user.name}` }).catch(() => {})
    const photos = await Attachment.find({ ownerOrgId: req.user.orgId, refType: 'grn', refId: String(made.grn._id) }, '-dataUrl').lean()
    res.status(201).json(grnView(made.grn, { po: await poContext(req, made.grn.poId), photos: photos.map(photoView), warnings: made.warnings }))
  } catch (err) { console.error('[grn scan]', err); fail(res, 500, 'The document could not be read. Try again') }
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
    const g = await Grn.findOne({ _id: req.params.id, ...mine(req) }, '-extraction.printed').lean()
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
    const g = await Grn.findOneAndUpdate({ _id: existing._id, ...mine(req), status: 'draft' }, { $set: p.data }, { new: true, projection: '-extraction.printed' }).lean()
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

// ── Photos ── (lib/photoRoutes.js: the same five routes as a job work challan's)
mountPhotoRoutes(router, {
  refType: 'grn', writeLimiter, photoLimiter, notFound: 'Goods received note not found',
  owned: req => Grn.findOne({ _id: req.params.id, ...mine(req) }, 'status').lean(),
  removable: g => g.status === 'draft', removeRefused: 'The photos of a posted goods received note are kept as evidence',
})

export default router
