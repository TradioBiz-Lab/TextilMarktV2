// Kriyaa for customers and manufacturers: same assistant, narrower reach.
// Tools act through the caller's own session, so these tests prove the narrowing
// holds at the tool layer and that master orders are scoped for manufacturers.

import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as, tokenFor } from './helpers/client.js'
import { makeAdmin, makeMaster, makeBuyer, makeMfr, makeMasterOrder, orderPayload } from './helpers/factories.js'
import { TOOL_HANDLERS, toolsFor } from '../src/routes/assistant.js'

before(async () => {
  await startTestDb()
  process.env.PORT = new URL(await startServer()).port
})
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(clearDb)

const ctxFor = user => ({ cookie: `tradio_token=${tokenFor(user)}`, user: { id: String(user._id), role: user.role } })

async function arrange() {
  const master = await makeMaster()
  const buyerA = await makeBuyer(), buyerB = await makeBuyer()
  const mfr1 = await makeMfr(), mfr2 = await makeMfr()
  const api = as(master)
  const mo = await makeMasterOrder({ buyerId: buyerA._id, createdBy: master._id, orderName: 'Scoped MO' })
  const mk = (id, buyer, mfr, extra = {}) => api.post('/api/orders', orderPayload({ id, buyerId: buyer._id, mfrId: mfr._id, ...extra }))
  assert.equal((await mk('SC-1', buyerA, mfr1, { masterOrderId: mo._id })).status, 201)
  assert.equal((await mk('SC-2', buyerB, mfr2)).status, 201)
  return { master, buyerA, buyerB, mfr1, mfr2, mo }
}

describe('tool set by role', () => {
  test('admins keep every tool; customers and manufacturers lose the admin-only ones', () => {
    const names = u => toolsFor(u).map(t => t.name)
    const adminOnly = ['list_action_items', 'add_action_item_update', 'update_action_item', 'update_stage_dates']
    for (const t of adminOnly) assert.ok(names({ role: 'admin' }).includes(t))
    for (const role of ['buyer', 'manufacturer'])
      for (const t of adminOnly) assert.ok(!names({ role }).includes(t), `${role} must not get ${t}`)
    assert.ok(names({ role: 'buyer' }).includes('find_orders') && names({ role: 'manufacturer' }).includes('post_stage_update'))
  })
})

describe('tools only reach what the caller can see', () => {
  test('list_orders and get_order are scoped by the caller\'s own session', async () => {
    const { buyerA, mfr1 } = await arrange()
    const bList = await TOOL_HANDLERS.list_orders({}, ctxFor(buyerA))
    assert.deepEqual(bList.data.map(o => o.id), ['SC-1'])
    assert.equal((await TOOL_HANDLERS.get_order({ orderId: 'SC-2' }, ctxFor(buyerA))).ok, false)
    const mList = await TOOL_HANDLERS.list_orders({}, ctxFor(mfr1))
    assert.deepEqual(mList.data.map(o => o.id), ['SC-1'])
  })

  test('check_delivery_risk refuses an order the caller cannot see', async () => {
    const { buyerA, mfr1, master } = await arrange()
    assert.equal((await TOOL_HANDLERS.check_delivery_risk({ orderId: 'SC-2' }, ctxFor(buyerA))).ok, false)
    assert.equal((await TOOL_HANDLERS.check_delivery_risk({ orderId: 'SC-2' }, ctxFor(mfr1))).ok, false)
    assert.equal((await TOOL_HANDLERS.check_delivery_risk({ orderId: 'SC-1' }, ctxFor(buyerA))).ok, true)
    assert.equal((await TOOL_HANDLERS.check_delivery_risk({ orderId: 'SC-2' }, ctxFor(master))).ok, true)
  })

  test('check_delivery_risk shows a manufacturer only their own assignment', async () => {
    const { master, buyerA, mfr1, mfr2 } = await arrange()
    // Give SC-1 a second factory so there is something to hide.
    await as(master).post('/api/orders/SC-1/assignments', { mid: String(mfr2._id), qty: 10 })
    const asMfr1 = await TOOL_HANDLERS.check_delivery_risk({ orderId: 'SC-1' }, ctxFor(mfr1))
    assert.deepEqual(asMfr1.data.assignments.map(a => a.mfrId), [String(mfr1._id)])
    const asBuyer = await TOOL_HANDLERS.check_delivery_risk({ orderId: 'SC-1' }, ctxFor(buyerA))
    assert.ok(asBuyer.data.assignments.length >= 1)
  })

  test('an action-items call from a manufacturer is refused by the server too', async () => {
    const { mfr1 } = await arrange()
    assert.equal((await TOOL_HANDLERS.list_action_items({}, ctxFor(mfr1))).ok, false)
  })
})

describe('master orders for manufacturers', () => {
  test('a manufacturer sees only the master orders their own orders belong to', async () => {
    const { mfr1, mfr2, mo } = await arrange()
    const a = await as(mfr1).get('/api/master-orders')
    assert.equal(a.status, 200)
    assert.deepEqual(a.body.map(m => m.id), [mo._id])
    assert.equal((await as(mfr2).get('/api/master-orders')).body.length, 0)
  })

  test('a manufacturer still cannot create or delete a master order', async () => {
    const { mfr1, buyerA, mo } = await arrange()
    assert.equal((await as(mfr1).post('/api/master-orders', { id: 'MO-X', buyerId: String(buyerA._id), orderName: 'x' })).status, 403)
    assert.equal((await as(mfr1).post(`/api/master-orders/${mo._id}/delete`, {})).status, 403)
  })
})
