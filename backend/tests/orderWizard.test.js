// Order/Project Setup Wizard — Phase 1 (schema + Documents + line items).
// Covers the new document scoping fields (masterOrderId/mfrMasterProjectId/
// mfrProjectId), the MfrProject image fields + bulk-creation route, and the
// orders.js bulk-route colourway/image forwarding fix. Adversarial priority
// matches this codebase's established discipline: cross-tenant isolation on
// every new scope, mirroring the patterns in materialsAndCosting.test.js.

import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as } from './helpers/client.js'
import { makeAdmin, makeMaster, makeBuyer, makeMfr, makeMasterOrder } from './helpers/factories.js'

before(async () => {
  await startTestDb()
  await startServer()
})
after(async () => {
  await stopServer()
  await stopTestDb()
})
beforeEach(clearDb)

const tinyPdf = 'data:application/pdf;base64,JVBERi0xLjQKJeLjz9MK'
const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

describe('Document scoping — masterOrderId', () => {
  test('admin can attach a document to a master order before any Order exists under it', async () => {
    const admin = await makeAdmin()
    const buyer = await makeBuyer()
    const mo = await makeMasterOrder({ buyerId: buyer._id, createdBy: admin._id })
    const res = await as(admin).post('/api/documents', {
      type: 'tech_pack', name: 'Tech Pack', dataUrl: tinyPdf, mimeType: 'application/pdf',
      masterOrderId: mo._id,
    })
    assert.equal(res.status, 201, JSON.stringify(res.body))
    assert.equal(res.body.masterOrderId, mo._id)
  })

  test('the owning buyer sees a masterOrderId-scoped document; an unrelated buyer does not', async () => {
    const admin = await makeAdmin()
    const buyerA = await makeBuyer()
    const buyerB = await makeBuyer()
    const mo = await makeMasterOrder({ buyerId: buyerA._id, createdBy: admin._id })
    await as(admin).post('/api/documents', { type: 'tech_pack', name: 'Tech Pack', dataUrl: tinyPdf, masterOrderId: mo._id })

    const listA = await as(buyerA).get('/api/documents')
    assert.equal(listA.body.some(d => d.masterOrderId === mo._id), true)

    const listB = await as(buyerB).get('/api/documents')
    assert.equal(listB.body.some(d => d.masterOrderId === mo._id), false)
  })

  test('a buyer cannot upload a document scoped to a master order that is not theirs', async () => {
    const admin = await makeAdmin()
    const buyerA = await makeBuyer()
    const buyerB = await makeBuyer()
    const mo = await makeMasterOrder({ buyerId: buyerA._id, createdBy: admin._id })
    const res = await as(buyerB).post('/api/documents', { type: 'RFQ', name: 'x', dataUrl: tinyPdf, masterOrderId: mo._id })
    assert.equal(res.status, 403)
  })
})

describe('Document scoping — mfrMasterProjectId / mfrProjectId (owner-only, no admin override)', () => {
  test('a manufacturer can attach a document to their own master project and project', async () => {
    const mfr = await makeMfr()
    const mp = await as(mfr).post('/api/mfr-master-projects', { buyerName: 'My Client', season: 'FW26' })
    const style = await as(mfr).post('/api/mfr-projects', { mfrMasterProjectId: mp.body.id, styleName: 'Style One' })

    const docOnMaster = await as(mfr).post('/api/documents', { type: 'measurement_sheet', name: 'Measurements', dataUrl: tinyPdf, mfrMasterProjectId: mp.body.id })
    assert.equal(docOnMaster.status, 201, JSON.stringify(docOnMaster.body))
    assert.equal(docOnMaster.body.mfrMasterProjectId, mp.body.id)

    const docOnStyle = await as(mfr).post('/api/documents', { type: 'sop', name: 'SOP', dataUrl: tinyPdf, mfrProjectId: style.body.id })
    assert.equal(docOnStyle.status, 201)
    assert.equal(docOnStyle.body.mfrProjectId, style.body.id)
  })

  test('manufacturer B cannot attach a document to manufacturer A\'s project, and never sees it in their own list', async () => {
    const mfrA = await makeMfr()
    const mfrB = await makeMfr()
    const style = await as(mfrA).post('/api/mfr-projects', { styleName: 'Private Style' })

    const attack = await as(mfrB).post('/api/documents', { type: 'sop', name: 'x', dataUrl: tinyPdf, mfrProjectId: style.body.id })
    assert.equal(attack.status, 403)

    await as(mfrA).post('/api/documents', { type: 'sop', name: 'Real SOP', dataUrl: tinyPdf, mfrProjectId: style.body.id })
    const listB = await as(mfrB).get('/api/documents')
    assert.equal(listB.body.some(d => d.mfrProjectId === style.body.id), false)
  })

  test('admin and master both 403 attaching a document to a manufacturer\'s private project — no admin override, matching MfrProject itself', async () => {
    const admin = await makeAdmin()
    const master = await makeMaster()
    const mfr = await makeMfr()
    const style = await as(mfr).post('/api/mfr-projects', { styleName: 'Private Style' })

    const asAdmin = await as(admin).post('/api/documents', { type: 'sop', name: 'x', dataUrl: tinyPdf, mfrProjectId: style.body.id })
    assert.equal(asAdmin.status, 403)
    const asMaster = await as(master).post('/api/documents', { type: 'sop', name: 'x', dataUrl: tinyPdf, mfrProjectId: style.body.id })
    assert.equal(asMaster.status, 403)
  })
})

describe('Document type: pattern is link-only (DXF has no reliable mime signature)', () => {
  test('an inline dataUrl on a pattern document is rejected', async () => {
    const admin = await makeAdmin()
    const res = await as(admin).post('/api/documents', { type: 'pattern', name: 'Cutting Pattern', dataUrl: tinyPdf })
    assert.equal(res.status, 400)
  })
  test('an externalUrl on a pattern document is accepted', async () => {
    const admin = await makeAdmin()
    const res = await as(admin).post('/api/documents', { type: 'pattern', name: 'Cutting Pattern', externalUrl: 'https://workdrive.zoho.com/pattern.dxf' })
    assert.equal(res.status, 201, JSON.stringify(res.body))
  })
})

describe('MfrProject — image fields + bulk creation', () => {
  test('create/update validates the image payload the same way Order does', async () => {
    const mfr = await makeMfr()
    const badBoth = await as(mfr).post('/api/mfr-projects', { styleName: 'X', imageDataUrl: tinyPng, imageUrl: 'https://example.com/a.png' })
    assert.equal(badBoth.status, 400)

    const ok = await as(mfr).post('/api/mfr-projects', { styleName: 'X', imageDataUrl: tinyPng })
    assert.equal(ok.status, 201)
    assert.equal(ok.body.imageDataUrl, tinyPng)
  })

  test('bulk creation: valid rows succeed, an invalid row fails independently, owner-only', async () => {
    const mfr = await makeMfr()
    const admin = await makeAdmin()

    const denied = await as(admin).post('/api/mfr-projects/bulk', { rows: [{ styleName: 'X' }] })
    assert.equal(denied.status, 403)

    const res = await as(mfr).post('/api/mfr-projects/bulk', {
      rows: [
        { styleName: 'Style A', totalQty: 100, colourways: [{ name: 'Black' }] },
        { styleName: '' }, // invalid — no name
        { styleName: 'Style C', imageDataUrl: tinyPng },
      ],
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.total, 3)
    assert.equal(res.body.created, 2)
    assert.equal(res.body.failed, 1)
    assert.equal(res.body.results[1].success, false)

    const list = await as(mfr).get('/api/mfr-projects')
    assert.equal(list.body.length, 2)
  })

  test('bulk creation caps at 100 rows', async () => {
    const mfr = await makeMfr()
    const rows = Array.from({ length: 101 }, (_, i) => ({ styleName: `Style ${i}` }))
    const res = await as(mfr).post('/api/mfr-projects/bulk', { rows })
    assert.equal(res.status, 400)
  })
})

describe('Order bulk creation — colourways/image now forwarded (Order Setup Wizard line-items fix)', () => {
  test('a bulk-created order carries the colourways and image the row specified', async () => {
    const admin = await makeAdmin()
    const buyer = await makeBuyer()
    const mfr = await makeMfr()
    const mo = await makeMasterOrder({ buyerId: buyer._id, createdBy: admin._id })

    const res = await as(admin).post('/api/orders/bulk', {
      masterOrderId: mo._id,
      rows: [{
        product: 'Wizard T-Shirt', totalQty: 50, delivery: '2026-12-31',
        assignments: [{ mid: String(mfr._id), qty: 50 }],
        stageNames: ['Stage One'], stageStartDates: ['2026-01-01'], stageEtas: ['2026-01-15'],
        colourways: ['Black', 'Navy'],
        imageUrl: 'https://example.com/photo.jpg',
      }],
    })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.created, 1, JSON.stringify(res.body.results))

    const orderId = res.body.results[0].orderId
    const order = await as(admin).get(`/api/orders/${orderId}`)
    assert.deepEqual(order.body.colourways.map(c => c.name), ['Black', 'Navy'])
    assert.equal(order.body.imageUrl, 'https://example.com/photo.jpg')
  })
})
