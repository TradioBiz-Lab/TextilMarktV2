// A file attached to a whole master order (the customer's PO at creation) is linked to it, seen by
// that master order's customer and by Tradio, and by nobody else.

import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as } from './helpers/client.js'
import { makeMaster, makeBuyer, makeMfr, makeMasterOrder } from './helpers/factories.js'

before(async () => { await startTestDb(); await startServer() })
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(clearDb)

const pdf = `data:application/pdf;base64,${Buffer.from('%PDF-1.4\n1 0 obj\n', 'latin1').toString('base64')}`

async function arrange() {
  const admin = await makeMaster()
  const buyer = await makeBuyer()
  const otherBuyer = await makeBuyer()
  const mfr = await makeMfr()
  const mo = await makeMasterOrder({ buyerId: buyer._id, createdBy: admin._id, id: 'MO-TST-001' })
  return { admin, buyer, otherBuyer, mfr, mo }
}

test('Tradio attaches a PO to a master order; its customer can see and open it, nobody else can', async () => {
  const { admin, buyer, otherBuyer, mfr, mo } = await arrange()
  const up = await as(admin).post('/api/documents', { type: 'PO', name: 'PO for MO-TST-001', masterOrderId: mo._id, dataUrl: pdf, fileName: 'po.pdf', mimeType: 'application/pdf' })
  assert.equal(up.status, 201, JSON.stringify(up.body))
  assert.equal(up.body.masterOrderId, 'MO-TST-001')
  const id = up.body.id

  const ownList = await as(buyer).get('/api/documents')
  assert.ok(ownList.body.some(d => d.id === id), 'the master order customer sees it')
  assert.equal((await as(buyer).get(`/api/documents/${id}/data`)).status, 200)

  assert.ok(!(await as(otherBuyer).get('/api/documents')).body.some(d => d.id === id), 'another customer does not')
  assert.equal((await as(otherBuyer).get(`/api/documents/${id}/data`)).status, 403)
  assert.ok(!(await as(mfr).get('/api/documents')).body.some(d => d.id === id), 'a manufacturer does not')
  assert.equal((await as(mfr).get(`/api/documents/${id}/data`)).status, 403)
})

test('only an admin may attach to a master order, and it must exist', async () => {
  const { admin, buyer, mo } = await arrange()
  const body = { type: 'PO', name: 'x', dataUrl: pdf, fileName: 'po.pdf', mimeType: 'application/pdf' }
  assert.equal((await as(buyer).post('/api/documents', { ...body, masterOrderId: mo._id })).status, 403)
  assert.equal((await as(admin).post('/api/documents', { ...body, masterOrderId: 'MO-NOPE-999' })).status, 400)
})
