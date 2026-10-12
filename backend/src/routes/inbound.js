import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import crypto from 'node:crypto'
import mongoose from 'mongoose'
import { requireAuth } from '../middleware/auth.js'
import { InboundMessage, User } from '../db/index.js'
import { getInboundAdapter } from '../lib/inbound/adapters.js'
import { ingestMessage, IMAGE_MIME, DOC_MIME, AUDIO_MIME, MAX_MEDIA_BYTES } from '../lib/inbound/pipeline.js'
import { isStandalone } from '../lib/platform.js'
import { staffMayActForMfrs, NOT_ENABLED } from '../lib/authz.js'
import { twilioConfig, validTwilioSignature } from '../lib/inbound/twilio.js'

const router = Router()
const skipInTest = () => process.env.NODE_ENV === 'test'
// The web upload is limited per signed-in user (keyed by IP it would throttle a whole factory
// behind one NAT). The provider webhook arrives from the provider's few IPs and is already gated by
// the shared secret, so it gets a far higher ceiling: at 300/hour a busy day could start dropping
// real messages from every factory at once.
const limiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 300,
  keyGenerator: req => req.user?.id ? `user|${req.user.actorId || req.user.id}` : req.ip,
  message: { error: 'Too many messages. Please wait a bit.' },
  standardHeaders: true, legacyHeaders: false, validate: false, skip: skipInTest,
})
const webhookLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 5000,
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
  reviewReason: m.reviewReason, rawText: m.rawText, grnId: m.grnId ? String(m.grnId) : null,
  description: m.parsed?.description || null,
})

// Messages being worked on after their webhook was answered. Twilio waits only 15 seconds for a reply and reading a
// document can take longer, so it is answered first and processed after; tests wait for this to drain.
const inFlight = new Set()
export const drainInbound = () => Promise.allSettled([...inFlight])

async function process_(adapter, body) {
  // A retry of a message already taken in is not taken in again.
  if (body?.MessageSid && await InboundMessage.exists({ externalId: String(body.MessageSid).slice(0, 64) })) return null
  const n = await adapter.normalize(body)
  if (n.type !== 'text' && !mimeAllowed(n.type, n.mime_type)) throw new Error('Unsupported media type')
  if (n.media_bytes && n.media_bytes.length > MAX_MEDIA_BYTES) throw new Error('Media too large')
  if (typeof n.text === 'string' && n.text.length > 2000) n.text = n.text.slice(0, 2000)
  return ingestMessage({
    senderNumber: n.sender_number, channel: 'whatsapp', type: n.type,
    buffer: n.media_bytes, mimeType: n.mime_type, text: n.text, receivedAt: n.received_at, externalId: n.message_id || null,
  })
}

// POST /api/inbound/webhook/:provider
// Provider-agnostic entry point; each provider's payload is normalized by its adapter. A call is proved genuine in the
// provider's own way: the shared secret header for the mock, Twilio's request signature for Twilio (it cannot send a
// header of ours).
router.post('/webhook/:provider', webhookLimiter, async (req, res) => {
  if (req.params.provider === 'twilio') {
    const adapter = getInboundAdapter('twilio')
    if (!adapter) return res.status(404).json({ error: 'Unknown provider' })
    const url = process.env.TWILIO_WEBHOOK_URL || `${req.protocol}://${req.get('host')}${req.originalUrl}`
    if (!validTwilioSignature(twilioConfig().token, req.get('X-Twilio-Signature'), url, req.body || {})) return res.status(403).json({ error: 'Forbidden' })
    const job = process_(adapter, req.body).catch(err => console.error('[inbound] twilio message not taken in:', err.message))
    inFlight.add(job); job.finally(() => inFlight.delete(job))
    return res.status(200).type('text/xml').send('<Response/>')
  }

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
  // Same 2000-character ceiling the web upload applies; the webhook had none.
  if (typeof n.text === 'string' && n.text.length > 2000) n.text = n.text.slice(0, 2000)

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
    // Standalone: Tradio relays a photo only for a factory it may act for.
    if (isStandalone() && !(await staffMayActForMfrs([factoryId]))) return res.status(403).json(NOT_ENABLED)
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
  // The order the person said it is for (the capture sheet's choice): only a hint, believed only if it is one of the factory's live orders.
  const orderHint = typeof req.body.orderId === 'string' && req.body.orderId.length <= 100 ? req.body.orderId : null
  const msg = await ingestMessage({ factoryId, channel: 'web', type, buffer, mimeType, text: type === 'text' ? text : '', orderHint })
  res.json({ message: publicMessage(msg) })
})

export default router
