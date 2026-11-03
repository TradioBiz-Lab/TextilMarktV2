// What a customer sends from its home page: a replen of several styles in production (each with its colours, quantity,
// links, expected delivery date and measurement sheets), a sheet of styles without choosing a master order, and new styles
// from the guided New Product Development form. All of it waits for a master admin, who picks the master order on approval.

import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as } from './helpers/client.js'
import { makeMaster, makeBuyer, makeMfr, makeMasterOrder, markDelivered } from './helpers/factories.js'
import { Order } from '../src/models/Order.js'
import { Document } from '../src/models/Document.js'
import { StyleRequest } from '../src/models/StyleRequest.js'
import { Notification } from '../src/models/Notification.js'

before(async () => { await startTestDb(); await startServer() })
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(clearDb)

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const PDF = `data:application/pdf;base64,${Buffer.from('%PDF-1.4\n').toString('base64')}`

async function arrange() {
  const master = await makeMaster()
  const buyer = await makeBuyer({ company: 'Cocoblu' })
  const mo = await makeMasterOrder({ buyerId: buyer._id, createdBy: master._id, season: 'SS26', orderName: 'SS26 Main' })
  const replenMo = await makeMasterOrder({ buyerId: buyer._id, createdBy: master._id, season: 'SS26', orderName: 'SS26 Replen' })
  for (const [id, sn] of [['SRC-1', 'FYL-4002'], ['SRC-2', 'FYL-4005']]) {
    const r = await as(master).post('/api/orders', { id, buyerId: String(buyer._id), masterOrderId: mo._id, product: `Dress ${sn}`, styleNumber: sn, category: 'DRESS', season: 'SS26', phase: 'production', totalQty: 300, ecommerceLink: 'https://www.amazon.in/dp/B0AAAAAAA1', colourways: [{ name: 'Blue' }] })
    assert.equal(r.status, 201, JSON.stringify(r.body))
  }
  await markDelivered('SRC-1', 'SRC-2')
  return { master, buyer, mo, replenMo }
}
const sheetDoc = (buyer, label = 'customer_submission') => as(buyer).post('/api/documents', { type: 'measurements', name: 'Spec', orderId: null, measurementLabel: label, dataUrl: `data:${XLSX};base64,${Buffer.from('PK').toString('base64')}`, fileName: 'spec.xlsx', mimeType: XLSX })

describe('a replen of several styles', () => {
  test('is sent with each style\'s details and files, waits, and is created under the master order the master admin picks', async () => {
    const { master, buyer, mo, replenMo } = await arrange()
    const spec = await sheetDoc(buyer, 'pp_approval')
    assert.equal(spec.status, 201, JSON.stringify(spec.body))
    const sent = await as(buyer).post('/api/style-requests', { kind: 'replen', items: [
      { sourceOrderId: 'SRC-1', colours: ['Red', 'Black', 'Red'], quantity: 1200, ecommerceLink: 'https://www.amazon.in/Title/dp/B0BBBBBBB2?th=1', techPackLink: 'drive.example.com/tp', delivery: '2099-12-15', docIds: [spec.body.id] },
      { sourceOrderId: 'SRC-2', delivery: '2027-01-10' },
    ] })
    assert.equal(sent.status, 201, JSON.stringify(sent.body))
    assert.equal(await Order.countDocuments(), 2, 'nothing is created yet')
    assert.equal((await Document.findById(spec.body.id).lean()).styleRequestId.toString(), sent.body.requestId)
    assert.equal(await Notification.countDocuments({ toUser: master._id, msg: /replen of 2 styles/ }), 1)

    // Both sources share a master order, so it is suggested; the master admin chooses another.
    const ok = await as(master).post(`/api/style-requests/${sent.body.requestId}/approve`, { masterOrderId: replenMo._id })
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
    assert.equal(ok.body.created.length, 2)
    const [a, b] = await Promise.all(ok.body.created.map(c => Order.findById(c.id).lean()))
    assert.deepEqual([a.phase, a.replenOf, a.masterOrderId, a.totalQty], ['replen', 'SRC-1', replenMo._id, 1200])
    assert.deepEqual(a.colourways.map(c => c.name), ['Red', 'Black'])
    assert.equal(a.ecommerceLink, 'https://www.amazon.in/dp/B0BBBBBBB2')
    assert.equal(a.techPackLink, 'https://drive.example.com/tp')
    assert.equal(new Date(a.delivery).toISOString().slice(0, 10), '2099-12-15')
    // Left blank: copied from the style being reordered, and the quantity can wait.
    assert.deepEqual([b.colourways.map(c => c.name), b.ecommerceLink, b.totalQty], [['Blue'], 'https://www.amazon.in/dp/B0AAAAAAA1', null])
    const filed = await Document.findById(spec.body.id).lean()
    assert.equal(filed.orderId, a._id, 'the measurement sheet is now on the new style')
    assert.equal(filed.measurementLabel, 'pp_approval')
    assert.equal(filed.locked, false)
    assert.equal((await StyleRequest.findById(sent.body.requestId).lean()).masterOrderId, replenMo._id)
    void mo
  })

  test('without a choice, the master order the reordered styles share is used', async () => {
    const { master, buyer, mo } = await arrange()
    const sent = await as(buyer).post('/api/style-requests', { kind: 'replen', items: [{ sourceOrderId: 'SRC-1', delivery: '2099-12-15' }] })
    const ok = await as(master).post(`/api/style-requests/${sent.body.requestId}/approve`)
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
    assert.equal((await Order.findById(ok.body.created[0].id).lean()).masterOrderId, mo._id)
  })

  test('is checked: own styles in production only, a delivery date, no doubles, real files of its own', async () => {
    const { master, buyer } = await arrange()
    const other = await makeBuyer()
    const send = items => as(buyer).post('/api/style-requests', { kind: 'replen', items })
    assert.equal((await send([])).status, 400)
    assert.equal((await send([{ sourceOrderId: 'SRC-1' }])).status, 400, 'the expected delivery date is needed')
    assert.equal((await send([{ sourceOrderId: 'SRC-1', delivery: 'soon' }])).status, 400)
    assert.equal((await send([{ sourceOrderId: 'SRC-1', delivery: '2099-12-15' }, { sourceOrderId: 'SRC-1', delivery: '2099-12-15' }])).status, 400)
    assert.equal((await send([{ sourceOrderId: 'SRC-1', delivery: '2099-12-15', quantity: 1.5 }])).status, 400)
    assert.equal((await send([{ sourceOrderId: 'SRC-1', delivery: '2099-12-15', ecommerceLink: 'javascript:alert(1)' }])).status, 400)
    assert.equal((await send([{ sourceOrderId: 'NOPE', delivery: '2099-12-15' }])).status, 400)
    assert.equal((await as(other).post('/api/style-requests', { kind: 'replen', items: [{ sourceOrderId: 'SRC-1', delivery: '2099-12-15' }] })).status, 400, 'another customer\'s style')
    const theirs = await sheetDoc(other)
    assert.equal((await send([{ sourceOrderId: 'SRC-1', delivery: '2099-12-15', docIds: [theirs.body.id] }])).status, 400, 'another customer\'s file')
    const mine = await sheetDoc(buyer)
    assert.equal((await send([{ sourceOrderId: 'SRC-1', delivery: '2099-12-15', docIds: [mine.body.id] }])).status, 201)
    assert.equal((await send([{ sourceOrderId: 'SRC-2', delivery: '2099-12-15', docIds: [mine.body.id] }])).status, 400, 'a file already sent with a request')
    assert.equal((await as(master).post('/api/style-requests', { kind: 'replen', items: [{ sourceOrderId: 'SRC-1', delivery: '2099-12-15' }] })).status, 403)
    assert.equal((await as(await makeMfr()).post('/api/style-requests', { kind: 'replen', items: [] })).status, 403)
    assert.equal(await Order.countDocuments(), 2)
  })

  test('a master order of another customer is refused at approval', async () => {
    const { master, buyer } = await arrange()
    const other = await makeBuyer()
    const otherMo = await makeMasterOrder({ buyerId: other._id, createdBy: master._id })
    const sent = await as(buyer).post('/api/style-requests', { kind: 'replen', items: [{ sourceOrderId: 'SRC-1', delivery: '2099-12-15' }] })
    const res = await as(master).post(`/api/style-requests/${sent.body.requestId}/approve`, { masterOrderId: otherMo._id })
    assert.equal(res.status, 400)
    assert.equal((await StyleRequest.findById(sent.body.requestId).lean()).status, 'pending')
  })
})

describe('new styles from the short form', () => {
  const style = (over = {}) => ({ styleNumber: 'FYL-5001', colours: ['Olive', 'Black'], quantity: 800, delivery: '2099-01-20', techPackLink: 'https://drive.example.com/tp', ...over })

  test('colours, quantity, delivery and tech pack link become an NPD style under the chosen master order', async () => {
    const { master, buyer, mo } = await arrange()
    const sent = await as(buyer).post('/api/style-requests', { kind: 'npd', items: [style()] })
    assert.equal(sent.status, 201, JSON.stringify(sent.body))
    // The approver must choose: an NPD request has no master order of its own.
    assert.equal((await as(master).post(`/api/style-requests/${sent.body.requestId}/approve`)).status, 400)
    const ok = await as(master).post(`/api/style-requests/${sent.body.requestId}/approve`, { masterOrderId: mo._id })
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
    const o = await Order.findById(ok.body.created[0].id).lean()
    assert.deepEqual([o.phase, o.product, o.styleNumber, o.masterOrderId, o.totalQty, o.techPackLink], ['development', 'New product (Olive, Black)', 'FYL-5001', mo._id, 800, 'https://drive.example.com/tp'])
    assert.deepEqual(o.colourways.map(c => c.name), ['Olive', 'Black'])
    assert.equal(new Date(o.delivery).toISOString().slice(0, 10), '2099-01-20')
  })

  test('the quantity may wait; the style no., colours, delivery date and tech pack link may not', async () => {
    const { buyer } = await arrange()
    const send = item => as(buyer).post('/api/style-requests', { kind: 'npd', items: [item] })
    assert.equal((await send(style({ quantity: '' }))).status, 201)
    for (const [over, why] of [[{ styleNumber: '' }, /style no/], [{ colours: [] }, /colour/], [{ delivery: '' }, /delivery/], [{ delivery: 'soon' }, /date/], [{ techPackLink: '' }, /tech pack/], [{ techPackLink: 'javascript:1' }, /./], [{ quantity: 2.5 }, /whole number/]]) {
      const res = await send(style(over))
      assert.equal(res.status, 400, JSON.stringify(over))
      assert.match(res.body.error, why)
    }
  })

  test('a request from the earlier guided form is still approved as it was sent', async () => {
    const { master, buyer, mo } = await arrange()
    const req = await StyleRequest.create({ kind: 'npd', buyerId: buyer._id, requestedBy: buyer._id, items: [{
      product: 'Wrap Dress', styleNumber: 'FYL-5001', category: 'DRESS', brand: 'FYLTR', totalQty: null,
      colourways: [{ name: 'Olive', code: '19-0419 TCX', hex: '#556b2f' }], fabricDetails: [], ecommerceLink: '', techPackLink: 'https://drive.example.com/tp', photos: [], photoCount: 0, docIds: [],
    }] })
    const ok = await as(master).post(`/api/style-requests/${req._id}/approve`, { masterOrderId: mo._id })
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
    const o = await Order.findById(ok.body.created[0].id).lean()
    assert.deepEqual([o.product, o.styleNumber, o.category, o.colourways[0].code], ['Wrap Dress', 'FYL-5001', 'DRESS', '19-0419 TCX'])
  })
})

describe('a sheet of styles from a customer', () => {
  test('is previewed and sent without a master order, and created under the one picked at approval', async () => {
    const { master, buyer, replenMo } = await arrange()
    const csv = 'Brand,Style No,Description,Image,Amazon link,Fabric,Stage\nFYLTR,F-9,Maxi Dress,https://img.example.com/1.jpg,https://amazon.in/dp/B0CCCCCCC3,Cotton,Replen\n'
    const up = await as(buyer).post('/api/style-imports', { filename: 'sheet.csv', data: Buffer.from(csv).toString('base64') })
    const prev = await as(buyer).post(`/api/style-imports/${up.body.id}/preview`, {})
    assert.equal(prev.status, 200, JSON.stringify(prev.body))
    assert.equal(prev.body.masterOrder, null)
    const sent = await as(buyer).post(`/api/style-imports/${up.body.id}/commit`, {})
    assert.equal(sent.status, 202, JSON.stringify(sent.body))
    assert.equal((await as(master).post(`/api/style-requests/${sent.body.requestId}/approve`)).status, 400, 'a master order has to be chosen')
    const ok = await as(master).post(`/api/style-requests/${sent.body.requestId}/approve`, { masterOrderId: replenMo._id })
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
    assert.equal((await Order.findById(ok.body.created[0].id).lean()).masterOrderId, replenMo._id)
  })

  test('a customer\'s NPD row needs its tech pack link; Tradio\'s does not', async () => {
    const { master } = await arrange()
    const buyer = await makeBuyer()
    const csv = 'Brand,Style No,Description,Image,Amazon link,Fabric,Stage\nFYLTR,N-1,Wrap Dress,https://img.example.com/1.jpg,,Cotton,NPD\n'
    const mine = await as(buyer).post('/api/style-imports', { filename: 'npd.csv', data: Buffer.from(csv).toString('base64') })
    const prev = await as(buyer).post(`/api/style-imports/${mine.body.id}/preview`, {})
    assert.equal(prev.body.rows[0].status, 'error')
    assert.match(prev.body.rows[0].problems.join(' '), /Tech pack link is missing/)
    const mo = await makeMasterOrder({ buyerId: buyer._id, createdBy: master._id })
    const tradio = await as(master).post('/api/style-imports', { filename: 'npd.csv', data: Buffer.from(csv).toString('base64') })
    assert.equal((await as(master).post(`/api/style-imports/${tradio.body.id}/preview`, { masterOrderId: mo._id })).body.rows[0].status, 'ok')
  })

  test('Tradio still has to choose a master order when it imports', async () => {
    const { master } = await arrange()
    const csv = 'Brand,Style No,Description,Image,Amazon link,Fabric,Stage\nFYLTR,F-9,Maxi Dress,https://img.example.com/1.jpg,https://amazon.in/dp/B0CCCCCCC3,Cotton,Replen\n'
    const up = await as(master).post('/api/style-imports', { filename: 'sheet.csv', data: Buffer.from(csv).toString('base64') })
    assert.equal((await as(master).post(`/api/style-imports/${up.body.id}/preview`, {})).status, 400)
  })
})

describe('Tradio adds a replen directly', () => {
  test('creates the replens at once under the master order chosen, with each style\'s details and files, and tells the customer', async () => {
    const { master, buyer, replenMo } = await arrange()
    const XLSXT = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    const spec = await as(master).post('/api/documents', { type: 'measurements', name: 'Spec', orderId: null, measurementLabel: 'pp_approval', dataUrl: `data:${XLSXT};base64,${Buffer.from('PK').toString('base64')}`, fileName: 'spec.xlsx', mimeType: XLSXT })
    assert.equal(spec.status, 201, JSON.stringify(spec.body))
    const r = await as(master).post('/api/style-requests/direct-replen', { masterOrderId: replenMo._id, items: [
      { sourceOrderId: 'SRC-1', colours: ['Navy'], quantity: 800, delivery: '2026-12-20', docIds: [spec.body.id] },
      { sourceOrderId: 'SRC-2', delivery: '2027-01-05' },
    ] })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.equal(r.body.created.length, 2)
    const a = await Order.findById(r.body.created[0].id).lean()
    assert.deepEqual([a.phase, a.masterOrderId, a.totalQty, a.replenOf, a.colourways[0].name], ['replen', replenMo._id, 800, 'SRC-1', 'Navy'])
    assert.equal((await Document.findById(spec.body.id).lean()).orderId, a._id)
    assert.equal(await StyleRequest.countDocuments(), 0, 'no review for Tradio')
    assert.equal(await Notification.countDocuments({ toUser: buyer._id, msg: /replen of 2 styles was added/ }), 1)
  })

  test('refused: a customer, no master order, another customer\'s style, a missing delivery date', async () => {
    const { master, buyer, mo } = await arrange()
    const other = await makeBuyer()
    const otherMo = await makeMasterOrder({ buyerId: other._id, createdBy: master._id })
    const send = (who, body) => as(who).post('/api/style-requests/direct-replen', body)
    assert.equal((await send(buyer, { masterOrderId: mo._id, items: [{ sourceOrderId: 'SRC-1', delivery: '2026-12-20' }] })).status, 403)
    assert.equal((await send(master, { items: [{ sourceOrderId: 'SRC-1', delivery: '2026-12-20' }] })).status, 400)
    const wrong = await send(master, { masterOrderId: otherMo._id, items: [{ sourceOrderId: 'SRC-1', delivery: '2026-12-20' }] })
    assert.equal(wrong.status, 400)
    assert.match(wrong.body.error, /customer/)
    assert.equal((await send(master, { masterOrderId: mo._id, items: [{ sourceOrderId: 'SRC-1' }] })).status, 400)
    assert.equal(await Order.countDocuments(), 2)
  })
})
