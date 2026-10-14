// A style can move to another master order of the same customer, and only of the same customer.

import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as } from './helpers/client.js'
import { makeMaster, makeBuyer, makeMfr, makeMasterOrder, orderPayload } from './helpers/factories.js'
import { Order } from '../src/models/Order.js'

before(async () => { await startTestDb(); await startServer() })
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(clearDb)

async function arrange() {
  const admin = await makeMaster()
  const buyer = await makeBuyer()
  const other = await makeBuyer()
  const mfr = await makeMfr()
  const from = await makeMasterOrder({ buyerId: buyer._id, createdBy: admin._id, orderName: 'H1' })
  const to = await makeMasterOrder({ buyerId: buyer._id, createdBy: admin._id, orderName: 'H2' })
  const foreign = await makeMasterOrder({ buyerId: other._id, createdBy: admin._id, orderName: 'Elsewhere' })
  const res = await as(admin).post('/api/orders', orderPayload({ id: 'MV-001', buyerId: buyer._id, mfrId: mfr._id, masterOrderId: from._id }))
  assert.equal(res.status, 201, JSON.stringify(res.body))
  return { admin, mfr, from, to, foreign }
}

describe('moving a style between master orders', () => {
  test('to another master order of the same customer', async () => {
    const { admin, to } = await arrange()
    const res = await as(admin).post('/api/orders/MV-001', { masterOrderId: to._id })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.masterOrderId, String(to._id))
    assert.equal((await Order.findById('MV-001').lean()).masterOrderId, String(to._id))
  })

  test('never to another customer\'s, an unknown one or an empty value', async () => {
    const { admin, from, foreign } = await arrange()
    assert.equal((await as(admin).post('/api/orders/MV-001', { masterOrderId: foreign._id })).status, 400)
    assert.equal((await as(admin).post('/api/orders/MV-001', { masterOrderId: 'MO-NOPE-001' })).status, 404)
    assert.equal((await as(admin).post('/api/orders/MV-001', { masterOrderId: '' })).status, 400)
    assert.equal((await Order.findById('MV-001').lean()).masterOrderId, String(from._id))
  })

  test('a factory cannot move a style', async () => {
    const { mfr, to } = await arrange()
    assert.equal((await as(mfr).post('/api/orders/MV-001', { masterOrderId: to._id })).status, 403)
  })
})
