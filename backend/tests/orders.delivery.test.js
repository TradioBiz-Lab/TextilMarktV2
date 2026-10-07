// The mandatory Delivery step: every TNA ends in one, and closing it is what
// marks the manufacturer split Delivered (reopening it reverts to Processing).

import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as } from './helpers/client.js'
import { makeAdmin, makeBuyer, makeMfr, orderPayload } from './helpers/factories.js'
import { Order, DEFAULT_STAGE_NAMES } from '../src/models/Order.js'
import { AuditLog } from '../src/models/AuditLog.js'
import { statusAfterDeliveryStep, isDeliveryName } from '../src/lib/stageMath.js'
import { gateChange } from '../src/lib/inbound/matching.js'

before(async () => {
  await startTestDb()
  await startServer()
})
after(async () => {
  await stopServer()
  await stopTestDb()
})
beforeEach(clearDb)

const ORDER_ID = 'DLV-TEST-001'
const DELIVERY = '2026-12-20'

async function arrange({ stageNames = ['One', 'Two'], delivery = DELIVERY, extra = {} } = {}) {
  const admin = await makeAdmin()
  const buyer = await makeBuyer()
  const mfr = await makeMfr()
  const api = as(admin)
  const res = await api.post('/api/orders', orderPayload({
    id: ORDER_ID, buyerId: buyer._id, mfrId: mfr._id, stageNames, delivery,
    stageStartDates: stageNames.map(() => '2026-07-01'),
    stageEtas: stageNames.map(() => '2026-07-15'),
    ...extra,
  }))
  assert.equal(res.status, 201, `arrange failed: ${JSON.stringify(res.body)}`)
  const base = `/api/orders/${ORDER_ID}/assignments/${mfr._id}`
  const read = async () => (await api.get(`/api/orders/${ORDER_ID}`)).body
  const stages = async () => (await read()).assignments[0].stages
  const status = async () => (await read()).assignments[0].status
  const last = async () => { const s = await stages(); return s.length - 1 }
  return { admin, buyer, mfr, api, base, read, stages, status, last, mfrApi: as(mfr), buyerApi: as(buyer), created: res.body }
}

describe('helpers', () => {
  test('statusAfterDeliveryStep: done delivers, anything else only reverts a delivered split', () => {
    assert.equal(statusAfterDeliveryStep('Processing', 'done'), 'Delivered')
    assert.equal(statusAfterDeliveryStep('Delayed', 'done'), 'Delivered')
    assert.equal(statusAfterDeliveryStep('Delivered', 'done'), null)
    assert.equal(statusAfterDeliveryStep('Delivered', 'in_progress'), 'Processing')
    assert.equal(statusAfterDeliveryStep('Delivered', 'not_started'), 'Processing')
    assert.equal(statusAfterDeliveryStep('Delayed', 'in_progress'), null)
    assert.equal(statusAfterDeliveryStep('Processing', 'not_started'), null)
  })

  test('isDeliveryName ignores case and padding but not other words', () => {
    assert.equal(isDeliveryName(' DELIVERY '), true)
    assert.equal(isDeliveryName('Delivery'), true)
    assert.equal(isDeliveryName('Dispatch'), false)
    assert.equal(isDeliveryName('Door delivery'), false)
    assert.equal(isDeliveryName(undefined), false)
  })
})

describe('creation', () => {
  test('appends a Delivery step planned for the promised delivery date', async () => {
    const { created } = await arrange()
    const stages = created.assignments[0].stages
    const d = stages[stages.length - 1]
    assert.equal(d.name, 'Delivery')
    assert.equal(d.isDelivery, true)
    assert.equal(d.kind, 'milestone')
    assert.equal(d.totalUnits, 1)
    assert.equal(d.startDate, DELIVERY)
    assert.equal(d.baselineEta, DELIVERY)
    assert.equal(d.eta, null)
    assert.equal(d.status, 'not_started')
    assert.deepEqual(stages.slice(0, -1).map(s => s.isDelivery), [false, false])
  })

  test('a plan that already ends in a Delivery step keeps it, flagged, without a duplicate', async () => {
    const { created } = await arrange({ stageNames: ['One', 'Delivery'] })
    const stages = created.assignments[0].stages
    assert.deepEqual(stages.map(s => s.name), ['One', 'Delivery'])
    assert.deepEqual(stages.map(s => s.isDelivery), [false, true])
  })

  test('a Delivery step that is not last is rejected', async () => {
    const admin = await makeAdmin(); const buyer = await makeBuyer(); const mfr = await makeMfr()
    const names = ['One', 'Delivery', 'Two']
    const res = await as(admin).post('/api/orders', orderPayload({
      id: ORDER_ID, buyerId: buyer._id, mfrId: mfr._id, stageNames: names,
      stageStartDates: names.map(() => '2026-07-01'), stageEtas: names.map(() => '2026-07-15'),
    }))
    assert.equal(res.status, 400)
    assert.match(res.body.error, /Delivery step must be the last/)
  })

  test('the default plan ends in Delivery', async () => {
    const admin = await makeAdmin(); const buyer = await makeBuyer(); const mfr = await makeMfr()
    const n = DEFAULT_STAGE_NAMES.length
    const payload = orderPayload({
      id: ORDER_ID, buyerId: buyer._id, mfrId: mfr._id,
      stageStartDates: Array(n).fill('2026-07-01'), stageEtas: Array(n).fill('2026-07-15'),
    })
    delete payload.stageNames   // no custom list: the server falls back to the default plan
    const res = await as(admin).post('/api/orders', payload)
    assert.equal(res.status, 201, JSON.stringify(res.body))
    const stages = res.body.assignments[0].stages
    assert.deepEqual(stages.map(s => s.name), DEFAULT_STAGE_NAMES)
    assert.equal(stages[stages.length - 1].name, 'Delivery')
    assert.equal(stages[stages.length - 1].isDelivery, true)
  })

  // A browser still running the previous build sends dates for the 12 stages it
  // knew about; the Delivery step's own dates are filled in server-side.
  test('a caller that sends no dates for the Delivery step still creates the order', async () => {
    const admin = await makeAdmin(); const buyer = await makeBuyer(); const mfr = await makeMfr()
    const n = DEFAULT_STAGE_NAMES.length - 1
    const payload = orderPayload({
      id: ORDER_ID, buyerId: buyer._id, mfrId: mfr._id, delivery: DELIVERY,
      stageStartDates: Array(n).fill('2026-07-01'), stageEtas: Array(n).fill('2026-07-15'),
    })
    delete payload.stageNames
    const res = await as(admin).post('/api/orders', payload)
    assert.equal(res.status, 201, JSON.stringify(res.body))
    const d = res.body.assignments[0].stages.at(-1)
    assert.equal(d.startDate, DELIVERY)
    assert.equal(d.baselineEta, DELIVERY)
  })

  test('a style created without a manufacturer gets its Delivery step when one is assigned', async () => {
    const { api, mfr, buyer } = await arrange()
    const mfr2 = await makeMfr()
    const payload = orderPayload({ id: 'DLV-NOASG', buyerId: buyer._id, mfrId: mfr._id, delivery: DELIVERY })
    payload.assignments = []
    for (const k of ['stageNames', 'stageStartDates', 'stageEtas']) delete payload[k]
    const res = await api.post('/api/orders', payload)
    assert.equal(res.status, 201, JSON.stringify(res.body))
    assert.equal(res.body.assignments.length, 0)
    const added = await api.post('/api/orders/DLV-NOASG/assignments', { mfrId: String(mfr2._id), qty: 100 })
    assert.equal(added.status, 201, JSON.stringify(added.body))
    const stages = added.body.assignments[0].stages
    assert.deepEqual(stages.map(s => s.name), ['Delivery'])
    assert.equal(stages[0].isDelivery, true)
    assert.equal(stages[0].baselineEta, DELIVERY)
  })
})

describe('keeping Delivery last and mandatory', () => {
  test('inserting with no position appends in front of Delivery', async () => {
    const { api, base, stages } = await arrange()
    await api.post(`${base}/stages/insert`, { name: 'Tail', startDate: 'NA', eta: 'NA' })
    assert.deepEqual((await stages()).map(s => s.name), ['One', 'Two', 'Tail', 'Delivery'])
  })

  test('an insert aimed exactly at the Delivery position goes in front of it', async () => {
    const { api, base, stages } = await arrange()
    const before = (await stages()).length
    const res = await api.post(`${base}/stages/insert`, { index: before, name: 'Late step', startDate: 'NA', eta: 'NA' })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    const names = res.body.assignments[0].stages.map(s => s.name)
    assert.deepEqual(names.slice(-2), ['Late step', 'Delivery'])
  })

  test('a second Delivery step cannot be inserted', async () => {
    const { api, base } = await arrange()
    const res = await api.post(`${base}/stages/insert`, { name: 'delivery', startDate: 'NA', eta: 'NA' })
    assert.equal(res.status, 400)
    assert.match(res.body.error, /already has a Delivery step/)
  })

  test('the Delivery step cannot be deleted', async () => {
    const { api, base, last, stages } = await arrange()
    const res = await api.post(`${base}/stages/${await last()}/delete`)
    assert.equal(res.status, 400)
    assert.match(res.body.error, /mandatory/)
    assert.equal((await stages()).at(-1).name, 'Delivery')
  })

  test('the flag survives an insert and a delete of other stages', async () => {
    const { api, base, stages } = await arrange({ stageNames: ['One', 'Two', 'Three'] })
    await api.post(`${base}/stages/insert`, { index: 0, name: 'First', startDate: 'NA', eta: 'NA' })
    await api.post(`${base}/stages/1/delete`)
    const s = await stages()
    assert.equal(s.at(-1).isDelivery, true)
    assert.equal(s.filter(x => x.isDelivery).length, 1)
  })
})

describe('completing and reopening', () => {
  test('closing the Delivery step marks the split Delivered', async () => {
    const { api, base, status, last } = await arrange()
    assert.equal(await status(), 'Processing')
    const res = await api.post(`${base}/stages/${await last()}`, { status: 'done' })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.assignments[0].status, 'Delivered')
    assert.equal(await status(), 'Delivered')
    assert.ok(await AuditLog.findOne({ action: 'Order Delivered' }))
  })

  test('closing an ordinary stage never changes the split status', async () => {
    const { api, base, status } = await arrange()
    await api.post(`${base}/stages/0`, { status: 'done' })
    assert.equal(await status(), 'Processing')
  })

  test('the manufacturer can close it; a customer cannot', async () => {
    const { mfrApi, buyerApi, base, status, last } = await arrange()
    const i = await last()
    assert.equal((await buyerApi.post(`${base}/stages/${i}`, { status: 'done' })).status, 403)
    assert.equal(await status(), 'Processing')
    assert.equal((await mfrApi.post(`${base}/stages/${i}`, { status: 'done' })).status, 200)
    assert.equal(await status(), 'Delivered')
  })

  test('reopening the step puts a Delivered split back to Processing', async () => {
    const { api, base, status, last } = await arrange()
    const i = await last()
    await api.post(`${base}/stages/${i}`, { status: 'done' })
    assert.equal(await status(), 'Delivered')
    await api.post(`${base}/stages/${i}`, { status: 'in_progress' })
    assert.equal(await status(), 'Processing')
    assert.ok(await AuditLog.findOne({ action: 'Delivery Reopened' }))
  })

  test('moving the step between open states leaves a manual Delayed status alone', async () => {
    const { api, base, status, last } = await arrange()
    const i = await last()
    const mid = (await api.get(`/api/orders/${ORDER_ID}`)).body.assignments[0].mid
    await api.post(`/api/orders/${ORDER_ID}/assignments/${mid}`, { status: 'Delayed' })
    await api.post(`${base}/stages/${i}`, { status: 'in_progress' })
    assert.equal(await status(), 'Delayed')
  })

  test('the bulk route closes and reopens it the same way', async () => {
    const { api, base, status, last } = await arrange()
    const i = await last()
    const done = await api.post(`${base}/stages/bulk`, { stages: [{ index: i, status: 'done' }] })
    assert.equal(done.status, 200, JSON.stringify(done.body))
    assert.equal(await status(), 'Delivered')
    await api.post(`${base}/stages/bulk`, { stages: [{ index: i, status: 'not_started' }] })
    assert.equal(await status(), 'Processing')
  })

  test('a bulk write that does not touch Delivery leaves the status alone', async () => {
    const { api, base, status } = await arrange()
    await api.post(`${base}/stages/bulk`, { stages: [{ index: 0, status: 'done' }] })
    assert.equal(await status(), 'Processing')
  })

  test('only the delivered split is Delivered when an order has two manufacturers', async () => {
    const admin = await makeAdmin(); const buyer = await makeBuyer(); const m1 = await makeMfr(); const m2 = await makeMfr()
    const api = as(admin)
    const names = ['One']
    const res = await api.post('/api/orders', orderPayload({
      id: ORDER_ID, buyerId: buyer._id, mfrId: m1._id, totalQty: 200, stageNames: names,
      stageStartDates: ['2026-07-01'], stageEtas: ['2026-07-15'],
      assignments: [{ mid: String(m1._id), qty: 100 }, { mid: String(m2._id), qty: 100 }],
    }))
    assert.equal(res.status, 201, JSON.stringify(res.body))
    await api.post(`/api/orders/${ORDER_ID}/assignments/${m1._id}/stages/1`, { status: 'done' })
    const after = (await api.get(`/api/orders/${ORDER_ID}`)).body.assignments
    assert.deepEqual(after.map(a => a.status).sort(), ['Delivered', 'Processing'])
  })

  test('an order from before this step (no flagged stage) keeps its manual status behaviour', async () => {
    const { api, base, status, last } = await arrange()
    await Order.updateOne({ _id: ORDER_ID }, { $set: { 'assignments.0.stages.$[].isDelivery': false } })
    const res = await api.post(`${base}/stages/${await last()}`, { status: 'done' })
    assert.equal(res.status, 200)
    assert.equal(await status(), 'Processing')
  })
})

describe('factory messages', () => {
  // Marking an order Delivered from a WhatsApp photo is too consequential to
  // do unattended, so the Delivery step always goes to the review queue.
  test('the confidence gate never auto-applies a change to the Delivery step', () => {
    const stages = [{ name: 'Cutting', status: 'not_started' }, { name: 'Delivery', status: 'not_started', isDelivery: true }]
    const g = gateChange({ confidence: 0.99, stageIndex: 1, status: 'done', stages, defect: false })
    assert.equal(g.ok, false)
    assert.match(g.reason, /Delivery/)
    assert.equal(gateChange({ confidence: 0.99, stageIndex: 0, status: 'done', stages, defect: false }).ok, true)
  })
})
