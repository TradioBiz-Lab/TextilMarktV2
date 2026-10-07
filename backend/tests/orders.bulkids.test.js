// Bulk order IDs come from the highest existing number, not a document count, so
// dropping a style never makes the next bulk upload collide with a survivor.

import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as } from './helpers/client.js'
import { makeMaster, makeBuyer, makeMfr, makeMasterOrder, orderPayload } from './helpers/factories.js'

before(async () => { await startTestDb(); await startServer() })
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(clearDb)

test('a bulk upload after a drop gets a fresh number, not a collision', async () => {
  const admin = await makeMaster()
  const buyer = await makeBuyer({ code: 'ZAR' })
  const mfr = await makeMfr()
  const mo = await makeMasterOrder({ buyerId: buyer._id, createdBy: admin._id, season: 'FW26' })
  const api = as(admin)
  const row = () => {
    const { id, buyerId, masterOrderId, ...rest } = orderPayload({ buyerId: buyer._id, mfrId: mfr._id })
    return rest
  }

  const first = await api.post('/api/orders/bulk', { masterOrderId: mo._id, rows: [row(), row(), row()] })
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.equal(first.body.created, 3, JSON.stringify(first.body.results))
  const ids = first.body.results.map(r => r.orderId)
  assert.equal(new Set(ids).size, 3)

  // Drop the FIRST one: a count-based number would now repeat the last suffix.
  const dropped = await api.post(`/api/orders/${ids[0]}/delete`, {})
  assert.equal(dropped.status, 200, JSON.stringify(dropped.body))

  const second = await api.post('/api/orders/bulk', { masterOrderId: mo._id, rows: [row(), row()] })
  assert.equal(second.status, 200, JSON.stringify(second.body))
  assert.equal(second.body.failed, 0, JSON.stringify(second.body.results))
  const all = [...ids.slice(1), ...second.body.results.map(r => r.orderId)]
  assert.equal(new Set(all).size, all.length, 'no ID is reused')
})
