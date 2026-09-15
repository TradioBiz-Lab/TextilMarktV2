import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { requireAuth, requireAdmin } from '../middleware/auth.js'

const router = Router()

const skipInTest = () => process.env.NODE_ENV === 'test'

const SARVAM_STT_URL = 'https://api.sarvam.ai/speech-to-text'
const SARVAM_TTS_URL = 'https://api.sarvam.ai/text-to-speech'

// A voice chat clip is a few seconds of audio — well under documents.js's
// 10MB document ceiling, but still a real abuse guard against someone
// sending an oversized payload.
const ALLOWED_AUDIO_MIME = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/wav', 'audio/mpeg']
const MAX_AUDIO_SIZE = 5 * 1024 * 1024 // 5MB

// Sarvam's TTS caps a single request at 2500 characters — reject rather
// than silently truncate, so a cut-off reply is never played back without
// the caller knowing content is missing (chunking a long reply into
// several sequential calls is the frontend's job, not this route's).
const MAX_TTS_CHARS = 2500

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

// Speaker choice stays a backend concern — the frontend only ever passes
// back the language_code it got from STT, never a speaker name.
// One speaker across every language, not one per language — confirmed
// live that 'priya' (lowercase; Sarvam rejects speaker names
// case-sensitively) handles Hindi/Kannada/Bengali/English cleanly on
// bulbul:v3. Kriyaa switching to a different voice mid-conversation
// whenever the detected language changed read as jarring/inconsistent.
const SPEAKER = 'priya'
const SUPPORTED_LANGUAGES = ['hi-IN', 'kn-IN', 'bn-IN', 'en-IN']
const DEFAULT_LANGUAGE = 'en-IN'
// bulbul:v3-only knobs (pitch/loudness exist on v2 but are rejected on
// v3). pace > 1.0 for a brisker, less deliberate-sounding reply; a higher
// temperature trades a little of Sarvam's default flatness for more
// natural-sounding, less mechanical-sounding inflection.
const TTS_PACE = 1.15
const TTS_TEMPERATURE = 0.9

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
  if (!match) return { error: 'Invalid audio payload — must be a base64 data URL' }
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

router.post('/transcribe', requireAuth, requireAdmin, voiceLimiter, async (req, res) => {
  if (!process.env.SARVAM_API_KEY)
    return res.status(503).json({ error: 'Voice is not configured on this server.' })

  const { audioDataUrl } = req.body
  const decoded = decodeAudioPayload(audioDataUrl)
  if (decoded.error) return res.status(400).json({ error: decoded.error })

  try {
    const form = new FormData()
    form.append('file', new Blob([decoded.buffer], { type: decoded.mimeType }), 'audio')
    form.append('model', 'saaras:v3')
    // language_code intentionally omitted — auto-detects across
    // Hindi/English/Kannada/Bengali (and everything else Saaras supports).

    const sarvamRes = await fetch(SARVAM_STT_URL, {
      method: 'POST',
      headers: { 'api-subscription-key': process.env.SARVAM_API_KEY },
      body: form,
    })
    if (!sarvamRes.ok) {
      console.error('[voice] Sarvam STT failed', sarvamRes.status, await sarvamRes.text().catch(() => ''))
      return res.status(502).json({ error: 'Voice transcription failed. Please try again or type your message.' })
    }
    const data = await sarvamRes.json()
    res.json({
      transcript: data.transcript || '',
      languageCode: data.language_code || null,
      languageProbability: data.language_probability ?? null,
    })
  } catch (err) {
    console.error('[voice]', err)
    res.status(502).json({ error: 'Voice transcription failed. Please try again or type your message.' })
  }
})

router.post('/speak', requireAuth, requireAdmin, voiceLimiter, async (req, res) => {
  if (!process.env.SARVAM_API_KEY)
    return res.status(503).json({ error: 'Voice is not configured on this server.' })

  const { text, languageCode } = req.body
  if (typeof text !== 'string' || text.trim().length === 0)
    return res.status(400).json({ error: 'text is required' })
  if (text.length > MAX_TTS_CHARS)
    return res.status(400).json({ error: `Text too long for speech (max ${MAX_TTS_CHARS} characters) — split it into shorter chunks.` })

  const resolvedLanguage = SUPPORTED_LANGUAGES.includes(languageCode) ? languageCode : DEFAULT_LANGUAGE

  try {
    const sarvamRes = await fetch(SARVAM_TTS_URL, {
      method: 'POST',
      headers: { 'api-subscription-key': process.env.SARVAM_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text, language_code: resolvedLanguage, speaker: SPEAKER, model: 'bulbul:v3',
        pace: TTS_PACE, temperature: TTS_TEMPERATURE,
      }),
    })
    if (!sarvamRes.ok) {
      console.error('[voice] Sarvam TTS failed', sarvamRes.status, await sarvamRes.text().catch(() => ''))
      return res.status(502).json({ error: 'Voice playback failed.' })
    }
    const data = await sarvamRes.json()
    const audioBase64 = data.audios?.[0]
    if (!audioBase64) return res.status(502).json({ error: 'Voice playback failed.' })
    // Re-wrapped as a data URL to match this repo's established
    // binary-over-JSON convention (documents.js) — lets the frontend reuse
    // dataUrlToBlobUrl (ui.jsx) unchanged instead of a second audio-decoding path.
    res.json({ audioDataUrl: `data:audio/wav;base64,${audioBase64}` })
  } catch (err) {
    console.error('[voice]', err)
    res.status(502).json({ error: 'Voice playback failed.' })
  }
})

export default router
