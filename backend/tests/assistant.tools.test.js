// Exercises the assistant's TOOL_HANDLERS directly against the real app + an
// in-memory Mongo — no Anthropic SDK involved. Most handlers are loopback
// HTTP wrappers around the app's own REST routes (see assistant.js), so this
// also proves they relay existing gates/permissions faithfully rather than
// re-implementing (or accidentally loosening) them.
//
// client.js's as() authenticates over an Authorization: Bearer header, not a
// cookie — so `ctx.cookie` here is built by hand in the cookie-parser shape
// requireAuth expects ("tradio_token=<jwt>"), matching what a real browser
// session sends.

import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as, tokenFor } from './helpers/client.js'
import { makeAdmin, makeBuyer, makeMfr, orderPayload } from './helpers/factories.js'
import { ActionItem } from '../src/db/index.js'
import { TOOL_HANDLERS } from '../src/routes/assistant.js'

before(async () => {
  await startTestDb()
  const baseUrl = await startServer()
  // loopbackPort() in assistant.js reads process.env.PORT fresh per call — this
  // points every loopback tool call at the same dynamically-bound port the test
  // server is actually listening on.
  process.env.PORT = new URL(baseUrl).port
})
after(async () => {
  await stopServer()
  await stopTestDb()
})
beforeEach(clearDb)

const cookieFor = user => `tradio_token=${tokenFor(user)}`

const ORDER_ID = 'ASSISTANT-TEST-001'

async function arrange({ stageNames = ['One', 'Two'], stageKinds, delivery = '2026-12-31' } = {}) {
  const admin = await makeAdmin()
  const buyer = await makeBuyer()
  const mfr = await makeMfr()
  const api = as(admin)

  const res = await api.post('/api/orders', orderPayload({
    id: ORDER_ID, buyerId: buyer._id, mfrId: mfr._id, delivery, stageNames,
    stageStartDates: stageNames.map(() => '2026-07-01'),
    stageEtas: stageNames.map(() => '2026-07-15'),
    ...(stageKinds ? { stageKinds } : {}),
  }))
  assert.equal(res.status, 201, `arrange failed: ${JSON.stringify(res.body)}`)

  const ctx = { cookie: cookieFor(admin) }
  return { admin, buyer, mfr, api, ctx }
}

describe('read tools', () => {
  test('list_action_items returns the workspace task list', async () => {
    const admin = await makeAdmin()
    await ActionItem.create({ title: 'Follow up on trims', assigneeId: admin._id, createdBy: admin._id })
    const result = await TOOL_HANDLERS.list_action_items({}, { cookie: cookieFor(admin) })
    assert.equal(result.ok, true)
    assert.equal(result.data.length, 1)
    assert.equal(result.data[0].title, 'Follow up on trims')
  })

  test('list_orders returns every order', async () => {
    const { ctx } = await arrange()
    const result = await TOOL_HANDLERS.list_orders({}, ctx)
    assert.equal(result.ok, true)
    assert.equal(result.data.length, 1)
    assert.equal(result.data[0].id, ORDER_ID)
  })

  test('get_order fetches one order by id', async () => {
    const { ctx } = await arrange()
    const result = await TOOL_HANDLERS.get_order({ orderId: ORDER_ID }, ctx)
    assert.equal(result.ok, true)
    assert.equal(result.data.id, ORDER_ID)
    assert.equal(result.data.assignments[0].stages.length, 2)
  })

  // Regression test for a real production incident: 15 of 17 live orders carry
  // a base64 product photo (some 400KB+), and passing that through to the
  // model blew straight past the Anthropic API's 1M-token limit the first
  // time a tool touched more than a couple of real orders. Every order-shaped
  // tool result must have image fields stripped.
  test('list_orders and get_order never leak imageDataUrl/imageUrl', async () => {
    const { ctx, api, mfr } = await arrange()
    const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    const editRes = await api.post(`/api/orders/${ORDER_ID}`, { imageDataUrl: tinyPng })
    assert.equal(editRes.status, 200, `edit failed: ${JSON.stringify(editRes.body)}`)

    const listResult = await TOOL_HANDLERS.list_orders({}, ctx)
    assert.equal(listResult.ok, true)
    for (const order of listResult.data) {
      assert.equal(order.imageDataUrl, undefined)
      assert.equal(order.imageUrl, undefined)
    }

    const getResult = await TOOL_HANDLERS.get_order({ orderId: ORDER_ID }, ctx)
    assert.equal(getResult.ok, true)
    assert.equal(getResult.data.imageDataUrl, undefined)
    assert.equal(getResult.data.imageUrl, undefined)

    // Write-tool responses echo back the whole updated order too — must be
    // stripped there as well, not just on the two read tools.
    const writeResult = await TOOL_HANDLERS.post_stage_update(
      { orderId: ORDER_ID, mfrId: String(mfr._id), stageIndex: 0, text: 'note' }, ctx)
    assert.equal(writeResult.ok, true)
    assert.equal(writeResult.data.imageDataUrl, undefined)

    // Confirm the image is still really there via the real REST route (i.e.
    // we stripped it in the assistant's tool layer, not from the app itself).
    const direct = await api.get(`/api/orders/${ORDER_ID}`)
    assert.equal(direct.body.imageDataUrl, tinyPng)
  })
})

describe('write tools', () => {
  test('post_stage_update appends a note without changing status', async () => {
    const { ctx, mfr } = await arrange()
    const result = await TOOL_HANDLERS.post_stage_update(
      { orderId: ORDER_ID, mfrId: String(mfr._id), stageIndex: 0, text: 'Buyer approved over a call' }, ctx)
    assert.equal(result.ok, true)
    const stage = result.data.assignments[0].stages[0]
    assert.equal(stage.updates.length, 1)
    assert.equal(stage.updates[0].text, 'Buyer approved over a call')
    assert.equal(stage.status, 'not_started')
  })

  test('update_stage_status sets unitsDone on a quantity-kind stage', async () => {
    const { ctx, mfr } = await arrange({ stageKinds: ['quantity', 'quantity'] })
    const result = await TOOL_HANDLERS.update_stage_status(
      { orderId: ORDER_ID, mfrId: String(mfr._id), stageIndex: 0, unitsDone: 100 }, ctx)
    assert.equal(result.ok, true)
    assert.equal(result.data.assignments[0].stages[0].unitsDone, 100)
  })

  test('update_stage_status sets status on a milestone-kind stage', async () => {
    const { ctx, mfr } = await arrange({ stageKinds: ['milestone', 'quantity'] })
    const result = await TOOL_HANDLERS.update_stage_status(
      { orderId: ORDER_ID, mfrId: String(mfr._id), stageIndex: 0, status: 'done' }, ctx)
    assert.equal(result.ok, true)
    const stage = result.data.assignments[0].stages[0]
    assert.equal(stage.status, 'done')
    assert.ok(stage.actualEnd)
  })

  test('a pending-materials gate rejection is relayed as a normal error, not thrown', async () => {
    const { ctx, api, mfr } = await arrange({ stageKinds: ['milestone', 'quantity'] })
    await api.post(`/api/orders/${ORDER_ID}/assignments/${mfr._id}/stages/0/materials`, { name: 'Fabric', requiredQty: 10 })

    const result = await TOOL_HANDLERS.update_stage_status(
      { orderId: ORDER_ID, mfrId: String(mfr._id), stageIndex: 0, status: 'done' }, ctx)
    assert.equal(result.ok, false)
    assert.equal(result.status, 400)
    assert.match(result.data.error, /material\(s\) still pending/)
  })

  test('update_stage_dates moves eta and preserves the frozen baseline', async () => {
    const { ctx, mfr } = await arrange()
    const result = await TOOL_HANDLERS.update_stage_dates(
      { orderId: ORDER_ID, mfrId: String(mfr._id), stageIndex: 0, eta: '2026-08-01' }, ctx)
    assert.equal(result.ok, true)
    const stage = result.data.assignments[0].stages[0]
    assert.equal(stage.eta, '2026-08-01')
    assert.equal(stage.baselineEta, '2026-07-15')
  })

  test('add_action_item_update appends to an ActionItem thread', async () => {
    const admin = await makeAdmin()
    const item = await ActionItem.create({ title: 'Chase supplier', assigneeId: admin._id, createdBy: admin._id })
    const result = await TOOL_HANDLERS.add_action_item_update(
      { id: item._id.toString(), text: 'Called them, awaiting reply' }, { cookie: cookieFor(admin) })
    assert.equal(result.ok, true)
    assert.equal(result.data.updates.length, 1)
  })

  test('update_action_item closes an item', async () => {
    const admin = await makeAdmin()
    const item = await ActionItem.create({ title: 'Chase supplier', assigneeId: admin._id, createdBy: admin._id })
    const result = await TOOL_HANDLERS.update_action_item(
      { id: item._id.toString(), status: 'done' }, { cookie: cookieFor(admin) })
    assert.equal(result.ok, true)
    assert.equal(result.data.status, 'done')
  })
})

describe('defense in depth — the loopback adds no bypass of its own', () => {
  test('a manufacturer cookie still 403s against another manufacturer\'s assignment', async () => {
    // Not a reachable production path — POST /api/assistant/chat itself
    // requires requireAdmin. This exists purely to prove loopbackFetch carries
    // through the acting user's real permissions rather than some elevated one.
    const { mfr } = await arrange()
    const otherMfr = await makeMfr()
    const result = await TOOL_HANDLERS.update_stage_status(
      { orderId: ORDER_ID, mfrId: String(mfr._id), stageIndex: 0, status: 'in_progress' },
      { cookie: cookieFor(otherMfr) })
    assert.equal(result.ok, false)
    assert.equal(result.status, 403)
  })
})

describe('check_delivery_risk', () => {
  test('computes exact per-stage and order-level variance — not a loopback call', async () => {
    const { admin, ctx, mfr } = await arrange({
      stageKinds: ['milestone', 'quantity'], delivery: '2026-07-10',
    })
    // Move stage 0's eta later and mark it done a few days late, so both
    // etaVarianceDays and actualVarianceDays are non-null and non-zero.
    await TOOL_HANDLERS.update_stage_dates({ orderId: ORDER_ID, mfrId: String(mfr._id), stageIndex: 0, eta: '2026-07-20' }, ctx)
    await TOOL_HANDLERS.update_stage_status({ orderId: ORDER_ID, mfrId: String(mfr._id), stageIndex: 0, status: 'done' }, ctx)

    // check_delivery_risk takes no ctx — it reads Mongoose directly, in-process.
    const result = await TOOL_HANDLERS.check_delivery_risk({ orderId: ORDER_ID })
    assert.equal(result.ok, true)
    assert.equal(result.data.delivery ? new Date(result.data.delivery).toISOString().slice(0, 10) : null, '2026-07-10')

    const stage0 = result.data.assignments[0].stages[0]
    assert.equal(stage0.etaVarianceDays, 5) // baseline 07-15 -> eta 07-20
    assert.ok(typeof stage0.actualVarianceDays === 'number') // actualEnd stamped today vs eta 07-20

    // Latest eta across the order is stage 1's 07-15 vs stage 0's revised 07-20 -> max is 07-20
    // Delivery is 07-10, so overrun = 10 days.
    assert.equal(result.data.deliveryOverrunDays, 10)
  })

  test('404 for an unknown order', async () => {
    const result = await TOOL_HANDLERS.check_delivery_risk({ orderId: 'DOES-NOT-EXIST' })
    assert.equal(result.ok, false)
    assert.equal(result.status, 404)
  })
})
