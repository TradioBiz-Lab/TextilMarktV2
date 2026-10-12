// The cross-tenant matrix: two manufacturers (A, B) and two brands (X, Y), and for every kind of
// data the platform holds, proof that nobody sees or changes anything that is not theirs.
//
// Every later phase adds its own resources here (suppliers, purchase orders, inventory, cost sheets,
// inspections...) before it counts as done. Reads are checked in BOTH platform modes, since the
// Tradio portal and the standalone product must hold the same line.
//
//   order AX    brand X  <->  manufacturer A
//   order BY    brand Y  <->  manufacturer B
//   order XAB   brand X  <->  manufacturers A and B (they work for the same brand, and compete)
import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as } from './helpers/client.js'
import { makeAdmin, makeMaster, makeBuyer, makeMfr, makeMember, makeOrder, makeMasterOrder, link } from './helpers/factories.js'
import { Notification } from '../src/models/Notification.js'

before(async () => { await startTestDb(); await startServer() })
after(async () => { delete process.env.PLATFORM_MODE; await stopServer(); await stopTestDb() })
beforeEach(async () => { await clearDb() })

async function world() {
  const A = await makeMfr({ code: 'AAA' }), B = await makeMfr({ code: 'BBB' })
  const X = await makeBuyer({ code: 'XXX' }), Y = await makeBuyer({ code: 'YYY' })
  const admin = await makeAdmin(), master = await makeMaster()
  await link(X, A); await link(X, B); await link(Y, B)
  await makeOrder({ id: 'AX', buyer: X, mfrs: [A] })
  await makeOrder({ id: 'BY', buyer: Y, mfrs: [B] })
  await makeOrder({ id: 'XAB', buyer: X, mfrs: [A, B] })
  return { A, B, X, Y, admin, master }
}
const ids = r => r.body.map(o => o.id).sort()

for (const mode of ['tradio', 'standalone']) {
  describe(`reads in the ${mode} product`, () => {
    // ENABLE_VIEW_AS can leak in from a developer's local .env; the Tradio portal's view as is off unless a test turns it on.
    beforeEach(() => { delete process.env.ENABLE_VIEW_AS; if (mode === 'standalone') process.env.PLATFORM_MODE = 'standalone'; else delete process.env.PLATFORM_MODE })

    test('orders: each company lists only its own', async () => {
      const { A, B, X, Y } = await world()
      assert.deepEqual(ids(await as(A).get('/api/orders')), ['AX', 'XAB'])
      assert.deepEqual(ids(await as(B).get('/api/orders')), ['BY', 'XAB'])
      assert.deepEqual(ids(await as(X).get('/api/orders')), ['AX', 'XAB'])
      assert.deepEqual(ids(await as(Y).get('/api/orders')), ['BY'])
    })

    test('orders: another company\'s order is forbidden by direct id', async () => {
      const { A, B, X, Y } = await world()
      assert.equal((await as(A).get('/api/orders/BY')).status, 403)
      assert.equal((await as(B).get('/api/orders/AX')).status, 403)
      assert.equal((await as(X).get('/api/orders/BY')).status, 403)
      assert.equal((await as(Y).get('/api/orders/AX')).status, 403)
      assert.equal((await as(Y).get('/api/orders/XAB')).status, 403)
    })

    test('a shared order shows each manufacturer only its own split', async () => {
      const { A, B, X } = await world()
      const seenByA = (await as(A).get('/api/orders/XAB')).body
      assert.deepEqual(seenByA.assignments.map(a => a.mid), [String(A._id)])
      const seenByB = (await as(B).get('/api/orders/XAB')).body
      assert.deepEqual(seenByB.assignments.map(a => a.mid), [String(B._id)])
      // The brand, who commissioned both, sees both.
      assert.equal((await as(X).get('/api/orders/XAB')).body.assignments.length, 2)
    })

    test('master orders: each brand lists only its own, manufacturers only those holding their orders', async () => {
      const { A, B, X, Y } = await world()
      await makeMasterOrder({ buyerId: X._id, createdBy: X._id, id: 'MO-X', season: 'FW26' })
      await makeMasterOrder({ buyerId: Y._id, createdBy: Y._id, id: 'MO-Y', season: 'FW26' })
      await makeOrder({ id: 'AX-IN-MO', buyer: X, mfrs: [A], masterOrderId: 'MO-X' })
      const list = async u => (await as(u).get('/api/master-orders')).body.map(m => m.id)
      assert.deepEqual(await list(X), ['MO-X'])
      assert.deepEqual(await list(Y), ['MO-Y'])
      assert.deepEqual(await list(A), ['MO-X'])
      assert.deepEqual(await list(B), [])
    })

    test('documents: shared with the brand and the manufacturer they belong to, nobody else', async () => {
      const { A, B, X, Y } = await world()
      const up = await as(A).post('/api/documents', { type: 'test_report', name: 'A report', orderId: 'AX', mfrId: String(A._id), externalUrl: 'https://example.com/r' })
      assert.equal(up.status, 201, JSON.stringify(up.body))
      const seen = async u => (await as(u).get('/api/documents')).body.map(d => d.name)
      assert.deepEqual(await seen(A), ['A report'])
      assert.deepEqual(await seen(X), ['A report'])
      assert.deepEqual(await seen(B), [])
      assert.deepEqual(await seen(Y), [])
      assert.equal((await as(B).get(`/api/documents/${up.body.id}/data`)).status, 403)
      assert.equal((await as(Y).get(`/api/documents/${up.body.id}/data`)).status, 403)
      assert.equal((await as(X).get(`/api/documents/${up.body.id}/data`)).status, 200)
    })

    test('documents: a manufacturer\'s file on a shared order is invisible to its competitor on that order', async () => {
      const { A, B } = await world()
      const up = await as(A).post('/api/documents', { type: 'test_report', name: 'A private report', orderId: 'XAB', mfrId: String(A._id), externalUrl: 'https://example.com/r' })
      assert.equal(up.status, 201, JSON.stringify(up.body))
      assert.deepEqual((await as(B).get('/api/documents')).body, [])
      assert.equal((await as(B).get(`/api/documents/${up.body.id}/data`)).status, 403)
    })

    test('documents: nobody can attach a file to, or change, another company\'s order or document', async () => {
      const { A, B, Y } = await world()
      const doc = { type: 'test_report', name: 'x', externalUrl: 'https://example.com/r' }
      assert.equal((await as(B).post('/api/documents', { ...doc, orderId: 'AX' })).status, 403)
      assert.equal((await as(Y).post('/api/documents', { ...doc, orderId: 'AX' })).status, 403)
      const mine = await as(A).post('/api/documents', { ...doc, orderId: 'AX' })
      assert.equal((await as(B).post(`/api/documents/${mine.body.id}`, { name: 'hijacked' })).status, 403)
      assert.equal((await as(B).post(`/api/documents/${mine.body.id}/delete`, {})).status, 403)
    })

    test('notifications: a company reads only its own', async () => {
      const { A, B, X } = await world()
      await Notification.create({ toUser: A._id, type: 'status', msg: 'for A' })
      await Notification.create({ toUser: X._id, type: 'status', msg: 'for X' })
      assert.deepEqual((await as(A).get('/api/notifications')).body.map(n => n.msg), ['for A'])
      assert.deepEqual((await as(B).get('/api/notifications')).body, [])
    })

    test('the live feed counts only the caller\'s own orders', async () => {
      const { A, Y } = await world()
      assert.match((await as(A).get('/api/floor/feed')).body.version, /orders:2:/)
      assert.match((await as(Y).get('/api/floor/feed')).body.version, /orders:1:/)
    })

    test('companies cannot list other companies, users, the audit log, or open view as', async () => {
      const { A, X } = await world()
      for (const u of [A, X]) {
        assert.equal((await as(u).get('/api/users')).status, 403)
        assert.equal((await as(u).get('/api/orgs')).status, 403)
        assert.equal((await as(u).get('/api/audit')).status, 403)
        assert.equal((await as(u).get('/api/dropped')).status, 403)
        assert.equal((await as(u).get('/api/auth/view-as/options')).status, mode === 'standalone' ? 403 : 404)
      }
    })

    test('partners: a company sees only the companies it is connected with', async () => {
      const { A, B, X, Y } = await world()
      const list = async u => (await as(u).get('/api/partners')).body.map(p => p.code).sort()
      assert.deepEqual(await list(X), ['AAA', 'BBB'])
      assert.deepEqual(await list(Y), ['BBB'])
      assert.deepEqual(await list(A), ['XXX'])
      assert.deepEqual(await list(B), ['XXX', 'YYY'])
    })

    test('a teammate sees exactly what their company sees and nothing of anyone else\'s', async () => {
      const { A, X } = await world()
      const memberA = await makeMember(A), memberX = await makeMember(X)
      assert.deepEqual(ids(await as(memberA).get('/api/orders')), ['AX', 'XAB'])
      assert.deepEqual(ids(await as(memberX).get('/api/orders')), ['AX', 'XAB'])
      assert.equal((await as(memberA).get('/api/orders/BY')).status, 403)
      assert.equal((await as(memberX).get('/api/orders/BY')).status, 403)
      assert.equal((await as(memberA).get('/api/orgs/me')).body.code, 'AAA')
    })
  })
}

describe('writes: nobody changes what is not theirs', () => {
  beforeEach(() => { process.env.PLATFORM_MODE = 'standalone' })

  test('progress on another manufacturer\'s split', async () => {
    const { A, B } = await world()
    assert.equal((await as(B).post(`/api/orders/AX/assignments/${A._id}/stages/0`, { unitsDone: 5 })).status, 403)
    assert.equal((await as(B).post(`/api/orders/XAB/assignments/${A._id}/stages/0`, { unitsDone: 5 })).status, 403)
    assert.equal((await as(A).post(`/api/orders/XAB/assignments/${B._id}/stages/0`, { unitsDone: 5 })).status, 403)
    assert.equal((await as(A).post(`/api/orders/XAB/assignments/${A._id}/stages/0`, { unitsDone: 5 })).status, 200)
  })

  test('another company\'s order header, plan, assignments and deletion', async () => {
    const { A, B, X, Y } = await world()
    for (const u of [Y, B]) {
      assert.equal((await as(u).post('/api/orders/AX', { product: 'x' })).status, 403)
      assert.equal((await as(u).post('/api/orders/AX/delete', {})).status, 403)
      assert.equal((await as(u).post('/api/orders/AX/assignments', { mfrId: String(B._id), qty: 1 })).status, 403)
      assert.equal((await as(u).post(`/api/orders/AX/assignments/${A._id}/stages/insert`, { name: 'x', startDate: 'NA', eta: 'NA' })).status, 403)
    }
    void X
  })

  test('another company\'s master order', async () => {
    const { X, Y } = await world()
    await makeMasterOrder({ buyerId: X._id, createdBy: X._id, id: 'MO-X', season: 'FW26' })
    assert.equal((await as(Y).post('/api/master-orders/MO-X', { orderName: 'hijack' })).status, 403)
    assert.equal((await as(Y).post('/api/master-orders/MO-X/delete', {})).status, 403)
  })

  test('creating orders in another company\'s name', async () => {
    const { A, B, X, Y } = await world()
    const body = { product: 'T', category: 'TSHRT', season: 'FW26', totalQty: 10, delivery: '2026-12-31' }
    assert.equal((await as(X).post('/api/orders', { ...body, buyerId: String(Y._id) })).status, 403)    // for another brand
    assert.equal((await as(A).post('/api/orders', { ...body, buyerId: String(Y._id) })).status, 403)    // for a brand it does not work with
    assert.equal((await as(Y).post('/api/orders', { ...body, assignments: [{ mid: String(A._id), qty: 10 }] })).status, 403)   // assigning a manufacturer it does not work with
  })

  test('escalating another brand\'s order', async () => {
    const { Y } = await world()
    assert.equal((await as(Y).post('/api/orders/AX/escalate', { reason: 'not mine' })).status, 403)
  })
})
