// Brands and manufacturers creating and running orders directly (the standalone product): who may
// create, whom they may name, who owns what they created, and who runs the factory's plan.
import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as } from './helpers/client.js'
import { makeAdmin, makeBuyer, makeMfr, makeMember, makeOrder, makeMasterOrder, setOrg, link } from './helpers/factories.js'
import { AuditLog } from '../src/models/AuditLog.js'
import { DroppedRecord } from '../src/models/DroppedRecord.js'
import { Order } from '../src/models/Order.js'
import { MasterOrder } from '../src/models/MasterOrder.js'

before(async () => { await startTestDb(); await startServer() })
after(async () => { delete process.env.PLATFORM_MODE; await stopServer(); await stopTestDb() })
beforeEach(async () => { await clearDb(); process.env.PLATFORM_MODE = 'standalone' })

/** A brand with two connected manufacturers, plus a brand and manufacturer that are connected to nobody here. */
async function world() {
  const brand = await makeBuyer({ code: 'ZAR' }), mfr = await makeMfr({ code: 'TPR' }), other = await makeMfr({ code: 'BLR' })
  const outsiderBrand = await makeBuyer({ code: 'HMX' }), outsiderMfr = await makeMfr({ code: 'OUT' })
  const admin = await makeAdmin()
  await link(brand, mfr); await link(brand, other); await link(outsiderBrand, outsiderMfr)
  return { brand, mfr, other, outsiderBrand, outsiderMfr, admin }
}
const body = (o = {}) => ({ product: 'Tee', category: 'TSHRT', season: 'FW26', totalQty: 100, delivery: '2026-12-31', ...o })

describe('a brand creating an order', () => {
  test('creates for itself with a connected manufacturer: numbered by the server, owned by the brand, plan deferred', async () => {
    const { brand, mfr } = await world()
    const r = await as(brand).post('/api/orders', body({ assignments: [{ mid: String(mfr._id), qty: 100 }] }))
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.equal(r.body.id, 'ZAR-TSHRT-FW26-001')
    assert.equal(r.body.buyerId, String(brand._id))
    assert.equal(r.body.createdByRole, 'buyer')
    assert.equal(r.body.createdBy, String(brand._id))
    // No schedule yet: just the mandatory Delivery step, to be built afterwards.
    assert.deepEqual(r.body.assignments[0].stages.map(s => s.name), ['Delivery'])
  })

  test('may give a schedule at creation, and it is used', async () => {
    const { brand, mfr } = await world()
    const r = await as(brand).post('/api/orders', body({
      assignments: [{ mid: String(mfr._id), qty: 100 }],
      stageNames: ['Fabric', 'Cutting'], stageStartDates: ['2026-10-01', '2026-10-10'], stageEtas: ['2026-10-09', '2026-10-20'],
    }))
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.deepEqual(r.body.assignments[0].stages.map(s => s.name), ['Fabric', 'Cutting', 'Delivery'])
  })

  test('can create with no manufacturer yet', async () => {
    const { brand } = await world()
    const r = await as(brand).post('/api/orders', body())
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.deepEqual(r.body.assignments, [])
  })

  test('cannot assign a manufacturer it is not connected with', async () => {
    const { brand, outsiderMfr } = await world()
    const r = await as(brand).post('/api/orders', body({ assignments: [{ mid: String(outsiderMfr._id), qty: 100 }] }))
    assert.equal(r.status, 403)
    assert.equal(r.body.code, 'NOT_CONNECTED')
  })

  test('cannot create for another brand', async () => {
    const { brand, outsiderBrand } = await world()
    assert.equal((await as(brand).post('/api/orders', body({ buyerId: String(outsiderBrand._id) }))).status, 403)
  })

  test('cannot choose the ID, nor claim another creator', async () => {
    const { brand, admin } = await world()
    const r = await as(brand).post('/api/orders', body({ id: 'MY-OWN-ID', createdBy: String(admin._id), createdByRole: 'admin' }))
    assert.equal(r.status, 201)
    assert.equal(r.body.id, 'ZAR-TSHRT-FW26-001')
    assert.equal(r.body.createdBy, String(brand._id))
    assert.equal(r.body.createdByRole, 'buyer')
  })

  test('cannot hand a step to a company that is not on the order', async () => {
    const { brand, mfr, outsiderMfr } = await world()
    const r = await as(brand).post('/api/orders', body({
      assignments: [{ mid: String(mfr._id), qty: 100 }],
      stageNames: ['Cutting'], stageStartDates: ['2026-10-01'], stageEtas: ['2026-10-09'], stageResponsibleIds: [String(outsiderMfr._id)],
    }))
    assert.equal(r.status, 400)
    assert.match(r.body.error, /company on this order/)
  })

  test('eight orders created at once get eight different numbers', async () => {
    const { brand, mfr } = await world()
    const rs = await Promise.all(Array.from({ length: 8 }, () => as(brand).post('/api/orders', body({ assignments: [{ mid: String(mfr._id), qty: 100 }] }))))
    assert.ok(rs.every(r => r.status === 201), JSON.stringify(rs.map(r => r.body.error)))
    assert.equal(new Set(rs.map(r => r.body.id)).size, 8)
  })

  test('a teammate creates it as the company, and the audit log names the person', async () => {
    const { brand } = await world()
    const member = await makeMember(brand, { name: 'Sourcing Lead' })
    const r = await as(member).post('/api/orders', body())
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.equal(r.body.createdBy, String(brand._id))
    const entry = await AuditLog.findOne({ action: 'Order Created' }).lean()
    assert.equal(String(entry.byUser), String(member._id))
  })

  test('the Tradio portal is unchanged: a brand cannot create at all', async () => {
    const { brand } = await world()
    delete process.env.PLATFORM_MODE
    assert.equal((await as(brand).post('/api/orders', body())).status, 403)
  })
})

describe('a manufacturer creating an order', () => {
  test('creates for a connected brand, assigned to itself, and sees it', async () => {
    const { brand, mfr } = await world()
    const r = await as(mfr).post('/api/orders', body({ buyerId: String(brand._id) }))
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.equal(r.body.createdByRole, 'manufacturer')
    assert.equal(r.body.assignments.length, 1)
    assert.equal(r.body.assignments[0].mid, String(mfr._id))
    assert.equal(r.body.assignments[0].qty, 100)
    assert.deepEqual((await as(mfr).get('/api/orders')).body.map(o => o.id), [r.body.id])
    // The brand sees it too, and who made it.
    const seen = (await as(brand).get('/api/orders')).body
    assert.equal(seen.length, 1)
    assert.equal(seen[0].createdByRole, 'manufacturer')
  })

  test('numbers keep counting up', async () => {
    const { brand, mfr } = await world()
    const a = await as(mfr).post('/api/orders', body({ buyerId: String(brand._id) }))
    const b = await as(mfr).post('/api/orders', body({ buyerId: String(brand._id) }))
    assert.deepEqual([a.body.id, b.body.id], ['ZAR-TSHRT-FW26-001', 'ZAR-TSHRT-FW26-002'])
  })

  test('cannot create for a brand it is not connected with', async () => {
    const { mfr, outsiderBrand } = await world()
    const r = await as(mfr).post('/api/orders', body({ buyerId: String(outsiderBrand._id) }))
    assert.equal(r.status, 403)
    assert.equal(r.body.code, 'NOT_CONNECTED')
  })

  test('must say who the customer is', async () => {
    const { mfr } = await world()
    assert.equal((await as(mfr).post('/api/orders', body())).status, 400)
  })

  test('cannot assign other manufacturers', async () => {
    const { brand, mfr, other } = await world()
    const r = await as(mfr).post('/api/orders', body({ buyerId: String(brand._id), assignments: [{ mid: String(other._id), qty: 100 }] }))
    assert.equal(r.status, 400)
  })
})

describe('master orders', () => {
  test('a brand creates its own, numbered by the server; a manufacturer creates for a connected brand and still sees it', async () => {
    const { brand, mfr, outsiderBrand } = await world()
    const a = await as(brand).post('/api/master-orders', { orderName: 'FW26 drop', season: 'FW26', id: 'IGNORED' })
    assert.equal(a.status, 201, JSON.stringify(a.body))
    assert.equal(a.body.id, 'MO-ZAR-FW26-001')
    assert.equal(a.body.createdByRole, 'buyer')
    const b = await as(mfr).post('/api/master-orders', { orderName: 'Our own', season: 'SS27', buyerId: String(brand._id) })
    assert.equal(b.status, 201, JSON.stringify(b.body))
    assert.equal(b.body.id, 'MO-ZAR-SS27-002')
    // No orders under it yet, yet the manufacturer that made it still sees it.
    assert.ok((await as(mfr).get('/api/master-orders')).body.some(m => m.id === b.body.id))
    assert.equal((await as(mfr).post('/api/master-orders', { orderName: 'x', buyerId: String(outsiderBrand._id) })).status, 403)
    assert.equal((await as(brand).post('/api/master-orders', { orderName: 'x', buyerId: String(outsiderBrand._id) })).status, 403)
  })

  test('only the company that created a master order edits or deletes it', async () => {
    const { brand, mfr } = await world()
    const theirs = (await as(mfr).post('/api/master-orders', { orderName: 'Theirs', season: 'FW26', buyerId: String(brand._id) })).body
    // The brand it is for cannot reshape the manufacturer's master order, and vice versa.
    assert.equal((await as(brand).post(`/api/master-orders/${theirs.id}`, { orderName: 'Hijack' })).status, 403)
    assert.equal((await as(mfr).post(`/api/master-orders/${theirs.id}`, { orderName: 'Renamed' })).status, 200)
    assert.equal((await as(brand).post(`/api/master-orders/${theirs.id}/delete`, {})).status, 403)
    assert.equal((await as(mfr).post(`/api/master-orders/${theirs.id}/delete`, {})).status, 200)
    assert.equal(await DroppedRecord.countDocuments({ kind: 'master_order' }), 1)
  })

  test('an invalid season is a clear error, not a crash', async () => {
    const { brand } = await world()
    assert.equal((await as(brand).post('/api/master-orders', { orderName: 'x', season: 'WINTER' })).status, 400)
  })

  test('Tradio staff may create one only for a brand that works with a manufacturer Tradio manages', async () => {
    const { brand, mfr, admin } = await world()
    assert.equal((await as(admin).post('/api/master-orders', { id: 'MO-X-1', buyerId: String(brand._id), orderName: 'x' })).status, 403)
    await setOrg(mfr, { tradioEnabled: true })
    assert.equal((await as(admin).post('/api/master-orders', { id: 'MO-X-1', buyerId: String(brand._id), orderName: 'x' })).status, 201)
  })
})

describe('who may edit or delete an order', () => {
  async function made() {
    const w = await world()
    const byBrand = (await as(w.brand).post('/api/orders', body({ assignments: [{ mid: String(w.mfr._id), qty: 100 }] }))).body.id
    const byMfr = (await as(w.mfr).post('/api/orders', body({ buyerId: String(w.brand._id) }))).body.id
    return { ...w, byBrand, byMfr }
  }

  test('the creator can; the other side cannot', async () => {
    const { brand, mfr, byBrand, byMfr } = await made()
    assert.equal((await as(brand).post(`/api/orders/${byBrand}`, { product: 'Renamed' })).status, 200)
    const no = await as(mfr).post(`/api/orders/${byBrand}`, { product: 'Hijack' })
    assert.equal(no.status, 403)
    assert.equal(no.body.code, 'NOT_ORDER_OWNER')
    assert.equal((await as(mfr).post(`/api/orders/${byMfr}`, { product: 'Renamed' })).status, 200)
    assert.equal((await as(brand).post(`/api/orders/${byMfr}`, { product: 'Hijack' })).status, 403)
  })

  test('deleting follows the same rule and keeps the record', async () => {
    const { brand, mfr, byBrand } = await made()
    assert.equal((await as(mfr).post(`/api/orders/${byBrand}/delete`, {})).status, 403)
    assert.equal((await as(brand).post(`/api/orders/${byBrand}/delete`, { reason: 'duplicate' })).status, 200)
    assert.equal(await DroppedRecord.countDocuments({ kind: 'style' }), 1)
    assert.equal(await Order.countDocuments({ _id: byBrand }), 0)
  })

  test('a teammate of the creating company can', async () => {
    const { brand, byBrand } = await made()
    const member = await makeMember(brand)
    assert.equal((await as(member).post(`/api/orders/${byBrand}`, { product: 'By a teammate' })).status, 200)
  })

  test('an order from before creators were recorded belongs to Tradio: neither side can change it', async () => {
    const { brand, mfr, admin } = await world()
    await makeOrder({ id: 'LEGACY-1', buyer: brand, mfrs: [mfr] })
    assert.equal((await as(brand).post('/api/orders/LEGACY-1', { product: 'x' })).status, 403)
    assert.equal((await as(mfr).post('/api/orders/LEGACY-1', { product: 'x' })).status, 403)
    assert.equal((await as(admin).post('/api/orders/LEGACY-1', { product: 'x' })).status, 403)   // mfr is not enabled
    await setOrg(mfr, { tradioEnabled: true })
    assert.equal((await as(admin).post('/api/orders/LEGACY-1', { product: 'x' })).status, 200)
  })
})

describe('adding a manufacturer to an order', () => {
  test('the brand that created it can add a connected manufacturer, not an unconnected one', async () => {
    const { brand, other, outsiderMfr } = await world()
    const id = (await as(brand).post('/api/orders', body())).body.id
    const no = await as(brand).post(`/api/orders/${id}/assignments`, { mfrId: String(outsiderMfr._id), qty: 100 })
    assert.equal(no.status, 403)
    assert.equal(no.body.code, 'NOT_CONNECTED')
    const yes = await as(brand).post(`/api/orders/${id}/assignments`, { mfrId: String(other._id), qty: 100 })
    assert.equal(yes.status, 201, JSON.stringify(yes.body))
  })

  test('a manufacturer cannot assign anyone, and a brand cannot assign on an order it did not create', async () => {
    const { brand, mfr, other } = await world()
    const mine = (await as(mfr).post('/api/orders', body({ buyerId: String(brand._id) }))).body.id
    assert.equal((await as(mfr).post(`/api/orders/${mine}/assignments`, { mfrId: String(other._id), qty: 10 })).status, 403)
    assert.equal((await as(brand).post(`/api/orders/${mine}/assignments`, { mfrId: String(other._id), qty: 10 })).status, 403)
  })
})

describe('the factory runs its own plan', () => {
  async function planWorld() {
    const w = await world()
    await makeOrder({ id: 'PLAN-1', buyer: w.brand, mfrs: [w.mfr, w.other], createdBy: w.brand._id, createdByRole: 'buyer' })
    return w
  }
  const insert = { name: 'Fit Sample', kind: 'milestone', startDate: '2026-10-05', eta: '2026-10-09' }

  test('a manufacturer edits the schedule of its own split: insert, revise, bulk-edit, delete', async () => {
    const { mfr } = await planWorld()
    const base = `/api/orders/PLAN-1/assignments/${mfr._id}/stages`
    assert.equal((await as(mfr).post(`${base}/insert`, { ...insert, index: 0 })).status, 200)
    assert.equal((await as(mfr).post(`${base}/1/eta`, { eta: '2026-11-01' })).status, 200)
    assert.equal((await as(mfr).post(`${base}/bulk`, { stages: [{ index: 1, startDate: '2026-10-02', eta: '2026-11-02' }] })).status, 200)
    assert.equal((await as(mfr).post(`${base}/1`, { eta: '2026-11-03' })).status, 200)
    assert.equal((await as(mfr).post(`${base}/0/delete`, {})).status, 200)
  })

  test('not on another manufacturer\'s split, and never by the brand', async () => {
    const { brand, mfr, other } = await planWorld()
    const base = `/api/orders/PLAN-1/assignments/${other._id}/stages`
    assert.equal((await as(mfr).post(`${base}/insert`, insert)).status, 403)
    assert.equal((await as(mfr).post(`${base}/1/eta`, { eta: '2026-11-01' })).status, 403)
    assert.equal((await as(mfr).post(`${base}/bulk`, { stages: [{ index: 0, eta: '2026-11-02' }] })).status, 403)
    const mine = `/api/orders/PLAN-1/assignments/${mfr._id}/stages`
    assert.equal((await as(brand).post(`${mine}/insert`, insert)).status, 403)
    assert.equal((await as(brand).post(`${mine}/1/eta`, { eta: '2026-11-01' })).status, 403)
  })

  test('a step may be handed only to a company on the order', async () => {
    const { brand, mfr, outsiderBrand } = await planWorld()
    const base = `/api/orders/PLAN-1/assignments/${mfr._id}/stages`
    const bad = await as(mfr).post(`${base}/bulk`, { stages: [{ index: 0, responsibleId: String(outsiderBrand._id) }] })
    assert.equal(bad.status, 400)
    assert.match(bad.body.error, /company on this order/)
    assert.equal((await as(mfr).post(`${base}/1/eta`, { responsibleId: String(outsiderBrand._id) })).status, 400)
    assert.equal((await as(mfr).post(`${base}/insert`, { ...insert, responsibleId: String(outsiderBrand._id) })).status, 400)
    // Its own customer is fine: that is how an approval step gets handed over.
    assert.equal((await as(mfr).post(`${base}/bulk`, { stages: [{ index: 0, kind: 'milestone', responsibleId: String(brand._id) }] })).status, 200)
  })

  test('the Tradio portal is unchanged: a manufacturer cannot edit the plan', async () => {
    const { mfr } = await planWorld()
    delete process.env.PLATFORM_MODE
    const base = `/api/orders/PLAN-1/assignments/${mfr._id}/stages`
    assert.equal((await as(mfr).post(`${base}/insert`, insert)).status, 403)
    assert.equal((await as(mfr).post(`${base}/1/eta`, { eta: '2026-11-01' })).status, 403)
    assert.equal((await as(mfr).post(`${base}/bulk`, { stages: [{ index: 0, eta: '2026-11-02' }] })).status, 403)
    assert.equal((await as(mfr).post(`${base}/1`, { eta: '2026-11-03' })).status, 403)
  })
})

describe('partners: the only other companies a company can see', () => {
  test('a brand sees its connected manufacturers and no one else; a manufacturer sees its brands', async () => {
    const { brand, mfr, other, outsiderMfr, outsiderBrand } = await world()
    const mine = (await as(brand).get('/api/partners')).body
    assert.deepEqual(mine.map(p => p.id).sort(), [String(mfr._id), String(other._id)].sort())
    assert.ok(!mine.some(p => p.id === String(outsiderMfr._id)))
    assert.equal(mine[0].role, 'manufacturer')
    assert.deepEqual((await as(mfr).get('/api/partners')).body.map(p => p.id), [String(brand._id)])
    assert.deepEqual((await as(outsiderMfr).get('/api/partners')).body.map(p => p.id), [String(outsiderBrand._id)])
  })

  test('admins are not companies', async () => {
    const { admin } = await world()
    assert.equal((await as(admin).get('/api/partners')).status, 403)
  })

  test('a teammate sees the company\'s partners', async () => {
    const { brand, mfr } = await world()
    const member = await makeMember(brand)
    assert.ok((await as(member).get('/api/partners')).body.some(p => p.id === String(mfr._id)))
  })
})

void makeMasterOrder, MasterOrder
