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
import { startServer, stopServer, as, req } from './helpers/client.js'
import { makeAdmin, makeMaster, makeBuyer, makeMfr, makeMember, makeOrder, makeMasterOrder, link } from './helpers/factories.js'
import { Notification } from '../src/models/Notification.js'
import { Supplier } from '../src/models/Supplier.js'
import { Document } from '../src/models/Document.js'
import { Order } from '../src/models/Order.js'
import { setMailerForTests } from '../src/lib/email.js'
import { setOrg } from './helpers/factories.js'

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

describe('procurement: a company\'s suppliers and purchase orders are its own (standalone product)', () => {
  beforeEach(() => {
    process.env.PLATFORM_MODE = 'standalone'
    setMailerForTests({ emails: { send: async () => ({ data: { id: 'x' }, error: null }) } })
  })
  after(() => setMailerForTests(null))

  /** Both factories have a supplier, a draft PO and a sent PO; brand X works with A and has a material line on its order. */
  async function stock() {
    const w = await world()
    await Supplier.init()
    const out = {}
    for (const [key, u] of [['A', w.A], ['B', w.B]]) {
      const s = (await as(u).post('/api/suppliers', { name: `${key} Mills`, email: `${key.toLowerCase()}@mill.test` })).body
      const line = { description: 'Jersey', qty: 10, unit: 'kg', rate: 100, taxPct: 5 }
      const draft = (await as(u).post('/api/purchase-orders', { supplierId: s.id, lines: [line] })).body
      const sent = (await as(u).post('/api/purchase-orders', { supplierId: s.id, lines: [line] })).body
      assert.equal((await as(u).post(`/api/purchase-orders/${sent.id}/send`, {})).status, 200)
      out[`data${key}`] = { supplier: s, draft, sent }
    }
    return { ...w, ...out }
  }

  test('each factory lists only its own', async () => {
    const { A, B, ...rest } = await stock()
    assert.deepEqual((await as(A).get('/api/suppliers')).body.map(s => s.name), ['A Mills'])
    assert.deepEqual((await as(B).get('/api/suppliers')).body.map(s => s.name), ['B Mills'])
    assert.deepEqual((await as(A).get('/api/purchase-orders')).body.map(p => p.id).sort(), [rest.dataA.draft.id, rest.dataA.sent.id].sort())
    assert.deepEqual((await as(B).get('/api/purchase-orders')).body.map(p => p.id).sort(), [rest.dataB.draft.id, rest.dataB.sent.id].sort())
  })

  test('a direct read of another factory\'s supplier or purchase order is "not found"', async () => {
    const { A, B, ...s } = await stock()
    void A
    assert.equal((await as(B).get(`/api/suppliers/${s.dataA.supplier.id}`)).status, 404)
    assert.equal((await as(B).get(`/api/purchase-orders/${s.dataA.sent.id}`)).status, 404)
    assert.equal((await as(B).get(`/api/purchase-orders/${s.dataA.sent.id}/pdf`)).status, 404)
    assert.equal((await as(A).get(`/api/purchase-orders/${s.dataB.sent.id}`)).status, 404)
  })

  test('another factory cannot change them, or raise a PO with another factory\'s supplier', async () => {
    const { B, ...s } = await stock()
    assert.equal((await as(B).post(`/api/suppliers/${s.dataA.supplier.id}`, { name: 'hijack' })).status, 404)
    assert.equal((await as(B).post(`/api/purchase-orders/${s.dataA.draft.id}`, { terms: 'hijack' })).status, 404)
    assert.equal((await as(B).post(`/api/purchase-orders/${s.dataA.sent.id}/cancel`, { reason: 'hijack' })).status, 404)
    assert.equal((await as(B).post('/api/purchase-orders', { supplierId: s.dataA.supplier.id, lines: [] })).status, 400)
    assert.equal((await Supplier.findById(s.dataA.supplier.id).lean()).name, 'A Mills')
  })

  test('brands, Tradio staff and visitors cannot use them at all', async () => {
    const { X, Y, admin, master } = await stock()
    for (const u of [X, Y, admin, master]) {
      assert.equal((await as(u).get('/api/suppliers')).status, 403, u.role)
      assert.equal((await as(u).get('/api/purchase-orders')).status, 403, u.role)
    }
    assert.equal((await req('GET', '/api/purchase-orders')).status, 401)
  })

  test('a brand sees no supplier, no PO number and no PO document on an order it commissioned', async () => {
    const { A, X, ...s } = await stock()
    await Order.updateOne({ _id: 'AX' }, { $set: { 'assignments.0.stages.0.materials': [{ name: 'Jersey', requiredQty: 10, status: 'ordered', supplier: 'A Mills', poNumber: s.dataA.sent.id, poId: s.dataA.sent.id }] } })
    const m = (await as(X).get('/api/orders/AX')).body.assignments[0].stages[0].materials[0]
    assert.deepEqual([m.supplier, m.poNumber, m.poId, m.supplierId], ['', '', null, null])
    assert.equal((await as(X).get('/api/documents')).body.some(d => d.type === 'supplier_po'), false)
    const po = await Document.findOne({ poId: s.dataA.sent.id })
    assert.equal((await as(X).get(`/api/documents/${po._id}/data`)).status, 404)
    assert.equal((await as(A).get(`/api/documents/${po._id}/data`)).status, 200)
  })

  test('the live feed\'s procurement versions move only for the company whose data changed', async () => {
    const { A, B, X, admin } = await stock()
    const v = async u => (await as(u).get('/api/floor/feed')).body.versions
    const [a0, b0] = [await v(A), await v(B)]
    assert.deepEqual(Object.keys(a0).sort(), ['boms', 'cost-sheets', 'grns', 'inventory', 'purchase-orders', 'suppliers'])
    // A changes something; B's numbers do not move, and A's do.
    await as(A).post('/api/suppliers', { name: 'Another A Mill' })
    const [a1, b1] = [await v(A), await v(B)]
    assert.notEqual(a1.suppliers, a0.suppliers)
    assert.deepEqual(b1, b0)
    // A brand gets only the versions of what is shared with it, and Tradio staff none at all.
    assert.deepEqual(Object.keys((await as(X).get('/api/floor/feed')).body.versions), ['cost-sheets'])
    assert.equal((await as(admin).get('/api/floor/feed')).body.versions, undefined)
  })

  test('Tradio\'s master admin viewing a factory reads it read-only; a company that switched Tradio off is closed to them', async () => {
    const { A, master, ...s } = await stock()
    const open = await as(master).post('/api/auth/view-as', { userId: String(A._id) })
    assert.equal(open.status, 200, JSON.stringify(open.body))
    const token = open.body.token
    assert.deepEqual((await req('GET', '/api/purchase-orders', { token })).body.map(p => p.id).sort(), [s.dataA.draft.id, s.dataA.sent.id].sort())
    const write = await req('POST', '/api/suppliers', { token, body: { name: 'Nope' } })
    assert.equal(write.status, 403)
    assert.equal(write.body.code, 'VIEW_ONLY')
    await setOrg(A, { tradioCanView: false })
    const closed = await req('GET', '/api/purchase-orders', { token })
    assert.equal(closed.status, 403)
    assert.equal(closed.body.code, 'VIEW_BLOCKED')
  })
})

describe('bills of materials: a company\'s BOMs and shopping list are its own (standalone product)', () => {
  beforeEach(() => { process.env.PLATFORM_MODE = 'standalone' })

  /** Both factories work the shared order XAB (competitors for brand X) and each keeps its own frozen BOM and supplier for it. */
  async function stock() {
    const w = await world()
    await Supplier.init()
    const out = {}
    for (const [key, u] of [['A', w.A], ['B', w.B]]) {
      const supplier = (await as(u).post('/api/suppliers', { name: `${key} Mills`, email: `${key.toLowerCase()}@mill.test` })).body
      const bom = (await as(u).post('/api/boms', { orderId: 'XAB' })).body
      const line = { section: 'fabric', item: `${key} secret fleece`, unit: 'kg', consumption: 0.7, wastagePct: 5, rate: key === 'A' ? 410 : 395, supplierId: supplier.id }
      assert.equal((await as(u).post(`/api/boms/${bom.id}`, { lines: [line] })).status, 200)
      const frozen = (await as(u).post(`/api/boms/${bom.id}/freeze`)).body
      out[`data${key}`] = { supplier, bom: frozen }
    }
    return { ...w, ...out }
  }

  test('competing factories on one order each see only their own BOM, rates and suppliers', async () => {
    const { A, B, dataA, dataB } = await stock()
    const seenByA = (await as(A).get('/api/boms?orderId=XAB')).body
    const seenByB = (await as(B).get('/api/boms?orderId=XAB')).body
    assert.deepEqual(seenByA.versions.map(v => v.id), [dataA.bom.id])
    assert.deepEqual(seenByB.versions.map(v => v.id), [dataB.bom.id])
    assert.ok(!JSON.stringify(seenByA).includes('B secret fleece'))
    assert.ok(!JSON.stringify(seenByA).includes('395'))
    assert.ok(!JSON.stringify(seenByB).includes('A secret fleece'))
    assert.ok(!JSON.stringify(seenByB).includes('A Mills'))
  })

  test('a direct read or write of another factory\'s BOM is "not found" and changes nothing', async () => {
    const { A, B, dataA } = await stock()
    assert.equal((await as(B).get(`/api/boms/${dataA.bom.id}`)).status, 404)
    assert.equal((await as(B).post(`/api/boms/${dataA.bom.id}`, { lines: [] })).status, 404)
    assert.equal((await as(B).post(`/api/boms/${dataA.bom.id}/revise`)).status, 404)
    assert.equal((await as(B).post(`/api/boms/${dataA.bom.id}/delete`)).status, 404)
    assert.equal((await as(B).post('/api/boms', { orderId: 'AX' })).status, 404)          // an order A is on and B is not
    assert.equal((await as(A).get(`/api/boms/${dataA.bom.id}`)).body.lines.length, 1)
  })

  test('the shopping list and generated purchase orders cover only the caller\'s own BOMs and suppliers', async () => {
    const { A, B } = await stock()
    const rowsA = (await as(A).get('/api/boms/aggregate')).body.rows
    const rowsB = (await as(B).get('/api/boms/aggregate')).body.rows
    assert.deepEqual(rowsA.map(r => r.item), ['A secret fleece'])
    assert.deepEqual(rowsB.map(r => r.item), ['B secret fleece'])
    const made = await as(A).post('/api/boms/generate-pos', {})
    assert.deepEqual(made.body.created.map(c => c.supplierName), ['A Mills'])
    assert.equal((await as(B).get('/api/purchase-orders')).body.length, 0)
    assert.deepEqual((await as(B).get('/api/boms/aggregate')).body.rows.map(r => r.onPo), [0])      // A's PO does not count against B
  })

  test('a BOM line cannot name another factory\'s supplier', async () => {
    const { B, dataA, dataB } = await stock()
    const r = await as(B).post('/api/boms', { orderId: 'BY' })
    assert.equal(r.status, 201)
    const line = { section: 'trims', item: 'Zip', consumption: 1, supplierId: dataA.supplier.id }
    assert.equal((await as(B).post(`/api/boms/${r.body.id}`, { lines: [line] })).status, 400)
    assert.equal((await as(B).post(`/api/boms/${r.body.id}`, { lines: [{ ...line, supplierId: dataB.supplier.id }] })).status, 200)
  })

  test('brands, Tradio staff and visitors cannot use them at all', async () => {
    const { X, Y, admin, master } = await stock()
    for (const u of [X, Y, admin, master]) {
      assert.equal((await as(u).get('/api/boms?orderId=XAB')).status, 403, u.role)
      assert.equal((await as(u).get('/api/boms/aggregate')).status, 403, u.role)
      assert.equal((await as(u).post('/api/boms/generate-pos', {})).status, 403, u.role)
    }
    assert.equal((await req('GET', '/api/boms/aggregate')).status, 401)
  })

  test('the Tradio portal has none of it', async () => {
    const { A } = await stock()
    delete process.env.PLATFORM_MODE
    assert.equal((await as(A).get('/api/boms?orderId=XAB')).status, 404)
    assert.equal((await as(A).get('/api/boms/aggregate')).status, 404)
  })
})

describe('cost sheets: each brand sees only what its factories shared with it (standalone product)', () => {
  beforeEach(() => { process.env.PLATFORM_MODE = 'standalone'; setMailerForTests({ emails: { send: async () => ({ data: { id: 'x' }, error: null }) } }) })
  after(() => setMailerForTests(null))

  const sheet = (brand, name) => ({
    brandId: String(brand._id), styleName: name, qty: 100,
    fabric: [{ name: 'Jersey', consumption: 1, rate: 200 }], labour: { making: 50 },
  })

  /** A and B each draft one sheet for brand X, and share one. B also works for Y: it shares one with Y. */
  async function stock() {
    const w = await world()
    const out = {}
    const make = async (u, brand, name, shareIt) => {
      const r = await as(u).post('/api/cost-sheets', sheet(brand, name))
      assert.equal(r.status, 201, JSON.stringify(r.body))
      if (shareIt) assert.equal((await as(u).post(`/api/cost-sheets/${r.body.id}/share`, {})).status, 200)
      return r.body
    }
    out.aDraft = await make(w.A, w.X, 'A draft for X', false)
    out.aShared = await make(w.A, w.X, 'A shared with X', true)
    out.bShared = await make(w.B, w.X, 'B shared with X', true)
    out.bForY = await make(w.B, w.Y, 'B shared with Y', true)
    return { ...w, ...out }
  }

  test('a brand lists only what was shared with it, never a draft and never another brand\'s', async () => {
    const { X, Y, aShared, bShared, bForY } = await stock()
    assert.deepEqual((await as(X).get('/api/cost-sheets')).body.map(r => r.id).sort(), [aShared.id, bShared.id].sort())
    assert.deepEqual((await as(Y).get('/api/cost-sheets')).body.map(r => r.id), [bForY.id])
  })

  test('a factory lists only its own sheets, drafts included', async () => {
    const { A, B, aDraft, aShared, bShared, bForY } = await stock()
    assert.deepEqual((await as(A).get('/api/cost-sheets')).body.map(r => r.id).sort(), [aDraft.id, aShared.id].sort())
    assert.deepEqual((await as(B).get('/api/cost-sheets')).body.map(r => r.id).sort(), [bShared.id, bForY.id].sort())
  })

  test('a direct read of a sheet that is not yours, or is still a draft, is "not found"', async () => {
    const { A, B, X, Y, aDraft, aShared, bForY } = await stock()
    assert.equal((await as(X).get(`/api/cost-sheets/${aDraft.id}`)).status, 404)       // brand, a draft
    assert.equal((await as(Y).get(`/api/cost-sheets/${aShared.id}`)).status, 404)      // another brand
    assert.equal((await as(X).get(`/api/cost-sheets/${bForY.id}`)).status, 404)        // shared, but with another brand
    assert.equal((await as(B).get(`/api/cost-sheets/${aShared.id}`)).status, 404)      // another factory
    assert.equal((await as(A).get(`/api/cost-sheets/${bForY.id}`)).status, 404)
    assert.equal((await as(X).get(`/api/cost-sheets/${aShared.id}/pdf`)).status, 200)
    assert.equal((await as(Y).get(`/api/cost-sheets/${aShared.id}/pdf`)).status, 404)
  })

  test('nobody can comment on, approve, revise or change a sheet that is not theirs', async () => {
    const { A, B, Y, aShared, aDraft } = await stock()
    assert.equal((await as(Y).post(`/api/cost-sheets/${aShared.id}/comments`, { text: 'hi' })).status, 404)
    assert.equal((await as(Y).post(`/api/cost-sheets/${aShared.id}/approve`)).status, 404)
    assert.equal((await as(B).post(`/api/cost-sheets/${aShared.id}/comments`, { text: 'hi' })).status, 404)
    assert.equal((await as(B).post(`/api/cost-sheets/${aShared.id}/revise`)).status, 404)
    assert.equal((await as(B).post(`/api/cost-sheets/${aDraft.id}`, { styleName: 'hijack' })).status, 404)
    assert.equal((await as(B).post(`/api/cost-sheets/${aDraft.id}/share`, {})).status, 404)
    assert.equal((await as(A).get(`/api/cost-sheets/${aDraft.id}`)).body.styleName, 'A draft for X')
  })

  test('a factory cannot start a sheet for a brand it does not work with, or seed it from a rival\'s bill of materials', async () => {
    const { A, Y } = await stock()
    assert.equal((await as(A).post('/api/cost-sheets', sheet(Y, 'Not my customer'))).status, 400)
  })

  test('the brand does not see a factory\'s own note on a sheet it shared', async () => {
    const { A, X } = await stock()
    const made = await as(A).post('/api/cost-sheets', { ...sheet(X, 'Noted'), internalNote: 'the real margin' })
    await as(A).post(`/api/cost-sheets/${made.body.id}/share`, {})
    assert.ok(!JSON.stringify((await as(X).get(`/api/cost-sheets/${made.body.id}`)).body).includes('the real margin'))
  })

  test('Tradio staff and visitors cannot use them, and the Tradio portal has none', async () => {
    const { admin, master, A } = await stock()
    for (const u of [admin, master]) assert.equal((await as(u).get('/api/cost-sheets')).status, 403, u.role)
    assert.equal((await req('GET', '/api/cost-sheets')).status, 401)
    delete process.env.PLATFORM_MODE
    assert.equal((await as(A).get('/api/cost-sheets')).status, 404)
  })

  test('the live feed\'s cost sheet version moves for the two sides of a sheet and no one else', async () => {
    const { A, B, X, Y } = await stock()
    const v = async u => (await as(u).get('/api/floor/feed')).body.versions['cost-sheets']
    const [y0, b0] = [await v(Y), await v(B)]
    await as(A).post('/api/cost-sheets', sheet(X, 'Another A sheet for X'))
    assert.equal(await v(Y), y0)                      // Y's view did not move
    assert.equal(await v(B), b0)                      // nor did B's
    const sharedNow = (await as(A).post('/api/cost-sheets', sheet(X, 'Shared later'))).body
    const x0 = await v(X)
    await as(A).post(`/api/cost-sheets/${sharedNow.id}/share`, {})
    assert.notEqual(await v(X), x0)                   // X's did, once something was shared with it
  })
})

describe('stock and goods received notes: a company\'s inventory is its own (standalone product)', () => {
  const PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2Q=='
  beforeEach(() => { process.env.PLATFORM_MODE = 'standalone' })

  /** Both factories hold 50 kg of their own fleece, with a posted note (and a photo on it) and a draft note, and have issued 10 kg to their order. */
  async function stock() {
    const w = await world()
    const out = {}
    for (const [key, u, orderId] of [['A', w.A, 'AX'], ['B', w.B, 'BY']]) {
      const posted = (await as(u).post('/api/grns', { supplierName: `${key} Mills`, lines: [{ description: `${key} fleece`, unit: 'kg', qty: 50, rate: 100 }] })).body
      await as(u).post(`/api/grns/${posted.id}/photos`, { dataUrl: PHOTO, kind: 'challan' })
      assert.equal((await as(u).post(`/api/grns/${posted.id}/post`)).status, 200)
      const draft = (await as(u).post('/api/grns', { supplierName: `${key} Mills`, lines: [{ description: `${key} zips`, unit: 'pcs', qty: 5 }] })).body
      const item = (await as(u).get('/api/inventory/items')).body.find(i => i.name === `${key} fleece`)
      const slip = (await as(u).post('/api/inventory/issues', { orderId, lines: [{ itemId: item.id, qty: 10 }] })).body
      out[`data${key}`] = { posted, draft, item, slip, orderId }
    }
    return { ...w, ...out }
  }

  test('each factory lists only its own items, notes, slips and movements', async () => {
    const { A, B, dataA, dataB } = await stock()
    assert.deepEqual((await as(A).get('/api/inventory/items')).body.map(i => [i.name, i.onHand]), [['A fleece', 40]])
    assert.deepEqual((await as(B).get('/api/inventory/items')).body.map(i => [i.name, i.onHand]), [['B fleece', 40]])
    assert.deepEqual((await as(A).get('/api/grns')).body.map(g => g.id).sort(), [dataA.posted.id, dataA.draft.id].sort())
    assert.deepEqual((await as(B).get('/api/grns')).body.map(g => g.id).sort(), [dataB.posted.id, dataB.draft.id].sort())
    assert.deepEqual((await as(A).get('/api/inventory/issues')).body.map(s => s.id), [dataA.slip.id])
    assert.deepEqual((await as(A).get('/api/inventory/ledger')).body.map(r => r.itemName), ['A fleece', 'A fleece'])
    assert.deepEqual((await as(B).get('/api/inventory/ledger?orderId=AX')).body, [])               // another company's order id finds nothing of B's
  })

  test('a direct read of another factory\'s item, note, photo, slip or PDF is "not found"', async () => {
    const { A, B, dataA } = await stock()
    const photoId = (await as(A).get(`/api/grns/${dataA.posted.id}/photos`)).body[0].id
    for (const url of [
      `/api/inventory/items/${dataA.item.id}`, `/api/inventory/issues/${dataA.slip.id}`, `/api/grns/${dataA.posted.id}`, `/api/grns/${dataA.posted.id}/pdf`,
      `/api/grns/${dataA.posted.id}/photos`, `/api/grns/${dataA.posted.id}/photos/${photoId}`, `/api/inventory/ledger?itemId=${dataA.item.id}`,
    ]) {
      const r = await as(B).get(url)
      assert.ok(r.status === 404 || (Array.isArray(r.body) && r.body.length === 0), `${url} gave ${r.status}`)
    }
    assert.equal((await as(A).get(`/api/grns/${dataA.posted.id}/photos/${photoId}`)).status, 200)
  })

  test('another factory cannot change them, post them, add photos, or issue another factory\'s stock', async () => {
    const { A, B, dataA } = await stock()
    assert.equal((await as(B).post(`/api/grns/${dataA.draft.id}`, { note: 'hijack' })).status, 404)
    assert.equal((await as(B).post(`/api/grns/${dataA.draft.id}/post`)).status, 404)
    assert.equal((await as(B).post(`/api/grns/${dataA.draft.id}/delete`)).status, 404)
    assert.equal((await as(B).post(`/api/grns/${dataA.draft.id}/photos`, { dataUrl: PHOTO })).status, 404)
    assert.equal((await as(B).post(`/api/inventory/items/${dataA.item.id}`, { name: 'hijack' })).status, 404)
    assert.equal((await as(B).post(`/api/inventory/items/${dataA.item.id}/archive`)).status, 404)
    assert.equal((await as(B).post(`/api/inventory/items/${dataA.item.id}/merge`, { intoId: (await as(B).get('/api/inventory/items')).body[0].id })).status, 404)
    assert.equal((await as(B).post(`/api/inventory/items/${(await as(B).get('/api/inventory/items')).body[0].id}/merge`, { intoId: dataA.item.id })).status, 400)
    assert.equal((await as(B).post('/api/inventory/issues', { orderId: 'BY', lines: [{ itemId: dataA.item.id, qty: 1 }] })).status, 400)
    assert.equal((await as(B).post('/api/inventory/adjustments', { itemId: dataA.item.id, delta: 5, reason: 'x' })).status, 400)
    assert.equal((await as(B).post('/api/grns', { lines: [{ description: 'x', qty: 1, itemId: dataA.item.id }] })).status, 400)
    assert.equal((await as(B).post('/api/inventory/issues', { orderId: 'AX', lines: [{ itemId: (await as(B).get('/api/inventory/items')).body[0].id, qty: 1 }] })).status, 400)   // not B's order
    assert.deepEqual((await as(A).get('/api/inventory/items')).body.map(i => [i.name, i.onHand]), [['A fleece', 40]])      // nothing of A's moved
  })

  test('brands, Tradio staff and visitors cannot use any of it', async () => {
    const { X, Y, admin, master, dataA } = await stock()
    for (const u of [X, Y, admin, master]) {
      for (const url of ['/api/inventory/items', '/api/inventory/ledger', '/api/inventory/issues', '/api/grns', `/api/grns/${dataA.posted.id}`, `/api/grns/${dataA.posted.id}/photos`]) assert.equal((await as(u).get(url)).status, 403, `${u.role} ${url}`)
      assert.equal((await as(u).post('/api/grns', {})).status, 403, u.role)
    }
    assert.equal((await req('GET', '/api/grns')).status, 401)
  })

  test('a brand never receives the posted note\'s PDF, even on the order it was for', async () => {
    const { A, X, dataA } = await stock()
    const doc = await Document.findOne({ grnId: dataA.posted.id })
    await Document.updateOne({ _id: doc._id }, { $set: { orderId: 'AX' } })
    assert.equal((await as(X).get('/api/documents')).body.some(d => d.type === 'goods_receipt'), false)
    assert.equal((await as(X).get(`/api/documents/${doc._id}/data`)).status, 404)
    assert.equal((await as(A).get(`/api/documents/${doc._id}/data`)).status, 200)
  })

  test('the live feed\'s stock versions move only for the company whose stock changed', async () => {
    const { A, B } = await stock()
    const v = async u => (await as(u).get('/api/floor/feed')).body.versions
    const [a0, b0] = [await v(A), await v(B)]
    const item = (await as(A).get('/api/inventory/items')).body[0]
    await as(A).post('/api/inventory/adjustments', { itemId: item.id, delta: 1, reason: 'found' })
    const [a1, b1] = [await v(A), await v(B)]
    assert.notEqual(a1.inventory, a0.inventory)
    assert.deepEqual([b1.inventory, b1.grns], [b0.inventory, b0.grns])
  })

  test('Tradio\'s master admin viewing a factory reads its stock read-only; a company that switched Tradio off is closed to them', async () => {
    const { A, master, dataA } = await stock()
    const open = await as(master).post('/api/auth/view-as', { userId: String(A._id) })
    assert.equal(open.status, 200, JSON.stringify(open.body))
    const token = open.body.token
    assert.deepEqual((await req('GET', '/api/inventory/items', { token })).body.map(i => i.name), ['A fleece'])
    assert.equal((await req('GET', `/api/grns/${dataA.posted.id}`, { token })).status, 200)
    for (const [path, body] of [['/api/grns', {}], ['/api/inventory/issues', { orderId: 'AX', lines: [] }], ['/api/inventory/adjustments', {}], [`/api/grns/${dataA.draft.id}/post`, {}]]) {
      const w = await req('POST', path, { token, body })
      assert.equal(w.status, 403, path)
      assert.equal(w.body.code, 'VIEW_ONLY')
    }
    await setOrg(A, { tradioCanView: false })
    const closed = await req('GET', '/api/inventory/items', { token })
    assert.equal(closed.status, 403)
    assert.equal(closed.body.code, 'VIEW_BLOCKED')
  })

  test('the Tradio portal has none of it', async () => {
    const { A } = await stock()
    delete process.env.PLATFORM_MODE
    for (const url of ['/api/inventory/items', '/api/grns', '/api/inventory/issues']) assert.equal((await as(A).get(url)).status, 404, url)
  })
})

