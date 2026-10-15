// Commercial data and documents: what a buy costs and on what terms (Tradio and the customer only), the cost sheet and
// terms kept from factories, "Buyer Order" filed as the PO it is, and earlier versions kept when a file is replaced.

import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as } from './helpers/client.js'
import { makeMaster, makeBuyer, makeMfr, orderPayload } from './helpers/factories.js'
import { Document } from '../src/models/Document.js'

before(async () => { await startTestDb(); await startServer() })
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(clearDb)

const pdfOf = text => `data:application/pdf;base64,${Buffer.from(`%PDF-1.4\n${text}\n`, 'latin1').toString('base64')}`
const file = (text = 'one') => ({ dataUrl: pdfOf(text), fileName: `${text}.pdf`, mimeType: 'application/pdf' })
const ORDER_ID = 'R4-001'

async function arrange() {
  const admin = await makeMaster(); const buyer = await makeBuyer(); const mfr = await makeMfr(); const otherMfr = await makeMfr()
  const mo = await as(admin).post('/api/master-orders', { id: 'auto', buyerId: String(buyer._id), orderName: 'Core tees', season: 'SS27',
    currency: 'usd', price: '125000.50', paymentTerms: '30% advance, 70% against BL', incoterm: 'fob', shipTo: 'Warehouse 4, Rotterdam' })
  assert.equal(mo.status, 201, JSON.stringify(mo.body))
  const res = await as(admin).post('/api/orders', orderPayload({ id: ORDER_ID, buyerId: buyer._id, mfrId: mfr._id, masterOrderId: mo.body.id }))
  assert.equal(res.status, 201, JSON.stringify(res.body))
  return { admin, buyer, mfr, otherMfr, mo: mo.body }
}

describe('master order commercial fields', () => {
  test('are saved and checked, and the customer sees them all', async () => {
    const { admin, buyer, mo } = await arrange()
    assert.deepEqual([mo.currency, mo.price, mo.paymentTerms, mo.incoterm, mo.shipTo], ['USD', 125000.5, '30% advance, 70% against BL', 'FOB', 'Warehouse 4, Rotterdam'])
    for (const bad of [{ currency: 'US' }, { price: -1 }, { price: '12.345' }, { price: 'lots' }, { incoterm: 'FOO' }, { paymentTerms: 'x'.repeat(201) }])
      assert.equal((await as(admin).post(`/api/master-orders/${mo.id}`, bad)).status, 400, JSON.stringify(bad))
    assert.equal((await as(admin).post(`/api/master-orders/${mo.id}`, { price: null, incoterm: '' })).status, 200)
    const seen = (await as(buyer).get('/api/master-orders')).body.find(m => m.id === mo.id)
    assert.deepEqual([seen.currency, seen.price, seen.incoterm, seen.paymentTerms], ['USD', null, '', '30% advance, 70% against BL'])
  })

  test('a factory gets the Incoterm and ship-to, never the price, currency or payment terms', async () => {
    const { mfr, mo } = await arrange()
    const seen = (await as(mfr).get('/api/master-orders')).body.find(m => m.id === mo.id)
    assert.deepEqual([seen.price, seen.currency, seen.paymentTerms], [null, '', ''])
    assert.deepEqual([seen.incoterm, seen.shipTo], ['FOB', 'Warehouse 4, Rotterdam'])
  })

  test('only Tradio sets them', async () => {
    const { buyer, mfr, mo } = await arrange()
    for (const who of [buyer, mfr]) assert.equal((await as(who).post(`/api/master-orders/${mo.id}`, { price: 1 })).status, 403)
  })
})

describe('cost sheets and terms', () => {
  test('a factory cannot list, open or upload them; the customer can see them', async () => {
    const { admin, buyer, mfr } = await arrange()
    const ids = {}
    for (const type of ['cost_sheet', 'terms']) {
      const r = await as(admin).post('/api/documents', { type, name: type, orderId: ORDER_ID, ...file() })
      assert.equal(r.status, 201, JSON.stringify(r.body)); ids[type] = r.body.id
    }
    const mfrList = (await as(mfr).get('/api/documents')).body.map(d => d.id)
    const buyerList = (await as(buyer).get('/api/documents')).body.map(d => d.id)
    for (const id of Object.values(ids)) {
      assert.ok(!mfrList.includes(id)); assert.ok(buyerList.includes(id))
      assert.equal((await as(mfr).get(`/api/documents/${id}/data`)).status, 403)
      assert.equal((await as(buyer).get(`/api/documents/${id}/data`)).status, 200)
    }
    for (const type of ['cost_sheet', 'terms'])
      assert.equal((await as(mfr).post('/api/documents', { type, name: 'x', orderId: ORDER_ID, ...file() })).status, 403)
  })
})

describe('Buyer Order is the purchase order', () => {
  test('a new upload of that type is filed as a PO, and an old record reads as one', async () => {
    const { admin, buyer } = await arrange()
    const r = await as(buyer).post('/api/documents', { type: 'buyer_order', name: 'Our order', orderId: ORDER_ID, ...file() })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.equal(r.body.type, 'PO')
    assert.equal((await Document.findById(r.body.id).lean()).type, 'PO')
    const old = await Document.create({ type: 'buyer_order', name: 'Legacy', orderId: ORDER_ID, uploadedBy: admin._id, dataUrl: pdfOf('old') })
    assert.equal((await as(admin).get('/api/documents')).body.find(d => d.id === String(old._id)).type, 'PO')
  })
})

describe('earlier versions', () => {
  async function techPack() {
    const ctx = await arrange()
    const r = await as(ctx.admin).post('/api/documents', { type: 'tech_pack', name: 'Tech pack', orderId: ORDER_ID, ...file('first') })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    return { ...ctx, id: r.body.id }
  }

  test('replacing the file keeps the old one, newest first, and it opens for whoever may open the document', async () => {
    const { admin, buyer, mfr, otherMfr, id } = await techPack()
    assert.equal((await as(admin).post(`/api/documents/${id}`, { name: 'Tech pack rev A' })).status, 200)
    assert.equal((await as(admin).get(`/api/documents/${id}/versions`)).body.length, 0)   // a rename keeps no copy
    assert.equal((await as(admin).post(`/api/documents/${id}`, { ...file('second') })).status, 200)
    assert.equal((await as(admin).post(`/api/documents/${id}`, { ...file('third') })).status, 200)

    const versions = (await as(buyer).get(`/api/documents/${id}/versions`)).body
    assert.deepEqual(versions.map(v => [v.version, v.fileName]), [[3, 'second.pdf'], [2, 'first.pdf']])
    assert.ok(versions.every(v => v.versionOf === id && v.replacedAt && v.dataUrl === undefined))
    assert.equal((await as(admin).get(`/api/documents/${id}/data`)).body.dataUrl, pdfOf('third'))
    assert.equal((await as(mfr).get(`/api/documents/${versions[1].id}/data`)).body.dataUrl, pdfOf('first'))
    assert.equal((await as(otherMfr).get(`/api/documents/${versions[1].id}/data`)).status, 403)
    assert.equal((await as(otherMfr).get(`/api/documents/${id}/versions`)).status, 403)
    // Earlier versions are not documents of their own in any list.
    assert.equal((await as(admin).get('/api/documents')).body.filter(d => d.type === 'tech_pack').length, 1)
  })

  test('once the document is deleted its earlier versions no longer open', async () => {
    const { admin, id } = await techPack()
    await as(admin).post(`/api/documents/${id}`, { ...file('second') })
    const [v] = (await as(admin).get(`/api/documents/${id}/versions`)).body
    assert.equal((await as(admin).post(`/api/documents/${id}/delete`, {})).status, 200)
    assert.equal((await as(admin).get(`/api/documents/${v.id}/data`)).status, 404)
  })
})
