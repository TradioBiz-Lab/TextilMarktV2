// The bugs a bug bash (3 Nov 2026) found and proved against a running copy, each pinned here so it stays fixed: double
// clicks and retries that made things twice, rules only the browser enforced, impossible dates, and what one factory
// could see of another's on a style they share.
import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'
import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as } from './helpers/client.js'
import { makeMaster, makeBuyer, makeMfr, makeMasterOrder, markDelivered } from './helpers/factories.js'
import { Order } from '../src/models/Order.js'
import { Document } from '../src/models/Document.js'
import { StyleRequest } from '../src/models/StyleRequest.js'
import { InboundMessage } from '../src/models/InboundMessage.js'

before(async () => { await startTestDb(); await startServer() })
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(clearDb)

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const PDF = `data:application/pdf;base64,${Buffer.from('%PDF-1.4\n').toString('base64')}`
const SOON = '2099-06-30'

async function arrange() {
  const master = await makeMaster()
  const buyer = await makeBuyer()
  const mo = await makeMasterOrder({ buyerId: buyer._id, createdBy: master._id, season: 'SS26' })
  const made = await as(master).post('/api/orders', { id: 'SRC-1', buyerId: String(buyer._id), masterOrderId: mo._id, product: 'Dress', styleNumber: 'FYL-4002', category: 'DRESS', season: 'SS26', phase: 'production', totalQty: 100 })
  assert.equal(made.status, 201, JSON.stringify(made.body))
  return { master, buyer, mo }
}

describe('a double click or a retry makes one thing, not two', () => {
  test('adding the same factory twice at once gives one split', async () => {
    const { master } = await arrange()
    const mfr = await makeMfr()
    const codes = await Promise.all([1, 2, 3].map(() => as(master).post('/api/orders/SRC-1/assignments', { mfrId: String(mfr._id), qty: 100 }).then(r => r.status)))
    assert.deepEqual(codes.sort(), [201, 400, 400])
    assert.equal((await Order.findById('SRC-1').lean()).assignments.length, 1)
  })

  test('the same request sent several times at once is stored once', async () => {
    const { buyer } = await arrange()
    await markDelivered('SRC-1')
    const body = { kind: 'replen', items: [{ sourceOrderId: 'SRC-1', delivery: SOON, quantity: 50 }] }
    const codes = await Promise.all([1, 2, 3].map(() => as(buyer).post('/api/style-requests', body).then(r => r.status)))
    assert.deepEqual(codes.sort(), [201, 409, 409])
    assert.equal(await StyleRequest.countDocuments({ kind: 'replen' }), 1)
  })

  test('Add replen pressed twice adds the replens once', async () => {
    const { master, mo } = await arrange()
    await markDelivered('SRC-1')
    const body = { masterOrderId: mo._id, items: [{ sourceOrderId: 'SRC-1', delivery: SOON }] }
    assert.equal((await as(master).post('/api/style-requests/direct-replen', body)).status, 201)
    assert.equal((await as(master).post('/api/style-requests/direct-replen', body)).status, 409)
    assert.equal(await Order.countDocuments({ replenOf: 'SRC-1' }), 1)
  })

  test('locking two measurement sheets at once leaves one Locked Measurement', async () => {
    const { master } = await arrange()
    const ids = []
    for (const n of [1, 2, 3]) {
      const d = await as(master).post('/api/documents', { type: 'measurements', name: `Spec ${n}`, orderId: 'SRC-1', measurementLabel: 'pp_approval', dataUrl: `data:${XLSX};base64,${Buffer.from('PK').toString('base64')}`, fileName: `s${n}.xlsx`, mimeType: XLSX })
      assert.equal(d.status, 201, JSON.stringify(d.body))
      ids.push(d.body.id)
    }
    await Promise.all(ids.map(id => as(master).post(`/api/documents/${id}/lock`, { locked: true })))
    assert.equal(await Document.countDocuments({ orderId: 'SRC-1', locked: true }), 1)
  })
})

describe('the server holds the rules, not only the browser', () => {
  test('only a delivered style can be reordered', async () => {
    const { master, buyer } = await arrange()
    const asked = await as(buyer).post('/api/style-requests', { kind: 'replen', items: [{ sourceOrderId: 'SRC-1', delivery: SOON }] })
    assert.equal(asked.status, 400)
    assert.match(asked.body.error, /delivered/)
    assert.equal((await as(master).post('/api/orders/SRC-1/replen', { quantity: 10 })).status, 400)
    await markDelivered('SRC-1')
    assert.equal((await as(buyer).post('/api/style-requests', { kind: 'replen', items: [{ sourceOrderId: 'SRC-1', delivery: SOON }] })).status, 201)
  })

  test('an expected delivery date must be a real day, and not in the past', async () => {
    const { buyer } = await arrange()
    await markDelivered('SRC-1')
    const send = delivery => as(buyer).post('/api/style-requests', { kind: 'replen', items: [{ sourceOrderId: 'SRC-1', delivery }] })
    assert.match((await send('2099-02-31')).body.error, /not a real date/)
    assert.match((await send('2001-01-01')).body.error, /in the past/)
    const npd = await as(buyer).post('/api/style-requests', { kind: 'npd', items: [{ styleNumber: 'FYL-5002', colours: ['Red'], delivery: '2001-01-01', techPackLink: 'https://drive.example.com/tp' }] })
    assert.match(npd.body.error, /in the past/)
  })

  test('a factory\'s first delivery date must be a real day', async () => {
    const { master } = await arrange()
    const mfr = await makeMfr()
    assert.equal((await as(master).post('/api/orders/SRC-1/assignments', { mfrId: String(mfr._id), qty: 100, delivery: '2099-02-31' })).status, 400)
  })

  test('a quantity is a number, not true or a list', async () => {
    const { buyer } = await arrange()
    for (const quantity of [true, [7]]) {
      const res = await as(buyer).post('/api/style-requests', { kind: 'npd', items: [{ styleNumber: 'FYL-5002', colours: ['Red'], quantity, delivery: SOON, techPackLink: 'https://drive.example.com/tp' }] })
      assert.equal(res.status, 400, JSON.stringify(quantity))
    }
  })
})

describe('what a replen and an approval leave behind', () => {
  test('a replen under another season\'s master order takes that season', async () => {
    const { master, buyer } = await arrange()
    await markDelivered('SRC-1')
    const fw = await makeMasterOrder({ buyerId: buyer._id, createdBy: master._id, season: 'FW26' })
    const res = await as(master).post('/api/style-requests/direct-replen', { masterOrderId: fw._id, items: [{ sourceOrderId: 'SRC-1', delivery: SOON }] })
    assert.equal(res.status, 201, JSON.stringify(res.body))
    const o = await Order.findById(res.body.created[0].id).lean()
    assert.equal(o.season, 'FW26')
    assert.match(o._id, /-FW26-/)
  })

  test('a style approved from the queue is stamped with the time it was made, not midnight', async () => {
    const { master, buyer, mo } = await arrange()
    const sent = await as(buyer).post('/api/style-requests', { kind: 'npd', items: [{ styleNumber: 'FYL-5002', colours: ['Red'], delivery: SOON, techPackLink: 'https://drive.example.com/tp' }] })
    const ok = await as(master).post(`/api/style-requests/${sent.body.requestId}/approve`, { masterOrderId: mo._id })
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
    const o = await Order.findById(ok.body.created[0].id).lean()
    assert.ok(Math.abs(Date.now() - new Date(o.createdAt).getTime()) < 60_000, `createdAt ${o.createdAt}`)
  })

  test('a declined request lets go of its files, so they can be sent again', async () => {
    const { master, buyer } = await arrange()
    await markDelivered('SRC-1')
    const file = await as(buyer).post('/api/documents', { type: 'tech_pack', name: 'TP', orderId: null, dataUrl: PDF, fileName: 'tp.pdf', mimeType: 'application/pdf' })
    const item = { sourceOrderId: 'SRC-1', delivery: SOON, docIds: [file.body.id] }
    const sent = await as(buyer).post('/api/style-requests', { kind: 'replen', items: [item] })
    assert.equal(sent.status, 201, JSON.stringify(sent.body))
    assert.equal((await as(master).post(`/api/style-requests/${sent.body.requestId}/decline`, { reason: 'Wrong date' })).status, 200)
    const again = await as(buyer).post('/api/style-requests', { kind: 'replen', items: [{ ...item, quantity: 10 }] })
    assert.equal(again.status, 201, JSON.stringify(again.body))
  })
})

describe('one factory never sees another\'s on a shared style', () => {
  async function twoFactories() {
    const { master, buyer } = await arrange()
    const [a, b] = [await makeMfr(), await makeMfr()]
    for (const m of [a, b]) assert.equal((await as(master).post('/api/orders/SRC-1/assignments', { mfrId: String(m._id), qty: 50 })).status, 201)
    return { master, buyer, a, b }
  }

  test('its messages', async () => {
    const { a, b } = await twoFactories()
    await InboundMessage.create({ channel: 'web', type: 'text', factoryId: a._id, orderId: 'SRC-1', state: 'applied', rawText: 'A-only: our rate is Rs 212/pc' })
    const feedB = await as(b).get('/api/floor/feed')
    assert.equal(feedB.status, 200)
    assert.equal(feedB.body.items.length, 0)
    assert.equal((await as(a).get('/api/floor/feed')).body.items.length, 1)
  })

  test('its files on the style', async () => {
    const { a, b } = await twoFactories()
    const up = await as(a).post('/api/documents', { type: 'packing_qc', name: 'A packing QC', orderId: 'SRC-1', mfrId: null, dataUrl: PDF, fileName: 'qc.pdf', mimeType: 'application/pdf' })
    assert.equal(up.status, 201, JSON.stringify(up.body))
    assert.equal(String((await Document.findById(up.body.id).lean()).mfrId), String(a._id))
    const listB = await as(b).get('/api/documents')
    assert.ok(!(listB.body.documents || listB.body).some(d => d.id === up.body.id))
    assert.notEqual((await as(b).get(`/api/documents/${up.body.id}/data`)).status, 200)
  })

  test('a customer cannot add evidence to a step, and a malformed id is a clean 400', async () => {
    const { buyer } = await arrange()
    assert.equal((await as(buyer).post('/api/documents', { type: 'final_qc', name: 'QC', orderId: 'SRC-1', stageIndex: 0, notes: 'looks fine' })).status, 403)
    const bad = await as(buyer).post('/api/documents', { type: 'other', name: 'X', orderId: { a: 1 }, dataUrl: PDF, fileName: 'x.pdf', mimeType: 'application/pdf' })
    assert.equal(bad.status, 400)
    assert.doesNotMatch(bad.body.error, /Cast to/)
  })
})

describe('a customer is never told which factory makes its styles', () => {
  test('its style shows Tradio, not the factory, its people or its split\'s quantity', async () => {
    const { master, buyer } = await arrange()
    const mfr = await makeMfr({ company: 'Secret Stitch Works', name: 'Faiz Factory' })
    assert.equal((await as(master).post('/api/orders/SRC-1/assignments', { mfrId: String(mfr._id), qty: 100 })).status, 201)
    await Order.updateOne({ _id: 'SRC-1' }, { $set: { 'assignments.0.stages.0.responsibleId': mfr._id, 'assignments.0.stages.0.updates': [{ text: 'Cutting started', byUser: mfr._id, at: new Date() }] } })
    for (const res of [await as(buyer).get('/api/orders/SRC-1'), await as(buyer).get('/api/orders')]) {
      assert.equal(res.status, 200)
      const text = JSON.stringify(res.body)
      assert.doesNotMatch(text, /Secret Stitch|Faiz/)
      const a = (Array.isArray(res.body) ? res.body[0] : res.body).assignments[0]
      assert.deepEqual([a.mfrCompany, a.qty], ['Tradio production', null])
    }
    // Tradio itself still sees everything.
    const mine = await as(master).get('/api/orders/SRC-1')
    assert.deepEqual([mine.body.assignments[0].mfrCompany, mine.body.assignments[0].qty], ['Secret Stitch Works', 100])
  })

  test('a factory\'s file reads as uploaded by Tradio', async () => {
    const { master, buyer } = await arrange()
    const mfr = await makeMfr({ company: 'Secret Stitch Works', name: 'Faiz Factory' })
    await as(master).post('/api/orders/SRC-1/assignments', { mfrId: String(mfr._id), qty: 100 })
    const up = await as(mfr).post('/api/documents', { type: 'packing_qc', name: 'Packing QC', orderId: 'SRC-1', dataUrl: PDF, fileName: 'qc.pdf', mimeType: 'application/pdf' })
    assert.equal(up.status, 201, JSON.stringify(up.body))
    const list = await as(buyer).get('/api/documents')
    const doc = (list.body.documents || list.body).find(d => d.id === up.body.id)
    assert.ok(doc, 'the customer still sees the file')
    assert.deepEqual([doc.uploadedByName, doc.uploadedByCompany], ['Tradio production', 'Tradio'])
  })
})
