// Replen is a reorder of an existing style (for now, work moved over from another company). It behaves exactly like New
// Product Development: no delivery date or Delivery step yet, quantity can wait, and it moves into production the same way.

import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as } from './helpers/client.js'
import { makeMaster, makeBuyer, makeMfr } from './helpers/factories.js'
import { Order } from '../src/models/Order.js'
import { isPreProduction, ORDER_PHASES } from '../src/lib/phases.js'

before(async () => { await startTestDb(); await startServer() })
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(clearDb)

const payload = (buyer, extra = {}) => ({ id: 'RP-001', buyerId: String(buyer._id), product: 'Replen Hoodie', category: 'HOODIE', season: 'FW26', totalQty: 100, phase: 'replen', ...extra })

describe('the phases', () => {
  test('replen and development are before production, production is not', () => {
    assert.deepEqual(ORDER_PHASES, ['development', 'replen', 'production'])
    assert.equal(isPreProduction('replen'), true)
    assert.equal(isPreProduction('development'), true)
    assert.equal(isPreProduction('production'), false)
    assert.equal(isPreProduction(undefined), false)
  })
})

describe('a replen style', () => {
  test('is created as replen, with no delivery date and quantity allowed to wait', async () => {
    const master = await makeMaster()
    const buyer = await makeBuyer()
    const made = await as(master).post('/api/orders', payload(buyer, { totalQty: undefined }))
    assert.equal(made.status, 201, JSON.stringify(made.body))
    assert.equal(made.body.phase, 'replen')
    assert.equal(made.body.delivery, null)
    assert.equal(made.body.totalQty, null)
  })

  test('a production style without a quantity is still refused', async () => {
    const master = await makeMaster()
    const buyer = await makeBuyer()
    const res = await as(master).post('/api/orders', payload(buyer, { id: 'RP-009', phase: 'production', totalQty: undefined }))
    assert.equal(res.status, 400)
  })

  test('a manufacturer added to it gets the development steps and no Delivery step', async () => {
    const master = await makeMaster()
    const buyer = await makeBuyer()
    const mfr = await makeMfr()
    await as(master).post('/api/orders', payload(buyer))
    const added = await as(master).post('/api/orders/RP-001/assignments', { mfrId: String(mfr._id), qty: 100 })
    assert.equal(added.status, 201, JSON.stringify(added.body))
    const names = (await Order.findById('RP-001').lean()).assignments[0].stages.map(s => s.name)
    assert.equal(names[0], 'Request Received')
    assert.ok(!names.includes('Delivery'))
  })

  test('moving it to production adds the Delivery step on the given date', async () => {
    const master = await makeMaster()
    const buyer = await makeBuyer()
    const mfr = await makeMfr()
    await as(master).post('/api/orders', payload(buyer))
    await as(master).post('/api/orders/RP-001/assignments', { mfrId: String(mfr._id), qty: 100 })
    const ok = await as(master).post('/api/orders/RP-001', { phase: 'production', delivery: '2026-12-20' })
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
    const o = await Order.findById('RP-001').lean()
    assert.equal(o.phase, 'production')
    const last = o.assignments[0].stages.at(-1)
    assert.equal(last.name, 'Delivery')
    assert.equal(String(last.startDate).slice(0, 10), '2026-12-20')
  })

  test('moving it to production needs a quantity, as NPD does', async () => {
    const master = await makeMaster()
    const buyer = await makeBuyer()
    await as(master).post('/api/orders', payload(buyer, { totalQty: undefined }))
    const res = await as(master).post('/api/orders/RP-001', { phase: 'production' })
    assert.equal(res.status, 400)
    assert.match(res.body.error, /quantity/i)
  })

  test('a production style can be moved back to replen, losing its Delivery step, and replen can become NPD', async () => {
    const master = await makeMaster()
    const buyer = await makeBuyer()
    const mfr = await makeMfr()
    await as(master).post('/api/orders', payload(buyer, { id: 'RP-002', phase: 'production', delivery: '2027-01-15' }))
    await as(master).post('/api/orders/RP-002/assignments', { mfrId: String(mfr._id), qty: 100 })
    const back = await as(master).post('/api/orders/RP-002', { phase: 'replen' })
    assert.equal(back.status, 200, JSON.stringify(back.body))
    let o = await Order.findById('RP-002').lean()
    assert.equal(o.phase, 'replen')
    assert.ok(!o.assignments[0].stages.some(s => s.isDelivery))
    assert.equal(o.delivery, null)
    assert.equal((await as(master).post('/api/orders/RP-002', { phase: 'development' })).status, 200)
    o = await Order.findById('RP-002').lean()
    assert.equal(o.phase, 'development')
  })

  test('a factory cannot move it, and an unknown phase is refused', async () => {
    const master = await makeMaster()
    const buyer = await makeBuyer()
    const mfr = await makeMfr()
    await as(master).post('/api/orders', payload(buyer))
    assert.equal((await as(mfr).post('/api/orders/RP-001', { phase: 'production' })).status, 403)
    assert.equal((await as(master).post('/api/orders/RP-001', { phase: 'reorder' })).status, 400)
  })
})
