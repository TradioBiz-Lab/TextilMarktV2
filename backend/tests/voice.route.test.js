// Real HTTP tests for POST /api/voice/transcribe and POST /api/voice/speak —
// auth/permission gating and validation only, all without ever calling
// Sarvam (these tests never send a real SARVAM_API_KEY, so a real voice
// request is never attempted here — see the plan's manual smoke-test
// script for that), mirroring assistant.route.test.js's own scope.

import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as, req } from './helpers/client.js'
import { makeAdmin, makeBuyer, makeMfr } from './helpers/factories.js'

before(async () => {
  await startTestDb()
  await startServer()
})
after(async () => {
  await stopServer()
  await stopTestDb()
})
beforeEach(clearDb)

const SAMPLE_AUDIO_DATA_URL = 'data:audio/webm;base64,AAAA'

describe('POST /api/voice/transcribe', () => {
  test('401 with no auth', async () => {
    const { status } = await req('POST', '/api/voice/transcribe', { body: { audioDataUrl: SAMPLE_AUDIO_DATA_URL } })
    assert.equal(status, 401)
  })

  test('403 for a buyer', async () => {
    const buyer = await makeBuyer()
    const { status } = await as(buyer).post('/api/voice/transcribe', { audioDataUrl: SAMPLE_AUDIO_DATA_URL })
    assert.equal(status, 403)
  })

  test('403 for a manufacturer', async () => {
    const mfr = await makeMfr()
    const { status } = await as(mfr).post('/api/voice/transcribe', { audioDataUrl: SAMPLE_AUDIO_DATA_URL })
    assert.equal(status, 403)
  })

  test('503 when SARVAM_API_KEY is unset', async () => {
    // app.js's `import 'dotenv/config'` loads the real backend/.env even
    // under NODE_ENV=test, so this must explicitly clear whatever the
    // developer's local .env happens to contain.
    const original = process.env.SARVAM_API_KEY
    delete process.env.SARVAM_API_KEY
    try {
      const admin = await makeAdmin()
      const { status, body } = await as(admin).post('/api/voice/transcribe', { audioDataUrl: SAMPLE_AUDIO_DATA_URL })
      assert.equal(status, 503)
      assert.match(body.error, /not configured/i)
    } finally {
      if (original !== undefined) process.env.SARVAM_API_KEY = original
    }
  })

  test('400 on a missing audioDataUrl', async () => {
    const original = process.env.SARVAM_API_KEY
    process.env.SARVAM_API_KEY = 'fake-key-for-validation-test-only'
    try {
      const admin = await makeAdmin()
      const { status } = await as(admin).post('/api/voice/transcribe', {})
      assert.equal(status, 400)
    } finally {
      if (original === undefined) delete process.env.SARVAM_API_KEY
      else process.env.SARVAM_API_KEY = original
    }
  })

  test('400 on a non-audio mime type', async () => {
    const original = process.env.SARVAM_API_KEY
    process.env.SARVAM_API_KEY = 'fake-key-for-validation-test-only'
    try {
      const admin = await makeAdmin()
      const { status } = await as(admin).post('/api/voice/transcribe', { audioDataUrl: 'data:text/html;base64,AAAA' })
      assert.equal(status, 400)
    } finally {
      if (original === undefined) delete process.env.SARVAM_API_KEY
      else process.env.SARVAM_API_KEY = original
    }
  })

  test('400 on a malformed data URL', async () => {
    const original = process.env.SARVAM_API_KEY
    process.env.SARVAM_API_KEY = 'fake-key-for-validation-test-only'
    try {
      const admin = await makeAdmin()
      const { status } = await as(admin).post('/api/voice/transcribe', { audioDataUrl: 'not-a-data-url' })
      assert.equal(status, 400)
    } finally {
      if (original === undefined) delete process.env.SARVAM_API_KEY
      else process.env.SARVAM_API_KEY = original
    }
  })

  // Regression: MediaRecorder's mimeType commonly carries a codec parameter
  // (e.g. 'audio/webm;codecs=opus'), which lands in the data URL as
  // 'data:audio/webm;codecs=opus;base64,...'. That must still validate —
  // it's not a malformed payload, just a mime type with a parameter. Uses a
  // fake key so this exercises validation only; the eventual Sarvam call
  // (502, not asserted here) is expected to fail against a fake key.
  test('accepts a data URL with a codec parameter (not a 400)', async () => {
    const original = process.env.SARVAM_API_KEY
    process.env.SARVAM_API_KEY = 'fake-key-for-validation-test-only'
    try {
      const admin = await makeAdmin()
      const { status } = await as(admin).post('/api/voice/transcribe', { audioDataUrl: 'data:audio/webm;codecs=opus;base64,AAAA' })
      assert.notEqual(status, 400)
    } finally {
      if (original === undefined) delete process.env.SARVAM_API_KEY
      else process.env.SARVAM_API_KEY = original
    }
  })
})

describe('POST /api/voice/speak', () => {
  test('401 with no auth', async () => {
    const { status } = await req('POST', '/api/voice/speak', { body: { text: 'hi', languageCode: 'en-IN' } })
    assert.equal(status, 401)
  })

  test('403 for a buyer', async () => {
    const buyer = await makeBuyer()
    const { status } = await as(buyer).post('/api/voice/speak', { text: 'hi', languageCode: 'en-IN' })
    assert.equal(status, 403)
  })

  test('403 for a manufacturer', async () => {
    const mfr = await makeMfr()
    const { status } = await as(mfr).post('/api/voice/speak', { text: 'hi', languageCode: 'en-IN' })
    assert.equal(status, 403)
  })

  test('503 when SARVAM_API_KEY is unset', async () => {
    const original = process.env.SARVAM_API_KEY
    delete process.env.SARVAM_API_KEY
    try {
      const admin = await makeAdmin()
      const { status, body } = await as(admin).post('/api/voice/speak', { text: 'hi', languageCode: 'en-IN' })
      assert.equal(status, 503)
      assert.match(body.error, /not configured/i)
    } finally {
      if (original !== undefined) process.env.SARVAM_API_KEY = original
    }
  })

  test('400 on missing text', async () => {
    const original = process.env.SARVAM_API_KEY
    process.env.SARVAM_API_KEY = 'fake-key-for-validation-test-only'
    try {
      const admin = await makeAdmin()
      const { status } = await as(admin).post('/api/voice/speak', { languageCode: 'en-IN' })
      assert.equal(status, 400)
    } finally {
      if (original === undefined) delete process.env.SARVAM_API_KEY
      else process.env.SARVAM_API_KEY = original
    }
  })

  test('400 on text over the 2500-char TTS limit', async () => {
    const original = process.env.SARVAM_API_KEY
    process.env.SARVAM_API_KEY = 'fake-key-for-validation-test-only'
    try {
      const admin = await makeAdmin()
      const { status } = await as(admin).post('/api/voice/speak', { text: 'x'.repeat(2501), languageCode: 'en-IN' })
      assert.equal(status, 400)
    } finally {
      if (original === undefined) delete process.env.SARVAM_API_KEY
      else process.env.SARVAM_API_KEY = original
    }
  })
})
