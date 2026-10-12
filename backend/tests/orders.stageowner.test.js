// Handing a step (Lab Dip Approval, PP Sample) to the customer: who may, what the customer can then do,
// and that they are told.

import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as } from './helpers/client.js'
import { makeAdmin, makeMaster, makeBuyer, makeMfr, orderPayload } from './helpers/factories.js'
import { Order } from '../src/models/Order.js'
import { Notification } from '../src/models/Notification.js'

before(async () => { await startTestDb(); await startServer() })
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(clearDb)

const ORDER_ID = 'OWN-TEST-001'

async function arrange() {
  const master = await makeMaster()
  const buyer = await makeBuyer()
  const mfr = await makeMfr()
  const res = await as(master).post('/api/orders', orderPayload({
    id: ORDER_ID, buyerId: buyer._id, mfrId: mfr._id, stageNames: ['Lab Dip Approval', 'PP Sample', 'Cutting'],
    stageStartDates: ['2026-07-01', '2026-07-05', '2026-07-10'], stageEtas: ['2026-07-04', '2026-07-09', '2026-07-20'],
  }))
  assert.equal(res.status, 201, JSON.stringify(res.body))
  await Notification.deleteMany({})
  const base = `/api/orders/${ORDER_ID}/assignments/${mfr._id}`
  const inbox = async u => (await Notification.find({ toUser: u._id }).lean()).map(n => n.msg)
  return { master, buyer, mfr, base, inbox, api: as(master) }
}

describe('assigning a step to the customer', () => {
  test('one step: the customer owns it, is told, and may then close it but not reschedule it', async () => {
    const { buyer, base, api, inbox } = await arrange()
    // The UI sends kind: milestone along with a customer owner (kindForCustomerOwner), since the server
    // never lets a customer close a quantity step.
    assert.equal((await api.post(`${base}/stages/0/eta`, { responsibleId: String(buyer._id), kind: 'milestone' })).status, 200)
    const stored = (await Order.findById(ORDER_ID).lean()).assignments[0].stages[0]
    assert.equal(String(stored.responsibleId), String(buyer._id))
    assert.deepEqual(await inbox(buyer), ['Lab Dip Approval on OWN-TEST-001 is now assigned to you'])

    const me = as(buyer)
    const closed = await me.post(`${base}/stages/0`, { status: 'done' })
    assert.equal(closed.status, 200, JSON.stringify(closed.body))
    assert.equal((await me.post(`${base}/stages/0/eta`, { eta: '2026-08-01' })).status, 403, 'dates stay with Tradio')
    assert.equal((await me.post(`${base}/stages/1`, { status: 'done' })).status, 403, 'a step that is not theirs stays closed to them')
  })

  test('Bulk Edit: two steps in one save give the customer one message', async () => {
    const { buyer, base, api, inbox } = await arrange()
    const res = await api.post(`${base}/stages/bulk`, { stages: [{ index: 0, responsibleId: String(buyer._id), kind: 'milestone' }, { index: 1, responsibleId: String(buyer._id), kind: 'milestone' }] })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    const msgs = (await inbox(buyer)).filter(m => m.includes('assigned to you'))
    assert.equal(msgs.length, 1)
    assert.match(msgs[0], /2 steps on OWN-TEST-001 are now assigned to you \(Lab Dip Approval, PP Sample\)/)
  })

  test('no message when the owner does not change, or when you assign yourself', async () => {
    const { master, buyer, base, api, inbox } = await arrange()
    await api.post(`${base}/stages/0/eta`, { responsibleId: String(buyer._id) })
    await Notification.deleteMany({})
    await api.post(`${base}/stages/0/eta`, { responsibleId: String(buyer._id) })
    assert.deepEqual(await inbox(buyer), [])
    await api.post(`${base}/stages/2/eta`, { responsibleId: String(master._id) })
    assert.deepEqual(await inbox(master), [])
  })

  test('the customer cannot own the Delivery step, by either route', async () => {
    const { buyer, base, api } = await arrange()
    const deliveryIdx = (await Order.findById(ORDER_ID).lean()).assignments[0].stages.findIndex(s => s.isDelivery)
    const one = await api.post(`${base}/stages/${deliveryIdx}/eta`, { responsibleId: String(buyer._id) })
    assert.equal(one.status, 400)
    assert.match(one.body.error, /Delivery/)
    const bulk = await api.post(`${base}/stages/bulk`, { stages: [{ index: deliveryIdx, responsibleId: String(buyer._id) }] })
    assert.equal(bulk.status, 400)
  })

  test('only an admin can hand a step over', async () => {
    const { buyer, mfr, base } = await arrange()
    assert.equal((await as(mfr).post(`${base}/stages/0/eta`, { responsibleId: String(buyer._id) })).status, 403)
    assert.equal((await as(buyer).post(`${base}/stages/0/eta`, { responsibleId: String(buyer._id) })).status, 403)
  })
})
