import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { sttProvider, languageCodeOf, elevenLabsTranscribe } from '../src/lib/speechToText.js'

describe('which service turns speech into text', () => {
  test('whichever has its key; ElevenLabs when both; none when neither', () => {
    assert.equal(sttProvider({}), null)
    assert.equal(sttProvider({ SARVAM_API_KEY: 's' }), 'sarvam')
    assert.equal(sttProvider({ ELEVENLABS_API_KEY: 'e' }), 'elevenlabs')
    assert.equal(sttProvider({ ELEVENLABS_API_KEY: 'e', SARVAM_API_KEY: 's' }), 'elevenlabs')
  })
  test('VOICE_STT chooses between two keys, and is ignored when its own key is missing', () => {
    assert.equal(sttProvider({ ELEVENLABS_API_KEY: 'e', SARVAM_API_KEY: 's', VOICE_STT: 'sarvam' }), 'sarvam')
    assert.equal(sttProvider({ ELEVENLABS_API_KEY: 'e', SARVAM_API_KEY: 's', VOICE_STT: ' ElevenLabs ' }), 'elevenlabs')
    assert.equal(sttProvider({ SARVAM_API_KEY: 's', VOICE_STT: 'elevenlabs' }), 'sarvam')
    assert.equal(sttProvider({ ELEVENLABS_API_KEY: 'e', VOICE_STT: 'whisper' }), 'elevenlabs')
  })
  test('a language comes back in the form the rest of the app uses', () => {
    assert.equal(languageCodeOf('hin'), 'hi-IN')
    assert.equal(languageCodeOf('ENG'), 'en-IN')
    assert.equal(languageCodeOf('kan'), 'kn-IN')
    assert.equal(languageCodeOf('tam'), 'tam')
    assert.equal(languageCodeOf(null), null)
  })
})

describe('asking ElevenLabs', () => {
  test('sends the clip with the key and the model, and returns the text and language', async () => {
    let seen = null
    const fetchImpl = async (url, opts) => {
      seen = { url, key: opts.headers['xi-api-key'], model: opts.body.get('model_id'), file: opts.body.get('file'), events: opts.body.get('tag_audio_events') }
      return { ok: true, json: async () => ({ text: ' 240 piece stitch ho gaye ', language_code: 'hin', language_probability: 0.97, words: [] }) }
    }
    const out = await elevenLabsTranscribe(Buffer.from('abc'), 'audio/webm', { fetchImpl, env: { ELEVENLABS_API_KEY: 'k-123' } })
    assert.deepEqual(out, { transcript: '240 piece stitch ho gaye', languageCode: 'hi-IN', languageProbability: 0.97 })
    assert.equal(seen.url, 'https://api.elevenlabs.io/v1/speech-to-text')
    assert.deepEqual([seen.key, seen.model, seen.events], ['k-123', 'scribe_v2', 'false'])
    assert.equal(seen.file.type, 'audio/webm')
    assert.equal(seen.file.size, 3)
  })
  test('another model can be named; a refusal is an error that carries what the service said', async () => {
    let model = null
    await elevenLabsTranscribe(Buffer.from('a'), 'audio/wav', { env: { ELEVENLABS_API_KEY: 'k', ELEVENLABS_STT_MODEL: 'scribe_v1' }, fetchImpl: async (_u, o) => { model = o.body.get('model_id'); return { ok: true, json: async () => ({ text: '' }) } } })
    assert.equal(model, 'scribe_v1')
    await assert.rejects(
      elevenLabsTranscribe(Buffer.from('a'), 'audio/wav', { env: { ELEVENLABS_API_KEY: 'bad' }, fetchImpl: async () => ({ ok: false, status: 401, text: async () => '{"detail":"invalid_api_key"}' }) }),
      e => /failed \(401\)/.test(e.message) && /invalid_api_key/.test(e.detail))
  })
})
