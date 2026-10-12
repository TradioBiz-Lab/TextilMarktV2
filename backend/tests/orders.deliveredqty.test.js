// The actual delivered quantity of a split: who may record it, validation, and that it never rewrites the order qty.

import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as } from './helpers/client.js'
import { makeMaster, makeBuyer, makeMfr, orderPayload } from './helpers/factories.js'
import { Order } from '../src/models/Order.js'
import { Notification } from '../src/models/Notification.js'
import { AuditLog } from '../src/models/AuditLog.js'

before(async () => { await startTestDb(); await startServer() })
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(clearDb)

const ORDER_ID = 'DQ-TEST-001'

async function arrange() {
  const master = await makeMaster()
  const buyer = await makeBuyer()
  const mfr = await makeMfr()
  const otherMfr = await makeMfr()
  const res = await as(master).post('/api/orders', orderPayload({
    id: ORDER_ID, buyerId: buyer._id, mfrId: mfr._id, totalQty: 453, stageNames: ['Cutting'],
    stageStartDates: ['2026-07-01'], stageEtas: ['2026-07-10'],
  }))
  assert.equal(res.status, 201, JSON.stringify(res.body))
  await Notification.deleteMany({})
  const url = `/api/orders/${ORDER_ID}/assignments/${mfr._id}/delivered-qty`
  const stored = async () => (await Order.findById(ORDER_ID).lean()).assignments[0]
  return { master, buyer, mfr, otherMfr, url, stored, api: as(master) }
}

describe('recording the delivered quantity', () => {
  test('admin records it; it is exposed and the order quantity is untouched', async () => {
    const { url, api, stored } = await arrange()
    const res = await api.post(url, { deliveredQty: 430 })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.assignments[0].deliveredQty, 430)
    assert.equal(res.body.assignments[0].qty, 453)
    const a = await stored()
    assert.equal(a.deliveredQty, 430)
    assert.equal(a.qty, 453)
    const read = await api.get(`/api/orders/${ORDER_ID}`)
    assert.equal(read.body.assignments[0].deliveredQty, 430)
  })

  test('is null until recorded, and can be cleared', async () => {
    const { url, api, stored } = await arrange()
    assert.equal((await api.get(`/api/orders/${ORDER_ID}`)).body.assignments[0].deliveredQty, null)
    await api.post(url, { deliveredQty: 100 })
    assert.equal((await api.post(url, { deliveredQty: null })).status, 200)
    assert.equal((await stored()).deliveredQty, null)
  })

  test('the split\'s own manufacturer may record it, and the customer and admins are told', async () => {
    const { master, buyer, mfr, url } = await arrange()
    const res = await as(mfr).post(url, { deliveredQty: 450 })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    const heard = async u => (await Notification.find({ toUser: u._id }).lean()).map(n => n.msg)
    assert.ok((await heard(buyer)).some(m => /450 pcs \(3 short of 453 ordered\)/.test(m)))
    assert.ok((await heard(master)).some(m => /450 pcs/.test(m)))
  })

  test('a different manufacturer and the customer may not', async () => {
    const { buyer, otherMfr, url, stored } = await arrange()
    assert.equal((await as(otherMfr).post(url, { deliveredQty: 1 })).status, 403)
    assert.equal((await as(buyer).post(url, { deliveredQty: 1 })).status, 403)
    assert.equal((await stored()).deliveredQty, null)
  })

  test('over-delivery is allowed and described as such', async () => {
    const { url, api } = await arrange()
    assert.equal((await api.post(url, { deliveredQty: 460 })).status, 200)
    const log = await AuditLog.findOne({ action: 'Delivered Quantity Updated' }).lean()
    assert.match(log.detail, /delivered 460 \(7 over 453 ordered\)/)
  })

  test('rejects negatives, fractions and text, and 404s for an unknown split', async () => {
    const { url, api, otherMfr } = await arrange()
    for (const v of [-1, 2.5, 'abc', 1e10]) assert.equal((await api.post(url, { deliveredQty: v })).status, 400, `value ${v}`)
    assert.equal((await api.post(`/api/orders/NOPE/assignments/${otherMfr._id}/delivered-qty`, { deliveredQty: 1 })).status, 404)
    assert.equal((await api.post(`/api/orders/${ORDER_ID}/assignments/${otherMfr._id}/delivered-qty`, { deliveredQty: 1 })).status, 404)
  })

  test('zero is a real value (nothing delivered), not "not recorded"', async () => {
    const { url, api, stored } = await arrange()
    assert.equal((await api.post(url, { deliveredQty: 0 })).status, 200)
    assert.equal((await stored()).deliveredQty, 0)
  })
})
