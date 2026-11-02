// "Order replen": a customer (or Tradio) reorders a style that is in production. The new style is a copy of the product in
// the Replen stage with the asked quantity, in the same master order, with no factory. Tradio creates it at once; a
// customer's order is a request that a master admin approves (see styleRequests.test.js for the queue itself).

import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as } from './helpers/client.js'
import { makeMaster, makeBuyer, makeMfr, makeMasterOrder } from './helpers/factories.js'
import { Order } from '../src/models/Order.js'
import { Notification } from '../src/models/Notification.js'
import { StyleRequest } from '../src/models/StyleRequest.js'

before(async () => { await startTestDb(); await startServer() })
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(clearDb)

const PHOTO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg=='

async function arrange(extra = {}) {
  const admin = await makeMaster()
  const buyer = await makeBuyer({ company: 'Cocoblu' })
  const mo = await makeMasterOrder({ buyerId: buyer._id, createdBy: admin._id, season: 'SS26' })
  const made = await as(admin).post('/api/orders', {
    id: 'SRC-001', buyerId: String(buyer._id), masterOrderId: mo._id, product: 'Midi Dress', styleNumber: 'FYL-4002', category: 'DRESS', season: 'SS26',
    phase: 'production', totalQty: 500, brand: 'FYLTR', ecommerceLink: 'https://amazon.in/dp/1', techPackLink: 'https://drive.example.com/tp',
    colourways: [{ name: 'Blue' }], fabricDetails: [{ name: 'Cotton Poplin', composition: '100% Cotton' }], photos: [{ image: PHOTO }], ...extra,
  })
  assert.equal(made.status, 201, JSON.stringify(made.body))
  return { admin, buyer, mo }
}

describe('ordering a replen', () => {
  test('a customer\'s replen is a request: nothing is created until a master admin approves, and then it is a copy in Replen with the quantity, unassigned', async () => {
    const { admin, buyer, mo } = await arrange()
    const sent = await as(buyer).post('/api/orders/SRC-001/replen', { quantity: 1200, note: 'Same as last time' })
    assert.equal(sent.status, 202, JSON.stringify(sent.body))
    assert.equal(sent.body.pending, true)
    assert.equal(await Order.countDocuments({ replenOf: 'SRC-001' }), 0)
    const asked = await Notification.find({ toUser: admin._id, msg: /asked for a replen/ }).lean()
    assert.equal(asked.length, 1)
    assert.match(asked[0].msg, /Cocoblu asked for a replen of Midi Dress/)
    assert.match(asked[0].msg, /1,200 pcs/)

    const res = await as(admin).post(`/api/style-requests/${sent.body.requestId}/approve`)
    assert.equal(res.status, 200, JSON.stringify(res.body))
    const o = await Order.findById(res.body.created[0].id).lean()
    assert.deepEqual([o.phase, o.totalQty, o.masterOrderId, o.replenOf], ['replen', 1200, mo._id, 'SRC-001'])
    assert.deepEqual([o.product, o.styleNumber, o.brand, o.category, o.season], ['Midi Dress', 'FYL-4002', 'FYLTR', 'DRESS', 'SS26'])
    assert.deepEqual([o.ecommerceLink, o.techPackLink, o.callout], ['https://amazon.in/dp/1', 'https://drive.example.com/tp', 'Same as last time'])
    assert.equal(o.colourways[0].name, 'Blue')
    assert.equal(o.fabricDetails[0].composition, '100% Cotton')
    assert.equal(o.photos[0].image, PHOTO)
    assert.equal(o.assignments.length, 0)
    assert.equal(o.delivery, null)
    assert.equal((await Order.findById('SRC-001').lean()).phase, 'production')
    assert.equal((await StyleRequest.findById(sent.body.requestId).lean()).status, 'approved')
  })

  test('Tradio can reorder for a customer, and the customer is told', async () => {
    const { admin, buyer } = await arrange()
    const res = await as(admin).post('/api/orders/SRC-001/replen', { quantity: 300 })
    assert.equal(res.status, 201, JSON.stringify(res.body))
    assert.equal(res.body.phase, 'replen')
    assert.equal(await Notification.countDocuments({ toUser: buyer._id, msg: /replen/i }), 1)
    assert.equal(await StyleRequest.countDocuments(), 0, 'Tradio does not go through the queue')
  })

  test('refused: another customer\'s style, a factory, a style not in production, and a bad quantity or note', async () => {
    const { admin, buyer } = await arrange()
    const other = await makeBuyer()
    assert.equal((await as(other).post('/api/orders/SRC-001/replen', { quantity: 10 })).status, 404)
    assert.equal((await as(await makeMfr()).post('/api/orders/SRC-001/replen', { quantity: 10 })).status, 403)
    for (const quantity of [0, -5, 1.5, 'lots', undefined, 20_000_000]) assert.equal((await as(buyer).post('/api/orders/SRC-001/replen', { quantity })).status, 400, String(quantity))
    assert.equal((await as(buyer).post('/api/orders/SRC-001/replen', { quantity: 10, note: 'x'.repeat(501) })).status, 400)
    const npd = await as(admin).post('/api/orders', { id: 'NPD-1', buyerId: String(buyer._id), product: 'New', category: 'TOP', season: 'SS26', phase: 'development' })
    assert.equal(npd.status, 201)
    assert.equal((await as(buyer).post('/api/orders/NPD-1/replen', { quantity: 10 })).status, 400)
    assert.equal(await Order.countDocuments({ replenOf: { $ne: null } }), 0)
    assert.equal(await StyleRequest.countDocuments(), 0)
  })

  test('sending the same request twice in a moment is caught, for a customer and for Tradio', async () => {
    const { admin, buyer } = await arrange()
    assert.equal((await as(buyer).post('/api/orders/SRC-001/replen', { quantity: 10 })).status, 202)
    assert.equal((await as(buyer).post('/api/orders/SRC-001/replen', { quantity: 10 })).status, 409)
    assert.equal(await StyleRequest.countDocuments(), 1)
    assert.equal((await as(admin).post('/api/orders/SRC-001/replen', { quantity: 10 })).status, 201)
    assert.equal((await as(admin).post('/api/orders/SRC-001/replen', { quantity: 10 })).status, 409)
    assert.equal(await Order.countDocuments({ replenOf: 'SRC-001' }), 1)
  })

  test('a style with only a single photo link (no gallery) is copied with it', async () => {
    const admin = await makeMaster()
    const buyer = await makeBuyer()
    const made = await as(admin).post('/api/orders', { id: 'SRC-002', buyerId: String(buyer._id), product: 'Skirt', category: 'SKIRT', season: 'SS26', phase: 'production', totalQty: 50, imageUrl: 'https://img.example.com/s.jpg' })
    assert.equal(made.status, 201, JSON.stringify(made.body))
    const res = await as(admin).post('/api/orders/SRC-002/replen', { quantity: 20 })
    assert.equal(res.status, 201, JSON.stringify(res.body))
    assert.equal((await Order.findById(res.body.id).lean()).imageUrl, 'https://img.example.com/s.jpg')
  })
})
