import { Router } from 'express'
import mongoose from 'mongoose'
import rateLimit from 'express-rate-limit'
import { MeasurementSession, Order, Document, AuditLog } from '../db/index.js'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import { COORDINATOR_ROLE } from '../lib/coordinator.js'
import { saveFile, loadFile, fromDataUrl, fileStoreProblem } from '../lib/fileStore.js'
import { notify, adminIds } from '../lib/notify.js'
import { dayIST } from '../lib/geo.js'
import { extractMeasurements } from '../lib/ai/extract.js'
import { readMeasurementWorkbook, writeMeasuredWorkbook, judge, MEASURE_STAGES, STAGE_NAMES } from '../lib/measurementSheet.js'

// The quality module: a garment measured against the style's own measurement sheet. The person picks the stage and the
// size, reads the measurements aloud or types them, and gets a copy of the sheet with the values filled in. Tradio, the
// factory making the style and a coordinator allocated to that factory may record; the customer sees a record once a
// Tradio admin has shared it.
const router = Router()
router.use(requireAuth)

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const LABEL_OF = { fit: 'fit_approval', pp: 'pp_approval', final: 'final_qc' }
const serverError = (res, err) => { console.error('[measurements]', err); res.status(500).json({ error: 'Server error' }) }
const isId = v => typeof v === 'string' && mongoose.Types.ObjectId.isValid(v)
const limiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 120, keyGenerator: req => req.user?.id || req.ip, message: { error: 'Too many requests. Please wait a little.' }, standardHeaders: true, legacyHeaders: false, validate: false, skip: () => process.env.NODE_ENV === 'test' })

// Tests swap the reader in; a server with no AI key says so and the values are typed instead.
let extractor = null
export function setMeasurementExtractor(fn) { extractor = fn }
const aiAvailable = () => !!extractor || (!!process.env.ANTHROPIC_API_KEY && process.env.NODE_ENV !== 'test')

const splitIds = o => (o.assignments || []).map(a => String(a.mfrId?._id ?? a.mfrId))
// The factories of this style a user may record at: Tradio any, a factory its own, a coordinator those allocated to him.
const recordableAt = (user, order) => (user.role === 'admin' ? splitIds(order)
  : user.role === 'manufacturer' ? splitIds(order).filter(id => id === String(user.id))
  : user.role === COORDINATOR_ROLE ? splitIds(order).filter(id => user.factoryIds.includes(id)) : [])
const maySee = (user, order) => (user.role === 'buyer' ? String(order.buyerId?._id ?? order.buyerId) === String(user.id) : recordableAt(user, order).length > 0)

const isXlsx = d => /\.xlsx$/i.test(d.fileName || '') || d.mimeType === XLSX
// The sheet the style is measured against, among those the module did not make: its Locked Measurement when that is an
// Excel file, else its newest Excel sheet (a locked PDF cannot be read here, and the style often has the Excel too).
// With no Excel at all the locked or newest sheet is returned, so the page can say why it cannot be read.
async function sheetOf(orderId) {
  const docs = await Document.find({ orderId, type: 'measurements', isActive: true, measurementSessionId: null }, '-dataUrl').sort({ createdAt: -1 }).lean()
  const excel = docs.filter(isXlsx)
  return excel.find(d => d.locked) || excel[0] || docs.find(d => d.locked) || docs[0] || null
}
async function bytesOf(docId, req) {
  const doc = await Document.findById(docId).lean()
  const f = doc ? fromDataUrl(await loadFile(doc, { req })) : null
  return f?.buffer || null
}
async function specFor(orderId, req) {
  const doc = await sheetOf(orderId)
  if (!doc) return { status: 404, error: 'This style has no measurement sheet yet. Upload one on the style first.' }
  if (!isXlsx(doc)) return { status: 422, error: 'The measurement sheet of this style is not an Excel file (.xlsx), so it cannot be read here yet.' }
  const buffer = await bytesOf(doc._id, req)
  if (!buffer) return { status: 422, error: 'The measurement sheet of this style is a link, not a file, so it cannot be read here.' }
  const read = await readMeasurementWorkbook(buffer)
  if (read.error) return { status: 422, error: read.error }
  return { doc, buffer, tabs: read.tabs }
}

const sessionOut = s => ({
  id: String(s._id), orderId: s.orderId, mfrId: String(s.mfrId), stage: s.stage, stageName: STAGE_NAMES[s.stage], size: s.size,
  byName: s.byName, byRole: s.byRole, method: s.method, at: s.at, measuredCount: s.measuredCount, outOfTolerance: s.outOfTolerance,
  points: s.points, documentId: s.resultDocumentId ? String(s.resultDocumentId) : null, released: !!s.releasedAt,
})

// GET /api/measurements/spec?orderId= - the style's measurement sheet as data: its tabs, sizes and points.
router.get('/spec', async (req, res) => {
  try {
    const order = await Order.findById(String(req.query.orderId || ''), 'buyerId product styleNumber assignments.mfrId').populate('assignments.mfrId', 'company').lean()
    if (!order) return res.status(404).json({ error: 'Order not found' })
    if (!maySee(req.user, order)) return res.status(403).json({ error: 'Forbidden' })
    const spec = await specFor(order._id, req)
    if (spec.error) return res.status(spec.status).json({ error: spec.error })
    const mine = recordableAt(req.user, order)
    res.json({
      document: { id: String(spec.doc._id), name: spec.doc.name, fileName: spec.doc.fileName || '', locked: !!spec.doc.locked },
      tabs: spec.tabs.map(t => ({ name: t.name, stage: t.stage, sizes: t.sizes, sampleSize: t.sampleSize, unit: t.unit, points: t.points.map(p => ({ name: p.name, tol: p.tol, values: p.values })) })),
      factories: (order.assignments || []).filter(a => mine.includes(String(a.mfrId?._id ?? a.mfrId))).map(a => ({ id: String(a.mfrId._id), name: a.mfrId.company })),
      canRead: aiAvailable(),
    })
  } catch (err) { serverError(res, err) }
})

// POST /api/measurements/read { orderId, tab, size, transcript } - what he said, as numbers against the sheet's points.
// Nothing is saved: the page shows the result for him to check.
router.post('/read', limiter, async (req, res) => {
  try {
    const { orderId, tab, size, transcript } = req.body || {}
    if (typeof transcript !== 'string' || !transcript.trim()) return res.status(400).json({ error: 'Nothing was heard. Record again.' })
    if (transcript.length > 8000) return res.status(400).json({ error: 'That recording is too long. Record it in two parts.' })
    const order = await Order.findById(String(orderId || ''), 'buyerId assignments.mfrId').lean()
    if (!order) return res.status(404).json({ error: 'Order not found' })
    if (!recordableAt(req.user, order).length) return res.status(403).json({ error: 'You cannot record measurements on this style' })
    if (!aiAvailable()) return res.status(503).json({ error: 'The voice reader is not set up on this server. Type the values instead.', code: 'READER_OFF' })
    const spec = await specFor(order._id, req)
    if (spec.error) return res.status(spec.status).json({ error: spec.error })
    const t = spec.tabs.find(x => x.name === tab); const S = String(size || '').toUpperCase()
    if (!t || !t.sizes.includes(S)) return res.status(400).json({ error: 'Choose a tab and a size from the sheet' })
    const out = await (extractor || extractMeasurements)(transcript, t.points.map(p => ({ name: p.name, spec: p.values[S] ?? null })), { unit: t.unit })
    if (!out) return res.status(502).json({ error: 'The recording could not be read. Record again or type the values.' })
    // One value per point, the last one said; an index that is not on the sheet is dropped.
    const byIndex = new Map()
    for (const v of out.values || []) if (Number.isInteger(v.index) && v.index >= 0 && v.index < t.points.length && Number.isFinite(v.value)) byIndex.set(v.index, { index: v.index, value: Math.round(v.value * 1000) / 1000, heard: v.heard || '' })
    res.json({ values: [...byIndex.values()].sort((a, b) => a.index - b.index), unmatched: (out.unmatched || []).map(u => ({ heard: u.heard, value: Number.isFinite(u.value) ? u.value : null })) })
  } catch (err) { serverError(res, err) }
})

// POST /api/measurements { orderId, mfrId, stage, size, tab, points: [{ index, measured }], transcript?, method? }
// Saves the session and makes the workbook. Every difference is worked out here, never taken from the page.
router.post('/', limiter, async (req, res) => {
  try {
    const { orderId, mfrId, stage, tab, transcript, method } = req.body || {}
    const S = String(req.body?.size || '').toUpperCase()
    if (!MEASURE_STAGES.includes(stage)) return res.status(400).json({ error: 'Choose the stage: fit sample, PP sample or final QC' })
    if (!isId(mfrId)) return res.status(400).json({ error: 'Choose the factory' })
    if (!Array.isArray(req.body?.points)) return res.status(400).json({ error: 'Send the measurements' })
    const order = await Order.findById(String(orderId || ''), 'buyerId product styleNumber assignments.mfrId').lean()
    if (!order) return res.status(404).json({ error: 'Order not found' })
    if (!recordableAt(req.user, order).includes(mfrId)) return res.status(403).json({ error: 'You cannot record measurements for that factory on this style' })
    const spec = await specFor(order._id, req)
    if (spec.error) return res.status(spec.status).json({ error: spec.error })
    const t = spec.tabs.find(x => x.name === tab)
    if (!t || !t.sizes.includes(S)) return res.status(400).json({ error: 'Choose a tab and a size from the sheet' })
    const given = new Map()
    for (const p of req.body.points) {
      if (!Number.isInteger(p?.index) || p.index < 0 || p.index >= t.points.length) return res.status(400).json({ error: 'A measurement does not belong to this sheet' })
      if (p.measured === null || p.measured === undefined || p.measured === '') continue
      if (typeof p.measured !== 'number' || !Number.isFinite(p.measured) || p.measured < 0 || p.measured > 1000) return res.status(400).json({ error: `The value for "${t.points[p.index].name}" is not a measurement` })
      given.set(p.index, Math.round(p.measured * 1000) / 1000)
    }
    if (!given.size) return res.status(400).json({ error: 'Nothing was measured yet' })
    const problem = fileStoreProblem()
    if (problem) { console.error('[measurements]', problem); return res.status(503).json({ error: 'The sheet cannot be saved right now. Tell Tradio.' }) }

    const points = t.points.map((p, i) => { const spec0 = p.values[S] ?? null; const measured = given.has(i) ? given.get(i) : null; return { row: p.row, name: p.name, spec: spec0, tol: p.tol, measured, ...judge(spec0, p.tol, measured) } })
    const now = new Date()
    // The copy builds on the last one made for this style, so one workbook gathers every size and stage measured so far.
    const last = await MeasurementSession.findOne({ orderId: order._id, sourceDocumentId: spec.doc._id, resultDocumentId: { $ne: null } }).sort({ at: -1 }).lean()
    const base = (last && await bytesOf(last.resultDocumentId, req)) || spec.buffer
    const made = await writeMeasuredWorkbook(base, {
      tab: t.name, size: S, stage, points, intoTab: t.stage === stage, who: req.user.name, styleName: order.product,
      when: now.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }),
    })
    const sessionId = new mongoose.Types.ObjectId(); const docId = new mongoose.Types.ObjectId()
    const safe = String(order.styleNumber || order.product || order._id).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'style'
    const name = `${order.product} - ${STAGE_NAMES[stage]} measured (${S})`
    const kept = await saveFile(`measurements/${dayIST(now).slice(0, 4)}/${dayIST(now).slice(5, 7)}/${order._id}/${docId}.xlsx`, made.buffer, XLSX, { req })
    await Document.create({
      _id: docId, type: 'measurements', measurementLabel: LABEL_OF[stage], name, orderId: order._id, mfrId, uploadedBy: req.user.id, issuer: 'Measured on TextilMarkt',
      issueDate: now, internal: true, isActive: true, measurementSessionId: sessionId, ...kept, fileName: `${safe}-${stage}-${S}-${dayIST(now)}.xlsx`, fileSize: made.buffer.length, mimeType: XLSX,
    })
    const out = points.filter(p => p.ok === false).length
    const session = await MeasurementSession.create({
      _id: sessionId, orderId: order._id, mfrId, by: req.user.id, byName: req.user.name, byRole: req.user.role, stage, size: S, sourceDocumentId: spec.doc._id, sourceTab: t.name,
      method: method === 'voice' ? 'voice' : 'typed', transcript: typeof transcript === 'string' ? transcript.slice(0, 8000) : '',
      points: points.map(({ row, ...p }) => p), measuredCount: given.size, outOfTolerance: out, resultDocumentId: docId, at: now,
    })
    await AuditLog.create({ byUser: req.user.id, action: 'Measurement Recorded', detail: `${order._id}: ${STAGE_NAMES[stage]}, size ${S}, ${given.size} of ${points.length} points, ${out} outside tolerance (by ${req.user.name})` })
    await notify(await adminIds(), { type: 'order', msg: `${req.user.name} measured ${order.product} (${STAGE_NAMES[stage]}, size ${S}): ${out ? `${out} point${out === 1 ? '' : 's'} outside tolerance` : 'all within tolerance'}`, orderId: order._id }, { exceptUserId: req.user.id })
    res.status(201).json({ session: sessionOut(session.toObject()), documentId: String(docId), fileName: `${safe}-${stage}-${S}-${dayIST(now)}.xlsx`, wroteTab: made.wroteTab })
  } catch (err) { serverError(res, err) }
})

// GET /api/measurements?orderId= - the sessions recorded on a style, newest first.
router.get('/', async (req, res) => {
  try {
    const order = await Order.findById(String(req.query.orderId || ''), 'buyerId assignments.mfrId').lean()
    if (!order) return res.status(404).json({ error: 'Order not found' })
    if (!maySee(req.user, order)) return res.status(403).json({ error: 'Forbidden' })
    const filter = { orderId: order._id }
    if (req.user.role === 'buyer') filter.releasedAt = { $ne: null }
    else if (req.user.role !== 'admin') filter.mfrId = { $in: recordableAt(req.user, order) }
    res.json((await MeasurementSession.find(filter).sort({ at: -1 }).limit(100).lean()).map(sessionOut))
  } catch (err) { serverError(res, err) }
})

// POST /api/measurements/:id/release - a Tradio admin shows the record, and its workbook, to the customer.
router.post('/:id/release', requireAdmin, async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ error: 'Not found' })
    const s = await MeasurementSession.findById(req.params.id)
    if (!s) return res.status(404).json({ error: 'Not found' })
    const first = !s.releasedAt
    if (s.resultDocumentId) await Document.updateOne({ _id: s.resultDocumentId }, { $set: { internal: false } })
    s.releasedAt = s.releasedAt || new Date(); s.releasedBy = req.user.id; await s.save()
    if (first) {
      const order = await Order.findById(s.orderId, 'buyerId product').lean()
      await AuditLog.create({ byUser: req.user.id, action: 'Measurement Released', detail: `${s.orderId}: ${STAGE_NAMES[s.stage]}, size ${s.size} shown to the customer (by ${req.user.name})` })
      if (order?.buyerId) await notify([order.buyerId], { type: 'order', msg: `Tradio shared the ${STAGE_NAMES[s.stage]} measurements of ${order.product} (size ${s.size})`, orderId: s.orderId }, { exceptUserId: req.user.id })
    }
    res.json(sessionOut(s.toObject()))
  } catch (err) { serverError(res, err) }
})

export default router
