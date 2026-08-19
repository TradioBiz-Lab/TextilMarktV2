// Real HTTP tests for POST /api/assistant/chat — auth/permission gating and
// the "not configured" path, all without ever calling the Anthropic SDK
// (these tests never send a real ANTHROPIC_API_KEY, so a real chat turn is
// never attempted here — see the plan's manual smoke-test script for that).

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

describe('POST /api/assistant/chat', () => {
  test('401 with no auth', async () => {
    const { status } = await req('POST', '/api/assistant/chat', { body: { messages: [{ role: 'user', content: 'hi' }] } })
    assert.equal(status, 401)
  })

  // Kriyaa is now open to all three roles — a buyer/manufacturer reaches
  // exactly as far as an admin does with no API key configured (503, not
  // 403). Reuses the same real-503-no-mock-SDK pattern as the test below,
  // proving these roles now pass the auth gate rather than being blocked
  // at the door.
  test('a buyer reaches past the auth gate (503 config-missing, not 403)', async () => {
    const original = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      const buyer = await makeBuyer()
      const { status, body } = await as(buyer).post('/api/assistant/chat', { messages: [{ role: 'user', content: 'hi' }] })
      assert.equal(status, 503)
      assert.match(body.error, /not configured/i)
    } finally {
      if (original !== undefined) process.env.ANTHROPIC_API_KEY = original
    }
  })

  test('a manufacturer reaches past the auth gate (503 config-missing, not 403)', async () => {
    const original = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      const mfr = await makeMfr()
      const { status, body } = await as(mfr).post('/api/assistant/chat', { messages: [{ role: 'user', content: 'hi' }] })
      assert.equal(status, 503)
      assert.match(body.error, /not configured/i)
    } finally {
      if (original !== undefined) process.env.ANTHROPIC_API_KEY = original
    }
  })

  test('503 when ANTHROPIC_API_KEY is unset', async () => {
    // app.js's `import 'dotenv/config'` (its literal first line) loads the real
    // backend/.env even under NODE_ENV=test, so this must explicitly clear
    // whatever the developer's local .env happens to contain — otherwise this
    // test's pass/fail would depend on the machine it runs on.
    const original = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      const admin = await makeAdmin()
      const { status, body } = await as(admin).post('/api/assistant/chat', { messages: [{ role: 'user', content: 'hi' }] })
      assert.equal(status, 503)
      assert.match(body.error, /not configured/i)
    } finally {
      if (original !== undefined) process.env.ANTHROPIC_API_KEY = original
    }
  })

  test('400 on an empty messages array', async () => {
    const original = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'sk-ant-fake-key-for-validation-test-only'
    try {
      const admin = await makeAdmin()
      const { status } = await as(admin).post('/api/assistant/chat', { messages: [] })
      assert.equal(status, 400)
    } finally {
      if (original === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = original
    }
  })

  test('400 on an oversized message', async () => {
    const original = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'sk-ant-fake-key-for-validation-test-only'
    try {
      const admin = await makeAdmin()
      const { status } = await as(admin).post('/api/assistant/chat', {
        messages: [{ role: 'user', content: 'x'.repeat(8001) }],
      })
      assert.equal(status, 400)
    } finally {
      if (original === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = original
    }
  })
})
