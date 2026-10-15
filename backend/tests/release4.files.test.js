// The customer's own files: its PO on the whole buy, its product photos, and a requirement it sent in being filed into
// one of its styles. Also the details a material line carries.

import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as } from './helpers/client.js'
import { makeMaster, makeBuyer, makeMfr, orderPayload } from './helpers/factories.js'
import { Notification } from '../src/models/Notification.js'

before(async () => { await startTestDb(); await startServer() })
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(clearDb)

const pdf = `data:application/pdf;base64,${Buffer.from('%PDF-1.4\n1 0 obj\n', 'latin1').toString('base64')}`
const file = { dataUrl: pdf, fileName: 'x.pdf', mimeType: 'application/pdf' }
// A 1x1 PNG.
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

async function arrange() {
  const admin = await makeMaster(); const buyer = await makeBuyer(); const other = await makeBuyer(); const mfr = await makeMfr()
  const mo = (await as(admin).post('/api/master-orders', { id: 'auto', buyerId: String(buyer._id), orderName: 'Buy', season: 'SS27' })).body
  const otherMo = (await as(admin).post('/api/master-orders', { id: 'auto', buyerId: String(other._id), orderName: 'Theirs', season: 'SS27' })).body
  const r = await as(admin).post('/api/orders', orderPayload({ id: 'R4F-001', buyerId: buyer._id, mfrId: mfr._id, masterOrderId: mo.id }))
  assert.equal(r.status, 201, JSON.stringify(r.body))
  const r2 = await as(admin).post('/api/orders', orderPayload({ id: 'R4F-OTH', buyerId: other._id, mfrId: mfr._id }))
  assert.equal(r2.status, 201, JSON.stringify(r2.body))
  return { admin, buyer, other, mfr, mo, otherMo }
}

describe("the customer's PO on the whole buy", () => {
  test('the customer attaches its own PO to its own master order, and nothing else there', async () => {
    const { buyer, mfr, mo, otherMo } = await arrange()
    const up = (who, body) => as(who).post('/api/documents', { name: 'PO 4471', ...file, ...body })
    assert.equal((await up(buyer, { type: 'PO', masterOrderId: mo.id })).status, 201)
    assert.equal((await up(buyer, { type: 'tech_pack', masterOrderId: mo.id })).status, 403)
    assert.equal((await up(buyer, { type: 'PO', masterOrderId: otherMo.id })).status, 403)
    assert.equal((await up(mfr, { type: 'PO', masterOrderId: mo.id })).status, 403)
  })
})

describe("the customer's product photos", () => {
  test('the customer sets the photos of its own style; the main one follows the first', async () => {
    const { buyer, other, mfr } = await arrange()
    const res = await as(buyer).post('/api/orders/R4F-001/photos', { photos: [{ image: png, colourway: '' }, { image: 'https://example.com/b.jpg' }] })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.photos.length, 2)
    assert.equal(res.body.imageDataUrl, png)
    assert.equal((await as(other).post('/api/orders/R4F-001/photos', { photos: [] })).status, 404)
    assert.equal((await as(mfr).post('/api/orders/R4F-001/photos', { photos: [] })).status, 403)
    assert.equal((await as(buyer).post('/api/orders/R4F-001/photos', { photos: ['data:text/html;base64,PGI+'] })).status, 400)
  })
})

describe('filing a requirement into a style', () => {
  async function sent() {
    const ctx = await arrange()
    const r = await as(ctx.buyer).post('/api/documents', { type: 'RFQ', name: 'Polo enquiry', ...file })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    return { ...ctx, id: r.body.id }
  }

  test('Tradio moves it onto one of that customer\'s styles; the customer is told and sees where it went', async () => {
    const { admin, buyer, mfr, id } = await sent()
    await Notification.deleteMany({})
    const res = await as(admin).post(`/api/documents/${id}/file`, { orderId: 'R4F-001' })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.orderId, 'R4F-001')
    assert.ok(res.body.filedAt)
    const mine = (await as(buyer).get('/api/documents')).body.find(d => d.id === id)
    assert.equal(mine.orderId, 'R4F-001')
    assert.ok(await Notification.exists({ toUser: buyer._id, orderId: 'R4F-001' }))
    // Now a style document like any other, which the style's factory sees.
    assert.ok((await as(mfr).get('/api/documents')).body.some(d => d.id === id))
    assert.equal((await as(admin).post(`/api/documents/${id}/file`, { orderId: 'R4F-001' })).status, 400)   // already filed
  })

  test("never into another customer's style, never by anyone but Tradio, and only a customer's own file", async () => {
    const { admin, buyer, id } = await sent()
    assert.equal((await as(admin).post(`/api/documents/${id}/file`, { orderId: 'R4F-OTH' })).status, 400)
    assert.equal((await as(buyer).post(`/api/documents/${id}/file`, { orderId: 'R4F-001' })).status, 403)
    assert.equal((await as(admin).post(`/api/documents/${id}/file`, { orderId: 'NOPE' })).status, 404)
    const tradios = (await as(admin).post('/api/documents', { type: 'RFQ', name: 'Ours', ...file })).body.id
    assert.equal((await as(admin).post(`/api/documents/${tradios}/file`, { orderId: 'R4F-001' })).status, 400)
  })
})

describe('a material line', () => {
  test('keeps its unit, supplier, PO number and expected date, checked on add and on edit', async () => {
    const { admin, mfr } = await arrange()
    const base = `/api/orders/R4F-001/assignments/${mfr._id}/stages/0/materials`
    const res = await as(admin).post(base, { name: 'Fabric', requiredQty: 1200, unit: 'm', supplier: ' Arvind ', poNumber: 'PO-77', expectedDate: '2027-02-01' })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    const line = res.body.assignments[0].stages[0].materials[0]
    assert.deepEqual([line.unit, line.supplier, line.poNumber, line.expectedDate], ['m', 'Arvind', 'PO-77', '2027-02-01'])
    assert.equal((await as(admin).post(base, { name: 'Trims', requiredQty: 1, expectedDate: 'next week' })).status, 400)
    assert.equal((await as(admin).post(base, { name: 'Trims', requiredQty: 1, poNumber: 'x'.repeat(61) })).status, 400)
    assert.equal((await as(admin).post(`${base}/0`, { expectedDate: '2027-02-30' })).status, 400)
    const edited = await as(admin).post(`${base}/0`, { expectedDate: '', supplier: 'Vardhman' })
    assert.equal(edited.status, 200, JSON.stringify(edited.body))
    const after = edited.body.assignments[0].stages[0].materials[0]
    assert.deepEqual([after.expectedDate, after.supplier], [null, 'Vardhman'])
  })
})
