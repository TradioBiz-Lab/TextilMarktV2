import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { ttsProvider, elevenLabsSpeak, sarvamSpeak, speak } from '../src/lib/textToSpeech.js'

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
})
