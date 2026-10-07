// Batch two of the bug review: the Delivery step is the single source of truth for
// "delivered", and a stage's status, unitsDone and actualEnd never disagree after its
// target changes.

import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as } from './helpers/client.js'
import { makeMaster, makeBuyer, makeMfr, orderPayload } from './helpers/factories.js'
import { reconcileForTotal } from '../src/models/Order.js'

before(async () => { await startTestDb(); await startServer() })
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(clearDb)

const ORDER_ID = 'CON-TEST-001'

async function arrange(extra = {}) {
  const admin = await makeMaster()
  const buyer = await makeBuyer()
  const mfr = await makeMfr()
  const api = as(admin)
  const res = await api.post('/api/orders', orderPayload({
    id: ORDER_ID, buyerId: buyer._id, mfrId: mfr._id, totalQty: 100, delivery: '2026-12-31',
    stageNames: ['Cutting', 'Sewing'],
    stageStartDates: ['2026-07-01', '2026-07-05'], stageEtas: ['2026-07-03', '2026-07-10'],
    stageKinds: ['quantity', 'milestone'],
    ...extra,
  }))
  assert.equal(res.status, 201, JSON.stringify(res.body))
  const base = `/api/orders/${ORDER_ID}/assignments/${mfr._id}`
  const read = async () => (await api.get(`/api/orders/${ORDER_ID}`)).body.assignments[0]
  const deliveryIndex = async () => (await read()).stages.findIndex(s => s.isDelivery)
  return { admin, mfr, api, base, read, deliveryIndex, mfrApi: as(mfr) }
}

describe('reconcileForTotal', () => {
  test('quantity stages follow their units', () => {
    const s = { kind: 'quantity', unitsDone: 600, totalUnits: 600, status: 'done', actualEnd: '2026-07-01' }
    assert.deepEqual(reconcileForTotal(s, 800), { status: 'in_progress', unitsDone: 600, actualEnd: null })
    assert.equal(reconcileForTotal(s, 600).status, 'done')
    assert.equal(reconcileForTotal({ kind: 'quantity', unitsDone: 0 }, 50).status, 'not_started')
  })

  test('milestone stages mirror their status onto the new target', () => {
    const done = { kind: 'milestone', status: 'done', unitsDone: 1, totalUnits: 1, actualEnd: '2026-07-01' }
    assert.deepEqual(reconcileForTotal(done, 5), { status: 'done', unitsDone: 5, actualEnd: '2026-07-01' })
    const open = { kind: 'milestone', status: 'not_started', unitsDone: 0, totalUnits: 1 }
    assert.equal(reconcileForTotal(open, 5).unitsDone, 0)
  })
})

describe('manual status cannot contradict the Delivery step', () => {
  test('Delivered needs the Delivery step closed; reopening is the way back', async () => {
    const { api, base, deliveryIndex } = await arrange()
    const d = await deliveryIndex()

    const early = await api.post(base, { status: 'Delivered' })
    assert.equal(early.status, 400, JSON.stringify(early.body))

    assert.equal((await api.post(`${base}/stages/${d}`, { status: 'done' })).status, 200)
    assert.equal((await api.post(base, { status: 'Delivered', note: 'received' })).status, 200)
    assert.equal((await api.post(base, { status: 'Processing' })).status, 400)
    assert.equal((await api.post(base, { status: 'On Hold' })).status, 400)

    assert.equal((await api.post(`${base}/stages/${d}`, { status: 'not_started' })).status, 200)
    assert.equal((await api.post(base, { status: 'On Hold' })).status, 200)
  })

  test('a manufacturer is held to the same rule', async () => {
    const { base, mfrApi } = await arrange()
    assert.equal((await mfrApi.post(base, { status: 'Delivered' })).status, 400)
    assert.equal((await mfrApi.post(base, { status: 'Delayed' })).status, 200)
  })
})

describe('closing the Delivery step through /eta', () => {
  test('setting its actual end marks the split Delivered', async () => {
    const { api, base, read, deliveryIndex } = await arrange()
    const d = await deliveryIndex()
    const res = await api.post(`${base}/stages/${d}/eta`, { actualEnd: '2026-07-20' })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    const asgn = await read()
    assert.equal(asgn.stages[d].status, 'done')
    assert.equal(asgn.status, 'Delivered')
  })
})

describe('the Delivery step keeps its shape', () => {
  test('/eta rejects a new kind or target', async () => {
    const { api, base, deliveryIndex } = await arrange()
    const d = await deliveryIndex()
    assert.equal((await api.post(`${base}/stages/${d}/eta`, { kind: 'quantity' })).status, 400)
    assert.equal((await api.post(`${base}/stages/${d}/eta`, { totalUnits: 5 })).status, 400)
  })

  test('bulk rejects a new kind or target', async () => {
    const { api, base, deliveryIndex } = await arrange()
    const d = await deliveryIndex()
    assert.equal((await api.post(`${base}/stages/bulk`, { stages: [{ index: d, kind: 'checklist' }] })).status, 400)
    assert.equal((await api.post(`${base}/stages/bulk`, { stages: [{ index: d, totalUnits: 3 }] })).status, 400)
  })
})

describe('changing a target keeps the mirror intact', () => {
  test('/eta: a done milestone given a bigger target stays consistent', async () => {
    const { api, base, read } = await arrange()
    assert.equal((await api.post(`${base}/stages/1`, { status: 'done' })).status, 200)
    assert.equal((await api.post(`${base}/stages/1/eta`, { totalUnits: 5 })).status, 200)
    const s = (await read()).stages[1]
    assert.equal(s.status, 'done')
    assert.equal(s.unitsDone, 5)
  })

  test('/eta: a finished quantity stage given a bigger target reopens', async () => {
    const { api, base, read } = await arrange()
    assert.equal((await api.post(`${base}/stages/0`, { status: 'done' })).status, 200)
    assert.equal((await read()).stages[0].unitsDone, 100)
    assert.equal((await api.post(`${base}/stages/0/eta`, { totalUnits: 150 })).status, 200)
    const s = (await read()).stages[0]
    assert.equal(s.status, 'in_progress')
    assert.equal(s.unitsDone, 100)
    assert.ok(!s.actualEnd, 'completion stamp is cleared')
  })

  test('bulk: the same target change is reconciled', async () => {
    const { api, base, read } = await arrange()
    assert.equal((await api.post(`${base}/stages/0`, { status: 'done' })).status, 200)
    assert.equal((await api.post(`${base}/stages/bulk`, { stages: [{ index: 0, totalUnits: 150 }] })).status, 200)
    const s = (await read()).stages[0]
    assert.equal(s.status, 'in_progress')
    assert.equal(s.unitsDone, 100)
  })

  test('raising the order quantity reopens a finished quantity stage', async () => {
    const { api, base, read } = await arrange()
    assert.equal((await api.post(`${base}/stages/0`, { status: 'done' })).status, 200)
    const edit = await api.post(`/api/orders/${ORDER_ID}`, { totalQty: 140 })
    assert.equal(edit.status, 200, JSON.stringify(edit.body))
    const s = (await read()).stages[0]
    assert.equal(s.totalUnits, 140)
    assert.equal(s.status, 'in_progress')
    assert.equal(s.unitsDone, 100)
  })
})
