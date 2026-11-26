// Moving a style to production swaps each split's plan for the customer's standard plan, dated from the production
// start day. The steps it had are kept as they stood, with what was filed on them. A customer with no standard plan
// moves on the steps it has.

import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'
import mongoose from 'mongoose'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as } from './helpers/client.js'
import { makeMaster, makeBuyer, makeMfr, orderPayload } from './helpers/factories.js'
import { Order } from '../src/models/Order.js'
import { Document } from '../src/models/Document.js'
import { FieldUpdate } from '../src/models/FieldUpdate.js'

before(async () => { await startTestDb(); await startServer() })
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(clearDb)

// A production style whose plan is the customer's standard, and a style still being developed at the same factory.
async function arrange({ standard = true } = {}) {
  const master = await makeMaster(), buyer = await makeBuyer(), mfr = await makeMfr()
  const src = await as(master).post('/api/orders', orderPayload({ id: 'STD-001', buyerId: buyer._id, mfrId: mfr._id,
    stageNames: ['Fabric in house', 'Cutting', 'Stitching'], stageStartDates: ['2026-10-01', '2026-10-11', '2026-10-21'], stageEtas: ['2026-10-10', '2026-10-20', '2026-10-30'] }))
  assert.equal(src.status, 201, JSON.stringify(src.body))
  if (standard) assert.equal((await as(master).post(`/api/plan-templates/${buyer._id}`, { fromOrderId: 'STD-001', fromMfrId: String(mfr._id) })).status, 200)
  const dev = await as(master).post('/api/orders', { id: 'DV-001', buyerId: String(buyer._id), product: 'Dev Hoodie', category: 'HOODIE', season: 'FW26', totalQty: 100, phase: 'development' })
  assert.equal(dev.status, 201, JSON.stringify(dev.body))
  const added = await as(master).post('/api/orders/DV-001/assignments', { mfrId: String(mfr._id), qty: 100 })
  assert.equal(added.status, 201, JSON.stringify(added.body))
  const before = (await Order.findById('DV-001').lean()).assignments[0].stages
  assert.ok(before.length > 0 && !before.some(s => s.isDelivery), 'a development plan has steps and no Delivery step')
  return { master, buyer, mfr, before }
}

describe('moving to production with a standard plan', () => {
  test('the plan becomes the standard steps from the start day, and the old steps are kept with their work', async () => {
    const { master, mfr, before } = await arrange()
    await Order.updateOne({ _id: 'DV-001' }, { $set: { 'assignments.0.stages.0.note': 'fit approved with comments', 'assignments.0.stages.0.status': 'done' } })
    const doc = await Document.create({ type: 'floor_evidence', name: 'Fit photo', orderId: 'DV-001', mfrId: mfr._id, stageIndex: 0, uploadedBy: master._id, notes: 'on the old first step' })

    const moved = await as(master).post('/api/orders/DV-001', { phase: 'production', delivery: '2027-03-01', productionStart: '2027-01-10' })
    assert.equal(moved.status, 200, JSON.stringify(moved.body))
    assert.equal(moved.body.promotedPlan, 'standard')

    const a = (await Order.findById('DV-001').lean()).assignments[0]
    assert.deepEqual(a.stages.map(s => s.name), ['Fabric in house', 'Cutting', 'Stitching', 'Delivery'])
    assert.deepEqual(a.stages.slice(0, 3).map(s => [s.startDate, s.baselineEta, s.status, s.unitsDone]),
      [['2027-01-10', '2027-01-19', 'not_started', 0], ['2027-01-20', '2027-01-29', 'not_started', 0], ['2027-01-30', '2027-02-08', 'not_started', 0]])
    assert.equal(a.stages[3].isDelivery, true)
    assert.deepEqual(a.priorStages.map(s => s.name), before.map(s => s.name), 'every old step is kept, in order')
    assert.equal(a.priorStages[0].note, 'fit approved with comments')
    assert.ok(a.priorStagesAt)

    const kept = await Document.findById(doc._id).lean()
    assert.deepEqual([kept.stageIndex, kept.priorStageIndex, kept.priorStageName], [null, 0, before[0].name], 'the document follows its step into the history')

    // Tradio's record: an admin is sent the kept steps, the factory is not.
    const seen = moved.body.assignments[0]
    assert.equal(seen.priorStages.length, before.length)
    assert.equal(seen.priorStages[0].status, 'done')
    const factoryView = (await as(mfr).get('/api/orders')).body.find(o => o.id === 'DV-001')
    assert.equal(factoryView.assignments[0].priorStages, undefined)
    assert.equal(factoryView.assignments[0].stages.length, 4)
  })

  test('with no start day given the steps count from today, and a bad one is refused', async () => {
    const { master } = await arrange()
    assert.equal((await as(master).post('/api/orders/DV-001', { phase: 'production', productionStart: 'soon' })).status, 400)
    assert.equal((await Order.findById('DV-001').lean()).phase, 'development', 'nothing moved')
    assert.equal((await as(master).post('/api/orders/DV-001', { phase: 'production' })).status, 200)
    const a = (await Order.findById('DV-001').lean()).assignments[0]
    assert.equal(a.stages[0].startDate, new Date().toISOString().slice(0, 10))
    assert.equal(a.stages.at(-1).isDelivery, true)
  })

  test('an update from the floor still waiting on the style stops the move', async () => {
    const { master, mfr } = await arrange()
    const id = () => new mongoose.Types.ObjectId()
    await FieldUpdate.create({ coordinatorId: id(), visitId: id(), factoryId: mfr._id, orderId: 'DV-001', stageIndex: 0, text: 'fit sample ready', at: new Date() })
    const res = await as(master).post('/api/orders/DV-001', { phase: 'production', productionStart: '2027-01-10' })
    assert.equal(res.status, 400)
    assert.match(res.body.error, /1 update from the floor is waiting/)
    assert.equal((await Order.findById('DV-001').lean()).phase, 'development')
    await FieldUpdate.updateMany({}, { $set: { state: 'dismissed' } })
    assert.equal((await as(master).post('/api/orders/DV-001', { phase: 'production', productionStart: '2027-01-10' })).status, 200)
  })
})

describe('moving to production with no standard plan saved', () => {
  test('the style keeps the steps it had and gains Delivery, and the page is told so', async () => {
    const { master, before } = await arrange({ standard: false })
    const moved = await as(master).post('/api/orders/DV-001', { phase: 'production', productionStart: '2027-01-10' })
    assert.equal(moved.status, 200, JSON.stringify(moved.body))
    assert.equal(moved.body.promotedPlan, 'kept')
    const a = (await Order.findById('DV-001').lean()).assignments[0]
    assert.deepEqual(a.stages.map(s => s.name), [...before.map(s => s.name), 'Delivery'])
    assert.equal(a.priorStages, undefined)
  })
})

describe('replacing a plan that has steps with the template', () => {
  test('a production style on the wrong steps is put on the template, and its steps are kept', async () => {
    const { master, mfr, before } = await arrange({ standard: false })
    // Moved before the customer had a standard plan: it kept its development steps and gained Delivery.
    assert.equal((await as(master).post('/api/orders/DV-001', { phase: 'production', delivery: '2027-03-01' })).status, 200)
    const base = `/api/orders/DV-001/assignments/${mfr._id}/stages/start-plan`
    assert.equal((await as(master).post(base, { from: 'template', startDate: '2027-01-10', replace: true })).status, 404, 'no template yet')
    const buyerId = (await Order.findById('DV-001').lean()).buyerId
    assert.equal((await as(master).post(`/api/plan-templates/${buyerId}`, { fromOrderId: 'STD-001', fromMfrId: String(mfr._id) })).status, 200)
    assert.equal((await as(master).post(base, { from: 'template', startDate: '2027-01-10' })).status, 400, 'without replace a plan with steps is left alone')
    assert.equal((await as(master).post(base, { from: 'template', startDate: 'soon', replace: true })).status, 400)

    const res = await as(master).post(base, { from: 'template', startDate: '2027-01-10', replace: true })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    const a = (await Order.findById('DV-001').lean()).assignments[0]
    assert.deepEqual(a.stages.map(s => s.name), ['Fabric in house', 'Cutting', 'Stitching', 'Delivery'])
    assert.equal(a.stages[0].startDate, '2027-01-10')
    assert.equal(String(a.stages[3].baselineEta).slice(0, 10), '2027-03-01', 'the Delivery step it had is kept')
    assert.deepEqual(a.priorStages.map(s => s.name), before.map(s => s.name))
    assert.equal(res.body.assignments[0].priorStages.length, before.length)

    // Done again, the steps replaced the second time join the history after the first ones.
    assert.equal((await as(master).post(base, { from: 'template', startDate: '2027-02-01', replace: true })).status, 200)
    const again = (await Order.findById('DV-001').lean()).assignments[0]
    assert.equal(again.priorStages.length, before.length + 3)
    assert.equal(again.stages.length, 4)
  })

  test('a style still being developed gets the template steps and no Delivery step; a factory cannot do it', async () => {
    const { master, mfr } = await arrange()
    const base = `/api/orders/DV-001/assignments/${mfr._id}/stages/start-plan`
    assert.equal((await as(mfr).post(base, { from: 'template', startDate: '2027-01-10', replace: true })).status, 403)
    assert.equal((await as(master).post(base, { from: 'template', startDate: '2027-01-10', replace: true })).status, 200)
    const a = (await Order.findById('DV-001').lean()).assignments[0]
    assert.deepEqual(a.stages.map(s => s.name), ['Fabric in house', 'Cutting', 'Stitching'])
  })
})
