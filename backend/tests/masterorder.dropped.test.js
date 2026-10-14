// A master order's page lists the styles dropped from it. Tradio and the master order's own customer see them;
// another customer and the factory do not.

import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as } from './helpers/client.js'
import { makeMaster, makeBuyer, makeMfr, makeMasterOrder, orderPayload } from './helpers/factories.js'

before(async () => { await startTestDb(); await startServer() })
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(clearDb)

async function arrange() {
  const admin = await makeMaster()
  const buyer = await makeBuyer({ company: 'Konexx' })
  const other = await makeBuyer({ company: 'Someone Else' })
  const mfr = await makeMfr()
  const mo = await makeMasterOrder({ buyerId: buyer._id, createdBy: admin._id, orderName: 'Konexx Corporate' })
  for (const id of ['MOD-001', 'MOD-002']) {
    const res = await as(admin).post('/api/orders', orderPayload({ id, buyerId: buyer._id, mfrId: mfr._id, masterOrderId: mo._id, product: 'Red Tee', styleNumber: id }))
    assert.equal(res.status, 201, JSON.stringify(res.body))
  }
  const drop = await as(admin).post('/api/orders/MOD-001/delete', { reason: 'Customer cut the range' })
  assert.equal(drop.status, 200, JSON.stringify(drop.body))
  return { admin, buyer, other, mfr, mo }
}

describe('styles dropped from a master order', () => {
  test('Tradio sees them, with who, when and why, and only light style details', async () => {
    const { admin, mo } = await arrange()
    const res = await as(admin).get(`/api/master-orders/${mo._id}/dropped`)
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.length, 1)
    const r = res.body[0]
    assert.equal(r.refId, 'MOD-001')
    assert.equal(r.label, 'Red Tee (MOD-001)')
    assert.equal(r.reason, 'Customer cut the range')
    assert.equal(r.droppedByName, admin.name)
    assert.equal(r.style.product, 'Red Tee')
    assert.equal(r.style.totalQty, 100)
    assert.equal(r.snapshot, undefined)
  })

  test('the customer sees its own; another customer and the factory do not', async () => {
    const { buyer, other, mfr, mo } = await arrange()
    const own = await as(buyer).get(`/api/master-orders/${mo._id}/dropped`)
    assert.equal(own.status, 200)
    assert.equal(own.body.length, 1)
    assert.equal((await as(other).get(`/api/master-orders/${mo._id}/dropped`)).status, 403)
    assert.equal((await as(mfr).get(`/api/master-orders/${mo._id}/dropped`)).status, 403)
  })

  test('an unknown master order is 404', async () => {
    const { admin } = await arrange()
    assert.equal((await as(admin).get('/api/master-orders/MO-NOPE-001/dropped')).status, 404)
  })
})
