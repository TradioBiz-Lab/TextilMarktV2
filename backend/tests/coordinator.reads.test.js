import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'
import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as, req } from './helpers/client.js'
import { makeAdmin, makeMaster, makeBuyer, makeMfr, makeCoordinator, makeMasterOrder, orderPayload } from './helpers/factories.js'
import { Document } from '../src/models/Document.js'
import { MasterOrder } from '../src/models/MasterOrder.js'
import { FactoryVisit } from '../src/models/FactoryVisit.js'

before(async () => { await startTestDb(); await startServer(); await FactoryVisit.init() })
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(clearDb)

// One customer, two factories. SPLIT-1 is made at both A and B; ONLY-B at B alone. The coordinator is allocated A.
async function arrange() {
  const admin = await makeAdmin(); const master = await makeMaster(); const buyer = await makeBuyer({ company: 'Cocoblu' })
  const a = await makeMfr({ company: 'Factory A' }); const b = await makeMfr({ company: 'Factory B' })
  const mo = await makeMasterOrder({ buyerId: buyer._id, createdBy: admin._id, id: 'MO-1', orderName: 'SS26 Main' })
  await MasterOrder.updateOne({ _id: mo._id }, { $set: { poNumber: 'PO/77', price: 499, currency: 'INR', paymentTerms: '30 days', notes: 'secret note', shipBy: '2026-12-20' } })
  const split = orderPayload({ id: 'SPLIT-1', buyerId: buyer._id, mfrId: a._id, totalQty: 100, masterOrderId: mo._id, product: 'Polo' })
  split.assignments = [{ mid: String(a._id), qty: 60 }, { mid: String(b._id), qty: 40 }]
  assert.equal((await as(admin).post('/api/orders', split)).status, 201)
  assert.equal((await as(admin).post('/api/orders', orderPayload({ id: 'ONLY-B', buyerId: buyer._id, mfrId: b._id, product: 'Jogger' }))).status, 201)
  const doc = (o) => Document.create({ name: o.type, uploadedBy: admin._id, notes: 'n', isActive: true, ...o })
  const docs = {
    techPack: await doc({ type: 'tech_pack', orderId: 'SPLIT-1' }),
    measurements: await doc({ type: 'measurements', orderId: 'SPLIT-1', measurementLabel: 'fit_approval' }),
    po: await doc({ type: 'PO', orderId: 'SPLIT-1' }),
    invoice: await doc({ type: 'invoice', orderId: 'SPLIT-1' }),
    costSheet: await doc({ type: 'cost_sheet', orderId: 'SPLIT-1' }),
    evidenceA: await doc({ type: 'floor_evidence', orderId: 'SPLIT-1', mfrId: a._id, stageIndex: 0 }),
    evidenceB: await doc({ type: 'floor_evidence', orderId: 'SPLIT-1', mfrId: b._id, stageIndex: 0 }),
    techPackB: await doc({ type: 'tech_pack', orderId: 'ONLY-B' }),
    certA: await doc({ type: 'compliance_cert', mfrId: a._id }),
    moPo: await doc({ type: 'PO', masterOrderId: 'MO-1' }),
  }
  const coord = await makeCoordinator({ assignedFactories: [a] })
  return { admin, master, buyer, a, b, coord, api: as(coord), docs }
}

describe('a coordinator reads the styles at his factories, and only those', () => {
  test('the order list and a single order carry only his factories\' splits', async () => {
    const { api, a } = await arrange()
    const list = await api.get('/api/orders')
    assert.equal(list.status, 200)
    assert.deepEqual(list.body.map(o => o.id), ['SPLIT-1'])
    assert.deepEqual(list.body[0].assignments.map(x => x.mid), [String(a._id)], 'factory B\'s split is not sent')
    assert.equal(list.body[0].assignments[0].mfrCompany ?? list.body[0].assignments[0].mfrName ?? 'Factory A', 'Factory A')
    assert.equal(list.body[0].buyerCompany, 'Cocoblu', 'he is Tradio staff: the customer is named')
    assert.ok(!JSON.stringify(list.body).includes('Factory B'))

    const one = await api.get('/api/orders/SPLIT-1')
    assert.equal(one.status, 200)
    assert.equal(one.body.assignments.length, 1)
    assert.equal((await api.get('/api/orders/ONLY-B')).status, 403)
    assert.equal((await api.get('/api/orders/NOPE')).status, 404)
  })

  test('documents: tech packs, measurements and his factory\'s files; nothing commercial, nothing of another factory', async () => {
    const { api, docs } = await arrange()
    const list = await api.get('/api/documents')
    assert.equal(list.status, 200)
    const ids = list.body.map(d => String(d.id)).sort()
    assert.deepEqual(ids, [docs.techPack, docs.measurements, docs.evidenceA, docs.certA].map(d => String(d._id)).sort())
    for (const k of ['techPack', 'measurements', 'evidenceA', 'certA']) {
      assert.equal((await api.get(`/api/documents/${docs[k]._id}/data`)).status, 200, k)
      assert.equal((await api.get(`/api/documents/${docs[k]._id}/versions`)).status, 200, k)
    }
    for (const k of ['po', 'invoice', 'costSheet', 'evidenceB', 'techPackB', 'moPo']) {
      assert.equal((await api.get(`/api/documents/${docs[k]._id}/data`)).status, 403, k)
      assert.equal((await api.get(`/api/documents/${docs[k]._id}/versions`)).status, 403, k)
    }
  })

  test('master orders: those his styles belong to, without the customer\'s commercial terms', async () => {
    const { api } = await arrange()
    const list = await api.get('/api/master-orders')
    assert.equal(list.status, 200)
    assert.deepEqual(list.body.map(m => m.id), ['MO-1'])
    const mo = list.body[0]
    assert.deepEqual([mo.poNumber, mo.price, mo.currency, mo.paymentTerms, mo.notes], ['', null, '', '', ''])
    assert.equal(mo.shipBy, '2026-12-20', 'the ship-by date is his deadline too')
    assert.equal(mo.buyerCompany, 'Cocoblu')
  })

  test('the live feed answers, scoped', async () => {
    const { api } = await arrange()
    const feed = await api.get('/api/floor/feed')
    assert.equal(feed.status, 200)
    assert.match(feed.body.version, /orders:1:/)
    assert.equal(feed.body.itemsVersion, null)
  })

  test('no factories, no styles; and a changed allocation takes effect on the next request', async () => {
    const { master, a, b, coord, api } = await arrange()
    const none = as(await makeCoordinator())
    assert.deepEqual((await none.get('/api/orders')).body, [])
    assert.deepEqual((await none.get('/api/documents')).body, [])
    assert.deepEqual((await none.get('/api/master-orders')).body, [])
    assert.equal((await none.get('/api/orders/SPLIT-1')).status, 403)

    assert.equal((await as(master).post(`/api/users/${coord._id}`, { assignedFactories: [String(b._id)] })).status, 200)
    const now = await api.get('/api/orders')
    assert.deepEqual(now.body.map(o => o.id).sort(), ['ONLY-B', 'SPLIT-1'])
    assert.deepEqual(now.body.find(o => o.id === 'SPLIT-1').assignments.map(x => x.mid), [String(b._id)])
    assert.ok(!JSON.stringify(now.body).includes(String(a._id)), 'factory A is gone from what he is sent')
  })

  test('still read only: every write is refused', async () => {
    const { api, a, docs } = await arrange()
    const stage = `/api/orders/SPLIT-1/assignments/${a._id}/stages/0`
    for (const [path, body] of [
      [stage, { status: 'done' }], [`${stage}/updates`, { text: 'x' }], [`/api/orders/SPLIT-1`, { product: 'X' }],
      ['/api/documents', { type: 'floor_evidence', name: 'x', orderId: 'SPLIT-1', stageIndex: 0, notes: 'n' }],
      [`/api/documents/${docs.evidenceA._id}/delete`, {}], ['/api/master-orders/MO-1', { orderName: 'x' }],
    ]) {
      const res = await req('POST', path, { token: api.token, body })
      assert.equal(res.status, 403, path)
      assert.equal(res.body.code, 'COORDINATOR_NOT_ALLOWED', path)
    }
  })

  test('other roles see what they did before', async () => {
    const { admin, buyer, a, b } = await arrange()
    assert.equal((await as(admin).get('/api/orders')).body.length, 2)
    assert.equal((await as(admin).get('/api/orders/SPLIT-1')).body.assignments.length, 2)
    assert.equal((await as(a).get('/api/orders/SPLIT-1')).body.assignments.length, 1)
    assert.equal((await as(b).get('/api/orders')).body.length, 2)
    assert.equal((await as(buyer).get('/api/orders')).body.length, 2)
    assert.equal((await as(admin).get('/api/master-orders')).body[0].poNumber, 'PO/77')
  })
})
