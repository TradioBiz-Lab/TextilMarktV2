import { Router } from 'express'
import mongoose from 'mongoose'
import rateLimit from 'express-rate-limit'
import { FieldUpdate, FactoryVisit, Order, Document, User, AuditLog } from '../db/index.js'
import { requireAuth, requireAdmin, requireMaster } from '../middleware/auth.js'
import { checkStratus } from '../lib/stratusDriver.js'
import { COORDINATOR_ROLE } from '../lib/coordinator.js'
import { openVisitOf } from './visits.js'
import { validLatLng, isAway, mapsUrlFor, dayIST, startOfDayIST } from '../lib/geo.js'
import { saveFile, loadFile, fromDataUrl, fileStoreProblem, fileDriverName } from '../lib/fileStore.js'
import { notify, adminIds } from '../lib/notify.js'
import { extractFieldUpdate } from '../lib/ai/extract.js'
import { deriveStageStatus } from '../models/Order.js'

// Updates from the factory floor. A coordinator, checked in at a factory, posts on one step of one style: words (typed
// or spoken and transcribed), photos, a voice note. Nothing here changes the plan. An account manager (any admin)
// reads the update with the AI's suggestions and changes the step through the ordinary admin routes, then marks the
// update actioned. It is Tradio's own until an admin releases it to the customer.
const router = Router()
router.use(requireAuth)

const sendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 120,
  keyGenerator: req => req.user?.id || req.ip,
  message: { error: 'Too many updates. Please wait a little.' },
  standardHeaders: true, legacyHeaders: false, validate: false,
  skip: () => process.env.NODE_ENV === 'test',
})

const coordinatorOnly = (req, res, next) =>
  (req.user.role === COORDINATOR_ROLE ? next() : res.status(403).json({ error: 'Only a coordinator sends an update from the floor' }))
const serverError = (res, err) => { console.error('[field-updates]', err); res.status(500).json({ error: 'Server error' }) }
const isId = v => typeof v === 'string' && mongoose.Types.ObjectId.isValid(v)

export const MAX_PHOTOS = 6
export const MAX_PHOTO_BYTES = 1024 * 1024        // the phone shrinks a photo to about 150 KB before sending
export const MAX_AUDIO_BYTES = 3 * 1024 * 1024    // two minutes of speech is well under this
const PHOTO_MIME = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png' }
const AUDIO_MIME = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/wav': 'wav', 'audio/mpeg': 'mp3' }
const isJpeg = b => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
const isPng = b => b.length >= 4 && b[0] === 0x89 && b.subarray(1, 4).toString('latin1') === 'PNG'

/** One photo as sent (a data URL) -> { buffer, mimeType, ext } or { error }. The bytes must be what they claim to be. */
function readPhoto(dataUrl) {
  if (typeof dataUrl !== 'string') return { error: 'A photo did not arrive properly. Take it again.' }
  if (dataUrl.length > MAX_PHOTO_BYTES * 1.4 + 100) return { error: 'A photo is too large. Take it again.' }
  const f = fromDataUrl(dataUrl)
  if (!f || !PHOTO_MIME[f.mimeType]) return { error: 'Photos must be JPEG or PNG' }
  if (f.buffer.length === 0 || f.buffer.length > MAX_PHOTO_BYTES) return { error: 'A photo is too large. Take it again.' }
  const real = f.mimeType === 'image/png' ? isPng(f.buffer) : isJpeg(f.buffer)
  if (!real) return { error: 'A photo is not a real image file' }
  return { buffer: f.buffer, mimeType: f.mimeType === 'image/jpg' ? 'image/jpeg' : f.mimeType, ext: PHOTO_MIME[f.mimeType] }
}
function readAudio(dataUrl) {
  if (typeof dataUrl !== 'string') return { error: 'The voice note did not arrive properly. Record it again.' }
  if (dataUrl.length > MAX_AUDIO_BYTES * 1.4 + 100) return { error: 'The voice note is too long. Keep it under two minutes.' }
  const f = fromDataUrl(dataUrl)
  if (!f || !AUDIO_MIME[f.mimeType]) return { error: 'Unsupported voice note format' }
  if (f.buffer.length === 0 || f.buffer.length > MAX_AUDIO_BYTES) return { error: 'The voice note is too long. Keep it under two minutes.' }
  return { buffer: f.buffer, mimeType: f.mimeType, ext: AUDIO_MIME[f.mimeType] }
}

const stagesOf = (order, factoryId) => (order?.assignments || []).find(a => String(a.mfrId?._id ?? a.mfrId) === String(factoryId))?.stages || null

// ── What the API returns ──────────────────────────────────────────────────────────────────────────────────────────
const fileOut = d => ({ id: String(d._id), name: d.name, kind: String(d.mimeType || '').startsWith('audio/') ? 'audio' : 'photo', mimeType: d.mimeType, internal: !!d.internal })

function updateOut(u, { docs = [], order = null, visit = null, now = Date.now() } = {}) {
  const hasPlace = u.lat != null && u.lng != null
  return {
    id: String(u._id),
    coordinatorId: String(u.coordinatorId?._id ?? u.coordinatorId), coordinatorName: u.coordinatorId?.name ?? null,
    factoryId: String(u.factoryId?._id ?? u.factoryId), factoryName: u.factoryId?.company ?? null,
    orderId: u.orderId, product: order?.product ?? null, styleNumber: order?.styleNumber ?? '',
    buyerId: u.buyerId ? String(u.buyerId) : null, buyerCompany: order?.buyerId?.company ?? null,
    stageIndex: u.stageIndex, stageName: u.stageName, movedFromStageIndex: u.movedFromStageIndex ?? null,
    text: u.text || '', viaVoice: !!u.viaVoice,
    at: u.at, deviceAt: u.deviceAt || null,
    place: hasPlace ? { lat: u.lat, lng: u.lng, accuracy: u.accuracy ?? null, mapsUrl: mapsUrlFor(u.lat, u.lng) } : null,
    // Whether he was at the factory when he checked in for this visit (the visit's own measure).
    visitAway: visit?.checkIn ? isAway(visit.checkIn) : null,
    files: docs.map(fileOut),
    ai: {
      state: u.ai?.state || 'off', summary: u.ai?.summary || '',
      suggestedStageIndex: u.ai?.suggestedStageIndex ?? null, units: u.ai?.units ?? null,
      statusHint: u.ai?.statusHint ?? null, result: u.ai?.result ?? null,
      issues: u.ai?.issues || [], colours: (u.ai?.colours || []).map(c => ({ name: c.name, note: c.note || '' })),
      confidence: u.ai?.confidence ?? null,
    },
    state: u.state, applied: u.applied || [], actionedAt: u.actionedAt || null, actionedByName: u.actionedBy?.name ?? null,
    released: !!u.releasedAt, releasedAt: u.releasedAt || null,
    waitingMinutes: u.state === 'new' ? Math.max(0, Math.round((now - new Date(u.at).getTime()) / 60000)) : null,
  }
}

// ── The AI's reading, after the update is saved ──────────────────────────────────────────────────────────────────────
// Tests swap the extractor in; on a server with no key the update simply carries no suggestions.
let extractor = null
export function setFieldUpdateExtractor(fn) { extractor = fn }
const aiAvailable = () => !!extractor || (!!process.env.ANTHROPIC_API_KEY && process.env.NODE_ENV !== 'test')

/** Reads one saved update and stores what it suggests. Never throws; a failed reading is recorded as such. */
export async function readFieldUpdate(id, fileCtx) {
  try {
    const u = await FieldUpdate.findById(id).lean()
    if (!u || u.ai?.state !== 'pending') return null
    const order = await Order.findById(u.orderId).populate('buyerId', 'company').lean()
    const stages = stagesOf(order, u.factoryId) || []
    const photoDocs = await Document.find({ fieldUpdateId: u._id, isActive: true, mimeType: /^image\// }).limit(3).lean()
    const photos = []
    for (const d of photoDocs) {
      const f = fromDataUrl(await loadFile(d, fileCtx))
      if (f) photos.push({ buffer: f.buffer, mimeType: f.mimeType })
    }
    const ctx = {
      client: order?.buyerId?.company || '', product: order?.product || '', styleNumber: order?.styleNumber || '',
      colours: (order?.colourways || []).map(c => c.name).filter(Boolean),
      stageIndex: u.stageIndex, stageName: u.stageName,
      steps: stages.map(s => ({ name: s.name, status: deriveStageStatus(s), unitsDone: s.unitsDone || 0, totalUnits: s.totalUnits || 0 })),
    }
    const out = await (extractor || extractFieldUpdate)(u.text, photos, ctx)
    if (!out) { await FieldUpdate.updateOne({ _id: id }, { $set: { 'ai.state': 'failed', 'ai.at': new Date() } }); return null }
    // A step to move it to must exist and differ from where it is; a colour must be one of the style's own.
    const move = out.suggested_stage_index != null && out.suggested_stage_index !== u.stageIndex && out.suggested_stage_index < stages.length ? out.suggested_stage_index : null
    const known = new Map(ctx.colours.map(c => [c.toLowerCase(), c]))
    const ai = {
      state: 'done', at: new Date(), summary: out.summary || '',
      suggestedStageIndex: move, units: out.units, statusHint: out.status_hint, result: out.result,
      issues: out.issues || [],
      colours: (out.colours || []).map(c => ({ name: known.get(String(c.name).toLowerCase()) || null, note: c.note })).filter(c => c.name),
      confidence: out.confidence,
    }
    await FieldUpdate.updateOne({ _id: id }, { $set: { ai } })
    return ai
  } catch (err) {
    console.error('[field-updates] reading failed', err.message)
    await FieldUpdate.updateOne({ _id: id }, { $set: { 'ai.state': 'failed', 'ai.at': new Date() } }).catch(() => {})
    return null
  }
}

// ── Coordinator ───────────────────────────────────────────────────────────────────────────────────────────────────
// POST /api/field-updates { orderId, mfrId, stageIndex, text?, viaVoice?, photos?: [dataUrl], audio?: dataUrl, lat?, lng?, accuracy?, deviceAt? }
router.post('/', coordinatorOnly, sendLimiter, async (req, res) => {
  const made = { update: null, docIds: [] }
  try {
    const { orderId, mfrId, viaVoice, photos, audio, lat, lng, accuracy, deviceAt } = req.body || {}
    if (typeof orderId !== 'string' || !orderId || orderId.length > 100) return res.status(400).json({ error: 'Choose a product' })
    if (!isId(mfrId)) return res.status(400).json({ error: 'Choose a factory' })
    if (!req.user.factoryIds.includes(mfrId)) return res.status(403).json({ error: 'That factory is not allocated to you' })
    const stageIndex = req.body.stageIndex
    if (!Number.isInteger(stageIndex) || stageIndex < 0) return res.status(400).json({ error: 'Choose a step' })
    let text = req.body.text
    if (text !== undefined && text !== null && typeof text !== 'string') return res.status(400).json({ error: 'The update must be text' })
    text = (text || '').trim()
    if (text.length > 2000) return res.status(400).json({ error: 'The update is too long (2000 characters at most)' })
    if (photos !== undefined && photos !== null && !Array.isArray(photos)) return res.status(400).json({ error: 'Photos must be a list' })
    if ((photos || []).length > MAX_PHOTOS) return res.status(400).json({ error: `At most ${MAX_PHOTOS} photos in one update` })
    const pics = []
    for (const p of photos || []) { const r = readPhoto(p); if (r.error) return res.status(400).json({ error: r.error }); pics.push(r) }
    let voice = null
    if (audio !== undefined && audio !== null && audio !== '') { voice = readAudio(audio); if (voice.error) return res.status(400).json({ error: voice.error }) }
    if (!text && !pics.length && !voice) return res.status(400).json({ error: 'Add a photo, speak or type something first' })
    // Where the phone was, when it would say. An update is not refused for want of it: the visit already has a place.
    let place = { lat: null, lng: null, accuracy: null }
    if (lat !== undefined && lat !== null || lng !== undefined && lng !== null) {
      if (!validLatLng(lat, lng)) return res.status(400).json({ error: 'Invalid location' })
      place = { lat, lng, accuracy: typeof accuracy === 'number' && accuracy >= 0 ? Math.min(Math.round(accuracy), 100000) : null }
    }
    const device = deviceAt ? new Date(deviceAt) : null
    if (device && isNaN(device.getTime())) return res.status(400).json({ error: 'Invalid device time' })
    const problem = fileStoreProblem()
    if (problem && (pics.length || voice)) { console.error('[field-updates]', problem); return res.status(503).json({ error: 'Photos cannot be saved right now. Tell Tradio.' }) }

    // He records for a factory only while he is checked in there.
    const visit = await openVisitOf(req.user.id)
    if (!visit || String(visit.factoryId) !== mfrId) return res.status(409).json({ error: 'Check in at this factory first', code: 'CHECK_IN_FIRST' })

    const order = await Order.findById(orderId).lean()
    const stages = stagesOf(order, mfrId)
    if (!order || !stages) return res.status(404).json({ error: 'That product is not made at this factory' })
    if (stageIndex >= stages.length) return res.status(400).json({ error: 'That step is not on the plan' })
    const stageName = stages[stageIndex].name || `Step ${stageIndex + 1}`

    const now = new Date()
    const update = await FieldUpdate.create({
      coordinatorId: req.user.id, visitId: visit._id, factoryId: mfrId, orderId, buyerId: order.buyerId,
      stageIndex, stageName, text, viaVoice: !!viaVoice && !!text, language: req.user.language || null,
      at: now, deviceAt: device, ...place,
      ai: { state: aiAvailable() ? 'pending' : 'off' },
    })
    made.update = update._id

    const base = {
      type: 'floor_evidence', mfrId, orderId, stageIndex, uploadedBy: req.user.id, issuer: 'Coordinator update from the floor',
      issueDate: now, fieldUpdateId: update._id, internal: true, isActive: true,
    }
    const folder = `field-updates/${dayIST(now).slice(0, 4)}/${dayIST(now).slice(5, 7)}/${update._id}`
    const store = async (file, name, extra = {}) => {
      const _id = new mongoose.Types.ObjectId()
      const kept = await saveFile(`${folder}/${_id}.${file.ext}`, file.buffer, file.mimeType, { req })
      await Document.create({ ...base, ...extra, _id, name, ...kept, fileName: `${name}.${file.ext}`, fileSize: file.buffer.length, mimeType: file.mimeType })
      made.docIds.push(_id)
    }
    for (let i = 0; i < pics.length; i++) await store(pics[i], `${stageName} - photo ${i + 1}`, { notes: i === 0 && text ? text : null })
    // The recording is kept so the account manager can check a transcript; it is never shown to the factory or the customer.
    if (voice) await store(voice, `${stageName} - voice note`, { notes: text || null, tradioOnly: true })

    // The step's own notes thread carries it too, so it shows on the style's page where everything else about the step is.
    const threadText = (text || `${pics.length ? `${pics.length} photo${pics.length === 1 ? '' : 's'}` : 'Voice note'} from the floor`).slice(0, 1000)
    const mfrObjectId = new mongoose.Types.ObjectId(mfrId)
    await Order.updateOne(
      { _id: orderId, 'assignments.mfrId': mfrObjectId },
      { $push: { [`assignments.$[asgn].stages.${stageIndex}.updates`]: { text: threadText, byUser: req.user.id, at: now, fieldUpdateId: update._id, internal: true } } },
      { arrayFilters: [{ 'asgn.mfrId': mfrObjectId }] },
    )

    const factory = await User.findById(mfrId, 'company').lean()
    await AuditLog.create({
      byUser: req.user.id, action: 'Field Update Added',
      detail: `${req.user.name} at ${factory?.company || 'a factory'}: ${stageName} on ${orderId}${pics.length ? `, ${pics.length} photo${pics.length === 1 ? '' : 's'}` : ''}${voice ? ', voice note' : ''}${place.lat != null ? ` (${place.lat}, ${place.lng})` : ''}`.slice(0, 1000),
    })
    await notify(await adminIds(), { type: 'order', msg: `${req.user.name} sent an update from ${factory?.company || 'the factory'}: ${stageName} on ${orderId}`, orderId })

    const docs = await Document.find({ _id: { $in: made.docIds } }, '-dataUrl').lean()
    res.status(201).json(updateOut(update.toObject(), { docs, order }))
    // The AI reads it after the answer has gone: he never waits for it.
    // (The request's headers are kept for it: a file kept in Stratus is fetched with them.)
    if (update.ai.state === 'pending') readFieldUpdate(update._id, { req: { headers: req.headers } })
  } catch (err) {
    // Nothing half-saved: the phone keeps its draft and he can try again.
    if (made.docIds.length) await Document.deleteMany({ _id: { $in: made.docIds } }).catch(() => {})
    if (made.update) await FieldUpdate.deleteOne({ _id: made.update }).catch(() => {})
    serverError(res, err)
  }
})

// GET /api/field-updates/mine - what he has sent today, newest first.
router.get('/mine', coordinatorOnly, async (req, res) => {
  try {
    const list = await FieldUpdate.find({ coordinatorId: req.user.id, at: { $gte: startOfDayIST(dayIST()) } }).sort({ at: -1 }).limit(100).lean()
    const orders = new Map((await Order.find({ _id: { $in: list.map(u => u.orderId) } }, 'product styleNumber').lean()).map(o => [o._id, o]))
    const docs = await Document.find({ fieldUpdateId: { $in: list.map(u => u._id) }, isActive: true }, '-dataUrl').lean()
    res.json(list.map(u => updateOut(u, { order: orders.get(u.orderId), docs: docs.filter(d => String(d.fieldUpdateId) === String(u._id)) })))
  } catch (err) { serverError(res, err) }
})

// ── Where the files are kept (master admin) ───────────────────────────────────────────────────────────────────────
// GET /api/field-updates/storage - where a coordinator's files go on this server.
// POST /api/field-updates/storage/check - writes, reads and removes a few bytes in Stratus, so it can be proven on a
// server before FILE_STORE=stratus is set and a photo depends on it. Works whatever FILE_STORE says.
router.get('/storage', requireMaster, (req, res) => {
  res.json({ fileStore: fileDriverName(), bucket: process.env.STRATUS_BUCKET ? String(process.env.STRATUS_BUCKET).trim() : null, problem: fileStoreProblem() })
})
router.post('/storage/check', requireMaster, async (req, res) => {
  const result = await checkStratus({ req })
  await AuditLog.create({ byUser: req.user.id, action: 'Storage Checked', detail: `Stratus bucket ${result.bucket || '(none set)'}: ${result.ok ? 'works' : result.steps.filter(s => !s.ok).map(s => `${s.step} failed (${s.error})`).join('; ')} (by ${req.user.name})`.slice(0, 1000) }).catch(() => {})
  res.status(result.ok ? 200 : 502).json({ fileStore: fileDriverName(), ...result })
})

// ── Account manager (any admin) ───────────────────────────────────────────────────────────────────────────────────
const STATES = ['new', 'actioned', 'dismissed']

// GET /api/field-updates/count - how many wait, for the menu.
router.get('/count', requireAdmin, async (req, res) => {
  try { res.json({ new: await FieldUpdate.countDocuments({ state: 'new' }) }) } catch (err) { serverError(res, err) }
})

// GET /api/field-updates?state=&factoryId=&coordinatorId=&buyerId=&orderId=
router.get('/', requireAdmin, async (req, res) => {
  try {
    const filter = {}
    if (req.query.state !== undefined && req.query.state !== '') {
      if (!STATES.includes(req.query.state)) return res.status(400).json({ error: 'Invalid state' })
      filter.state = req.query.state
    }
    for (const k of ['factoryId', 'coordinatorId', 'buyerId']) {
      if (req.query[k] === undefined || req.query[k] === '') continue
      if (!isId(req.query[k])) return res.status(400).json({ error: `Invalid ${k}` })
      filter[k] = req.query[k]
    }
    if (typeof req.query.orderId === 'string' && req.query.orderId) filter.orderId = req.query.orderId.slice(0, 100)
    const list = await FieldUpdate.find(filter).sort({ at: -1 }).limit(200)
      .populate('coordinatorId', 'name').populate('factoryId', 'company').populate('actionedBy', 'name').lean()
    const [orders, docs, visits, waiting] = await Promise.all([
      Order.find({ _id: { $in: [...new Set(list.map(u => u.orderId))] } }, 'product styleNumber buyerId').populate('buyerId', 'company').lean(),
      Document.find({ fieldUpdateId: { $in: list.map(u => u._id) }, isActive: true }, '-dataUrl').lean(),
      FactoryVisit.find({ _id: { $in: list.map(u => u.visitId) } }, 'checkIn').lean(),
      FieldUpdate.countDocuments({ state: 'new' }),
    ])
    const byOrder = new Map(orders.map(o => [o._id, o])); const byVisit = new Map(visits.map(v => [String(v._id), v]))
    res.json({
      waiting,
      updates: list.map(u => updateOut(u, { order: byOrder.get(u.orderId), visit: byVisit.get(String(u.visitId)), docs: docs.filter(d => String(d.fieldUpdateId) === String(u._id)) })),
    })
  } catch (err) { serverError(res, err) }
})

async function loadUpdate(req, res) {
  if (!isId(req.params.id)) { res.status(404).json({ error: 'Update not found' }); return null }
  const u = await FieldUpdate.findById(req.params.id)
  if (!u) { res.status(404).json({ error: 'Update not found' }); return null }
  return u
}
const respond = async (res, u) => {
  const full = await FieldUpdate.findById(u._id).populate('coordinatorId', 'name').populate('factoryId', 'company').populate('actionedBy', 'name').lean()
  const [order, docs, visit] = await Promise.all([
    Order.findById(full.orderId, 'product styleNumber buyerId').populate('buyerId', 'company').lean(),
    Document.find({ fieldUpdateId: full._id, isActive: true }, '-dataUrl').lean(),
    FactoryVisit.findById(full.visitId, 'checkIn').lean(),
  ])
  res.json(updateOut(full, { order, docs, visit }))
}

// POST /api/field-updates/:id/move { stageIndex } - he posted it on the wrong step: its files and its note go to the right one.
router.post('/:id/move', requireAdmin, async (req, res) => {
  try {
    const u = await loadUpdate(req, res); if (!u) return
    const to = req.body?.stageIndex
    if (!Number.isInteger(to) || to < 0) return res.status(400).json({ error: 'Choose a step' })
    if (to === u.stageIndex) return respond(res, u)
    const order = await Order.findById(u.orderId).lean()
    const stages = stagesOf(order, u.factoryId)
    if (!stages || to >= stages.length) return res.status(400).json({ error: 'That step is not on the plan' })
    const from = u.stageIndex
    const mfrObjectId = new mongoose.Types.ObjectId(String(u.factoryId))
    const entry = (stages[from]?.updates || []).find(x => String(x.fieldUpdateId) === String(u._id))
    const filters = { arrayFilters: [{ 'asgn.mfrId': mfrObjectId }] }
    if (entry) {
      await Order.updateOne({ _id: u.orderId, 'assignments.mfrId': mfrObjectId }, { $pull: { [`assignments.$[asgn].stages.${from}.updates`]: { fieldUpdateId: u._id } } }, filters)
      await Order.updateOne({ _id: u.orderId, 'assignments.mfrId': mfrObjectId }, { $push: { [`assignments.$[asgn].stages.${to}.updates`]: entry } }, filters)
    }
    const newName = stages[to].name || `Step ${to + 1}`
    const docs = await Document.find({ fieldUpdateId: u._id }, 'name').lean()
    await Document.bulkWrite(docs.map(d => ({ updateOne: { filter: { _id: d._id }, update: { $set: { stageIndex: to, name: d.name.startsWith(`${u.stageName} - `) ? `${newName} - ${d.name.slice(u.stageName.length + 3)}` : d.name } } } })))
    if (u.movedFromStageIndex == null) u.movedFromStageIndex = from
    const oldName = u.stageName
    u.stageIndex = to; u.stageName = newName
    if (u.ai?.suggestedStageIndex === to) u.ai.suggestedStageIndex = null
    await u.save()
    await AuditLog.create({ byUser: req.user.id, action: 'Field Update Moved', detail: `${u.orderId}: an update from the floor moved from ${oldName} to ${newName} by ${req.user.name}` })
    respond(res, u)
  } catch (err) { serverError(res, err) }
})

// POST /api/field-updates/:id/action { applied?: [text] } - the account manager has dealt with it. The step itself was
// changed (or not) through the ordinary admin routes; `applied` only records in words what was confirmed.
router.post('/:id/action', requireAdmin, async (req, res) => {
  try {
    const u = await loadUpdate(req, res); if (!u) return
    const applied = req.body?.applied
    if (applied !== undefined && (!Array.isArray(applied) || applied.length > 10 || applied.some(a => typeof a !== 'string' || a.length > 200))) return res.status(400).json({ error: 'Invalid list of what was applied' })
    u.state = 'actioned'; u.actionedBy = req.user.id; u.actionedAt = new Date()
    if (applied) u.applied = [...new Set([...(u.applied || []), ...applied.map(a => a.trim()).filter(Boolean)])].slice(0, 20)
    await u.save()
    await AuditLog.create({ byUser: req.user.id, action: 'Field Update Actioned', detail: `${u.orderId}, ${u.stageName}: ${u.applied.length ? u.applied.join('; ') : 'read, nothing changed'} (by ${req.user.name})`.slice(0, 1000) })
    respond(res, u)
  } catch (err) { serverError(res, err) }
})

// POST /api/field-updates/:id/dismiss - nothing to do with it. /reopen puts it back in the queue.
router.post('/:id/dismiss', requireAdmin, async (req, res) => {
  try {
    const u = await loadUpdate(req, res); if (!u) return
    u.state = 'dismissed'; u.actionedBy = req.user.id; u.actionedAt = new Date()
    await u.save()
    await AuditLog.create({ byUser: req.user.id, action: 'Field Update Dismissed', detail: `${u.orderId}, ${u.stageName} (by ${req.user.name})` })
    respond(res, u)
  } catch (err) { serverError(res, err) }
})
router.post('/:id/reopen', requireAdmin, async (req, res) => {
  try {
    const u = await loadUpdate(req, res); if (!u) return
    u.state = 'new'; u.actionedBy = null; u.actionedAt = null
    await u.save()
    respond(res, u)
  } catch (err) { serverError(res, err) }
})

// POST /api/field-updates/:id/release { photoIds: [documentId] } - show it to the customer: its words and the photos the
// admin picked. The voice recording is never released. The customer is told only now.
router.post('/:id/release', requireAdmin, async (req, res) => {
  try {
    const u = await loadUpdate(req, res); if (!u) return
    const ids = req.body?.photoIds ?? []
    if (!Array.isArray(ids) || ids.some(x => !isId(x))) return res.status(400).json({ error: 'Invalid list of photos' })
    const photos = await Document.find({ fieldUpdateId: u._id, isActive: true, tradioOnly: { $ne: true }, mimeType: /^image\// }, '_id').lean()
    const mine = new Set(photos.map(d => String(d._id)))
    if (ids.some(x => !mine.has(x))) return res.status(400).json({ error: 'A photo in the list does not belong to this update' })
    if (ids.length) await Document.updateMany({ _id: { $in: ids } }, { $set: { internal: false } })
    const mfrObjectId = new mongoose.Types.ObjectId(String(u.factoryId))
    await Order.updateOne(
      { _id: u.orderId, 'assignments.mfrId': mfrObjectId },
      { $set: { [`assignments.$[asgn].stages.${u.stageIndex}.updates.$[note].internal`]: false } },
      { arrayFilters: [{ 'asgn.mfrId': mfrObjectId }, { 'note.fieldUpdateId': u._id }] },
    )
    const first = !u.releasedAt
    u.releasedAt = u.releasedAt || new Date(); u.releasedBy = req.user.id
    await u.save()
    await AuditLog.create({ byUser: req.user.id, action: 'Field Update Released', detail: `${u.orderId}, ${u.stageName}: shown to the customer with ${ids.length} photo${ids.length === 1 ? '' : 's'} (by ${req.user.name})` })
    if (first && u.buyerId) await notify([u.buyerId], { type: 'order', msg: `Tradio shared an update from the factory floor on ${u.orderId} (${u.stageName})`, orderId: u.orderId }, { exceptUserId: req.user.id })
    respond(res, u)
  } catch (err) { serverError(res, err) }
})

export default router
