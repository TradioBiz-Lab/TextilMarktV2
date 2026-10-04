// Shared Sarvam speech-to-text call, used by the admin voice route and the
// zero-entry-capture inbound pipeline.
const SARVAM_STT_URL = 'https://api.sarvam.ai/speech-to-text'

/** @returns {{transcript: string, languageCode: string|null, languageProbability: number|null}} */
export async function transcribeAudio(buffer, mimeType) {
  const form = new FormData()
  form.append('file', new Blob([buffer], { type: mimeType }), 'audio')
  form.append('model', 'saaras:v3')
  // language_code intentionally omitted — auto-detects Hindi/English/Kannada/Bengali.
  const res = await fetch(SARVAM_STT_URL, {
    method: 'POST',
    headers: { 'api-subscription-key': process.env.SARVAM_API_KEY },
    body: form,
  })
  if (!res.ok) {
    const err = new Error(`Sarvam STT failed (${res.status})`)
    err.detail = await res.text().catch(() => '')
    throw err
  }
  const data = await res.json()
  return {
    transcript: data.transcript || '',
    languageCode: data.language_code || null,
    languageProbability: data.language_probability ?? null,
  }
}
