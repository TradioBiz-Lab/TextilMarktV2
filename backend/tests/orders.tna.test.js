// New behaviour: stage kinds, checklist items, baseline dates, colourways, the
// bulk endpoint, and the two landmines the design review surfaced.

import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as } from './helpers/client.js'
import { makeAdmin, makeBuyer, makeMfr, orderPayload } from './helpers/factories.js'
import { Document } from '../src/db/index.js'

before(async () => {
  await startTestDb()
  await startServer()
})
after(async () => {
  await stopServer()
  await stopTestDb()
})
beforeEach(clearDb)

const ORDER_ID = 'TNA-TEST-001'

async function arrange({ stageNames = ['One', 'Two', 'Three'], stageKinds, colourways, totalQty = 100, delivery } = {}) {
  const admin = await makeAdmin()
  const buyer = await makeBuyer()
  const mfr = await makeMfr()
  const api = as(admin)

  const res = await api.post('/api/orders', orderPayload({
    id: ORDER_ID, buyerId: buyer._id, mfrId: mfr._id, totalQty, stageNames,
    stageStartDates: stageNames.map(() => '2026-07-01'),
    stageEtas: stageNames.map(() => '2026-07-15'),
    ...(stageKinds ? { stageKinds } : {}),
    ...(colourways ? { colourways } : {}),
    ...(delivery ? { delivery } : {}),
  }))
  assert.equal(res.status, 201, `arrange failed: ${JSON.stringify(res.body)}`)

  const base = `/api/orders/${ORDER_ID}/assignments/${mfr._id}`
  const readStages = async () => (await api.get(`/api/orders/${ORDER_ID}`)).body.assignments[0].stages
  const readOrder = async () => (await api.get(`/api/orders/${ORDER_ID}`)).body

  return { admin, buyer, mfr, api, buyerApi: as(buyer), mfrApi: as(mfr), base, readStages, readOrder, created: res.body }
}

describe('stage kinds', () => {
  test('stages default to quantity — unchanged from before this feature', async () => {
    const { created } = await arrange()
    assert.deepEqual(created.assignments[0].stages.map(s => s.kind), ['quantity', 'quantity', 'quantity'])
    // Quantity stages still target the assignment qty.
    assert.equal(created.assignments[0].stages[0].totalUnits, 100)
  })

  test('milestone and checklist stages target 1, not the order quantity', async () => {
    const { created } = await arrange({
      stageNames: ['Lab Dip Receipt', 'Lab Dips', 'Production'],
      stageKinds: ['milestone', 'checklist', 'quantity'],
      totalQty: 10800,
    })
    const stages = created.assignments[0].stages
    assert.deepEqual(stages.map(s => s.kind), ['milestone', 'checklist', 'quantity'])
    assert.deepEqual(stages.map(s => s.totalUnits), [1, 1, 10800])
  })

  test('an invalid kind is rejected at creation', async () => {
    const admin = await makeAdmin(); const buyer = await makeBuyer(); const mfr = await makeMfr()
    const { status, body } = await as(admin).post('/api/orders', orderPayload({
      buyerId: buyer._id, mfrId: mfr._id, stageNames: ['A'],
      stageStartDates: ['2026-07-01'], stageEtas: ['2026-07-02'], stageKinds: ['nonsense'],
    }))
    assert.equal(status, 400)
    assert.match(body.error, /Invalid kind "nonsense"/)
  })

  test('a milestone is completed by status, and units mirror it', async () => {
    const { api, base, readStages } = await arrange({
      stageNames: ['NB Approval'], stageKinds: ['milestone'], totalQty: 500,
    })

    const { status } = await api.post(`${base}/stages/0`, { status: 'done' })
    assert.equal(status, 200)

    const s = (await readStages())[0]
    assert.equal(s.status, 'done')
    // The mirror is what keeps the frontend's `unitsDone < totalUnits`
    // "first incomplete stage" derivations working untouched.
    assert.equal(s.unitsDone, s.totalUnits)
  })

  test('reopening a milestone clears the mirrored units', async () => {
    const { api, base, readStages } = await arrange({ stageNames: ['A'], stageKinds: ['milestone'] })

    await api.post(`${base}/stages/0`, { status: 'done' })
    await api.post(`${base}/stages/0`, { status: 'not_started' })

    const s = (await readStages())[0]
    assert.equal(s.status, 'not_started')
    assert.equal(s.unitsDone, 0)
  })

  test('a quantity stage derives its status from units', async () => {
    const { api, base, readStages } = await arrange({ totalQty: 100 })

    await api.post(`${base}/stages/0`, { unitsDone: 0 })
    assert.equal((await readStages())[0].status, 'not_started')

    await api.post(`${base}/stages/0`, { unitsDone: 40 })
    assert.equal((await readStages())[0].status, 'in_progress')

    await api.post(`${base}/stages/0`, { unitsDone: 100 })
    assert.equal((await readStages())[0].status, 'done')
  })

  test('blocked is orthogonal to status', async () => {
    const { api, base, readStages } = await arrange({ stageNames: ['A'], stageKinds: ['checklist'] })

    await api.post(`${base}/stages/0`, { status: 'in_progress', blocked: true, blockedReason: 'waiting on Olivine sample' })

    const s = (await readStages())[0]
    assert.equal(s.status, 'in_progress')
    assert.equal(s.blocked, true)
    assert.equal(s.blockedReason, 'waiting on Olivine sample')
  })

  test('an invalid status is rejected', async () => {
    const { api, base } = await arrange({ stageNames: ['A'], stageKinds: ['milestone'] })
    const { status } = await api.post(`${base}/stages/0`, { status: 'almost' })
    assert.equal(status, 400)
  })
})

describe('checklist items', () => {
  test('items generate one per colourway', async () => {
    const { api, base, readStages } = await arrange({
      stageNames: ['Lab Dip/Cutting to be shared'], stageKinds: ['checklist'],
      colourways: ['Peacot', 'Brown', 'Olivine'],
    })

    const { status } = await api.post(`${base}/stages/0/items`, { name: 'Lab Dip', fromColourways: true })
    assert.equal(status, 200)

    const s = (await readStages())[0]
    assert.equal(s.itemsTotal, 3)
    assert.equal(s.itemsDone, 0)
    assert.deepEqual(s.items.map(i => i.name), ['Lab Dip — Peacot', 'Lab Dip — Brown', 'Lab Dip — Olivine'])
    assert.deepEqual(s.items.map(i => i.colourway), ['Peacot', 'Brown', 'Olivine'])
  })

  test('items complete independently, and the count reflects it', async () => {
    const { api, base, readStages } = await arrange({
      stageNames: ['Lab Dips'], stageKinds: ['checklist'], colourways: ['Peacot', 'Brown', 'Olivine'],
    })
    await api.post(`${base}/stages/0/items`, { name: 'Lab Dip', fromColourways: true })

    await api.post(`${base}/stages/0/items/0`, { status: 'done' })

    const s = (await readStages())[0]
    assert.equal(s.itemsDone, 1)
    assert.equal(s.itemsTotal, 3)
    assert.equal(s.items[0].status, 'done')
    assert.ok(s.items[0].doneDate, 'completion date is stamped automatically')
    assert.equal(s.items[1].status, 'pending')
  })

  test('reopening an item clears its done date', async () => {
    const { api, base, readStages } = await arrange({ stageNames: ['A'], stageKinds: ['checklist'] })
    await api.post(`${base}/stages/0/items`, { name: 'Red dip' })
    await api.post(`${base}/stages/0/items/0`, { status: 'done' })
    await api.post(`${base}/stages/0/items/0`, { status: 'pending' })

    const item = (await readStages())[0].items[0]
    assert.equal(item.status, 'pending')
    assert.equal(item.doneDate, null)
  })

  test('an item can be added and removed individually', async () => {
    const { api, base, readStages } = await arrange({ stageNames: ['A'], stageKinds: ['checklist'] })

    await api.post(`${base}/stages/0/items`, { name: 'Red dip' })
    await api.post(`${base}/stages/0/items`, { name: 'Navy dip' })
    assert.equal((await readStages())[0].itemsTotal, 2)

    await api.post(`${base}/stages/0/items/0/delete`)
    const s = (await readStages())[0]
    assert.equal(s.itemsTotal, 1)
    assert.deepEqual(s.items.map(i => i.name), ['Navy dip'])
  })

  test('fromColourways needs colourways on the order', async () => {
    const { api, base } = await arrange({ stageNames: ['A'], stageKinds: ['checklist'] })
    const { status, body } = await api.post(`${base}/stages/0/items`, { name: 'Lab Dip', fromColourways: true })
    assert.equal(status, 400)
    assert.match(body.error, /no colourways/)
  })

  test('a manufacturer who owns the stage may manage its items', async () => {
    const { api, mfrApi, mfr, base, readStages } = await arrange({ stageNames: ['A'], stageKinds: ['checklist'] })
    await api.post(`${base}/stages/0/eta`, { responsibleId: String(mfr._id) })

    assert.equal((await mfrApi.post(`${base}/stages/0/items`, { name: 'Mine' })).status, 200)
    assert.equal((await readStages())[0].itemsTotal, 1)
  })

  test('an item with no revision yet reads plannedDate as its current due date', async () => {
    const { api, base, readStages } = await arrange({ stageNames: ['A'], stageKinds: ['checklist'] })
    await api.post(`${base}/stages/0/items`, { name: 'Red dip', dueDate: '2026-07-20' })

    const item = (await readStages())[0].items[0]
    assert.equal(item.plannedDate, '2026-07-20')
    assert.equal(item.dueDate, '2026-07-20')
  })

  test('revising an item due date backfills plannedDate from the old value', async () => {
    const { api, base, readStages } = await arrange({ stageNames: ['A'], stageKinds: ['checklist'] })
    await api.post(`${base}/stages/0/items`, { name: 'Red dip', dueDate: '2026-07-20' })

    await api.post(`${base}/stages/0/items/0`, { dueDate: '2026-07-27' })
    const item = (await readStages())[0].items[0]
    assert.equal(item.plannedDate, '2026-07-20', 'frozen at the original due date')
    assert.equal(item.dueDate, '2026-07-27')
  })

  test('a second revision does not move the planned date', async () => {
    const { api, base, readStages } = await arrange({ stageNames: ['A'], stageKinds: ['checklist'] })
    await api.post(`${base}/stages/0/items`, { name: 'Red dip', dueDate: '2026-07-20' })

    await api.post(`${base}/stages/0/items/0`, { dueDate: '2026-07-27' })
    await api.post(`${base}/stages/0/items/0`, { dueDate: '2026-08-01' })

    const item = (await readStages())[0].items[0]
    assert.equal(item.plannedDate, '2026-07-20')
    assert.equal(item.dueDate, '2026-08-01')
  })
})

describe('colourways and callout', () => {
  test('colourways are stored at order level and de-duplicated', async () => {
    const { readOrder } = await arrange({ colourways: ['Peacot', 'Brown', 'peacot', ''] })
    const o = await readOrder()
    assert.deepEqual(o.colourways.map(c => c.name), ['Peacot', 'Brown'])
  })

  test('callout round-trips through the order edit route', async () => {
    const { api, readOrder } = await arrange()
    assert.equal((await readOrder()).callout, '')

    const { status } = await api.post(`/api/orders/${ORDER_ID}`, { callout: 'delayed a week — lab dip submission slipped' })
    assert.equal(status, 200)
    assert.equal((await readOrder()).callout, 'delayed a week — lab dip submission slipped')
  })

  test('colourways can be edited after creation', async () => {
    const { api, readOrder } = await arrange({ colourways: ['Peacot'] })
    await api.post(`/api/orders/${ORDER_ID}`, { colourways: ['Peacot', 'Olivine'] })
    assert.deepEqual((await readOrder()).colourways.map(c => c.name), ['Peacot', 'Olivine'])
  })
})

// baselineDelivery: same baselineEta/eta pattern one level up. `delivery` can
// be corrected (e.g. realigned to the TNA plan's last stage) without losing
// track of what was originally promised.
describe('delivery baseline', () => {
  test('baselineDelivery is set at creation, matching delivery', async () => {
    const { readOrder } = await arrange()
    const o = await readOrder()
    assert.equal(o.baselineDelivery?.slice(0, 10), o.delivery.slice(0, 10))
    assert.equal(o.deliveryVarianceDays, 0)
  })

  test('the first revision backfills baselineDelivery to the OLD value', async () => {
    const { api, readOrder } = await arrange({ delivery: '2026-08-25' })
    const before = await readOrder()
    assert.equal(before.baselineDelivery.slice(0, 10), '2026-08-25')

    await api.post(`/api/orders/${ORDER_ID}`, { delivery: '2026-09-02' })
    const after = await readOrder()
    assert.equal(after.delivery.slice(0, 10), '2026-09-02')
    assert.equal(after.baselineDelivery.slice(0, 10), '2026-08-25', 'baseline stays the ORIGINAL promise')
    assert.equal(after.deliveryVarianceDays, 8)
  })

  test('a second revision does not move the baseline', async () => {
    const { api, readOrder } = await arrange({ delivery: '2026-08-25' })
    await api.post(`/api/orders/${ORDER_ID}`, { delivery: '2026-09-02' })
    await api.post(`/api/orders/${ORDER_ID}`, { delivery: '2026-09-10' })
    const o = await readOrder()
    assert.equal(o.delivery.slice(0, 10), '2026-09-10')
    assert.equal(o.baselineDelivery.slice(0, 10), '2026-08-25', 'still the original, not the previous revision')
    assert.equal(o.deliveryVarianceDays, 16)
  })

  test('re-saving the same delivery date does not spuriously freeze a baseline', async () => {
    const { api, readOrder } = await arrange({ delivery: '2026-08-25' })
    await api.post(`/api/orders/${ORDER_ID}`, { delivery: '2026-08-25' })
    const o = await readOrder()
    // Still equal to the creation-time baseline (never "moved" at all), and
    // variance is a real, measurable zero — not null from a bad backfill.
    assert.equal(o.baselineDelivery.slice(0, 10), '2026-08-25')
    assert.equal(o.deliveryVarianceDays, 0)
  })

  test('pulling delivery earlier reads as negative variance', async () => {
    const { api, readOrder } = await arrange({ delivery: '2026-12-01' })
    await api.post(`/api/orders/${ORDER_ID}`, { delivery: '2026-10-20' })
    const o = await readOrder()
    assert.equal(o.deliveryVarianceDays, -42)
  })
})

// Creation enforces that the manufacturer splits sum to totalQty. Editing used
// to change only the order total, so the splits went stale — and since every
// screen shows the assignment qty, the edit looked like it hadn't saved.
describe('editing total quantity keeps the splits in step', () => {
  test('a single-assignment order syncs its split and stage targets', async () => {
    const { api, readOrder, created } = await arrange({ totalQty: 500 })
    assert.equal(created.assignments[0].qty, 500)
    assert.equal(created.assignments[0].stages[0].totalUnits, 500)

    const { status } = await api.post(`/api/orders/${ORDER_ID}`, { totalQty: 777 })
    assert.equal(status, 200)

    const o = await readOrder()
    assert.equal(o.totalQty, 777)
    assert.equal(o.assignments[0].qty, 777, 'the split follows the total')
    assert.equal(o.assignments[0].stages[0].totalUnits, 777, 'defaulted stage targets follow too')
  })

  test('a deliberately overridden stage target is left alone', async () => {
    const { api, base, readStages } = await arrange({ totalQty: 500 })
    await api.post(`${base}/stages/0/eta`, { totalUnits: 3 })

    await api.post(`/api/orders/${ORDER_ID}`, { totalQty: 900 })

    const stages = await readStages()
    assert.equal(stages[0].totalUnits, 3, 'an explicit target is not overwritten')
    assert.equal(stages[1].totalUnits, 900, 'defaulted ones still follow')
  })

  test('a stage target never drops below units already completed', async () => {
    const { api, base, readStages } = await arrange({ totalQty: 500 })
    await api.post(`${base}/stages/0`, { unitsDone: 400 })

    await api.post(`/api/orders/${ORDER_ID}`, { totalQty: 100 })

    assert.equal((await readStages())[0].totalUnits, 400)
  })

  test('a split order refuses rather than guessing the reallocation', async () => {
    const admin = await makeAdmin(); const buyer = await makeBuyer()
    const m1 = await makeMfr(); const m2 = await makeMfr()
    const api = as(admin)
    const payload = orderPayload({ id: 'SPLIT-QTY-001', buyerId: buyer._id, mfrId: m1._id, totalQty: 100 })
    payload.assignments = [{ mid: String(m1._id), qty: 60 }, { mid: String(m2._id), qty: 40 }]
    assert.equal((await api.post('/api/orders', payload)).status, 201)

    const { status, body } = await api.post('/api/orders/SPLIT-QTY-001', { totalQty: 200 })
    assert.equal(status, 400)
    assert.match(body.error, /Adjust the splits first/)
  })

  test('editing other fields on a split order still works', async () => {
    const admin = await makeAdmin(); const buyer = await makeBuyer()
    const m1 = await makeMfr(); const m2 = await makeMfr()
    const api = as(admin)
    const payload = orderPayload({ id: 'SPLIT-QTY-002', buyerId: buyer._id, mfrId: m1._id, totalQty: 100 })
    payload.assignments = [{ mid: String(m1._id), qty: 60 }, { mid: String(m2._id), qty: 40 }]
    await api.post('/api/orders', payload)

    const { status } = await api.post('/api/orders/SPLIT-QTY-002', { callout: 'watch this one' })
    assert.equal(status, 200)
  })
})

describe('baseline vs revised end date', () => {
  test('baseline is frozen at creation and variance starts at zero', async () => {
    const { created } = await arrange()
    const s = created.assignments[0].stages[0]
    assert.equal(s.baselineEta, '2026-07-15')
    assert.equal(s.eta, '2026-07-15')
    assert.equal(s.etaVarianceDays, 0)
  })

  test('revising the end date measures slippage against the original', async () => {
    const { api, base, readStages } = await arrange()

    await api.post(`${base}/stages/0/eta`, { eta: '2026-07-25' })

    const s = (await readStages())[0]
    assert.equal(s.baselineEta, '2026-07-15', 'baseline is untouched')
    assert.equal(s.eta, '2026-07-25')
    assert.equal(s.etaVarianceDays, 10)
  })

  test('a second revision does not move the baseline', async () => {
    const { api, base, readStages } = await arrange()

    await api.post(`${base}/stages/0/eta`, { eta: '2026-07-20' })
    await api.post(`${base}/stages/0/eta`, { eta: '2026-07-30' })

    const s = (await readStages())[0]
    assert.equal(s.baselineEta, '2026-07-15')
    assert.equal(s.etaVarianceDays, 15)
  })

  test('pulling a date in reads as negative variance', async () => {
    const { api, base, readStages } = await arrange()
    await api.post(`${base}/stages/0/eta`, { eta: '2026-07-10' })
    assert.equal((await readStages())[0].etaVarianceDays, -5)
  })
})

describe('actual end date', () => {
  test('marking a milestone done stamps actualEnd; reopening clears it', async () => {
    const { api, base, readStages } = await arrange({ stageNames: ['A'], stageKinds: ['milestone'] })

    await api.post(`${base}/stages/0`, { status: 'done' })
    const done = (await readStages())[0]
    assert.ok(done.actualEnd, 'actualEnd is stamped')

    await api.post(`${base}/stages/0`, { status: 'not_started' })
    assert.equal((await readStages())[0].actualEnd, null)
  })

  test('a second done save does not move the stamp', async () => {
    const { api, base, readStages } = await arrange({ stageNames: ['A'], stageKinds: ['milestone'] })
    await api.post(`${base}/stages/0`, { status: 'done' })
    const first = (await readStages())[0].actualEnd

    await api.post(`${base}/stages/0`, { status: 'done', blocked: false })
    const second = (await readStages())[0].actualEnd
    assert.equal(second, first)
  })

  test('a quantity stage reaching totalUnits stamps actualEnd; dropping below clears it', async () => {
    const { api, base, readStages } = await arrange({ totalQty: 100 })

    await api.post(`${base}/stages/0`, { unitsDone: 100 })
    assert.ok((await readStages())[0].actualEnd)

    await api.post(`${base}/stages/0`, { unitsDone: 60 })
    assert.equal((await readStages())[0].actualEnd, null)
  })

  test('a kind flip on an already-done stage carries actualEnd forward, not stale', async () => {
    const { api, base, readStages } = await arrange({ stageNames: ['A'], stageKinds: ['milestone'] })
    await api.post(`${base}/stages/0`, { status: 'done' })
    const stamped = (await readStages())[0].actualEnd

    await api.post(`${base}/stages/0/eta`, { kind: 'checklist' })
    const s = (await readStages())[0]
    assert.equal(s.status, 'done', 'still done after the flip')
    assert.equal(s.actualEnd, stamped, 're-derived consistently, not wiped by the flip')
  })

  test('an explicit actualEnd backdates completion — "it finished on the 3rd"', async () => {
    const { api, base, readStages } = await arrange({ stageNames: ['A'], stageKinds: ['milestone'] })
    const { status } = await api.post(`${base}/stages/0`, { status: 'done', actualEnd: '2026-07-03' })
    assert.equal(status, 200)
    assert.equal((await readStages())[0].actualEnd, '2026-07-03')
  })

  test('actualEnd cannot be backdated into the future', async () => {
    const { api, base } = await arrange({ stageNames: ['A'], stageKinds: ['milestone'] })
    const farFuture = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10)
    const { status, body } = await api.post(`${base}/stages/0`, { status: 'done', actualEnd: farFuture })
    assert.equal(status, 400)
    assert.match(body.error, /cannot be in the future/)
  })

  test('an invalid actualEnd is rejected', async () => {
    const { api, base } = await arrange({ stageNames: ['A'], stageKinds: ['milestone'] })
    const { status, body } = await api.post(`${base}/stages/0`, { status: 'done', actualEnd: 'not-a-date' })
    assert.equal(status, 400)
    assert.match(body.error, /Invalid actual completion date/)
  })

  test('the bulk route also accepts an explicit actualEnd per row', async () => {
    const { api, base, readStages } = await arrange({ stageNames: ['A', 'B'], stageKinds: ['milestone', 'milestone'] })
    const { status } = await api.post(`${base}/stages/bulk`, {
      stages: [{ index: 0, status: 'done', actualEnd: '2026-07-04' }],
    })
    assert.equal(status, 200)
    assert.equal((await readStages())[0].actualEnd, '2026-07-04')
  })

  test('the bulk route rejects a future actualEnd too', async () => {
    const { api, base } = await arrange({ stageNames: ['A'], stageKinds: ['milestone'] })
    const farFuture = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10)
    const { status, body } = await api.post(`${base}/stages/bulk`, {
      stages: [{ index: 0, status: 'done', actualEnd: farFuture }],
    })
    assert.equal(status, 400)
    assert.match(body.error, /cannot be in the future/)
  })
})

describe('checklist full-close gate', () => {
  test('cannot mark a checklist stage done while items are pending', async () => {
    const { api, base, readStages } = await arrange({ stageNames: ['A'], stageKinds: ['checklist'] })
    await api.post(`${base}/stages/0/items`, { name: 'Red dip' })
    await api.post(`${base}/stages/0/items`, { name: 'Navy dip' })
    await api.post(`${base}/stages/0/items/0`, { status: 'done' })

    const { status, body } = await api.post(`${base}/stages/0`, { status: 'done' })
    assert.equal(status, 400)
    assert.match(body.error, /1 of 2 checklist item\(s\) still pending/)
    assert.equal((await readStages())[0].status, 'not_started', 'nothing was written')
  })

  test('closing succeeds once every item is done', async () => {
    const { api, base, readStages } = await arrange({ stageNames: ['A'], stageKinds: ['checklist'] })
    await api.post(`${base}/stages/0/items`, { name: 'Red dip' })
    await api.post(`${base}/stages/0/items/0`, { status: 'done' })

    const { status } = await api.post(`${base}/stages/0`, { status: 'done' })
    assert.equal(status, 200)
    const s = (await readStages())[0]
    assert.equal(s.status, 'done')
    assert.ok(s.actualEnd)
  })

  test('a checklist stage with no items has nothing blocking it', async () => {
    const { api, base, readStages } = await arrange({ stageNames: ['A'], stageKinds: ['checklist'] })
    const { status } = await api.post(`${base}/stages/0`, { status: 'done' })
    assert.equal(status, 200)
    assert.equal((await readStages())[0].status, 'done')
  })

  test('milestone and quantity kinds are unaffected by the gate', async () => {
    const { api, base, readStages } = await arrange({
      stageNames: ['M', 'Q'], stageKinds: ['milestone', 'quantity'], totalQty: 50,
    })
    assert.equal((await api.post(`${base}/stages/0`, { status: 'done' })).status, 200)
    assert.equal((await api.post(`${base}/stages/1`, { unitsDone: 50 })).status, 200)
    const stages = await readStages()
    assert.equal(stages[0].status, 'done')
    assert.equal(stages[1].status, 'done')
  })

  test('the bulk route enforces the same gate', async () => {
    const { api, base, readStages } = await arrange({ stageNames: ['A'], stageKinds: ['checklist'] })
    await api.post(`${base}/stages/0/items`, { name: 'Red dip' })

    const { status, body } = await api.post(`${base}/stages/bulk`, { stages: [{ index: 0, status: 'done' }] })
    assert.equal(status, 400)
    assert.match(body.error, /checklist item\(s\) still pending/)
    assert.equal((await readStages())[0].status, 'not_started')
  })

  test('the /eta kind-flip branch enforces the same gate', async () => {
    const { api, base, readStages } = await arrange({ stageNames: ['A'], stageKinds: ['milestone'] })
    await api.post(`${base}/stages/0`, { status: 'done' })
    // Flip to checklist while empty — passes, since there's nothing pending yet.
    await api.post(`${base}/stages/0/eta`, { kind: 'checklist' })
    await api.post(`${base}/stages/0/items`, { name: 'Late-added item' })

    const { status, body } = await api.post(`${base}/stages/0/eta`, { kind: 'checklist' })
    assert.equal(status, 400)
    assert.match(body.error, /checklist item\(s\) still pending/)
    assert.equal((await readStages())[0].status, 'done', 'unchanged by the rejected request')
  })
})

describe('bulk stage update', () => {
  test('updates many stages in one request', async () => {
    const { api, base, readStages } = await arrange({
      stageNames: ['A', 'B', 'C'], stageKinds: ['milestone', 'milestone', 'milestone'],
    })

    const { status, body } = await api.post(`${base}/stages/bulk`, {
      stages: [
        { index: 0, status: 'done' },
        { index: 1, status: 'in_progress', blocked: true, blockedReason: 'awaiting fabric' },
        { index: 2, eta: '2026-08-30' },
      ],
    })
    assert.equal(status, 200)
    assert.equal(body.updated, 3)

    const stages = await readStages()
    assert.equal(stages[0].status, 'done')
    assert.equal(stages[0].unitsDone, stages[0].totalUnits)
    assert.equal(stages[1].status, 'in_progress')
    assert.equal(stages[1].blockedReason, 'awaiting fabric')
    assert.equal(stages[2].eta, '2026-08-30')
    assert.equal(stages[2].baselineEta, '2026-07-15', 'baseline captured on bulk revision too')
  })

  test('/stages/bulk is not parsed as a stage index', async () => {
    const { api, base } = await arrange()
    const { status, body } = await api.post(`${base}/stages/bulk`, { stages: [{ index: 0, eta: '2026-08-01' }] })
    assert.equal(status, 200, `route shadowed by :stageIndex — got ${JSON.stringify(body)}`)
  })

  test('one bad row rejects the whole request', async () => {
    const { api, base, readStages } = await arrange({
      stageNames: ['A', 'B'], stageKinds: ['milestone', 'milestone'],
    })

    const { status } = await api.post(`${base}/stages/bulk`, {
      stages: [{ index: 0, status: 'done' }, { index: 1, status: 'bogus' }],
    })
    assert.equal(status, 400)

    // Nothing was written — all-or-nothing.
    assert.equal((await readStages())[0].status, 'not_started')
  })

  test('duplicate indices are rejected', async () => {
    const { api, base } = await arrange({ stageNames: ['A'], stageKinds: ['milestone'] })
    const { status, body } = await api.post(`${base}/stages/bulk`, {
      stages: [{ index: 0, status: 'done' }, { index: 0, status: 'not_started' }],
    })
    assert.equal(status, 400)
    assert.match(body.error, /Duplicate entry/)
  })

  test('an out-of-range index is rejected', async () => {
    const { api, base } = await arrange()
    assert.equal((await api.post(`${base}/stages/bulk`, { stages: [{ index: 42, status: 'done' }] })).status, 400)
  })

  test('setting status on a quantity stage is refused with a pointer to the stage itself', async () => {
    const { api, base } = await arrange()
    const { status, body } = await api.post(`${base}/stages/bulk`, { stages: [{ index: 0, status: 'done' }] })
    assert.equal(status, 400)
    assert.match(body.error, /tracks units/)
  })

  test('the materials gate still applies through the bulk route', async () => {
    const { api, base } = await arrange({ stageNames: ['A'], stageKinds: ['milestone'] })
    await api.post(`${base}/stages/0/materials`, { name: 'Fabric', requiredQty: 10 })

    const { status, body } = await api.post(`${base}/stages/bulk`, { stages: [{ index: 0, status: 'done' }] })
    assert.equal(status, 400)
    assert.match(body.error, /material\(s\) still pending/)
  })

  test('an empty or oversized batch is rejected', async () => {
    const { api, base } = await arrange()
    assert.equal((await api.post(`${base}/stages/bulk`, { stages: [] })).status, 400)
    const many = Array.from({ length: 51 }, (_, i) => ({ index: 0, eta: '2026-08-01' }))
    assert.equal((await api.post(`${base}/stages/bulk`, { stages: many })).status, 400)
  })

  test('marking several milestones done in one batch stamps actualEnd on all of them', async () => {
    const { api, base, readStages } = await arrange({
      stageNames: ['A', 'B', 'C'], stageKinds: ['milestone', 'milestone', 'milestone'],
    })

    const { status } = await api.post(`${base}/stages/bulk`, {
      stages: [{ index: 0, status: 'done' }, { index: 1, status: 'done' }, { index: 2, status: 'done' }],
    })
    assert.equal(status, 200)

    const stages = await readStages()
    assert.ok(stages.every(s => s.actualEnd), 'every stage in the batch got actualEnd stamped')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// LANDMINE — stage insert is a second whole-array $set (alongside delete), so
// it needs the same explicit-normalization treatment for existing stages.
// ─────────────────────────────────────────────────────────────────────────────
describe('insert stage', () => {
  test('inserts at the start and shifts everything else down', async () => {
    const { api, base, readStages } = await arrange({ stageNames: ['One', 'Two'] })
    const { status, body } = await api.post(`${base}/stages/insert`, {
      index: 0, name: 'New First', startDate: 'NA', eta: 'NA',
    })
    assert.equal(status, 200)
    const stages = body.assignments[0].stages
    assert.deepEqual(stages.map(s => s.name), ['New First', 'One', 'Two'])
    assert.equal(stages[0].status, 'not_started')
    assert.equal(stages[0].kind, 'quantity')

    const fresh = await readStages()
    assert.deepEqual(fresh.map(s => s.name), ['New First', 'One', 'Two'])
  })

  test('inserts in the middle and at the end', async () => {
    const { api, base, readStages } = await arrange({ stageNames: ['One', 'Two', 'Three'] })
    await api.post(`${base}/stages/insert`, { index: 2, name: 'Middle', startDate: 'NA', eta: 'NA' })
    let stages = await readStages()
    assert.deepEqual(stages.map(s => s.name), ['One', 'Two', 'Middle', 'Three'])

    await api.post(`${base}/stages/insert`, { name: 'Tail', startDate: 'NA', eta: 'NA' })
    stages = await readStages()
    assert.deepEqual(stages.map(s => s.name), ['One', 'Two', 'Middle', 'Three', 'Tail'], 'omitting index appends to the end')
  })

  test('completed sibling stages survive the insert unchanged', async () => {
    const { api, base, readStages } = await arrange({ stageNames: ['One', 'Two', 'Three'], totalQty: 100 })
    await api.post(`${base}/stages/0`, { unitsDone: 100 })
    await api.post(`${base}/stages/1`, { unitsDone: 40 })

    await api.post(`${base}/stages/insert`, { index: 1, name: 'Inserted', startDate: 'NA', eta: 'NA' })

    const stages = await readStages()
    assert.deepEqual(stages.map(s => s.name), ['One', 'Inserted', 'Two', 'Three'])
    assert.equal(stages[0].status, 'done')
    assert.equal(stages[0].unitsDone, 100)
    assert.equal(stages[2].status, 'in_progress')
    assert.equal(stages[2].unitsDone, 40)
  })

  test('can insert an already-done stage with an explicit actualEnd', async () => {
    const { api, base, readStages } = await arrange({ stageNames: ['One'] })
    const { status } = await api.post(`${base}/stages/insert`, {
      index: 0, name: 'Already Closed', kind: 'milestone',
      startDate: '2026-07-28', eta: '2026-07-31', status: 'done', actualEnd: '2026-08-03',
    })
    assert.equal(status, 200)
    const s = (await readStages())[0]
    assert.equal(s.status, 'done')
    assert.equal(s.actualEnd, '2026-08-03')
    assert.equal(s.baselineEta, '2026-07-31', 'baseline freezes at the given eta, same as creation')
    assert.equal(s.unitsDone, s.totalUnits)
  })

  test('documents linked to a later stage shift their stageIndex up to match', async () => {
    const { api, base, readStages, admin, created } = await arrange({ stageNames: ['One', 'Two', 'Three'] })
    const mfrId = created.assignments[0].mid
    await Document.create({
      type: 'material_po', name: 'PO for stage 2', orderId: ORDER_ID, mfrId,
      uploadedBy: admin._id, stageIndex: 1,
    })

    await api.post(`${base}/stages/insert`, { index: 1, name: 'New', startDate: 'NA', eta: 'NA' })

    const doc = await Document.findOne({ orderId: ORDER_ID })
    assert.equal(doc.stageIndex, 2, 'shifted from 1 to 2 since the insert landed at its old position')

    const stages = await readStages()
    assert.equal(stages[2].name, 'Two', 'confirms the document now points at the stage it originally referenced')
  })

  test('rejects when it would exceed 50 stages', async () => {
    const names = Array.from({ length: 50 }, (_, i) => `S${i}`)
    const { api, base } = await arrange({ stageNames: names })
    const { status, body } = await api.post(`${base}/stages/insert`, { name: 'One more', startDate: 'NA', eta: 'NA' })
    assert.equal(status, 400)
    assert.match(body.error, /maximum of 50/)
  })

  test('rejects an invalid index and an invalid date', async () => {
    const { api, base } = await arrange({ stageNames: ['One'] })
    assert.equal((await api.post(`${base}/stages/insert`, { index: 5, name: 'X', startDate: 'NA', eta: 'NA' })).status, 400)
    assert.equal((await api.post(`${base}/stages/insert`, { index: 0, name: 'X', startDate: '', eta: 'NA' })).status, 400)
    assert.equal((await api.post(`${base}/stages/insert`, { index: 0, name: '', startDate: 'NA', eta: 'NA' })).status, 400)
  })

  test('a manufacturer cannot insert a stage', async () => {
    const { mfrApi, base } = await arrange({ stageNames: ['One'] })
    const { status } = await mfrApi.post(`${base}/stages/insert`, { name: 'X', startDate: 'NA', eta: 'NA' })
    assert.equal(status, 403)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// LANDMINE 1 — the stage-delete route is the only write that $sets the whole
// stages array from a .lean() read, so schema defaults could be stamped onto
// every sibling stage.
// ─────────────────────────────────────────────────────────────────────────────
describe('landmine: stage delete must not reset sibling stages', () => {
  test('completed stages survive the deletion of another stage', async () => {
    const { api, base, readStages } = await arrange({
      stageNames: ['One', 'Two', 'Three', 'Four', 'Five'], totalQty: 100,
    })

    await api.post(`${base}/stages/0`, { unitsDone: 100 })
    await api.post(`${base}/stages/1`, { unitsDone: 100 })
    await api.post(`${base}/stages/2`, { unitsDone: 60 })

    const { status } = await api.post(`${base}/stages/4/delete`)
    assert.equal(status, 200)

    const stages = await readStages()
    assert.equal(stages.length, 4)
    assert.deepEqual(stages.map(s => s.status), ['done', 'done', 'in_progress', 'not_started'])
    assert.deepEqual(stages.map(s => s.unitsDone), [100, 100, 60, 0])
  })

  test('baseline dates and blocked flags survive too', async () => {
    const { api, base, readStages } = await arrange({ stageNames: ['One', 'Two', 'Three'] })

    await api.post(`${base}/stages/0/eta`, { eta: '2026-08-01' })
    await api.post(`${base}/stages/0`, { unitsDone: 0, blocked: true, blockedReason: 'mill delay' })

    await api.post(`${base}/stages/2/delete`)

    const s = (await readStages())[0]
    assert.equal(s.baselineEta, '2026-07-15')
    assert.equal(s.etaVarianceDays, 17)
    assert.equal(s.blocked, true)
    assert.equal(s.blockedReason, 'mill delay')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// LANDMINE 2 — buyers can now BE a stage's responsibleId. Their write must stay
// scoped to status; everything else, especially materials, stays forbidden.
// ─────────────────────────────────────────────────────────────────────────────
describe('landmine: buyer carve-out is narrow', () => {
  async function buyerOwnsStage0() {
    const ctx = await arrange({ stageNames: ['NB Approval', 'Two'], stageKinds: ['milestone', 'quantity'] })
    await ctx.api.post(`${ctx.base}/stages/0/eta`, { responsibleId: String(ctx.buyer._id) })
    return ctx
  }

  test('a buyer may set the status of a stage they own', async () => {
    const { buyerApi, base, readStages } = await buyerOwnsStage0()

    const { status } = await buyerApi.post(`${base}/stages/0`, { status: 'done' })
    assert.equal(status, 200)
    assert.equal((await readStages())[0].status, 'done')
  })

  test('a buyer may flag their own stage blocked', async () => {
    const { buyerApi, base, readStages } = await buyerOwnsStage0()
    assert.equal((await buyerApi.post(`${base}/stages/0`, { blocked: true, blockedReason: 'need physical sample' })).status, 200)
    assert.equal((await readStages())[0].blocked, true)
  })

  test('a buyer may NOT touch dates, units or notes even on a stage they own', async () => {
    const { buyerApi, base } = await buyerOwnsStage0()

    for (const body of [{ eta: '2026-09-01' }, { unitsDone: 1 }, { note: 'hi' }, { startDate: '2026-06-01' }]) {
      const { status } = await buyerApi.post(`${base}/stages/0`, body)
      assert.equal(status, 403, `buyer should not write ${Object.keys(body)[0]}`)
    }
  })

  test('a buyer may NOT write a stage they do not own', async () => {
    const { buyerApi, base } = await buyerOwnsStage0()
    assert.equal((await buyerApi.post(`${base}/stages/1`, { status: 'done' })).status, 403)
  })

  test('a buyer still may NOT manage materials on a stage they own', async () => {
    const { api, buyerApi, base } = await buyerOwnsStage0()
    await api.post(`${base}/stages/0/materials`, { name: 'Fabric', requiredQty: 10 })

    assert.equal((await buyerApi.post(`${base}/stages/0/materials`, { name: 'X', requiredQty: 1 })).status, 403)
    assert.equal((await buyerApi.post(`${base}/stages/0/materials/0`, { status: 'received' })).status, 403)
    assert.equal((await buyerApi.post(`${base}/stages/0/materials/0/delete`)).status, 403)
  })

  test('a buyer still may NOT manage checklist items on a stage they own', async () => {
    const { buyerApi, base } = await buyerOwnsStage0()
    assert.equal((await buyerApi.post(`${base}/stages/0/items`, { name: 'X' })).status, 403)
  })

  test('a buyer still may NOT adjust stage metadata on a stage they own', async () => {
    const { buyerApi, base } = await buyerOwnsStage0()
    assert.equal((await buyerApi.post(`${base}/stages/0/eta`, { eta: '2026-09-01' })).status, 403)
  })

  test('the bulk route applies the same carve-out', async () => {
    const { buyerApi, base, readStages } = await buyerOwnsStage0()

    assert.equal((await buyerApi.post(`${base}/stages/bulk`, { stages: [{ index: 0, status: 'done' }] })).status, 200)
    assert.equal((await readStages())[0].status, 'done')

    assert.equal((await buyerApi.post(`${base}/stages/bulk`, { stages: [{ index: 0, eta: '2026-09-09' }] })).status, 403)
    assert.equal((await buyerApi.post(`${base}/stages/bulk`, { stages: [{ index: 1, status: 'done' }] })).status, 403)
  })
})
