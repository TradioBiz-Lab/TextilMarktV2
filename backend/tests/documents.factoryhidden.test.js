// A customer's purchase order and Tradio's invoice are commercial: a factory never lists, opens or uploads them.
// Delivery paperwork (packing lists and the like) is the factory's own and stays visible to it.

import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as } from './helpers/client.js'
import { makeMaster, makeBuyer, makeMfr, orderPayload } from './helpers/factories.js'

before(async () => { await startTestDb(); await startServer() })
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(clearDb)

const pdf = `data:application/pdf;base64,${Buffer.from('%PDF-1.4\n1 0 obj\n', 'latin1').toString('base64')}`
const file = { dataUrl: pdf, fileName: 'x.pdf', mimeType: 'application/pdf' }
const ORDER_ID = 'DOC-HIDE-001'

async function arrange() {
  const admin = await makeMaster(); const buyer = await makeBuyer(); const mfr = await makeMfr(); const otherMfr = await makeMfr()
  const res = await as(admin).post('/api/orders', orderPayload({ id: ORDER_ID, buyerId: buyer._id, mfrId: mfr._id }))
  assert.equal(res.status, 201, JSON.stringify(res.body))
  const up = async (type, name, extra = {}) => {
    const r = await as(admin).post('/api/documents', { type, name, orderId: ORDER_ID, ...file, ...extra })
    assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.id
  }
  const ids = {
    po: await up('PO', 'Customer PO'),
    invoice: await up('invoice', 'Invoice NBCB-1'),
    buyerOrder: await up('buyer_order', 'Buyer order'),
    packing: await up('dispatch_docs', 'Packing list'),
    techPack: await up('tech_pack', 'Tech pack'),
  }
  return { admin, buyer, mfr, otherMfr, ids }
}

describe('what a factory can see', () => {
  test('the PO, the invoice and the buyer order are not in its list', async () => {
    const { mfr, ids } = await arrange()
    const list = (await as(mfr).get('/api/documents')).body.map(d => d.id)
    for (const k of ['po', 'invoice', 'buyerOrder']) assert.ok(!list.includes(ids[k]), `${k} must be hidden`)
    for (const k of ['packing', 'techPack']) assert.ok(list.includes(ids[k]), `${k} stays visible`)
  })

  test('and it cannot open them directly either', async () => {
    const { mfr, ids } = await arrange()
    for (const k of ['po', 'invoice', 'buyerOrder']) assert.equal((await as(mfr).get(`/api/documents/${ids[k]}/data`)).status, 403, k)
    assert.equal((await as(mfr).get(`/api/documents/${ids.packing}/data`)).status, 200)
  })

  test('the customer and Tradio still see all of it', async () => {
    const { admin, buyer, ids } = await arrange()
    for (const who of [admin, buyer]) {
      const list = (await as(who).get('/api/documents')).body.map(d => d.id)
      for (const id of Object.values(ids)) assert.ok(list.includes(id))
      assert.equal((await as(who).get(`/api/documents/${ids.invoice}/data`)).status, 200)
    }
  })
})

describe('who may upload them', () => {
  const body = type => ({ type, name: `a ${type}`, orderId: ORDER_ID, ...file })

  test('a factory cannot upload a PO, an invoice or a buyer order, but can upload delivery paperwork', async () => {
    const { mfr } = await arrange()
    for (const type of ['PO', 'invoice', 'buyer_order']) assert.equal((await as(mfr).post('/api/documents', body(type))).status, 403, type)
    assert.equal((await as(mfr).post('/api/documents', { ...body('dispatch_docs'), mfrId: String(mfr._id) })).status, 201)
  })

  test('the customer may upload a PO but never an invoice', async () => {
    const { buyer } = await arrange()
    assert.equal((await as(buyer).post('/api/documents', body('PO'))).status, 201)
    const inv = await as(buyer).post('/api/documents', body('invoice'))
    assert.equal(inv.status, 403)
    assert.match(inv.body.error, /Only Tradio/)
  })

  test('Tradio uploads invoices', async () => {
    const { admin } = await arrange()
    assert.equal((await as(admin).post('/api/documents', body('invoice'))).status, 201)
  })
})
