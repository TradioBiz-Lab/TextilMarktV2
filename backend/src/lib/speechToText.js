// Turning speech into text, for Kriyaa's microphone. Two services can do it:
// ElevenLabs (Scribe) and Sarvam. Whichever has its key on this server is used; with both, ElevenLabs is, unless
// VOICE_STT names the other. With neither, voice is off and the route says so.
//
//   ELEVENLABS_API_KEY   use ElevenLabs
//   SARVAM_API_KEY       use Sarvam (reading replies aloud is lib/textToSpeech.js)
//   VOICE_STT            'elevenlabs' or 'sarvam', to choose when both keys are set
//   ELEVENLABS_STT_MODEL the Scribe model, default scribe_v3
//
// ElevenLabs is called directly (one form upload), not through its SDK: the SDK is 122 MB and every deploy uploads
// the backend's packages. The request is the one ElevenLabs' own speech-to-text guide shows.
import { transcribeAudio as sarvamTranscribe } from './sarvam.js'

const ELEVENLABS_STT_URL = 'https://api.elevenlabs.io/v1/speech-to-text'

/** Which service turns speech into text on this server: 'elevenlabs', 'sarvam', or null for none. */
export function sttProvider(env = process.env) {
  const has = { elevenlabs: !!env.ELEVENLABS_API_KEY, sarvam: !!env.SARVAM_API_KEY }
  const asked = String(env.VOICE_STT || '').trim().toLowerCase()
  if (has[asked]) return asked
  return has.elevenlabs ? 'elevenlabs' : has.sarvam ? 'sarvam' : null
}

// ElevenLabs names a language by three letters ('hin'); the rest of the app, and Sarvam's voice for reading replies
// aloud, use the 'hi-IN' form. A language outside this list is passed on as it came.
const LANGUAGE = { hin: 'hi-IN', eng: 'en-IN', kan: 'kn-IN', ben: 'bn-IN', hi: 'hi-IN', en: 'en-IN', kn: 'kn-IN', bn: 'bn-IN' }
export const languageCodeOf = code => (code ? LANGUAGE[String(code).toLowerCase()] || String(code) : null)

// Words the speaker is likely to say that a listener would not know: a client's name, a product, its colours, the
// steps of its plan. ElevenLabs hears them better when told (it calls them keyterms; they cost a little extra).
// Its limits: 50 characters and five words each, and none of < > { } [ ] \.
export const MAX_TERMS = 60
export function cleanTerms(terms) {
  if (!Array.isArray(terms)) return []
  const out = []
  for (const t of terms) {
    if (typeof t !== 'string') continue
    const s = t.replace(/[<>{}[\]\\]/g, ' ').replace(/\s+/g, ' ').trim()
    if (!s || s.length > 50 || s.split(' ').length > 5) continue
    if (!out.some(x => x.toLowerCase() === s.toLowerCase())) out.push(s)
    if (out.length >= MAX_TERMS) break
  }
  return out
}

/** @returns {{transcript: string, languageCode: string|null, languageProbability: number|null}} */
export async function elevenLabsTranscribe(buffer, mimeType, { terms = [], fetchImpl = fetch, env = process.env } = {}) {
  const form = new FormData()
  form.append('file', new Blob([buffer], { type: mimeType }), 'audio')
  form.append('model_id', env.ELEVENLABS_STT_MODEL || 'scribe_v3')
  // No language is named: it works out Hindi, English or a mix by itself. Laughter and noises are left out of the
  // text, and so are ums and false starts: what is wanted is what he meant to say.
  form.append('tag_audio_events', 'false')
  form.append('no_verbatim', 'true')
  for (const t of cleanTerms(terms)) form.append('keyterms', t)
  const res = await fetchImpl(ELEVENLABS_STT_URL, { method: 'POST', headers: { 'xi-api-key': env.ELEVENLABS_API_KEY }, body: form })
  if (!res.ok) {
    const err = new Error(`ElevenLabs speech-to-text failed (${res.status})`)
    err.detail = await res.text().catch(() => '')
    throw err
  }
  const data = await res.json()
  return {
    transcript: (data.text || '').trim(),
    languageCode: languageCodeOf(data.language_code),
    languageProbability: data.language_probability ?? null,
  }
}

/** Speech to text with whichever service this server has. Throws when there is none, or when the service fails. */
export async function transcribeAudio(buffer, mimeType, { terms = [] } = {}) {
  const provider = sttProvider()
  if (provider === 'elevenlabs') return elevenLabsTranscribe(buffer, mimeType, { terms })
  if (provider === 'sarvam') return sarvamTranscribe(buffer, mimeType)
  throw new Error('No speech-to-text service is set up on this server')
}
