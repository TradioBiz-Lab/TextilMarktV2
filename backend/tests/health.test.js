// GET /api/health is what the runbook uses to check a deploy from outside: database up, and which Node it runs.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startTestDb, stopTestDb } from './helpers/db.js'
import { startServer, stopServer } from './helpers/client.js'

let base
before(async () => { await startTestDb(); base = await startServer() })
after(async () => { await stopServer(); await stopTestDb() })

test('health reports the database and the Node major version, nothing more', async () => {
  const res = await fetch(`${base}/api/health`)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.db, 'connected')
  assert.equal(body.node, process.versions.node.split('.')[0])
  assert.deepEqual(Object.keys(body).sort(), ['db', 'node', 'ok', 'uptime'])
})
