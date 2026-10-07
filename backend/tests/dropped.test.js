// Dropping a style keeps a permanent record of it, and master orders can be
// edited. Both are admin-only, and a drop never loses data silently.

import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as } from './helpers/client.js'
import { makeAdmin, makeMaster, makeBuyer, makeMfr, makeMasterOrder, orderPayload } from './helpers/factories.js'
import { Order } from '../src/models/Order.js'
import { MasterOrder } from '../src/models/MasterOrder.js'
import { Document } from '../src/models/Document.js'
import { AuditLog } from '../src/models/AuditLog.js'
import { DroppedRecord } from '../src/models/DroppedRecord.js'

before(async () => { await startTestDb(); await startServer() })
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(clearDb)

async function arrange() {
  const admin = await makeMaster()
  const buyer = await makeBuyer({ company: 'Zara India' })
  const mfr = await makeMfr()
  const mo = await makeMasterOrder({ buyerId: buyer._id, createdBy: admin._id, orderName: 'Zara FW26 Core' })
  const api = as(admin)
  const create = async (id, extra = {}) => {
    const res = await api.post('/api/orders', orderPayload({
      id, buyerId: buyer._id, mfrId: mfr._id, masterOrderId: mo._id, product: 'Slim Fit Jeans', styleNumber: 'JNS-01',
      stageNames: ['Cutting', 'Packing'], stageStartDates: ['2026-07-01', '2026-07-05'], stageEtas: ['2026-07-03', '2026-07-10'], ...extra,
    }))
    assert.equal(res.status, 201, JSON.stringify(res.body))
    return res.body
  }
  return { admin, buyer, mfr, mo, api, create }
}

describe('dropping a style', () => {
  test('keeps a full record, then removes the style', async () => {
    const { admin, buyer, mo, api, create } = await arrange()
    await create('DRP-001')
    const doc = await Document.create({ type: 'tech_pack', name: 'Tech pack', orderId: 'DRP-001', uploadedBy: admin._id, externalUrl: 'https://example.com/tp' })

    const res = await api.post('/api/orders/DRP-001/delete', { reason: 'Buyer cancelled the style' })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.ok(res.body.recordId)
    assert.equal(await Order.countDocuments({ _id: 'DRP-001' }), 0)

    const rec = await DroppedRecord.findById(res.body.recordId).lean()
    assert.equal(rec.kind, 'style')
    assert.equal(rec.refId, 'DRP-001')
    assert.equal(rec.label, 'Slim Fit Jeans (JNS-01)')
    assert.equal(rec.masterOrderId, String(mo._id))
    assert.equal(String(rec.buyerId), String(buyer._id))
    assert.equal(rec.buyerCompany, 'Zara India')
    assert.equal(rec.reason, 'Buyer cancelled the style')
    assert.equal(String(rec.droppedBy), String(admin._id))
    assert.equal(rec.droppedByName, admin.name)
    assert.ok(rec.droppedAt)
    // The whole document is kept: stages (with the Delivery step), assignments, quantities.
    assert.equal(rec.snapshot._id, 'DRP-001')
    assert.equal(rec.snapshot.totalQty, 100)
    assert.deepEqual(rec.snapshot.assignments[0].stages.map(s => s.name), ['Cutting', 'Packing', 'Delivery'])
    assert.deepEqual(rec.documentIds.map(String), [String(doc._id)])
    // Documents stay in the Documents tab, as the delete dialog has always promised.
    assert.equal((await Document.findById(doc._id).lean()).isActive, true)
  })

  test('the reason is optional', async () => {
    const { api, create } = await arrange()
    await create('DRP-002')
    const res = await api.post('/api/orders/DRP-002/delete', {})
    assert.equal(res.status, 200)
    assert.equal((await DroppedRecord.findById(res.body.recordId).lean()).reason, '')
  })

  test('an over-long reason is refused and nothing is dropped', async () => {
    const { api, create } = await arrange()
    await create('DRP-003')
    const res = await api.post('/api/orders/DRP-003/delete', { reason: 'x'.repeat(501) })
    assert.equal(res.status, 400)
    assert.equal(await Order.countDocuments({ _id: 'DRP-003' }), 1)
    assert.equal(await DroppedRecord.countDocuments({}), 0)
  })

  test('dropping a style that does not exist records nothing', async () => {
    const { api } = await arrange()
    assert.equal((await api.post('/api/orders/NOPE/delete', {})).status, 404)
    assert.equal(await DroppedRecord.countDocuments({}), 0)
  })

  test('only an admin can drop, and a refused drop keeps both the style and the record count', async () => {
    const { buyer, mfr, create } = await arrange()
    await create('DRP-004')
    assert.equal((await as(buyer).post('/api/orders/DRP-004/delete', {})).status, 403)
    assert.equal((await as(mfr).post('/api/orders/DRP-004/delete', {})).status, 403)
    assert.equal(await Order.countDocuments({ _id: 'DRP-004' }), 1)
    assert.equal(await DroppedRecord.countDocuments({}), 0)
  })

  test('the audit log points at the record', async () => {
    const { api, create } = await arrange()
    await create('DRP-005')
    const res = await api.post('/api/orders/DRP-005/delete', { reason: 'Duplicate' })
    const log = await AuditLog.findOne({ action: 'Order Deleted' }).lean()
    assert.match(log.detail, /DRP-005/)
    assert.match(log.detail, /Duplicate/)
    assert.match(log.detail, new RegExp(res.body.recordId))
  })

  test('dropping one style leaves its siblings in the master order alone', async () => {
    const { api, create, mo } = await arrange()
    await create('DRP-006'); await create('DRP-007')
    await api.post('/api/orders/DRP-006/delete', {})
    assert.deepEqual((await Order.find({ masterOrderId: mo._id }, '_id').lean()).map(o => o._id), ['DRP-007'])
  })
})

describe('reading the record', () => {
  test('lists drops newest first without the heavy snapshot, and filters by master order', async () => {
    const { api, create, mo } = await arrange()
    await create('DRP-010'); await create('DRP-011')
    await api.post('/api/orders/DRP-010/delete', { reason: 'first' })
    await new Promise(r => setTimeout(r, 5))
    await api.post('/api/orders/DRP-011/delete', { reason: 'second' })
    const res = await api.get('/api/dropped')
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.map(r => r.refId), ['DRP-011', 'DRP-010'])
    assert.equal(res.body[0].snapshot, undefined)
    assert.equal(res.body[0].reason, 'second')
    assert.equal(res.body[0].kind, 'style')
    assert.equal((await api.get(`/api/dropped?masterOrderId=${mo._id}`)).body.length, 2)
    assert.equal((await api.get('/api/dropped?masterOrderId=OTHER')).body.length, 0)
  })

  test('returns the full snapshot for one record', async () => {
    const { api, create } = await arrange()
    await create('DRP-012')
    const { body: { recordId } } = await api.post('/api/orders/DRP-012/delete', {})
    const res = await api.get(`/api/dropped/${recordId}`)
    assert.equal(res.status, 200)
    assert.equal(res.body.snapshot._id, 'DRP-012')
    assert.equal(res.body.snapshot.assignments[0].stages.length, 3)
  })

  test('is admin-only', async () => {
    const { buyer, mfr, create, api } = await arrange()
    await create('DRP-013')
    const { body: { recordId } } = await api.post('/api/orders/DRP-013/delete', {})
    for (const who of [buyer, mfr]) {
      assert.equal((await as(who).get('/api/dropped')).status, 403)
      assert.equal((await as(who).get(`/api/dropped/${recordId}`)).status, 403)
    }
  })

  test('an unknown or malformed record id is a 404', async () => {
    const { api } = await arrange()
    assert.equal((await api.get('/api/dropped/not-an-id')).status, 404)
    assert.equal((await api.get('/api/dropped/000000000000000000000000')).status, 404)
  })
})

describe('editing a master order', () => {
  test('renames it and changes its season', async () => {
    const { api, mo } = await arrange()
    const res = await api.post(`/api/master-orders/${mo._id}`, { orderName: '  Zara FW26 Basics ', season: 'SS27' })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.orderName, 'Zara FW26 Basics')
    assert.equal(res.body.season, 'SS27')
    assert.equal(res.body.buyerCompany, 'Zara India')
    const row = await MasterOrder.findById(mo._id).lean()
    assert.equal(row.orderName, 'Zara FW26 Basics')
    assert.equal(String(row.buyerId).length > 0, true)
  })

  test('only the fields sent change, and the season can be cleared', async () => {
    const { api, mo } = await arrange()
    await api.post(`/api/master-orders/${mo._id}`, { season: 'SS27' })
    assert.equal((await MasterOrder.findById(mo._id).lean()).orderName, 'Zara FW26 Core')
    const res = await api.post(`/api/master-orders/${mo._id}`, { season: '' })
    assert.equal(res.status, 200)
    assert.equal((await MasterOrder.findById(mo._id).lean()).season ?? null, null)
  })

  test('rejects a blank name, a bad season and an empty edit', async () => {
    const { api, mo } = await arrange()
    assert.equal((await api.post(`/api/master-orders/${mo._id}`, { orderName: '   ' })).status, 400)
    assert.equal((await api.post(`/api/master-orders/${mo._id}`, { orderName: 'x'.repeat(201) })).status, 400)
    assert.equal((await api.post(`/api/master-orders/${mo._id}`, { season: 'FW99' })).status, 400)
    assert.equal((await api.post(`/api/master-orders/${mo._id}`, {})).status, 400)
    assert.equal((await MasterOrder.findById(mo._id).lean()).orderName, 'Zara FW26 Core')
  })

  test('is admin-only and 404s for an unknown master order', async () => {
    const { buyer, mfr, api, mo } = await arrange()
    assert.equal((await as(buyer).post(`/api/master-orders/${mo._id}`, { orderName: 'Hacked' })).status, 403)
    assert.equal((await as(mfr).post(`/api/master-orders/${mo._id}`, { orderName: 'Hacked' })).status, 403)
    assert.equal((await api.post('/api/master-orders/NOPE', { orderName: 'X' })).status, 404)
    assert.equal((await MasterOrder.findById(mo._id).lean()).orderName, 'Zara FW26 Core')
  })

  test('writes an audit entry showing before and after', async () => {
    const { api, mo } = await arrange()
    await api.post(`/api/master-orders/${mo._id}`, { orderName: 'Renamed' })
    const log = await AuditLog.findOne({ action: 'Master Order Edited' }).lean()
    assert.match(log.detail, /Zara FW26 Core/)
    assert.match(log.detail, /Renamed/)
  })
})

describe('deleting a master order', () => {
  test('still refuses while styles remain under it, and records nothing', async () => {
    const { api, mo, create } = await arrange()
    await create('DRP-020')
    const res = await api.post(`/api/master-orders/${mo._id}/delete`, {})
    assert.equal(res.status, 400)
    assert.equal(await MasterOrder.countDocuments({ _id: mo._id }), 1)
    assert.equal(await DroppedRecord.countDocuments({}), 0)
  })

  test('once empty, deletes it and keeps a record of it', async () => {
    const { api, mo, create } = await arrange()
    await create('DRP-021')
    await api.post('/api/orders/DRP-021/delete', {})
    const res = await api.post(`/api/master-orders/${mo._id}/delete`, { reason: 'Season cancelled' })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(await MasterOrder.countDocuments({ _id: mo._id }), 0)
    const rec = await DroppedRecord.findById(res.body.recordId).lean()
    assert.equal(rec.kind, 'master_order')
    assert.equal(rec.label, 'Zara FW26 Core')
    assert.equal(rec.reason, 'Season cancelled')
    assert.equal(rec.snapshot._id, String(mo._id))
    assert.equal((await api.get('/api/dropped?kind=master_order')).body.length, 1)
    assert.equal((await api.get('/api/dropped?kind=style')).body.length, 1)
  })
})
