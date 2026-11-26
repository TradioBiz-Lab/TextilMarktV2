import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { ttsProvider, elevenLabsSpeak, sarvamSpeak, speak } from '../src/lib/textToSpeech.js'
import { voiceProblems } from '../src/lib/voiceStatus.js'

describe('which service reads replies aloud', () => {
  test('ElevenLabs needs its key and a voice; Sarvam its key; none when neither', () => {
    assert.equal(ttsProvider({}), null)
    assert.equal(ttsProvider({ SARVAM_API_KEY: 's' }), 'sarvam')
    assert.equal(ttsProvider({ ELEVENLABS_API_KEY: 'e' }), null, 'a key with no voice cannot speak')
    assert.equal(ttsProvider({ ELEVENLABS_API_KEY: 'e', SARVAM_API_KEY: 's' }), 'sarvam')
    assert.equal(ttsProvider({ ELEVENLABS_API_KEY: 'e', ELEVENLABS_VOICE_ID: 'v' }), 'elevenlabs')
    assert.equal(ttsProvider({ ELEVENLABS_API_KEY: 'e', ELEVENLABS_VOICE_ID: 'v', SARVAM_API_KEY: 's' }), 'elevenlabs')
  })
  test('VOICE_TTS chooses between the two, and is ignored when its own service is not set up', () => {
    const both = { ELEVENLABS_API_KEY: 'e', ELEVENLABS_VOICE_ID: 'v', SARVAM_API_KEY: 's' }
    assert.equal(ttsProvider({ ...both, VOICE_TTS: 'sarvam' }), 'sarvam')
    assert.equal(ttsProvider({ ...both, VOICE_TTS: ' ElevenLabs ' }), 'elevenlabs')
    assert.equal(ttsProvider({ SARVAM_API_KEY: 's', VOICE_TTS: 'elevenlabs' }), 'sarvam')
  })
})

describe('asking ElevenLabs to speak', () => {
  test('sends the text, the voice, the model and the language, and returns the audio as a data URL', async () => {
    let seen = null
    const fetchImpl = async (url, opts) => { seen = { url, key: opts.headers['xi-api-key'], body: JSON.parse(opts.body) }; return { ok: true, arrayBuffer: async () => Uint8Array.from([73, 68, 51]).buffer } }
    const out = await elevenLabsSpeak('240 पीस बन गए', 'hi-IN', { fetchImpl, env: { ELEVENLABS_API_KEY: 'k-1', ELEVENLABS_VOICE_ID: ' voice 1 ' } })
    assert.equal(seen.url, 'https://api.elevenlabs.io/v1/text-to-speech/voice%201?output_format=mp3_44100_64')
    assert.deepEqual([seen.key, seen.body.text, seen.body.model_id, seen.body.language_code, seen.body.voice_settings.speed], ['k-1', '240 पीस बन गए', 'eleven_v4_turbo', 'hi', 1.1])
    assert.equal(out.audioDataUrl, `data:audio/mpeg;base64,${Buffer.from('ID3').toString('base64')}`)
    await elevenLabsSpeak('x', 'en-IN', { fetchImpl, env: { ELEVENLABS_API_KEY: 'k', ELEVENLABS_VOICE_ID: 'v', ELEVENLABS_TTS_MODEL: 'eleven_flash_v2_5' } })
    assert.deepEqual([seen.body.model_id, seen.body.language_code], ['eleven_flash_v2_5', 'en'])
  })
  test('a refusal is thrown with what the service said, and never the key', async () => {
    const fetchImpl = async () => ({ ok: false, status: 401, text: async () => '{"detail":{"status":"missing_permissions"}}' })
    await assert.rejects(elevenLabsSpeak('x', 'en-IN', { fetchImpl, env: { ELEVENLABS_API_KEY: 'secret-key', ELEVENLABS_VOICE_ID: 'v' } }), e => /ElevenLabs TTS failed \(401\)/.test(e.message) && /missing_permissions/.test(e.detail) && !/secret-key/.test(e.message + e.detail))
    await assert.rejects(elevenLabsSpeak('x', 'en-IN', { fetchImpl: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) }), env: { ELEVENLABS_API_KEY: 'k', ELEVENLABS_VOICE_ID: 'v' } }), /no audio/)
  })
})

describe('speaking with whichever service is set up', () => {
  test('Sarvam keeps its speaker and settings; an unknown language is spoken as English', async () => {
    let seen = null
    const fetchImpl = async (url, opts) => { seen = { url, body: JSON.parse(opts.body) }; return { ok: true, json: async () => ({ audios: ['QUJD'] }) } }
    assert.deepEqual(await sarvamSpeak('hi', 'hi-IN', { fetchImpl, env: { SARVAM_API_KEY: 's' } }), { audioDataUrl: 'data:audio/wav;base64,QUJD' })
    assert.deepEqual([seen.url, seen.body.speaker, seen.body.model, seen.body.language_code], ['https://api.sarvam.ai/text-to-speech', 'priya', 'bulbul:v3', 'hi-IN'])
    await speak('hi', 'ta-IN', { fetchImpl, env: { SARVAM_API_KEY: 's' } })
    assert.equal(seen.body.language_code, 'en-IN')
    const el = async (url, opts) => { seen = { url, body: JSON.parse(opts.body) }; return { ok: true, arrayBuffer: async () => Uint8Array.from([1]).buffer } }
    await speak('hi', 'kn-IN', { fetchImpl: el, env: { ELEVENLABS_API_KEY: 'k', ELEVENLABS_VOICE_ID: 'v', SARVAM_API_KEY: 's' } })
    assert.deepEqual([seen.url.startsWith('https://api.elevenlabs.io/'), seen.body.language_code], [true, 'kn'])
  })

  test('when ElevenLabs refuses: another model for Hindi and English, then Sarvam; a refusal about the key goes straight to Sarvam', async () => {
    const env = { ELEVENLABS_API_KEY: 'k', ELEVENLABS_VOICE_ID: 'v', SARVAM_API_KEY: 's' }
    const calls = []
    // The first model is not available to this account; the second works.
    const modelMissing = async (url, opts) => { const b = JSON.parse(opts.body); calls.push(b.model_id || 'sarvam'); return b.model_id === 'eleven_v4_turbo' ? { ok: false, status: 400, text: async () => '{"detail":{"status":"model_not_found"}}' } : { ok: true, arrayBuffer: async () => Uint8Array.from([1]).buffer } }
    assert.match((await speak('hi', 'hi-IN', { fetchImpl: modelMissing, env })).audioDataUrl, /^data:audio\/mpeg/)
    assert.deepEqual(calls, ['eleven_v4_turbo', 'eleven_flash_v2_5'])
    // Kannada: the older models do not speak it, so Sarvam is next.
    calls.length = 0
    const allRefuse = async (url, opts) => { const b = JSON.parse(opts.body); calls.push(b.model_id || 'sarvam'); return url.includes('elevenlabs') ? { ok: false, status: 400, text: async () => '{}' } : { ok: true, json: async () => ({ audios: ['QUJD'] }) } }
    assert.match((await speak('hi', 'kn-IN', { fetchImpl: allRefuse, env })).audioDataUrl, /^data:audio\/wav/)
    assert.deepEqual(calls, ['eleven_v4_turbo', 'sarvam'])
    // The key lacks the permission: no point trying other models.
    calls.length = 0
    const noPermission = async (url, opts) => { const b = JSON.parse(opts.body); calls.push(b.model_id || 'sarvam'); return url.includes('elevenlabs') ? { ok: false, status: 401, text: async () => '{"detail":{"status":"missing_permissions"}}' } : { ok: true, json: async () => ({ audios: ['QUJD'] }) } }
    await speak('hi', 'en-IN', { fetchImpl: noPermission, env })
    assert.deepEqual(calls, ['eleven_v4_turbo', 'sarvam'])
    assert.deepEqual([voiceProblems().speak.service, voiceProblems().speak.status, voiceProblems().speak.code], ['elevenlabs', 401, 'missing_permissions'], 'what was refused is kept for the health check')
    await assert.rejects(speak('hi', 'en-IN', { fetchImpl: noPermission, env: { ELEVENLABS_API_KEY: 'k', ELEVENLABS_VOICE_ID: 'v' } }), /ElevenLabs TTS failed \(401\)/, 'with no Sarvam key the failure is passed on')
  })
})

