// Reading Kriyaa's replies aloud. Two services can do it: ElevenLabs and Sarvam. ElevenLabs is used when its key and a
// voice are set on this server (unless VOICE_TTS names Sarvam); otherwise Sarvam, when it has a key. With neither,
// spoken replies are off and the route says so.
//
//   ELEVENLABS_API_KEY    the same key speech-to-text uses; it needs the "Text to Speech" permission as well
//   ELEVENLABS_VOICE_ID   the voice Kriyaa speaks in (an id from the account's voice library). No voice, no ElevenLabs.
//   ELEVENLABS_TTS_MODEL  default eleven_v4_turbo: the low-latency model, and one that speaks Hindi, English, Kannada
//                         and Bengali (eleven_flash_v2_5 and eleven_multilingual_v2 have no Kannada or Bengali)
//   VOICE_TTS             'elevenlabs' or 'sarvam', to choose when both are set up
//   SARVAM_API_KEY        use Sarvam
//
// ElevenLabs is called directly (one JSON request, audio back), not through its SDK, for the same reason as
// speech-to-text: the SDK is 122 MB and every deploy uploads the backend's packages.
const ELEVENLABS_TTS_URL = 'https://api.elevenlabs.io/v1/text-to-speech'
const SARVAM_TTS_URL = 'https://api.sarvam.ai/text-to-speech'

// The longest text one request reads (Sarvam's limit; ElevenLabs takes far more). A longer reply is split by the page.
export const MAX_TTS_CHARS = 2500
export const SUPPORTED_LANGUAGES = ['hi-IN', 'kn-IN', 'bn-IN', 'en-IN']
export const DEFAULT_LANGUAGE = 'en-IN'

/** Which service reads replies aloud on this server: 'elevenlabs', 'sarvam', or null for none. */
export function ttsProvider(env = process.env) {
  const has = { elevenlabs: !!env.ELEVENLABS_API_KEY && !!String(env.ELEVENLABS_VOICE_ID || '').trim(), sarvam: !!env.SARVAM_API_KEY }
  const asked = String(env.VOICE_TTS || '').trim().toLowerCase()
  if (has[asked]) return asked
  return has.elevenlabs ? 'elevenlabs' : has.sarvam ? 'sarvam' : null
}

// One voice across every language: a different voice whenever the language changed read as jarring (the same choice
// made for Sarvam's 'priya'). A little brisker than the default pace, as Kriyaa has always spoken.
const ELEVENLABS_SPEED = 1.1

/** ElevenLabs: text in, an MP3 back as a data URL. Throws with `.detail` when the service refuses. */
export async function elevenLabsSpeak(text, languageCode, { fetchImpl = fetch, env = process.env } = {}) {
  const voice = encodeURIComponent(String(env.ELEVENLABS_VOICE_ID).trim())
  const res = await fetchImpl(`${ELEVENLABS_TTS_URL}/${voice}?output_format=mp3_44100_64`, {
    method: 'POST',
    headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text, model_id: env.ELEVENLABS_TTS_MODEL || 'eleven_v4_turbo',
      // The language the reply is in ('hi' from 'hi-IN'): numbers and mixed words are read right. A model that does not
      // take the hint ignores it.
      language_code: String(languageCode || DEFAULT_LANGUAGE).slice(0, 2).toLowerCase(),
      voice_settings: { speed: ELEVENLABS_SPEED },
    }),
  })
  if (!res.ok) {
    const err = new Error(`ElevenLabs TTS failed (${res.status})`)
    err.detail = (await res.text().catch(() => '')).slice(0, 400)
    throw err
  }
  const bytes = Buffer.from(await res.arrayBuffer())
  if (!bytes.length) throw new Error('ElevenLabs TTS returned no audio')
  return { audioDataUrl: `data:audio/mpeg;base64,${bytes.toString('base64')}` }
}

// Sarvam: one speaker ('priya', lowercase: Sarvam's names are case-sensitive) on bulbul:v3, a little brisk and a
// little warmer than its defaults. It answers with base64 WAV.
export async function sarvamSpeak(text, languageCode, { fetchImpl = fetch, env = process.env } = {}) {
  const res = await fetchImpl(SARVAM_TTS_URL, {
    method: 'POST',
    headers: { 'api-subscription-key': env.SARVAM_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, language_code: languageCode, speaker: 'priya', model: 'bulbul:v3', pace: 1.15, temperature: 0.9 }),
  })
  if (!res.ok) {
    const err = new Error(`Sarvam TTS failed (${res.status})`)
    err.detail = (await res.text().catch(() => '')).slice(0, 400)
    throw err
  }
  const audio = (await res.json()).audios?.[0]
  if (!audio) throw new Error('Sarvam TTS returned no audio')
  return { audioDataUrl: `data:audio/wav;base64,${audio}` }
}

/** Reads `text` aloud with whichever service this server uses. Returns { audioDataUrl }. */
export async function speak(text, languageCode, opts = {}) {
  const lang = SUPPORTED_LANGUAGES.includes(languageCode) ? languageCode : DEFAULT_LANGUAGE
  return ttsProvider(opts.env || process.env) === 'elevenlabs' ? elevenLabsSpeak(text, lang, opts) : sarvamSpeak(text, lang, opts)
}
