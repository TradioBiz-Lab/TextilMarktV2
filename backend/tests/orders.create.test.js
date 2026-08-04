// Characterization: order-creation validation as it behaves TODAY.
//
// These pin rules that must survive the parallel-stage work. If one of them
// changes, that has to be a reviewed edit to this file — not a surprise.

import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as } from './helpers/client.js'
import { makeAdmin, makeBuyer, makeMfr, makeMasterOrder, orderPayload } from './helpers/factories.js'

before(async () => {
  await startTestDb()
  await startServer()
})
after(async () => {
  await stopServer()
  await stopTestDb()
})
beforeEach(clearDb)

async function arrange() {
  const admin = await makeAdmin()
  const buyer = await makeBuyer()
  const mfr = await makeMfr()
  return { admin, buyer, mfr, api: as(admin) }
}

describe('POST /api/orders — creation rules', () => {
  test('creates an order with index-aligned stage arrays', async () => {
    const { buyer, mfr, api } = await arrange()
    const { status, body } = await api.post('/api/orders', orderPayload({
      buyerId: buyer._id, mfrId: mfr._id,
      stageNames: ['Trims Order', 'Dyeing', 'Production'],
      stageStartDates: ['2026-07-01', '2026-07-05', '2026-07-20'],
      stageEtas: ['2026-07-03', '2026-07-18', '2026-08-10'],
    }))

    assert.equal(status, 201)
    assert.equal(body.assignments.length, 1)
    const stages = body.assignments[0].stages
    assert.equal(stages.length, 3)
    assert.deepEqual(stages.map(s => s.name), ['Trims Order', 'Dyeing', 'Production'])
    assert.equal(stages[1].startDate, '2026-07-05')
    assert.equal(stages[1].eta, '2026-07-18')
    // Every stage starts at zero progress.
    assert.deepEqual(stages.map(s => s.unitsDone), [0, 0, 0])
  })

  test('assignment quantities must sum to totalQty', async () => {
    const { buyer, mfr, api } = await arrange()
    const payload = orderPayload({ buyerId: buyer._id, mfrId: mfr._id, totalQty: 100 })
    payload.assignments = [{ mid: String(mfr._id), qty: 60 }]

    const { status, body } = await api.post('/api/orders', payload)
    assert.equal(status, 400)
    assert.match(body.error, /must sum to total quantity/)
  })

  test('a stage missing a start date is rejected', async () => {
    const { buyer, mfr, api } = await arrange()
    const { status, body } = await api.post('/api/orders', orderPayload({
      buyerId: buyer._id, mfrId: mfr._id,
      stageNames: ['Alpha', 'Beta'],
      stageStartDates: ['2026-07-01', ''],
      stageEtas: ['2026-07-02', '2026-07-09'],
    }))
    assert.equal(status, 400)
    assert.equal(body.error, 'Stage "Beta" is missing a start date')
  })

  test('a stage missing an end date is rejected', async () => {
    const { buyer, mfr, api } = await arrange()
    const { status, body } = await api.post('/api/orders', orderPayload({
      buyerId: buyer._id, mfrId: mfr._id,
      stageNames: ['Alpha'],
      stageStartDates: ['2026-07-01'],
      stageEtas: [''],
    }))
    assert.equal(status, 400)
    assert.equal(body.error, 'Stage "Alpha" is missing an end date')
  })

  test('"NA" is accepted for both dates', async () => {
    const { buyer, mfr, api } = await arrange()
    const { status, body } = await api.post('/api/orders', orderPayload({
      buyerId: buyer._id, mfrId: mfr._id,
      stageNames: ['Not Applicable Step'],
      stageStartDates: ['NA'],
      stageEtas: ['NA'],
    }))
    assert.equal(status, 201)
    assert.equal(body.assignments[0].stages[0].startDate, 'NA')
  })

  test('start date must be on or before end date, within a stage', async () => {
    const { buyer, mfr, api } = await arrange()
    const { status, body } = await api.post('/api/orders', orderPayload({
      buyerId: buyer._id, mfrId: mfr._id,
      stageNames: ['Backwards'],
      stageStartDates: ['2026-07-10'],
      stageEtas: ['2026-07-01'],
    }))
    assert.equal(status, 400)
    assert.equal(body.error, 'Stage "Backwards" start date must be on or before its end date')
  })

  // The behaviour that makes parallel steps expressible at all: there is no
  // cross-stage ordering rule, so overlapping windows are already legal.
  test('overlapping stage windows are accepted', async () => {
    const { buyer, mfr, api } = await arrange()
    const { status, body } = await api.post('/api/orders', orderPayload({
      buyerId: buyer._id, mfrId: mfr._id,
      stageNames: ['FPT Sent', 'PP Sample Sent', 'GPT Sent'],
      stageStartDates: ['2026-08-03', '2026-08-06', '2026-08-06'],
      stageEtas:       ['2026-08-07', '2026-08-10', '2026-08-10'],
    }))
    assert.equal(status, 201)
    assert.equal(body.assignments[0].stages.length, 3)
  })

  test('more than 50 stages is rejected', async () => {
    const { buyer, mfr, api } = await arrange()
    const names = Array.from({ length: 51 }, (_, i) => `Stage ${i + 1}`)
    const { status, body } = await api.post('/api/orders', orderPayload({
      buyerId: buyer._id, mfrId: mfr._id,
      stageNames: names,
      stageStartDates: names.map(() => '2026-07-01'),
      stageEtas: names.map(() => '2026-07-02'),
    }))
    assert.equal(status, 400)
    assert.equal(body.error, 'Too many stages (max 50)')
  })

  test('a duplicate order id returns 409', async () => {
    const { buyer, mfr, api } = await arrange()
    const payload = orderPayload({ buyerId: buyer._id, mfrId: mfr._id, id: 'DUP-TEST-001' })

    assert.equal((await api.post('/api/orders', payload)).status, 201)
    const second = await api.post('/api/orders', { ...payload })
    assert.equal(second.status, 409)
    assert.equal(second.body.error, 'Order ID already exists')
  })

  test('a manufacturer id that is not a manufacturer is rejected', async () => {
    const { buyer, api } = await arrange()
    const notAnMfr = await makeBuyer()
    const { status, body } = await api.post('/api/orders', orderPayload({
      buyerId: buyer._id, mfrId: notAnMfr._id,
    }))
    assert.equal(status, 400)
    assert.match(body.error, /is not a manufacturer/)
  })

  test('an inactive manufacturer is rejected', async () => {
    const { buyer, api } = await arrange()
    const inactive = await makeMfr({ isActive: false })
    const { status, body } = await api.post('/api/orders', orderPayload({
      buyerId: buyer._id, mfrId: inactive._id,
    }))
    assert.equal(status, 400)
    assert.match(body.error, /is inactive/)
  })

  test('a master order belonging to a different buyer is rejected', async () => {
    const { admin, buyer, mfr, api } = await arrange()
    const otherBuyer = await makeBuyer()
    const mo = await makeMasterOrder({ buyerId: otherBuyer._id, createdBy: admin._id })

    const { status, body } = await api.post('/api/orders', orderPayload({
      buyerId: buyer._id, mfrId: mfr._id, masterOrderId: mo._id,
    }))
    assert.equal(status, 400)
    assert.equal(body.error, 'Master order does not belong to the selected buyer')
  })

  test('non-admins cannot create orders', async () => {
    const { buyer, mfr } = await arrange()
    for (const user of [buyer, mfr]) {
      const { status } = await as(user).post('/api/orders', orderPayload({ buyerId: buyer._id, mfrId: mfr._id }))
      assert.equal(status, 403, `${user.role} should not be able to create an order`)
    }
  })
})
