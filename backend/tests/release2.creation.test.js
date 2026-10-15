// Creating styles and plans: a customer's own seasons, a development style that does not know its quantity yet, and
// a new plan started from a sibling style or from the customer's saved template.

import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as } from './helpers/client.js'
import { makeMaster, makeBuyer, makeMfr, orderPayload } from './helpers/factories.js'
import { Order } from '../src/models/Order.js'

before(async () => {
  await startTestDb()
  process.env.PORT = new URL(await startServer()).port
})
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(clearDb)

describe("a customer's own seasons", () => {
  test('a customer with a list uses only it (and the value already on a record stays allowed); one without uses SS/FW', async () => {
    const admin = await makeMaster()
    const cocoblu = await makeBuyer({ code: 'CBNB' })
    const other = await makeBuyer({ code: 'OTH' })
    assert.equal((await as(admin).post(`/api/users/${cocoblu._id}`, { seasons: 'h1, H2' })).status, 200)
    assert.equal((await as(admin).post(`/api/users/${cocoblu._id}`, { seasons: 'Core Series' })).status, 400)
    assert.deepEqual((await as(admin).get('/api/users')).body.find(u => u.id === String(cocoblu._id)).seasons, ['H1', 'H2'])

    const mo = await as(admin).post('/api/master-orders', { id: 'auto', buyerId: String(cocoblu._id), orderName: 'H1 range', season: 'H1' })
    assert.equal(mo.status, 201, JSON.stringify(mo.body))
    assert.equal(mo.body.id, 'MO-CBNB-H1-001')
    assert.equal((await as(admin).post('/api/master-orders', { id: 'auto', buyerId: String(cocoblu._id), orderName: 'x', season: 'SS27' })).status, 400)
    assert.equal((await as(admin).post('/api/master-orders', { id: 'auto', buyerId: String(other._id), orderName: 'y', season: 'SS27' })).status, 201)

    const style = await as(admin).post('/api/orders', { id: 'auto', buyerId: String(cocoblu._id), product: 'Top', category: 'TOP', season: 'H2', totalQty: 10 })
    assert.equal(style.status, 201, JSON.stringify(style.body))
    assert.equal(style.body.id, 'CBNB-TOP-H2-001')
    // H1 comes off the list: the master order keeps it and can still be edited.
    await as(admin).post(`/api/users/${cocoblu._id}`, { seasons: ['H2'] })
    assert.equal((await as(admin).post(`/api/master-orders/${mo.body.id}`, { orderName: 'H1 range (final)', season: 'H1' })).status, 200)
    assert.equal((await as(admin).post(`/api/master-orders/${mo.body.id}`, { season: 'FW27' })).status, 400)
  })
})

describe('a development style without its quantity', () => {
  test('may be created and edited without one, but needs one to move to production', async () => {
    const admin = await makeMaster()
    const buyer = await makeBuyer({ code: 'NPD' })
    const dev = await as(admin).post('/api/orders', { id: 'auto', buyerId: String(buyer._id), product: 'Sample tee', category: 'TEE', season: 'SS27', phase: 'development' })
    assert.equal(dev.status, 201, JSON.stringify(dev.body))
    assert.equal(dev.body.totalQty, null)
    assert.equal((await as(admin).post('/api/orders', { id: 'auto', buyerId: String(buyer._id), product: 'Bulk tee', category: 'TEE', season: 'SS27' })).status, 400)
    assert.equal((await as(admin).post(`/api/orders/${dev.body.id}`, { phase: 'production' })).status, 400)
    assert.equal((await as(admin).post(`/api/orders/${dev.body.id}`, { totalQty: 500 })).status, 200)
    assert.equal((await as(admin).post(`/api/orders/${dev.body.id}`, { totalQty: null })).status, 200)
    assert.equal((await Order.findById(dev.body.id).lean()).totalQty, null)
    assert.equal((await as(admin).post(`/api/orders/${dev.body.id}`, { phase: 'production', totalQty: 500 })).status, 200)
  })
})

describe('starting a plan', () => {
  async function arrange() {
    const admin = await makeMaster()
    const buyer = await makeBuyer({ code: 'KON' })
    const mfrA = await makeMfr(), mfrB = await makeMfr()
    const mo = (await as(admin).post('/api/master-orders', { id: 'auto', buyerId: String(buyer._id), orderName: 'Corporate tees', season: 'SS27' })).body
    // Style A: a planned split at factory A. Lab Dip targets 3 dips (its own count), Cutting the split quantity.
    const a = await as(admin).post('/api/orders', orderPayload({ id: 'PA-001', buyerId: buyer._id, mfrId: mfrA._id, masterOrderId: mo.id, totalQty: 100,
      delivery: '2027-03-30', stageNames: ['Lab Dip Approval', 'Cutting'], stageStartDates: ['2027-01-05', '2027-02-01'], stageEtas: ['2027-01-12', '2027-02-20'],
      stageResponsibleIds: [String(buyer._id), String(mfrA._id)], stageTotalUnits: [3, 100], stageKinds: ['quantity', 'quantity'] }))
    assert.equal(a.status, 201, JSON.stringify(a.body))
    // Style B: same buy, factory B, nothing planned yet.
    const b = await as(admin).post('/api/orders', { id: 'PB-001', buyerId: String(buyer._id), product: 'Polo', category: 'POLO', season: 'SS27', totalQty: 400, masterOrderId: mo.id })
    assert.equal(b.status, 201, JSON.stringify(b.body))
    assert.equal((await as(admin).post('/api/orders/PB-001/assignments', { mfrId: String(mfrB._id), qty: 400, delivery: '2027-04-10' })).status, 201)
    return { admin, buyer, mfrA, mfrB, mo }
  }
  const planOf = async id => (await Order.findById(id).lean()).assignments[0].stages

  test("copying a sibling's plan maps its owners and targets onto this split, keeps its dates, and fills an empty plan only", async () => {
    const { admin, buyer, mfrA, mfrB } = await arrange()
    const base = `/api/orders/PB-001/assignments/${mfrB._id}/stages/start-plan`
    const res = await as(admin).post(base, { from: 'style', fromOrderId: 'PA-001' })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    const st = await planOf('PB-001')
    assert.deepEqual(st.map(s => s.name), ['Lab Dip Approval', 'Cutting', 'Delivery'])
    assert.equal(String(st[0].responsibleId), String(buyer._id))      // the customer stays the customer
    assert.equal(String(st[1].responsibleId), String(mfrB._id))       // factory A's step is now factory B's
    assert.deepEqual([st[0].totalUnits, st[1].totalUnits], [3, 400])  // its own count kept; the split quantity followed
    assert.deepEqual([st[0].startDate, st[0].baselineEta, st[1].baselineEta], ['2027-01-05', '2027-01-12', '2027-02-20'])
    assert.equal((await as(admin).post(base, { from: 'style', fromOrderId: 'PA-001' })).status, 400)
    assert.notEqual(String(st[1].responsibleId), String(mfrA._id))
  })

  test("the customer's template is saved from a plan and applied from a start date", async () => {
    const { admin, buyer, mfrA, mfrB } = await arrange()
    const base = `/api/orders/PB-001/assignments/${mfrB._id}/stages/start-plan`
    assert.equal((await as(admin).post(base, { from: 'template', startDate: '2027-06-01' })).status, 404)
    const saved = await as(admin).post(`/api/plan-templates/${buyer._id}`, { fromOrderId: 'PA-001', fromMfrId: String(mfrA._id) })
    assert.equal(saved.status, 200, JSON.stringify(saved.body))
    assert.equal(saved.body.stepCount, 2)
    assert.deepEqual(saved.body.steps.map(s => [s.startOffset, s.endOffset, s.owner]), [[0, 7, 'buyer'], [27, 46, 'manufacturer']])
    assert.equal((await as(admin).get(`/api/plan-templates/${buyer._id}`)).body.exists, true)
    assert.equal((await as(admin).post(base, { from: 'template', startDate: 'soon' })).status, 400)
    assert.equal((await as(admin).post(base, { from: 'template', startDate: '2027-06-01' })).status, 200)
    const st = await planOf('PB-001')
    assert.deepEqual(st.slice(0, 2).map(s => [s.startDate, s.baselineEta]), [['2027-06-01', '2027-06-08'], ['2027-06-28', '2027-07-17']])
    assert.equal(String(st[1].responsibleId), String(mfrB._id))
  })

  test('only a style in the same master order can be copied, and a factory cannot start a plan', async () => {
    const { admin, buyer, mfrB } = await arrange()
    await as(admin).post('/api/orders', orderPayload({ id: 'PX-001', buyerId: buyer._id, mfrId: (await makeMfr())._id, delivery: '2027-03-30' }))
    const base = `/api/orders/PB-001/assignments/${mfrB._id}/stages/start-plan`
    assert.equal((await as(admin).post(base, { from: 'style', fromOrderId: 'PX-001' })).status, 400)
    assert.equal((await as(mfrB).post(base, { from: 'style', fromOrderId: 'PA-001' })).status, 403)
  })
})
