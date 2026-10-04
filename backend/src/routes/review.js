import { Router } from 'express'
import mongoose from 'mongoose'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import { InboundMessage, Order, User, AuditLog } from '../db/index.js'
import { deriveStageStatus } from '../models/Order.js'
import { applyStageChange, revertStageChange } from '../lib/inbound/applyStage.js'
import { loadActiveOrders } from '../lib/inbound/pipeline.js'
import { mapStageIndex } from '../lib/inbound/matching.js'
import { createEvidence, retractEvidence } from '../lib/inbound/evidence.js'

const router = Router()
const LIGHT = '-dataUrl'

const shape = (m, factories, orders) => ({
  id: String(m._id), type: m.type, state: m.state, createdAt: m.createdAt,
  factory: factories[String(m.factoryId)] || null, senderNumber: m.senderNumber,
  rawText: m.rawText, parsed: m.parsed, confidence: m.confidence,
  orderId: m.orderId, stageApplied: m.stageApplied, hasDefect: m.hasDefect,
  reviewReason: m.reviewReason, hasMedia: m.type !== 'text',
  changes: m.changes, candidates: orders[String(m.factoryId)] || [],
})

// GET /api/review/queue - needs_review, oldest first
router.get('/queue', requireAuth, requireAdmin, async (_req, res) => {
  const msgs = await InboundMessage.find({ state: 'needs_review' }).select(LIGHT).sort({ createdAt: 1 }).limit(100).lean()
  const ids = [...new Set(msgs.map(m => String(m.factoryId)).filter(i => i !== 'null'))]
  const users = await User.find({ _id: { $in: ids } }, 'name company').lean()
  const factories = Object.fromEntries(users.map(u => [String(u._id), { id: String(u._id), name: u.name, company: u.company }]))
  const orders = {}
  for (const id of ids) orders[id] = (await loadActiveOrders(id)).map(o => ({ id: o.id, product: o.product, styleNumber: o.styleNumber, stages: o.stages.map(s => s.name) }))
  res.json(msgs.map(m => shape(m, factories, orders)))
})

// GET /api/review/:id/media - raw media for the preview (admin, or the brand that owns the order)
router.get('/:id/media', requireAuth, async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).end()
  const m = await InboundMessage.findById(req.params.id, 'dataUrl mimeType orderId').lean()
  if (!m?.dataUrl) return res.status(404).end()
  if (req.user.role !== 'admin') {
    const ok = req.user.role === 'buyer' && m.orderId && await Order.exists({ _id: m.orderId, buyerId: req.user.id })
    if (!ok) return res.status(403).end()
  }
  const comma = m.dataUrl.indexOf(',')
  res.set('Content-Type', m.mimeType || 'application/octet-stream')
  res.set('Cache-Control', 'private, max-age=3600')
  res.send(Buffer.from(m.dataUrl.slice(comma + 1), 'base64'))
})

const finish = async (msg, req, state, detail) => {
  msg.state = state; msg.reviewedBy = req.user.id; msg.reviewedAt = new Date()
  await msg.save()
  await AuditLog.create({ byUser: req.user.id, action: 'Inbound Review', detail }).catch(() => {})
}

// POST /api/review/:id/approve - keep whatever the AI already applied; if it
// applied nothing, apply its own best guess (needs a matched order + stage).
router.post('/:id/approve', requireAuth, requireAdmin, async (req, res) => {
  const msg = await InboundMessage.findOne({ _id: req.params.id, state: 'needs_review' })
  if (!msg) return res.status(404).json({ error: 'Message not found or already reviewed' })
  if (!msg.changes.length) {
    const u = msg.parsed?.updates?.[0]
    const canonical = msg.parsed?.stage || msg.parsed?.implied_stage || u?.stage
    if (!msg.orderId || !canonical || !msg.factoryId)
      return res.status(400).json({ error: 'Nothing to approve - use Correct to pick the order and stage' })
    const r = await applyForReview(msg, msg.orderId, canonical, u?.status === 'in_progress' ? 'in_progress' : 'done')
    if (r.error) return res.status(400).json({ error: r.error })
  }
  await finish(msg, req, 'applied', `Approved inbound message ${msg._id}`)
  res.json({ ok: true })
})

async function applyForReview(msg, orderId, canonicalOrName, status) {
  const orders = await loadActiveOrders(msg.factoryId)
  const order = orders.find(o => o.id === orderId)
  if (!order) return { error: 'Order is not active for this factory' }
  let idx = mapStageIndex(canonicalOrName, order.stages)
  if (idx < 0) idx = order.stages.findIndex(s => s.name === canonicalOrName)
  if (idx < 0) return { error: 'Stage not found on this order' }
  const r = await applyStageChange({ orderId, mfrId: msg.factoryId, stageIndex: idx, status, note: msg.parsed?.description || msg.rawText?.slice(0, 200) })
  if (r.error) return r
  msg.orderId = orderId; msg.stageApplied = r.stageName
  const factory = await User.findById(msg.factoryId, '_id').lean()
  await createEvidence({ msg, factory, orderId, stageIndex: idx, stageName: r.stageName, note: msg.parsed?.description })
  msg.changes.push({ orderId, mfrId: msg.factoryId, stageIndex: idx, stageName: r.stageName, before: r.before, after: r.after })
  return r
}

// POST /api/review/:id/correct  { orderId, stage, status? } - coordinator overrides the guess
router.post('/:id/correct', requireAuth, requireAdmin, async (req, res) => {
  const { orderId, stage, status = 'done' } = req.body || {}
  if (typeof orderId !== 'string' || typeof stage !== 'string') return res.status(400).json({ error: 'orderId and stage required' })
  if (!['done', 'in_progress'].includes(status)) return res.status(400).json({ error: 'Invalid status' })
  const msg = await InboundMessage.findOne({ _id: req.params.id, state: 'needs_review' })
  if (!msg) return res.status(404).json({ error: 'Message not found or already reviewed' })
  if (!msg.factoryId) return res.status(400).json({ error: 'Unknown sender - assign a factory number first' })
  // Undo anything the AI applied before applying the coordinator's version.
  for (const c of msg.changes) await revertStageChange({ orderId: c.orderId, mfrId: c.mfrId, stageIndex: c.stageIndex, before: c.before })
  msg.changes = []
  await retractEvidence(msg._id)
  const r = await applyForReview(msg, orderId, stage, status)
  if (r.error) return res.status(400).json({ error: r.error })
  await finish(msg, req, 'applied', `Corrected inbound message ${msg._id} to ${orderId} / ${r.stageName}`)
  res.json({ ok: true })
})

// POST /api/review/:id/reject - revert any AI write, keep the raw message
router.post('/:id/reject', requireAuth, requireAdmin, async (req, res) => {
  const msg = await InboundMessage.findOne({ _id: req.params.id, state: 'needs_review' })
  if (!msg) return res.status(404).json({ error: 'Message not found or already reviewed' })
  for (const c of msg.changes) await revertStageChange({ orderId: c.orderId, mfrId: c.mfrId, stageIndex: c.stageIndex, before: c.before })
  await retractEvidence(msg._id)
  await finish(msg, req, 'rejected', `Rejected inbound message ${msg._id}`)
  res.json({ ok: true })
})

export default router
