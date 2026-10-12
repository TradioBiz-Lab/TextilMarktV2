// Goods a factory has sent to its job workers (dyers, printers, embroiderers) and what has come back.
//
// Private to the company: every query is scoped by the caller's own organization (taken from the session), brands and Tradio
// staff cannot use these routes (requireInventory), and another company's challan is a 404. The work is in
// lib/inventory/jobwork.js.
import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { JobWork, Document } from '../db/index.js'
import { requireAuth } from '../middleware/auth.js'
import { userKey } from '../lib/limiterKey.js'
import { requireInventory } from '../lib/procurement.js'
import { sendJobWork, returnJobWork, closeJobWork, cancelJobWork, outstandingByJobWorker, jobView, jobSummary } from '../lib/inventory/jobwork.js'
import { mountPhotoRoutes } from '../lib/photoRoutes.js'
import { renderJobworkChallanPdf } from '../lib/pdf/jobwork.js'

const router = Router()
router.use(requireAuth, requireInventory)

const skipInTest = () => process.env.NODE_ENV === 'test'
const limiter = (max, message) => rateLimit({
  windowMs: 60 * 60 * 1000, max, keyGenerator: userKey, skip: skipInTest, message: { error: message },
  standardHeaders: true, legacyHeaders: false, validate: false,
})
const writeLimiter = limiter(300, 'Too many changes. Please wait.')
const photoLimiter = limiter(240, 'Too many photos. Please wait.')

const OBJECT_ID = /^[a-f0-9]{24}$/
const mine = req => ({ ownerOrgId: req.user.orgId })
const fail = (res, status, error) => res.status(status).json({ error })
const idOk = (req, res) => { if (!OBJECT_ID.test(req.params.id || '')) { fail(res, 404, 'Job work not found'); return false } return true }

// GET /api/jobwork - the company's challans, newest first. ?status= ?supplierId=
router.get('/', async (req, res) => {
  try {
    const filter = { ...mine(req) }
    if (['open', 'partially_returned', 'closed', 'cancelled'].includes(req.query.status)) filter.status = req.query.status
    if (req.query.open === '1') filter.status = { $in: ['open', 'partially_returned'] }
    if (typeof req.query.supplierId === 'string' && OBJECT_ID.test(req.query.supplierId)) filter.supplierId = req.query.supplierId
    const jobs = await JobWork.find(filter).sort({ createdAt: -1 }).limit(300).lean()
    res.json(jobs.map(jobSummary))
  } catch (err) { console.error('[jobwork]', err); fail(res, 500, 'Server error') }
})

// GET /api/jobwork/outstanding - every job worker with goods still out
router.get('/outstanding', async (req, res) => {
  try { res.json(await outstandingByJobWorker(req)) } catch (err) { console.error('[jobwork]', err); fail(res, 500, 'Server error') }
})

// POST /api/jobwork { supplierId, process, lines: [{ itemId, qty, rate? }], orderId?, sentOn?, expectedBack?, vehicleNo?, note? } - send goods
router.post('/', writeLimiter, async (req, res) => {
  try {
    const made = await sendJobWork(req, req.body)
    if (!made.ok) return fail(res, made.status, made.error)
    res.status(201).json(jobView(made.job))
  } catch (err) { console.error('[jobwork]', err); fail(res, 500, 'The goods could not be sent. Nothing has moved: try again') }
})

// GET /api/jobwork/:id
router.get('/:id', async (req, res) => {
  try {
    if (!idOk(req, res)) return
    const j = await JobWork.findOne({ _id: req.params.id, ...mine(req) }).lean()
    if (!j) return fail(res, 404, 'Job work not found')
    res.json(jobView(j))
  } catch (err) { console.error('[jobwork]', err); fail(res, 500, 'Server error') }
})

// POST /api/jobwork/:id/return { lines: [{ lineId, inputQty, outputs: [{ itemId? | description, unit?, qty }] }], note? } - goods came back
router.post('/:id/return', writeLimiter, async (req, res) => {
  try {
    if (!idOk(req, res)) return
    const r = await returnJobWork(req, req.params.id, req.body)
    if (!r.ok) return fail(res, r.status, r.error)
    res.json(jobView(r.job))
  } catch (err) { console.error('[jobwork]', err); fail(res, 500, 'The return could not be recorded. Open the challan and check what is still out') }
})

// POST /api/jobwork/:id/close { reason } - write off what is still out
router.post('/:id/close', writeLimiter, async (req, res) => {
  try {
    if (!idOk(req, res)) return
    const r = await closeJobWork(req, req.params.id, req.body?.reason)
    if (!r.ok) return fail(res, r.status, r.error)
    res.json(jobView(r.job))
  } catch (err) { console.error('[jobwork]', err); fail(res, 500, 'Server error') }
})

// POST /api/jobwork/:id/cancel { reason } - sent in error, before anything came back
router.post('/:id/cancel', writeLimiter, async (req, res) => {
  try {
    if (!idOk(req, res)) return
    const r = await cancelJobWork(req, req.params.id, req.body?.reason)
    if (!r.ok) return fail(res, r.status, r.error)
    res.json(jobView(r.job))
  } catch (err) { console.error('[jobwork]', err); fail(res, 500, 'Server error') }
})

// GET /api/jobwork/:id/pdf - { fileName, mimeType, dataUrl }: the challan as sent (a cancelled one is drawn again, marked cancelled)
router.get('/:id/pdf', async (req, res) => {
  try {
    if (!idOk(req, res)) return
    const j = await JobWork.findOne({ _id: req.params.id, ...mine(req) }).lean()
    if (!j) return fail(res, 404, 'Job work not found')
    let buf
    if (j.documentId && j.status !== 'cancelled') {
      const d = await Document.findOne({ _id: j.documentId, jobworkId: String(j._id) }, 'dataUrl').lean()
      if (d?.dataUrl) buf = Buffer.from(d.dataUrl.split(',')[1] || '', 'base64')
    }
    if (!buf) buf = await renderJobworkChallanPdf(j)
    res.json({ fileName: `${j.number}.pdf`, mimeType: 'application/pdf', dataUrl: `data:application/pdf;base64,${buf.toString('base64')}` })
  } catch (err) { console.error('[jobwork]', err); fail(res, 500, 'Server error') }
})

// Photos of the goods sent or back (lib/photoRoutes.js): they stay as evidence.
mountPhotoRoutes(router, {
  refType: 'jobwork', writeLimiter, photoLimiter, notFound: 'Job work not found',
  owned: req => JobWork.findOne({ _id: req.params.id, ...mine(req) }, 'status').lean(),
  removable: j => j.status === 'open', removeRefused: 'The photos of a job work challan are kept as evidence once goods have come back',
})

export default router
