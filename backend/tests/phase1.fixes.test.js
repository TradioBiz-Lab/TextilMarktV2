// Three real bugs, fixed on their own:
//  1. a step could be owned by another factory's user (a copy across styles put Factory A's id on Factory B's split);
//  2. notes and a customer's approval reached nobody;
//  3. Kriyaa could close the Delivery step by sending an end date, with no confirmation.
import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as, tokenFor } from './helpers/client.js'
import { makeMaster, makeAdmin, makeBuyer, makeMfr, orderPayload } from './helpers/factories.js'
import { Notification } from '../src/db/index.js'
import { TOOL_HANDLERS } from '../src/routes/assistant.js'

before(async () => {
  await startTestDb()
  const baseUrl = await startServer()
  process.env.PORT = new URL(baseUrl).port // Kriyaa's loopback calls reach the test server
})
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(clearDb)

async function arrange() {
  const master = await makeMaster({ name: 'Ankit' }), second = await makeMaster({ name: 'Asha' }), staff = await makeAdmin({ name: 'Deepa' })
  const buyer = await makeBuyer({ company: 'Zara India', name: 'Sarah' }), otherBuyer = await makeBuyer({ company: 'H and M' })
  const A = await makeMfr({ company: 'Shahi' }), B = await makeMfr({ company: 'Arvind' })
  const api = as(master)
  for (const [id, mfr] of [['S-A', A], ['S-B', B]]) {
    const r = await api.post('/api/orders', orderPayload({ id, buyerId: buyer._id, mfrId: mfr._id, stageNames: ['Lab Dip Approval', 'Cutting'] }))
    assert.equal(r.status, 201, JSON.stringify(r.body))
  }
  await Notification.deleteMany({}) // the new-order notices are not what these tests are about
  const url = (id, mfr, i, tail = '') => `/api/orders/${id}/assignments/${mfr._id}/stages/${i}${tail}`
  const inbox = async u => (await Notification.find({ toUser: u._id }).lean()).map(n => n.msg)
  return { master, second, staff, buyer, otherBuyer, A, B, api, url, inbox }
}

describe("a step's owner must belong to that split", () => {
  test("Bulk Edit refuses another factory's user and another customer, and accepts the split's own", async () => {
    const w = await arrange()
    const bulk = (mfr, owner) => w.api.post(`/api/orders/${mfr === w.A ? 'S-A' : 'S-B'}/assignments/${mfr._id}/stages/bulk`, { stages: [{ index: 1, responsibleId: String(owner._id) }] })
    const wrongFactory = await bulk(w.B, w.A)
    assert.equal(wrongFactory.status, 400)
    assert.match(wrongFactory.body.error, /different factory/)
    const wrongCustomer = await bulk(w.B, w.otherBuyer)
    assert.equal(wrongCustomer.status, 400)
    assert.match(wrongCustomer.body.error, /not this order's customer/)
    assert.equal((await bulk(w.B, w.B)).status, 200)
    assert.equal((await bulk(w.B, w.staff)).status, 200)
    assert.equal((await bulk(w.A, w.buyer)).status, 200)
  })

  test('the single step route and Add step refuse it too', async () => {
    const w = await arrange()
    const single = await w.api.post(w.url('S-B', w.B, 1, '/eta'), { responsibleId: String(w.A._id) })
    assert.equal(single.status, 400)
    assert.match(single.body.error, /different factory/)
    const insert = await w.api.post(`/api/orders/S-B/assignments/${w.B._id}/stages/insert`, { name: 'Wash', kind: 'milestone', eta: '2026-12-01', responsibleId: String(w.A._id) })
    assert.equal(insert.status, 400)
    assert.match(insert.body.error, /different factory/)
    const ok = await w.api.post(`/api/orders/S-B/assignments/${w.B._id}/stages/insert`, { name: 'Wash', kind: 'milestone', eta: '2026-12-01', responsibleId: String(w.B._id) })
    assert.equal(ok.status, 200)
  })
})

const giveToCustomer = async w => {
  await w.api.post(`/api/orders/S-A/assignments/${w.A._id}/stages/bulk`, { stages: [{ index: 0, responsibleId: String(w.buyer._id), kind: 'milestone' }] })
  await Notification.deleteMany({}) // the "assigned to you" notice is not what is being tested
}

describe('notes and approvals reach the people who need them', () => {
  test("a factory's note tells every master admin, not the factory or other styles' factories", async () => {
    const w = await arrange()
    const r = await as(w.A).post(w.url('S-A', w.A, 1, '/updates'), { text: 'Fabric arrived, cutting tomorrow' })
    assert.equal(r.status, 200)
    for (const m of [w.master, w.second]) assert.deepEqual(await w.inbox(m), ['New note on Cutting, S-A: Fabric arrived, cutting tomorrow'])
    assert.deepEqual(await w.inbox(w.A), [])
    assert.deepEqual(await w.inbox(w.B), [])
    assert.deepEqual(await w.inbox(w.staff), [])
  })

  test("a customer's approval tells that split's factory and the master admins, and nobody on another split", async () => {
    const w = await arrange()
    await giveToCustomer(w)
    const r = await as(w.buyer).post(w.url('S-A', w.A, 0), { status: 'done' })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const text = 'Sarah (Zara India) approved Lab Dip Approval on S-A'
    assert.deepEqual(await w.inbox(w.A), [text])
    assert.deepEqual(await w.inbox(w.master), [text])
    assert.deepEqual(await w.inbox(w.second), [text])
    assert.deepEqual(await w.inbox(w.buyer), [])
    assert.deepEqual(await w.inbox(w.B), [])
  })

  test('sending a step back is one clear line with the reason', async () => {
    const w = await arrange()
    await giveToCustomer(w)
    const r = await as(w.buyer).post(w.url('S-A', w.A, 0, '/updates'), { text: 'Rejected: shade is too dark' })
    assert.equal(r.status, 200)
    assert.deepEqual(await w.inbox(w.A), ['Sarah (Zara India) sent back Lab Dip Approval on S-A: shade is too dark'])
    assert.deepEqual(await w.inbox(w.master), ['Sarah (Zara India) sent back Lab Dip Approval on S-A: shade is too dark'])
  })
})

describe('Kriyaa and the Delivery step', () => {
  test('an end date, a unit count or a status on Delivery all need the admin to confirm first', async () => {
    const w = await arrange()
    const ctx = { cookie: `tradio_token=${tokenFor(w.master)}`, conversation: [] }
    const delivery = 2 // Lab Dip Approval, Cutting, Delivery
    for (const change of [{ actualEnd: '2026-08-01' }, { unitsDone: 1 }, { status: 'done' }]) {
      const r = await TOOL_HANDLERS.update_stage_status({ orderId: 'S-A', mfrId: String(w.A._id), stageIndex: delivery, ...change }, ctx)
      assert.equal(r.status, 409, JSON.stringify(change))
      assert.match(r.data.error, /CONFIRMATION REQUIRED/)
    }
    // An ordinary step needs no confirmation.
    const plain = await TOOL_HANDLERS.update_stage_status({ orderId: 'S-A', mfrId: String(w.A._id), stageIndex: 1, status: 'in_progress' }, ctx)
    assert.notEqual(plain.status, 409)
  })
})
