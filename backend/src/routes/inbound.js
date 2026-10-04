import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import crypto from 'node:crypto'
import mongoose from 'mongoose'
import { requireAuth } from '../middleware/auth.js'
import { InboundMessage, User } from '../db/index.js'
import { getInboundAdapter } from '../lib/inbound/adapters.js'
import { ingestMessage, IMAGE_MIME, DOC_MIME, AUDIO_MIME, MAX_MEDIA_BYTES } from '../lib/inbound/pipeline.js'

const router = Router()
const skipInTest = () => process.env.NODE_ENV === 'test'
const limiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 300,
  message: { error: 'Too many messages. Please wait a bit.' },
  standardHeaders: true, legacyHeaders: false, validate: false, skip: skipInTest,
})

const mimeAllowed = (type, mime) =>
  (type === 'image' && IMAGE_MIME.includes(mime)) ||
  (type === 'document' && DOC_MIME.includes(mime)) ||
  (type === 'audio' && AUDIO_MIME.includes(mime))

const publicMessage = m => ({
  id: String(m._id), type: m.type, state: m.state, orderId: m.orderId,
  stageApplied: m.stageApplied, confidence: m.confidence, hasDefect: m.hasDefect,
  reviewReason: m.reviewReason, rawText: m.rawText,
  description: m.parsed?.description || null,
})

// POST /api/inbound/webhook/:provider
// Provider-agnostic entry point. The shared secret keeps strangers from
// feeding the pipeline; each provider's payload is normalized by its adapter.
router.post('/webhook/:provider', limiter, async (req, res) => {
  const secret = process.env.INBOUND_WEBHOOK_SECRET
  if (!secret) return res.status(503).json({ error: 'Inbound webhook is not configured' })
  const given = String(req.headers['x-webhook-secret'] || '')
  const a = Buffer.from(given), b = Buffer.from(secret)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Unauthorized' })

  const adapter = getInboundAdapter(req.params.provider)
  if (!adapter) return res.status(404).json({ error: 'Unknown provider' })
  let n
  try { n = await adapter.normalize(req.body) } catch (err) { return res.status(400).json({ error: err.message }) }
  if (n.type !== 'text' && !mimeAllowed(n.type, n.mime_type)) return res.status(400).json({ error: 'Unsupported media type' })
  if (n.media_bytes && n.media_bytes.length > MAX_MEDIA_BYTES) return res.status(400).json({ error: 'Media too large' })

  const msg = await ingestMessage({
    senderNumber: n.sender_number, channel: 'whatsapp', type: n.type,
    buffer: n.media_bytes, mimeType: n.mime_type, text: n.text, receivedAt: n.received_at,
  })
  res.json({ message: publicMessage(msg) })
})

// POST /api/inbound/upload  { type, fileDataUrl?, text?, factoryId? }
// Web channel. A manufacturer uploads as themselves; an admin may upload on a
// factory's behalf (factoryId), e.g. for the demo or when a coordinator relays a photo.
router.post('/upload', requireAuth, limiter, async (req, res) => {
  const { type, fileDataUrl, text } = req.body || {}
  let factoryId
  if (req.user.role === 'manufacturer') factoryId = req.user.id
  else if (req.user.role === 'admin') {
    factoryId = req.body.factoryId
    if (!mongoose.Types.ObjectId.isValid(factoryId)) return res.status(400).json({ error: 'factoryId required' })
    const f = await User.findOne({ _id: factoryId, role: 'manufacturer' }, '_id').lean()
    if (!f) return res.status(404).json({ error: 'Factory not found' })
  } else return res.status(403).json({ error: 'Forbidden' })

  if (!['image', 'audio', 'document', 'text'].includes(type)) return res.status(400).json({ error: 'Invalid type' })
  let buffer = null, mimeType = null
  if (type === 'text') {
    if (typeof text !== 'string' || !text.trim() || text.length > 2000) return res.status(400).json({ error: 'text required (max 2000 chars)' })
  } else {
    const m = /^data:([^;,]+)(?:;[^;,]+)*;base64,(.+)$/i.exec(typeof fileDataUrl === 'string' ? fileDataUrl : '')
    if (!m) return res.status(400).json({ error: 'fileDataUrl must be a base64 data URL' })
    mimeType = m[1].toLowerCase()
    if (!mimeAllowed(type, mimeType)) return res.status(400).json({ error: 'Unsupported file type' })
    buffer = Buffer.from(m[2], 'base64')
    if (!buffer.length || buffer.length > MAX_MEDIA_BYTES) return res.status(400).json({ error: 'File empty or over 8MB' })
  }
  const msg = await ingestMessage({ factoryId, channel: 'web', type, buffer, mimeType, text: type === 'text' ? text : '' })
  res.json({ message: publicMessage(msg) })
})

export default router
