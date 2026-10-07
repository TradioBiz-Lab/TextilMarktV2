// Three product decisions: a buyer never writes the Delivery step; Kriyaa needs a real human
// confirmation before closing Delivery or using an override; and both are enforced by the server.

import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as, tokenFor } from './helpers/client.js'
import { makeMaster, makeBuyer, makeMfr, orderPayload } from './helpers/factories.js'
import { TOOL_HANDLERS } from '../src/routes/assistant.js'
import { Order } from '../src/models/Order.js'

before(async () => {
  await startTestDb()
  const baseUrl = await startServer()
  process.env.PORT = new URL(baseUrl).port
})
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(clearDb)

const ORDER_ID = 'DEC-TEST-001'

async function arrange() {
  const admin = await makeMaster()
  const buyer = await makeBuyer()
  const mfr = await makeMfr()
  const api = as(admin)
  const res = await api.post('/api/orders', orderPayload({
    id: ORDER_ID, buyerId: buyer._id, mfrId: mfr._id, stageNames: ['Cutting'],
    stageStartDates: ['2026-07-01'], stageEtas: ['2026-07-10'], stageKinds: ['milestone'],
  }))
  assert.equal(res.status, 201, JSON.stringify(res.body))
  const base = `/api/orders/${ORDER_ID}/assignments/${mfr._id}`
  const asgn = async () => (await Order.findById(ORDER_ID).lean()).assignments[0]
  const deliveryIdx = (await asgn()).stages.findIndex(s => s.isDelivery)
  return { admin, buyer, mfr, api, base, asgn, deliveryIdx, ctx: extra => ({ cookie: `tradio_token=${tokenFor(admin)}`, user: admin, ...extra }) }
}

describe('a buyer cannot write the Delivery step', () => {
  test('even when they own it', async () => {
    const { api, buyer, base, deliveryIdx, asgn } = await arrange()
    // The coordinator makes the buyer responsible for the Delivery step.
    assert.equal((await api.post(`${base}/stages/${deliveryIdx}/eta`, { responsibleId: String(buyer._id) })).status, 200)
    const b = as(buyer)
    const r = await b.post(`${base}/stages/${deliveryIdx}`, { status: 'done' })
    assert.equal(r.status, 403, JSON.stringify(r.body))
    assert.match(r.body.error, /confirm delivery/i)
    assert.equal((await b.post(`${base}/stages/bulk`, { stages: [{ index: deliveryIdx, status: 'done' }] })).status, 403)
    const a = await asgn()
    assert.equal(a.stages[deliveryIdx].status, 'not_started')
    assert.equal(a.status, 'Processing')
  })

  test('an approval step they own still works', async () => {
    const { api, buyer, base } = await arrange()
    assert.equal((await api.post(`${base}/stages/0/eta`, { responsibleId: String(buyer._id) })).status, 200)
    assert.equal((await as(buyer).post(`${base}/stages/0`, { status: 'done' })).status, 200)
  })
})

describe('Kriyaa needs a human confirmation for the risky writes', () => {
  const closeDelivery = (idx, mfr, extra = {}) => ({ orderId: ORDER_ID, mfrId: String(mfr._id), stageIndex: idx, status: 'done', ...extra })
  const asked = { role: 'assistant', content: 'Closing Delivery marks the split Delivered. Please confirm.' }

  test('closing Delivery is refused until the admin has confirmed', async () => {
    const { mfr, deliveryIdx, asgn, ctx } = await arrange()
    const bare = await TOOL_HANDLERS.update_stage_status(closeDelivery(deliveryIdx, mfr), ctx({ conversation: [{ role: 'user', content: 'mark delivery done' }] }))
    assert.equal(bare.ok, false)
    assert.match(bare.data.error, /CONFIRMATION REQUIRED/)
    assert.equal((await asgn()).status, 'Processing')
  })

  test('a "yes" that is not answering a confirmation request does not count', async () => {
    const { mfr, deliveryIdx, ctx } = await arrange()
    const r = await TOOL_HANDLERS.update_stage_status(closeDelivery(deliveryIdx, mfr), ctx({
      conversation: [{ role: 'assistant', content: 'Here is the status of your orders.' }, { role: 'user', content: 'yes' }] }))
    assert.equal(r.ok, false)
  })

  test('a refusal does not count even after being asked', async () => {
    const { mfr, deliveryIdx, ctx } = await arrange()
    const r = await TOOL_HANDLERS.update_stage_status(closeDelivery(deliveryIdx, mfr), ctx({
      conversation: [asked, { role: 'user', content: "no, don't do that" }] }))
    assert.equal(r.ok, false)
  })

  test('the model cannot confirm for the admin by passing a flag', async () => {
    const { mfr, deliveryIdx, ctx } = await arrange()
    const r = await TOOL_HANDLERS.update_stage_status(closeDelivery(deliveryIdx, mfr, { confirmed: true }), ctx({ conversation: [{ role: 'user', content: 'mark it' }] }))
    assert.equal(r.ok, false)
  })

  test('after the admin confirms, it goes through and the split is Delivered', async () => {
    const { mfr, deliveryIdx, asgn, ctx } = await arrange()
    const r = await TOOL_HANDLERS.update_stage_status(closeDelivery(deliveryIdx, mfr), ctx({
      conversation: [{ role: 'user', content: 'mark delivery done' }, asked, { role: 'user', content: 'Yes, confirm' }] }))
    assert.equal(r.ok, true, JSON.stringify(r.data))
    assert.equal((await asgn()).status, 'Delivered')
  })

  test('an override needs the same confirmation', async () => {
    const { mfr, ctx } = await arrange()
    const input = { orderId: ORDER_ID, mfrId: String(mfr._id), stageIndex: 0, status: 'done', override: true }
    assert.equal((await TOOL_HANDLERS.update_stage_status(input, ctx({ conversation: [{ role: 'user', content: 'force it' }] }))).ok, false)
    const ok = await TOOL_HANDLERS.update_stage_status(input, ctx({ conversation: [asked, { role: 'user', content: 'yes go ahead' }] }))
    assert.equal(ok.ok, true, JSON.stringify(ok.data))
  })

  test('ordinary stage updates are not slowed down', async () => {
    const { mfr, ctx } = await arrange()
    const r = await TOOL_HANDLERS.update_stage_status({ orderId: ORDER_ID, mfrId: String(mfr._id), stageIndex: 0, status: 'in_progress' }, ctx({ conversation: [{ role: 'user', content: 'start cutting' }] }))
    assert.equal(r.ok, true, JSON.stringify(r.data))
  })
})
