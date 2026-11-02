// What a customer sends from its home page: a replen of several styles in production (each with its colours, quantity,
// links, expected delivery date and measurement sheets), a sheet of styles without choosing a master order, and new styles
// from the guided New Product Development form. All of it waits for a master admin, who picks the master order on approval.

import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as } from './helpers/client.js'
import { makeMaster, makeBuyer, makeMfr, makeMasterOrder } from './helpers/factories.js'
import { Order } from '../src/models/Order.js'
import { Document } from '../src/models/Document.js'
import { StyleRequest } from '../src/models/StyleRequest.js'
import { Notification } from '../src/models/Notification.js'

before(async () => { await startTestDb(); await startServer() })
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(clearDb)

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const PDF = `data:application/pdf;base64,${Buffer.from('%PDF-1.4\n').toString('base64')}`
const PHOTO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg=='

async function arrange() {
  const master = await makeMaster()
  const buyer = await makeBuyer({ company: 'Cocoblu' })
  const mo = await makeMasterOrder({ buyerId: buyer._id, createdBy: master._id, season: 'SS26', orderName: 'SS26 Main' })
  const replenMo = await makeMasterOrder({ buyerId: buyer._id, createdBy: master._id, season: 'SS26', orderName: 'SS26 Replen' })
  for (const [id, sn] of [['SRC-1', 'FYL-4002'], ['SRC-2', 'FYL-4005']]) {
    const r = await as(master).post('/api/orders', { id, buyerId: String(buyer._id), masterOrderId: mo._id, product: `Dress ${sn}`, styleNumber: sn, category: 'DRESS', season: 'SS26', phase: 'production', totalQty: 300, ecommerceLink: 'https://www.amazon.in/dp/B0AAAAAAA1', colourways: [{ name: 'Blue' }] })
    assert.equal(r.status, 201, JSON.stringify(r.body))
  }
  return { master, buyer, mo, replenMo }
}
const sheetDoc = (buyer, label = 'customer_submission') => as(buyer).post('/api/documents', { type: 'measurements', name: 'Spec', orderId: null, measurementLabel: label, dataUrl: `data:${XLSX};base64,${Buffer.from('PK').toString('base64')}`, fileName: 'spec.xlsx', mimeType: XLSX })

describe('a replen of several styles', () => {
  test('is sent with each style\'s details and files, waits, and is created under the master order the master admin picks', async () => {
    const { master, buyer, mo, replenMo } = await arrange()
    const spec = await sheetDoc(buyer, 'pp_approval')
    assert.equal(spec.status, 201, JSON.stringify(spec.body))
    const sent = await as(buyer).post('/api/style-requests', { kind: 'replen', items: [
      { sourceOrderId: 'SRC-1', colours: ['Red', 'Black', 'Red'], quantity: 1200, ecommerceLink: 'https://www.amazon.in/Title/dp/B0BBBBBBB2?th=1', techPackLink: 'drive.example.com/tp', delivery: '2026-12-15', docIds: [spec.body.id] },
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
    assert.equal(new Date(a.delivery).toISOString().slice(0, 10), '2026-12-15')
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
    const sent = await as(buyer).post('/api/style-requests', { kind: 'replen', items: [{ sourceOrderId: 'SRC-1', delivery: '2026-12-15' }] })
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
    assert.equal((await send([{ sourceOrderId: 'SRC-1', delivery: '2026-12-15' }, { sourceOrderId: 'SRC-1', delivery: '2026-12-15' }])).status, 400)
    assert.equal((await send([{ sourceOrderId: 'SRC-1', delivery: '2026-12-15', quantity: 1.5 }])).status, 400)
    assert.equal((await send([{ sourceOrderId: 'SRC-1', delivery: '2026-12-15', ecommerceLink: 'javascript:alert(1)' }])).status, 400)
    assert.equal((await send([{ sourceOrderId: 'NOPE', delivery: '2026-12-15' }])).status, 400)
    assert.equal((await as(other).post('/api/style-requests', { kind: 'replen', items: [{ sourceOrderId: 'SRC-1', delivery: '2026-12-15' }] })).status, 400, 'another customer\'s style')
    const theirs = await sheetDoc(other)
    assert.equal((await send([{ sourceOrderId: 'SRC-1', delivery: '2026-12-15', docIds: [theirs.body.id] }])).status, 400, 'another customer\'s file')
    const mine = await sheetDoc(buyer)
    assert.equal((await send([{ sourceOrderId: 'SRC-1', delivery: '2026-12-15', docIds: [mine.body.id] }])).status, 201)
    assert.equal((await send([{ sourceOrderId: 'SRC-2', delivery: '2026-12-15', docIds: [mine.body.id] }])).status, 400, 'a file already sent with a request')
    assert.equal((await as(master).post('/api/style-requests', { kind: 'replen', items: [{ sourceOrderId: 'SRC-1', delivery: '2026-12-15' }] })).status, 403)
    assert.equal((await as(await makeMfr()).post('/api/style-requests', { kind: 'replen', items: [] })).status, 403)
    assert.equal(await Order.countDocuments(), 2)
  })

  test('a master order of another customer is refused at approval', async () => {
    const { master, buyer } = await arrange()
    const other = await makeBuyer()
    const otherMo = await makeMasterOrder({ buyerId: other._id, createdBy: master._id })
    const sent = await as(buyer).post('/api/style-requests', { kind: 'replen', items: [{ sourceOrderId: 'SRC-1', delivery: '2026-12-15' }] })
    const res = await as(master).post(`/api/style-requests/${sent.body.requestId}/approve`, { masterOrderId: otherMo._id })
    assert.equal(res.status, 400)
    assert.equal((await StyleRequest.findById(sent.body.requestId).lean()).status, 'pending')
  })
})

describe('new styles from the guided form', () => {
  test('are sent with photos, colours, fabrics and files, and become NPD styles under the chosen master order', async () => {
    const { master, buyer, mo } = await arrange()
    const tp = await as(buyer).post('/api/documents', { type: 'tech_pack', name: 'Tech pack', orderId: null, dataUrl: PDF, fileName: 'tp.pdf', mimeType: 'application/pdf' })
    const spec = await sheetDoc(buyer)
    const sent = await as(buyer).post('/api/style-requests', { kind: 'npd', items: [{
      product: 'Wrap Dress', styleNumber: 'FYL-5001', category: 'dress', brand: 'FYLTR', totalQty: '',
      colourways: [{ name: 'Olive', code: '19-0419 TCX', hex: '#556b2f' }], fabricDetails: [{ name: 'Cotton Poplin', composition: '100% Cotton' }],
      ecommerceLink: '', techPackLink: '', photos: [{ image: PHOTO, colourway: 'Olive' }], docIds: [tp.body.id, spec.body.id],
    }] })
    assert.equal(sent.status, 201, JSON.stringify(sent.body))
    // The approver must choose: an NPD request has no master order of its own.
    assert.equal((await as(master).post(`/api/style-requests/${sent.body.requestId}/approve`)).status, 400)
    const ok = await as(master).post(`/api/style-requests/${sent.body.requestId}/approve`, { masterOrderId: mo._id })
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
    const o = await Order.findById(ok.body.created[0].id).lean()
    assert.deepEqual([o.phase, o.product, o.styleNumber, o.category, o.brand, o.masterOrderId, o.totalQty], ['development', 'Wrap Dress', 'FYL-5001', 'DRESS', 'FYLTR', mo._id, null])
    assert.equal(o.colourways[0].code, '19-0419 TCX')
    assert.equal(o.photos[0].colourway, 'Olive')
    assert.equal(o.fabricDetails[0].composition, '100% Cotton')
    assert.equal(await Document.countDocuments({ orderId: o._id }), 2)
  })

  test('a style without a product name or category is refused', async () => {
    const { buyer } = await arrange()
    assert.equal((await as(buyer).post('/api/style-requests', { kind: 'npd', items: [{ category: 'DRESS' }] })).status, 400)
    assert.equal((await as(buyer).post('/api/style-requests', { kind: 'npd', items: [{ product: 'X' }] })).status, 400)
    assert.equal((await as(buyer).post('/api/style-requests', { kind: 'npd', items: [{ product: 'X', category: 'TOP', photos: [{ image: 'javascript:1' }] }] })).status, 400)
  })

  test('the review shows each style and its files; the list never carries photo data', async () => {
    const { master, buyer } = await arrange()
    const spec = await sheetDoc(buyer, 'fit_approval')
    const sent = await as(buyer).post('/api/style-requests', { kind: 'npd', items: [{ product: 'Top', category: 'TOP', photos: [{ image: PHOTO }], docIds: [spec.body.id] }] })
    const list = await as(master).get('/api/style-requests')
    assert.equal(list.body[0].items[0].photos, undefined)
    assert.equal(list.body[0].items[0].photoCount, 1)
    const prev = await as(master).post(`/api/style-requests/${sent.body.requestId}/preview`)
    assert.equal(prev.status, 200)
    assert.equal(prev.body.items[0].files[0].measurementLabel, 'fit_approval')
    assert.equal(prev.body.items[0].photos.length, 1)
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

  test('Tradio still has to choose a master order when it imports', async () => {
    const { master } = await arrange()
    const csv = 'Brand,Style No,Description,Image,Amazon link,Fabric,Stage\nFYLTR,F-9,Maxi Dress,https://img.example.com/1.jpg,https://amazon.in/dp/B0CCCCCCC3,Cotton,Replen\n'
    const up = await as(master).post('/api/style-imports', { filename: 'sheet.csv', data: Buffer.from(csv).toString('base64') })
    assert.equal((await as(master).post(`/api/style-imports/${up.body.id}/preview`, {})).status, 400)
  })
})
