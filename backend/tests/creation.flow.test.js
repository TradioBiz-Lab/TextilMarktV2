// The creation flow end to end: a master order with its commercial details, styles numbered by the server, photos at
// creation, and a plan whose steps can be moved.

import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as } from './helpers/client.js'
import { makeMaster, makeBuyer, makeMfr, makeMasterOrder, orderPayload } from './helpers/factories.js'
import { Order } from '../src/models/Order.js'
import { MasterOrder } from '../src/models/MasterOrder.js'
import { Document } from '../src/models/Document.js'
import { AuditLog } from '../src/models/AuditLog.js'

before(async () => {
  await startTestDb()
  process.env.PORT = new URL(await startServer()).port
})
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(clearDb)

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

describe('master order details', () => {
  test('PO number, PO date, ship-by and notes are kept on create and edit', async () => {
    const admin = await makeMaster()
    const buyer = await makeBuyer({ code: 'KON' })
    const res = await as(admin).post('/api/master-orders', { id: 'auto', buyerId: String(buyer._id), orderName: 'Corporate tees', season: 'SS27', poNumber: 'KHA/PO/118', poDate: '2026-09-01', shipBy: '2026-10-20', notes: 'Door delivery to Hyderabad' })
    assert.equal(res.status, 201, JSON.stringify(res.body))
    assert.match(res.body.id, /^MO-KON-/)
    assert.deepEqual([res.body.poNumber, res.body.poDate, res.body.shipBy, res.body.notes], ['KHA/PO/118', '2026-09-01', '2026-10-20', 'Door delivery to Hyderabad'])
    const edit = await as(admin).post(`/api/master-orders/${res.body.id}`, { shipBy: '2026-11-01', poNumber: '' })
    assert.equal(edit.status, 200, JSON.stringify(edit.body))
    assert.equal(edit.body.shipBy, '2026-11-01')
    assert.equal(edit.body.poNumber, '')
    assert.equal((await as(admin).post(`/api/master-orders/${res.body.id}`, { poDate: '1 Sept' })).status, 400)
  })
  test('a factory on the order sees the ship-by date, not the customer PO or the notes; the customer sees all of it', async () => {
    const admin = await makeMaster()
    const buyer = await makeBuyer({ code: 'KON' })
    const mfr = await makeMfr()
    const mo = await as(admin).post('/api/master-orders', { id: 'auto', buyerId: String(buyer._id), orderName: 'Corporate tees', season: 'SS27', poNumber: 'KHA/PO/118', poDate: '2026-09-01', shipBy: '2026-10-20', notes: 'Price 240 a piece' })
    assert.equal(mo.status, 201, JSON.stringify(mo.body))
    const style = await as(admin).post('/api/orders', orderPayload({ buyerId: buyer._id, mfrId: mfr._id, masterOrderId: mo.body.id }))
    assert.equal(style.status, 201, JSON.stringify(style.body))
    const seen = (await as(mfr).get('/api/master-orders')).body.find(m => m.id === mo.body.id)
    assert.deepEqual([seen.poNumber, seen.poDate, seen.shipBy, seen.notes], ['', null, '2026-10-20', ''])
    const own = (await as(buyer).get('/api/master-orders')).body.find(m => m.id === mo.body.id)
    assert.deepEqual([own.poNumber, own.notes], ['KHA/PO/118', 'Price 240 a piece'])
  })

  test('an edit that sends the stored values changes and logs nothing; a day that does not exist is refused', async () => {
    const admin = await makeMaster()
    const buyer = await makeBuyer({ code: 'KON' })
    const mo = await as(admin).post('/api/master-orders', { id: 'auto', buyerId: String(buyer._id), orderName: 'Corporate tees', season: 'SS27', poDate: '2026-09-01' })
    const same = await as(admin).post(`/api/master-orders/${mo.body.id}`, { orderName: 'Corporate tees', season: 'SS27', poNumber: '', poDate: '2026-09-01', shipBy: null, notes: '' })
    assert.equal(same.status, 200, JSON.stringify(same.body))
    assert.equal(await AuditLog.countDocuments({ action: 'Master Order Edited' }), 0)
    assert.equal((await as(admin).post(`/api/master-orders/${mo.body.id}`, { shipBy: '2026-02-30' })).status, 400)
    assert.equal((await as(admin).post(`/api/master-orders/${mo.body.id}`, { shipBy: '2026-11-01' })).status, 200)
    assert.equal(await AuditLog.countDocuments({ action: 'Master Order Edited' }), 1)
  })
})

describe('styles', () => {
  test('photos sent at creation make the gallery, the first is the main photo, and there is no delivery date yet', async () => {
    const admin = await makeMaster()
    const buyer = await makeBuyer({ code: 'KON' })
    const body = { id: 'auto', buyerId: String(buyer._id), product: 'Red Tee', category: 'tshrt', season: 'SS27', totalQty: 2000,
      colourways: [{ name: 'Red' }], photos: [{ image: PNG, colourway: 'red' }] }
    const a = await as(admin).post('/api/orders', body)
    assert.equal(a.status, 201, JSON.stringify(a.body))
    assert.match(a.body.id, /^KON-/)
    assert.equal(a.body.delivery, null)
    assert.deepEqual(a.body.photos, [{ image: PNG, colourway: 'Red' }])
    assert.equal(a.body.imageDataUrl, PNG)
  })
})

describe('moving a step in the plan', () => {
  async function arrange() {
    const admin = await makeMaster()
    const buyer = await makeBuyer()
    const mfr = await makeMfr()
    const res = await as(admin).post('/api/orders', orderPayload({ id: 'MS-001', buyerId: buyer._id, mfrId: mfr._id, stageNames: ['Cutting', 'Stitching', 'Packing'] }))
    assert.equal(res.status, 201, JSON.stringify(res.body))
    return { admin, mfr }
  }
  const names = async () => (await Order.findById('MS-001').lean()).assignments[0].stages.map(s => s.name)

  test('up and down swap neighbours, and each step keeps its documents', async () => {
    const { admin, mfr } = await arrange()
    const before = await names()
    assert.equal(before[before.length - 1], 'Delivery')
    const doc = await Document.create({ type: 'floor_evidence', name: 'Cut panels', orderId: 'MS-001', mfrId: mfr._id, stageIndex: 0, uploadedBy: admin._id, notes: 'cut' })
    const down = await as(admin).post(`/api/orders/MS-001/assignments/${mfr._id}/stages/0/move`, { direction: 'down' })
    assert.equal(down.status, 200, JSON.stringify(down.body))
    assert.deepEqual((await names()).slice(0, 3), ['Stitching', 'Cutting', 'Packing'])
    assert.equal((await Document.findById(doc._id).lean()).stageIndex, 1)
    await as(admin).post(`/api/orders/MS-001/assignments/${mfr._id}/stages/1/move`, { direction: 'up' })
    assert.deepEqual((await names()).slice(0, 3), ['Cutting', 'Stitching', 'Packing'])
    assert.equal((await Document.findById(doc._id).lean()).stageIndex, 0)
  })

  test('the Delivery step stays last and the ends do not move further', async () => {
    const { admin, mfr } = await arrange()
    const n = (await names()).length
    for (const [i, direction] of [[n - 1, 'up'], [n - 2, 'down'], [0, 'up']])
      assert.equal((await as(admin).post(`/api/orders/MS-001/assignments/${mfr._id}/stages/${i}/move`, { direction })).status, 400, `${i} ${direction}`)
    assert.equal((await as(admin).post(`/api/orders/MS-001/assignments/${mfr._id}/stages/0/move`, { direction: 'sideways' })).status, 400)
  })

  test('a factory cannot move steps', async () => {
    const { mfr } = await arrange()
    assert.equal((await as(mfr).post(`/api/orders/MS-001/assignments/${mfr._id}/stages/0/move`, { direction: 'down' })).status, 403)
  })
})
