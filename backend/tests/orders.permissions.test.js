// Characterization: the role boundary, which CLAUDE.md calls load-bearing.
//
// The "buyer cannot touch materials" block is the regression guard for the
// change that widens responsibleId to accept buyers. Those routes gate on
// `role !== 'admin' && !isResponsible` with NO explicit buyer deny — they are
// safe today only because a buyer can never currently BE responsibleId. These
// tests pass now and must still pass afterwards.

import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as } from './helpers/client.js'
import { makeAdmin, makeMaster, makeBuyer, makeMfr, orderPayload } from './helpers/factories.js'

before(async () => {
  await startTestDb()
  await startServer()
})
after(async () => {
  await stopServer()
  await stopTestDb()
})
beforeEach(clearDb)

const ORDER_ID = 'PERM-TEST-001'

/** An order split across two manufacturers, so cross-tenant stripping is testable. */
async function arrangeSplit() {
  const admin = await makeAdmin()
  const master = await makeMaster()
  const buyer = await makeBuyer()
  const mfrA = await makeMfr()
  const mfrB = await makeMfr()
  const api = as(admin)

  const payload = orderPayload({ id: ORDER_ID, buyerId: buyer._id, mfrId: mfrA._id, totalQty: 100 })
  payload.assignments = [
    { mid: String(mfrA._id), qty: 60 },
    { mid: String(mfrB._id), qty: 40 },
  ]
  const res = await api.post('/api/orders', payload)
  assert.equal(res.status, 201, `arrange failed: ${JSON.stringify(res.body)}`)

  return { admin, master, buyer, mfrA, mfrB, api, masterApi: as(master) }
}

describe('enrichOrder — cross-tenant stripping', () => {
  test('a manufacturer sees only their own assignment', async () => {
    const { mfrA, mfrB } = await arrangeSplit()

    const { status, body } = await as(mfrA).get(`/api/orders/${ORDER_ID}`)
    assert.equal(status, 200)
    assert.equal(body.assignments.length, 1)
    assert.equal(body.assignments[0].mid, String(mfrA._id))

    // Nothing of the other split leaks through, at any depth.
    assert.ok(!JSON.stringify(body).includes(String(mfrB._id)))
  })

  test('the list endpoint strips the same way', async () => {
    const { mfrA } = await arrangeSplit()
    const { body } = await as(mfrA).get('/api/orders')
    const order = body.find(o => o.id === ORDER_ID)
    assert.equal(order.assignments.length, 1)
    assert.equal(order.assignments[0].mid, String(mfrA._id))
  })

  test('an admin and the buyer see both assignments', async () => {
    const { api, buyer } = await arrangeSplit()
    assert.equal((await api.get(`/api/orders/${ORDER_ID}`)).body.assignments.length, 2)
    assert.equal((await as(buyer).get(`/api/orders/${ORDER_ID}`)).body.assignments.length, 2)
  })

  test('an unrelated manufacturer cannot read the order at all', async () => {
    await arrangeSplit()
    const outsider = await makeMfr()
    assert.equal((await as(outsider).get(`/api/orders/${ORDER_ID}`)).status, 403)
  })

  test('an unrelated buyer cannot read the order', async () => {
    await arrangeSplit()
    const otherBuyer = await makeBuyer()
    assert.equal((await as(otherBuyer).get(`/api/orders/${ORDER_ID}`)).status, 403)
  })
})

// Regression for the enrichOrder(order) call sites that echoed back the WHOLE
// order (including the other manufacturer's assignment) after a write,
// unlike GET /:id which correctly strips it. Not just a Kriyaa concern — the
// human UI's own manual edits hit these same routes and got the same leak in
// the raw response body. Every site a manufacturer can actually reach.
describe('a manufacturer\'s own write never echoes the other manufacturer\'s assignment back', () => {
  test('the general stage-status route', async () => {
    const { mfrA, mfrB } = await arrangeSplit()
    const { status, body } = await as(mfrA).post(`/api/orders/${ORDER_ID}/assignments/${mfrA._id}/stages/0`, { unitsDone: 1 })
    assert.equal(status, 200)
    assert.ok(!JSON.stringify(body).includes(String(mfrB._id)), 'mfrB must not appear in mfrA\'s own write response')
    assert.equal(body.assignments.length, 1)
  })

  test('the stage-updates (comment thread) route', async () => {
    const { mfrA, mfrB } = await arrangeSplit()
    const { status, body } = await as(mfrA).post(`/api/orders/${ORDER_ID}/assignments/${mfrA._id}/stages/0/updates`, { text: 'fabric received' })
    assert.equal(status, 200)
    assert.ok(!JSON.stringify(body).includes(String(mfrB._id)))
  })

  test('the materials add/update/delete routes', async () => {
    const { mfrA, mfrB, api } = await arrangeSplit()
    // Materials routes gate on admin OR that stage's own responsibleId.
    await api.post(`/api/orders/${ORDER_ID}/assignments/${mfrA._id}/stages/bulk`, { stages: [{ index: 0, responsibleId: String(mfrA._id) }] })
    const add = await as(mfrA).post(`/api/orders/${ORDER_ID}/assignments/${mfrA._id}/stages/0/materials`, { name: 'Zipper', requiredQty: 10 })
    assert.equal(add.status, 200)
    assert.ok(!JSON.stringify(add.body).includes(String(mfrB._id)))

    const lineId = add.body.assignments[0].stages[0].materials[0].id
    const upd = await as(mfrA).post(`/api/orders/${ORDER_ID}/assignments/${mfrA._id}/stages/0/materials/0`, { receivedQty: 5 })
    assert.equal(upd.status, 200)
    assert.ok(!JSON.stringify(upd.body).includes(String(mfrB._id)))

    const del = await as(mfrA).post(`/api/orders/${ORDER_ID}/assignments/${mfrA._id}/stages/0/materials/0/delete`)
    assert.equal(del.status, 200)
    assert.ok(!JSON.stringify(del.body).includes(String(mfrB._id)))
  })

  test('the checklist items add/update/delete routes', async () => {
    const { mfrA, mfrB, api } = await arrangeSplit()
    // Items live on a checklist-kind stage, and the route gates on admin OR
    // that stage's own responsibleId — set both via bulk first.
    await api.post(`/api/orders/${ORDER_ID}/assignments/${mfrA._id}/stages/bulk`, { stages: [{ index: 0, kind: 'checklist', responsibleId: String(mfrA._id) }] })

    const add = await as(mfrA).post(`/api/orders/${ORDER_ID}/assignments/${mfrA._id}/stages/0/items`, { name: 'Lab Dip — Red' })
    assert.equal(add.status, 200, JSON.stringify(add.body))
    assert.ok(!JSON.stringify(add.body).includes(String(mfrB._id)))

    const upd = await as(mfrA).post(`/api/orders/${ORDER_ID}/assignments/${mfrA._id}/stages/0/items/0`, { status: 'done' })
    assert.equal(upd.status, 200)
    assert.ok(!JSON.stringify(upd.body).includes(String(mfrB._id)))

    const del = await as(mfrA).post(`/api/orders/${ORDER_ID}/assignments/${mfrA._id}/stages/0/items/0/delete`)
    assert.equal(del.status, 200)
    assert.ok(!JSON.stringify(del.body).includes(String(mfrB._id)))
  })
})

describe('stage writes — who may write', () => {
  test('a manufacturer may update their own stage', async () => {
    const { mfrA } = await arrangeSplit()
    const { status } = await as(mfrA).post(`/api/orders/${ORDER_ID}/assignments/${mfrA._id}/stages/0`, { unitsDone: 5 })
    assert.equal(status, 200)
  })

  test('a manufacturer may not write another manufacturer\'s stage', async () => {
    const { mfrA, mfrB } = await arrangeSplit()
    const { status } = await as(mfrA).post(`/api/orders/${ORDER_ID}/assignments/${mfrB._id}/stages/0`, { unitsDone: 5 })
    assert.equal(status, 403)
  })

  test('a buyer may not update a stage', async () => {
    const { buyer, mfrA } = await arrangeSplit()
    const { status, body } = await as(buyer).post(`/api/orders/${ORDER_ID}/assignments/${mfrA._id}/stages/0`, { unitsDone: 5 })
    assert.equal(status, 403)
    assert.equal(body.error, 'Buyers cannot update production stages')
  })

  test('a buyer may not post to a stage updates thread', async () => {
    const { buyer, mfrA } = await arrangeSplit()
    const { status } = await as(buyer).post(`/api/orders/${ORDER_ID}/assignments/${mfrA._id}/stages/0/updates`, { text: 'hi' })
    assert.equal(status, 403)
  })

  test('a buyer may not adjust stage dates', async () => {
    const { buyer, mfrA } = await arrangeSplit()
    const { status } = await as(buyer).post(`/api/orders/${ORDER_ID}/assignments/${mfrA._id}/stages/0/eta`, { eta: '2026-09-09' })
    assert.equal(status, 403)
  })

  test('only a master admin may override', async () => {
    const { api, masterApi, mfrA } = await arrangeSplit()
    const url = `/api/orders/${ORDER_ID}/assignments/${mfrA._id}/stages/0`

    const plain = await api.post(url, { unitsDone: 5, override: true })
    assert.equal(plain.status, 403)
    assert.equal(plain.body.error, 'Only master admin can override a stage')

    assert.equal((await masterApi.post(url, { unitsDone: 5, override: true })).status, 200)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// LANDMINE GUARD — these must keep passing after responsibleId accepts buyers.
// ─────────────────────────────────────────────────────────────────────────────
describe('buyer may never write materials / PO lines', () => {
  async function withMaterial() {
    const ctx = await arrangeSplit()
    const base = `/api/orders/${ORDER_ID}/assignments/${ctx.mfrA._id}/stages/0`
    const res = await ctx.api.post(`${base}/materials`, { name: 'Main fabric', requiredQty: 500 })
    assert.equal(res.status, 200)
    return { ...ctx, base }
  }

  test('cannot add a material line', async () => {
    const { buyer, base } = await withMaterial()
    const { status } = await as(buyer).post(`${base}/materials`, { name: 'Sneaky', requiredQty: 1 })
    assert.equal(status, 403)
  })

  test('cannot update a material line', async () => {
    const { buyer, base } = await withMaterial()
    const { status } = await as(buyer).post(`${base}/materials/0`, { status: 'received', receivedQty: 500 })
    assert.equal(status, 403)
  })

  test('cannot delete a material line', async () => {
    const { buyer, base } = await withMaterial()
    const { status } = await as(buyer).post(`${base}/materials/0/delete`)
    assert.equal(status, 403)
  })

  test('cannot bulk-upload materials', async () => {
    const { buyer } = await withMaterial()
    const { status } = await as(buyer).post('/api/orders/materials/bulk', { rows: [] })
    assert.equal(status, 403)
  })
})

describe('order-level writes', () => {
  test('a buyer may not change assignment status', async () => {
    const { buyer, mfrA } = await arrangeSplit()
    const { status } = await as(buyer).post(`/api/orders/${ORDER_ID}/assignments/${mfrA._id}`, { status: 'Delivered' })
    assert.equal(status, 403)
  })

  test('a buyer may not delete an order', async () => {
    const { buyer } = await arrangeSplit()
    assert.equal((await as(buyer).post(`/api/orders/${ORDER_ID}/delete`)).status, 403)
  })

  test('unauthenticated requests are rejected', async () => {
    await arrangeSplit()
    const { req } = await import('./helpers/client.js')
    assert.equal((await req('GET', '/api/orders')).status, 401)
  })
})
