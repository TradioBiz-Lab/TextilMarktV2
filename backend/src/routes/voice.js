import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { requireAuth } from '../middleware/auth.js'
import { transcribeAudio, sttProvider } from '../lib/speechToText.js'
import { speak, ttsProvider, MAX_TTS_CHARS } from '../lib/textToSpeech.js'

const router = Router()

const skipInTest = () => process.env.NODE_ENV === 'test'


// A voice chat clip is a few seconds of audio — well under documents.js's
// 10MB document ceiling, but still a real abuse guard against someone
// sending an oversized payload.
const ALLOWED_AUDIO_MIME = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/wav', 'audio/mpeg']
const MAX_AUDIO_SIZE = 5 * 1024 * 1024 // 5MB

// 80 voice requests (transcribe+speak pairs count as 2 calls each) per
// admin per hour. Separate bucket from assistant.js's assistantLimiter
// (30 chat-turns/hr) — a voice exchange is strictly additive to a chat
// turn (STT before, TTS after), so sharing one bucket would let voice
// usage silently eat into the admin's text-chat budget.
const voiceLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 80,
  keyGenerator: req => req.user?.id || req.ip,
  message: { error: 'Too many voice requests. Please wait, or switch to typing.' },
  standardHeaders: true, legacyHeaders: false, validate: false, skip: skipInTest,
})

// Same base64-data-URL validation shape as documents.js's
// validateFilePayload, adapted for audio mime types instead of documents.
// Returns { buffer, mimeType } on success or { error } on failure.
function decodeAudioPayload(audioDataUrl) {
  if (typeof audioDataUrl !== 'string') return { error: 'Invalid audio payload' }
  // MediaRecorder's mimeType commonly carries a codec parameter, e.g.
  // 'audio/webm;codecs=opus' — that lands in the data URL as
  // 'data:audio/webm;codecs=opus;base64,...', so unlike documents.js's
  // plain file-upload data URLs, this one needs to tolerate an optional
  // ';param=value' segment between the mime type and the 'base64,' marker.
  const match = /^data:([^;,]+)(?:;[^;,]+)*;base64,(.+)$/i.exec(audioDataUrl)
  if (!match) return { error: 'Invalid audio payload - must be a base64 data URL' }
  const mimeType = match[1].toLowerCase()
  if (!ALLOWED_AUDIO_MIME.includes(mimeType)) return { error: 'Unsupported audio format' }
  if (Buffer.byteLength(audioDataUrl, 'utf8') > MAX_AUDIO_SIZE * 1.4) return { error: 'Audio payload too large' }
  let buffer
  try {
    buffer = Buffer.from(match[2], 'base64')
  } catch {
    return { error: 'Invalid audio payload' }
  }
  if (buffer.length === 0) return { error: 'Empty audio payload' }
  if (buffer.length > MAX_AUDIO_SIZE) return { error: 'Audio exceeds 5MB limit' }
  return { buffer, mimeType }
}

router.post('/transcribe', requireAuth, voiceLimiter, async (req, res) => {
  // ElevenLabs or Sarvam, whichever this server has a key for (lib/speechToText.js).
  if (!sttProvider())
    return res.status(503).json({ error: 'Voice is not configured on this server.' })

  const { audioDataUrl } = req.body
  const decoded = decodeAudioPayload(audioDataUrl)
  if (decoded.error) return res.status(400).json({ error: decoded.error })

  try {
    // `terms`: names the speaker is likely to say (a client, a product, its colours, its steps), so they are heard right.
    const data = await transcribeAudio(decoded.buffer, decoded.mimeType, { terms: req.body.terms })
    res.json({
      transcript: data.transcript,
      languageCode: data.languageCode,
      languageProbability: data.languageProbability,
    })
  } catch (err) {
    console.error('[voice]', err)
    res.status(502).json({ error: 'Voice transcription failed. Please try again or type your message.' })
  }
})

router.post('/speak', requireAuth, voiceLimiter, async (req, res) => {
  if (!ttsProvider())
    return res.status(503).json({ error: 'Voice is not configured on this server.' })

  const { text, languageCode } = req.body
  if (typeof text !== 'string' || text.trim().length === 0)
    return res.status(400).json({ error: 'text is required' })
  if (text.length > MAX_TTS_CHARS)
    return res.status(400).json({ error: `Text too long for speech (max ${MAX_TTS_CHARS} characters) - split it into shorter chunks.` })

  try {
    // The audio goes back as a data URL (this repo's way of sending a file in JSON), so the page plays it through the
    // same path whichever service made it: ElevenLabs gives MP3, Sarvam WAV.
    res.json(await speak(text, languageCode))
  } catch (err) {
    console.error('[voice]', err.message, err.detail || '')
    res.status(502).json({ error: 'Voice playback failed.' })
  }
})

export default router
