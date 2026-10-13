// A style is in Sampling & Development or in Production. Old styles are production; the customer and Tradio
// move a style across, the factory does not.

import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as } from './helpers/client.js'
import { makeMaster, makeBuyer, makeMfr, orderPayload } from './helpers/factories.js'
import { Order } from '../src/models/Order.js'

before(async () => { await startTestDb(); await startServer() })
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(clearDb)

async function arrange(extra = {}) {
  const master = await makeMaster()
  const buyer = await makeBuyer()
  const mfr = await makeMfr()
  const res = await as(master).post('/api/orders', orderPayload({ id: 'PH-001', buyerId: buyer._id, mfrId: mfr._id, ...extra }))
  assert.equal(res.status, 201, JSON.stringify(res.body))
  return { master, buyer, mfr, res }
}

describe('style phase', () => {
  test('a new style is production unless said otherwise', async () => {
    const { res } = await arrange()
    assert.equal(res.body.phase, 'production')
  })

  test('a style can be created in sampling and development, and moved to production', async () => {
    const { master, res } = await arrange({ phase: 'development' })
    assert.equal(res.body.phase, 'development')
    const moved = await as(master).post('/api/orders/PH-001', { phase: 'production' })
    assert.equal(moved.status, 200, JSON.stringify(moved.body))
    assert.equal((await Order.findById('PH-001').lean()).phase, 'production')
  })

  test('a style from before the field reads as production', async () => {
    const { master } = await arrange()
    await Order.collection.updateOne({ _id: 'PH-001' }, { $unset: { phase: '' } })
    const list = await as(master).get('/api/orders')
    assert.equal(list.body.find(o => o.id === 'PH-001').phase, 'production')
  })

  test('only a known phase is accepted, and a factory cannot change it', async () => {
    const { master, mfr } = await arrange({ phase: 'development' })
    assert.equal((await as(master).post('/api/orders/PH-001', { phase: 'launched' })).status, 400)
    assert.equal((await as(mfr).post('/api/orders/PH-001', { phase: 'production' })).status, 403)
    assert.equal((await Order.findById('PH-001').lean()).phase, 'development')
  })
})

describe('the standard plan for a style in sampling and development', () => {
  test('a manufacturer added to a development style gets the development steps and no Delivery step', async () => {
    const master = await makeMaster()
    const buyer = await makeBuyer()
    const mfr = await makeMfr()
    const made = await as(master).post('/api/orders', { id: 'DV-001', buyerId: String(buyer._id), product: 'Dev Hoodie', category: 'HOODIE', season: 'FW26', totalQty: 100, delivery: '2026-12-31', phase: 'development' })
    assert.equal(made.status, 201, JSON.stringify(made.body))
    const added = await as(master).post('/api/orders/DV-001/assignments', { mfrId: String(mfr._id), qty: 100 })
    assert.equal(added.status, 201, JSON.stringify(added.body))
    const stages = (await Order.findById('DV-001').lean()).assignments[0].stages
    assert.deepEqual(stages.map(s => s.name), ['Request Received', 'Manufacturer Matching', 'Proto/Fit Sample', 'Fit Sample Shared', 'Fit Sample Approved', 'Pricing Approved', 'Ready for Production'])
    assert.ok(stages.every(s => s.kind === 'milestone'))
    // Matching books 4 days, the proto / fit sample 5, and each step starts where the last one ends.
    const day = iso => Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`) / 86400000
    assert.equal(day(stages[1].baselineEta) - day(stages[1].startDate), 4)
    assert.equal(day(stages[2].baselineEta) - day(stages[2].startDate), 5)
    assert.equal(String(stages[2].startDate).slice(0, 10), String(stages[1].baselineEta).slice(0, 10))
    assert.ok(!stages.some(s => s.isDelivery))
  })

  test('a production style still starts with only Delivery', async () => {
    const master = await makeMaster()
    const buyer = await makeBuyer()
    const mfr = await makeMfr()
    await as(master).post('/api/orders', { id: 'PR-001', buyerId: String(buyer._id), product: 'Prod Hoodie', category: 'HOODIE', season: 'FW26', totalQty: 100, delivery: '2026-12-31' })
    await as(master).post('/api/orders/PR-001/assignments', { mfrId: String(mfr._id), qty: 100 })
    assert.deepEqual((await Order.findById('PR-001').lean()).assignments[0].stages.map(s => s.name), ['Delivery'])
  })
})

describe('a style in sampling and development has no delivery date and no Delivery step', () => {
  async function dev() {
    const master = await makeMaster()
    const buyer = await makeBuyer()
    const mfr = await makeMfr()
    const made = await as(master).post('/api/orders', { id: 'ND-001', buyerId: String(buyer._id), product: 'No-date Hoodie', category: 'HOODIE', season: 'FW26', totalQty: 100, phase: 'development' })
    assert.equal(made.status, 201, JSON.stringify(made.body))
    return { master, mfr, made }
  }

  test('it can be created without a delivery date; production still needs one', async () => {
    const { master, made } = await dev()
    assert.equal(made.body.delivery, null)
    const bad = await as(master).post('/api/orders', { id: 'ND-002', buyerId: String(made.body.buyerId), product: 'Prod', category: 'HOODIE', season: 'FW26', totalQty: 10 })
    assert.equal(bad.status, 400)
  })

  test('adding a manufacturer gives the development steps and no Delivery step', async () => {
    const { master, mfr } = await dev()
    const added = await as(master).post('/api/orders/ND-001/assignments', { mfrId: String(mfr._id), qty: 100 })
    assert.equal(added.status, 201, JSON.stringify(added.body))
    const names = (await Order.findById('ND-001').lean()).assignments[0].stages.map(s => s.name)
    assert.ok(!names.includes('Delivery'))
    assert.equal(names[0], 'Request Received')
  })

  test('moving it to production needs a date, then adds the Delivery step', async () => {
    const { master, mfr } = await dev()
    await as(master).post('/api/orders/ND-001/assignments', { mfrId: String(mfr._id), qty: 100 })
    const refused = await as(master).post('/api/orders/ND-001', { phase: 'production' })
    assert.equal(refused.status, 400)
    assert.equal((await Order.findById('ND-001').lean()).phase, 'development')
    const ok = await as(master).post('/api/orders/ND-001', { phase: 'production', delivery: '2026-12-20' })
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
    const o = await Order.findById('ND-001').lean()
    assert.equal(o.phase, 'production')
    const stages = o.assignments[0].stages
    assert.equal(stages[stages.length - 1].name, 'Delivery')
    assert.equal(stages[stages.length - 1].isDelivery, true)
    assert.equal(String(stages[stages.length - 1].startDate).slice(0, 10), '2026-12-20')
  })
})

describe('moving a style back to sampling and development', () => {
  async function prod() {
    const master = await makeMaster()
    const buyer = await makeBuyer()
    const mfr = await makeMfr()
    await as(master).post('/api/orders', { id: 'BK-001', buyerId: String(buyer._id), product: 'Back Hoodie', category: 'HOODIE', season: 'FW26', totalQty: 100, delivery: '2026-12-31' })
    await as(master).post('/api/orders/BK-001/assignments', { mfrId: String(mfr._id), qty: 100 })
    return { master }
  }

  test('loses its Delivery step and its delivery date, and gets both back on the way to production', async () => {
    const { master } = await prod()
    const back = await as(master).post('/api/orders/BK-001', { phase: 'development' })
    assert.equal(back.status, 200, JSON.stringify(back.body))
    let o = await Order.findById('BK-001').lean()
    assert.equal(o.phase, 'development')
    assert.equal(o.delivery, null)
    assert.ok(!o.assignments[0].stages.some(s => s.isDelivery))
    assert.equal((await as(master).post('/api/orders/BK-001', { phase: 'production' })).status, 400)
    assert.equal((await as(master).post('/api/orders/BK-001', { phase: 'production', delivery: '2027-01-15' })).status, 200)
    o = await Order.findById('BK-001').lean()
    assert.equal(o.assignments[0].stages.filter(s => s.isDelivery).length, 1)
  })

  test('a style with a delivered split stays in production', async () => {
    const { master } = await prod()
    await Order.updateOne({ _id: 'BK-001' }, { $set: { 'assignments.0.status': 'Delivered' } })
    assert.equal((await as(master).post('/api/orders/BK-001', { phase: 'development' })).status, 400)
    assert.equal((await Order.findById('BK-001').lean()).phase, 'production')
  })
})

describe('an empty delivery date', () => {
  test('is refused in production and clears the date in development, never 1 Jan 1970', async () => {
    const master = await makeMaster()
    const buyer = await makeBuyer()
    await as(master).post('/api/orders', { id: 'NL-001', buyerId: String(buyer._id), product: 'P', category: 'HOODIE', season: 'FW26', totalQty: 10, delivery: '2026-12-31' })
    assert.equal((await as(master).post('/api/orders/NL-001', { delivery: null })).status, 400)
    assert.equal(new Date((await Order.findById('NL-001').lean()).delivery).toISOString().slice(0, 10), '2026-12-31')
    await as(master).post('/api/orders', { id: 'NL-002', buyerId: String(buyer._id), product: 'P', category: 'HOODIE', season: 'FW26', totalQty: 10, delivery: '2026-12-31', phase: 'development' })
    assert.equal((await as(master).post('/api/orders/NL-002', { delivery: null })).status, 200)
    assert.equal((await Order.findById('NL-002').lean()).delivery, null)
  })
})
