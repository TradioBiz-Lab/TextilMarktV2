// Which product a deployment is (PLATFORM_MODE), and that the health check says so, so a deployment's mode can be read from outside.
import test, { before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb } from './helpers/db.js'
import { startServer, stopServer, req } from './helpers/client.js'
import { platformMode, isStandalone } from '../src/lib/platform.js'

before(async () => { await startTestDb(); await startServer() })
after(async () => { delete process.env.PLATFORM_MODE; await stopServer(); await stopTestDb() })
afterEach(() => { delete process.env.PLATFORM_MODE })

const modeOf = value => { if (value === undefined) delete process.env.PLATFORM_MODE; else process.env.PLATFORM_MODE = value; return platformMode() }

test('only the word standalone turns the standalone product on', () => {
  assert.equal(modeOf(undefined), 'tradio')
  for (const v of ['', 'tradio', 'standalone-2', 'stand alone', 'false', '1', '""']) assert.equal(modeOf(v), 'tradio', JSON.stringify(v))
  assert.equal(isStandalone(), false)
})

test('case, stray spaces and quotes around the word are forgiven', () => {
  for (const v of ['standalone', 'Standalone', 'STANDALONE', ' standalone ', '"standalone"', "'Standalone'", ' "standalone" ', '\tstandalone\n']) assert.equal(modeOf(v), 'standalone', JSON.stringify(v))
  assert.equal(isStandalone(), true)
})

test('the health check names the mode', async () => {
  delete process.env.PLATFORM_MODE
  let r = await req('GET', '/api/health')
  assert.equal(r.status, 200)
  assert.equal(r.body.mode, 'tradio')
  process.env.PLATFORM_MODE = ' Standalone '
  r = await req('GET', '/api/health')
  assert.equal(r.body.mode, 'standalone')
})
