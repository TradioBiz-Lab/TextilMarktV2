// GET /api/health is what the runbook uses to check a deploy from outside: database up, which Node it runs, and which
// service Kriyaa's voice goes through (names only, so a key that did not reach the server can be seen without signing in).
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startTestDb, stopTestDb } from './helpers/db.js'
import { startServer, stopServer } from './helpers/client.js'

let base
before(async () => { await startTestDb(); base = await startServer() })
after(async () => { await stopServer(); await stopTestDb() })

test('health reports the database, the Node major version and the voice services, nothing more', async () => {
  const res = await fetch(`${base}/api/health`)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.db, 'connected')
  assert.equal(body.node, process.versions.node.split('.')[0])
  assert.deepEqual(Object.keys(body).sort(), ['assistant', 'db', 'node', 'ok', 'uptime', 'voice'])
  assert.deepEqual(body.assistant, { lastProblem: null })
  assert.deepEqual(Object.keys(body.voice).sort(), ['lastProblem', 'listen', 'speak'])
  assert.deepEqual(body.voice.lastProblem, { listen: null, speak: null })
  assert.ok(!/sk_|key/i.test(JSON.stringify(body)), 'no key, and nothing named like one')
})
