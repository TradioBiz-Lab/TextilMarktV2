// The standalone product's rules for Tradio staff: viewers who can act only for manufacturers
// Tradio has enabled, who never see a company that switched Tradio's view access off, and whose
// "view as" sessions are read-only unless acting for an enabled manufacturer.
import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'
import jwt from 'jsonwebtoken'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as, req } from './helpers/client.js'
import { makeAdmin, makeMaster, makeBuyer, makeMfr, makeMember, makeOrder, setOrg, link, orderPayload } from './helpers/factories.js'
import { Notification } from '../src/models/Notification.js'
import { Partnership } from '../src/models/Partnership.js'
import { AuditLog } from '../src/models/AuditLog.js'
import { Order } from '../src/models/Order.js'

before(async () => { await startTestDb(); await startServer() })
after(async () => { delete process.env.PLATFORM_MODE; await stopServer(); await stopTestDb() })
beforeEach(async () => { await clearDb(); process.env.PLATFORM_MODE = 'standalone' })

const tokenFrom = r => r.body.token

/** A brand, an enabled manufacturer and a manufacturer Tradio is not enabled for, all connected, one order each. */
async function world() {
  const admin = await makeAdmin(), master = await makeMaster()
  const brand = await makeBuyer(), enabled = await makeMfr(), plain = await makeMfr()
  await setOrg(enabled, { tradioEnabled: true }); await setOrg(plain, { tradioEnabled: false }); await setOrg(brand, {})
  await link(brand, enabled); await link(brand, plain)
  await makeOrder({ id: 'ORD-EN', buyer: brand, mfrs: [enabled] })
  await makeOrder({ id: 'ORD-PL', buyer: brand, mfrs: [plain] })
  return { admin, master, brand, enabled, plain }
}

describe('Tradio staff act only for enabled manufacturers', () => {
  test('a stage update on a manufacturer that is not enabled is refused, and allowed on one that is', async () => {
    const { admin, enabled, plain } = await world()
    const no = await as(admin).post(`/api/orders/ORD-PL/assignments/${plain._id}/stages/0`, { unitsDone: 5 })
    assert.equal(no.status, 403)
    assert.equal(no.body.code, 'NOT_TRADIO_ENABLED')
    const yes = await as(admin).post(`/api/orders/ORD-EN/assignments/${enabled._id}/stages/0`, { unitsDone: 5 })
    assert.equal(yes.status, 200, JSON.stringify(yes.body))
  })

  test('the master admin has no special bypass', async () => {
    const { master, plain } = await world()
    assert.equal((await as(master).post(`/api/orders/ORD-PL/assignments/${plain._id}/stages/0`, { unitsDone: 5 })).status, 403)
    assert.equal((await as(master).post('/api/orders/ORD-PL', { product: 'Renamed' })).status, 403)
    assert.equal((await as(master).post('/api/orders/ORD-PL/delete', { reason: 'cleanup of a test order' })).status, 403)
  })

  test('every manufacturer on a split order must be enabled', async () => {
    const { admin, brand, enabled, plain } = await world()
    await makeOrder({ id: 'ORD-MIX', buyer: brand, mfrs: [enabled, plain] })
    assert.equal((await as(admin).post('/api/orders/ORD-MIX', { callout: 'x' })).status, 403)
    await setOrg(plain, { tradioEnabled: true })
    assert.equal((await as(admin).post('/api/orders/ORD-MIX', { callout: 'x' })).status, 200)
  })

  test('an order with no manufacturer is nobody Tradio could be acting for', async () => {
    const { admin, brand } = await world()
    await makeOrder({ id: 'ORD-NONE', buyer: brand, mfrs: [] })
    assert.equal((await as(admin).post('/api/orders/ORD-NONE', { callout: 'x' })).status, 403)
  })

  test('creating an order: allowed for an enabled manufacturer (and it makes them partners), refused otherwise', async () => {
    const { admin, brand, enabled, plain } = await world()
    const base = { buyerId: String(brand._id), product: 'Tee', category: 'TSHRT', season: 'FW26', totalQty: 100, delivery: '2026-12-31', stageNames: ['Cutting'], stageStartDates: ['2026-10-01'], stageEtas: ['2026-10-10'] }
    const no = await as(admin).post('/api/orders', { ...base, id: 'NEW-PL', assignments: [{ mid: String(plain._id), qty: 100 }] })
    assert.equal(no.status, 403)
    assert.equal(no.body.code, 'NOT_TRADIO_ENABLED')
    const noMfr = await as(admin).post('/api/orders', { ...base, id: 'NEW-NONE' })
    assert.equal(noMfr.status, 403)
    const yes = await as(admin).post('/api/orders', { ...base, id: 'NEW-EN', assignments: [{ mid: String(enabled._id), qty: 100 }] })
    assert.equal(yes.status, 201, JSON.stringify(yes.body))
    assert.equal(yes.body.createdByRole, 'admin')
  })

  test('assigning a manufacturer to an order forms the partnership', async () => {
    const { admin, brand, enabled } = await world()
    const other = await makeMfr(); await setOrg(other, { tradioEnabled: true })
    await makeOrder({ id: 'ORD-ASSIGN', buyer: brand, mfrs: [enabled] })
    assert.equal(await Partnership.countDocuments(), 2)
    const r = await as(admin).post('/api/orders/ORD-ASSIGN/assignments', { mfrId: String(other._id), qty: 10 })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.equal(await Partnership.countDocuments(), 3)
  })

  test('assigning a manufacturer that is not enabled is refused', async () => {
    const { admin, brand, enabled, plain } = await world()
    await makeOrder({ id: 'ORD-ASSIGN2', buyer: brand, mfrs: [enabled] })
    const r = await as(admin).post('/api/orders/ORD-ASSIGN2/assignments', { mfrId: String(plain._id), qty: 10 })
    assert.equal(r.status, 403)
  })

  test('a document goes on an enabled manufacturer\'s order but not another\'s', async () => {
    const { admin } = await world()
    const doc = id => ({ type: 'PO', name: 'a PO', orderId: id, externalUrl: 'https://example.com/po' })
    assert.equal((await as(admin).post('/api/documents', doc('ORD-PL'))).status, 403)
    assert.equal((await as(admin).post('/api/documents', doc('ORD-EN'))).status, 201)
  })

  test('Tradio staff can still read every order, enabled or not', async () => {
    const { admin } = await world()
    const list = await as(admin).get('/api/orders')
    assert.deepEqual(list.body.map(o => o.id).sort(), ['ORD-EN', 'ORD-PL'])
    assert.equal((await as(admin).get('/api/orders/ORD-PL')).status, 200)
  })

  test('the Tradio portal is unchanged: with the mode unset, staff write anywhere', async () => {
    const { admin, plain } = await world()
    delete process.env.PLATFORM_MODE
    assert.equal((await as(admin).post(`/api/orders/ORD-PL/assignments/${plain._id}/stages/0`, { unitsDone: 5 })).status, 200)
  })
})

describe('a company that switched Tradio\'s view access off', () => {
  async function privateWorld() {
    const w = await world()
    const r = await as(w.plain).post('/api/orgs/me/privacy', { tradioCanView: false })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    return w
  }

  test('disappears from Tradio staff\'s lists and direct reads', async () => {
    const { admin, plain, brand } = await privateWorld()
    assert.deepEqual((await as(admin).get('/api/orders')).body.map(o => o.id), ['ORD-EN'])
    assert.equal((await as(admin).get('/api/orders/ORD-PL')).status, 404)
    // The company and its brand still see their own order.
    assert.equal((await as(plain).get('/api/orders/ORD-PL')).status, 200)
    assert.equal((await as(brand).get('/api/orders/ORD-PL')).status, 200)
  })

  test('its documents and master orders are hidden too', async () => {
    const { admin, plain } = await privateWorld()
    const d = await as(plain).post('/api/documents', { type: 'compliance_cert', name: 'Our cert', externalUrl: 'https://example.com/c', mfrId: String(plain._id) })
    assert.equal(d.status, 201, JSON.stringify(d.body))
    assert.equal((await as(admin).get('/api/documents')).body.length, 0)
    assert.equal((await as(admin).get(`/api/documents/${d.body.id}/data`)).status, 404)
    assert.equal((await as(admin).get('/api/documents/cert-summary')).body.length, 0)
  })

  test('cannot be acted for even if it is also enabled: privacy wins', async () => {
    const { admin, plain } = await privateWorld()
    await setOrg(plain, { tradioEnabled: true })
    assert.equal((await as(admin).post(`/api/orders/ORD-PL/assignments/${plain._id}/stages/0`, { unitsDone: 5 })).status, 403)
  })

  test('cannot be opened with view as, but the master admin can still leave a session that was open', async () => {
    const { master, enabled } = await world()
    // Open a session first, then the company turns Tradio off mid-view.
    const open = await as(master).post('/api/auth/view-as', { userId: String(enabled._id) })
    assert.equal(open.status, 200)
    await as(enabled).post('/api/orgs/me/privacy', { tradioCanView: false })
    const blocked = await req('GET', '/api/orders', { token: tokenFrom(open) })
    assert.equal(blocked.status, 403)
    assert.equal(blocked.body.code, 'VIEW_BLOCKED')
    assert.equal((await req('POST', '/api/auth/view-as/exit', { token: tokenFrom(open) })).status, 200)
    assert.equal((await as(master).post('/api/auth/view-as', { userId: String(enabled._id) })).status, 403)
  })

  test('only the company\'s owner can change it, never Tradio and never a teammate', async () => {
    const { master, admin, plain } = await world()
    const member = await makeMember(plain)
    assert.equal((await as(master).post('/api/orgs/me/privacy', { tradioCanView: false })).status, 403)
    assert.equal((await as(admin).post('/api/orgs/me/privacy', { tradioCanView: false })).status, 403)
    assert.equal((await as(member).post('/api/orgs/me/privacy', { tradioCanView: false })).status, 403)
    assert.equal((await as(plain).post('/api/orgs/me/privacy', { tradioCanView: false })).status, 200)
    // Tradio cannot turn it back on through the organization editor either.
    const orgs = await as(master).get('/api/orgs')
    const org = orgs.body.find(o => o.ownerUserId === String(plain._id))
    assert.equal(org.tradioCanView, false)
    await as(master).post(`/api/orgs/${org.id}`, { tradioCanView: true, name: org.name })
    assert.equal((await as(master).get('/api/orgs')).body.find(o => o.id === org.id).tradioCanView, false)
  })

  test('is not offered to Tradio\'s review queue', async () => {
    const { admin } = await privateWorld()
    assert.deepEqual((await as(admin).get('/api/review/queue')).body, [])
  })
})

describe('view as in the standalone product', () => {
  test('is read-only by default: reads work, every change is refused', async () => {
    const { master, brand } = await world()
    const r = await as(master).post('/api/auth/view-as', { userId: String(brand._id) })
    assert.equal(r.status, 200)
    assert.equal(r.body.user.actingFor, false)
    const t = tokenFrom(r)
    assert.equal((await req('GET', '/api/orders', { token: t })).status, 200)
    const write = await req('POST', '/api/orders/ORD-EN/escalate', { token: t, body: { reason: 'please look' } })
    assert.equal(write.status, 403)
    assert.equal(write.body.code, 'VIEW_ONLY')
    assert.equal((await req('POST', '/api/master-orders', { token: t, body: { buyerId: String(brand._id), orderName: 'x' } })).body.code, 'VIEW_ONLY')
    // Even marking the company's notifications read would change its state.
    assert.equal((await req('POST', '/api/notifications/mark-all-read', { token: t })).body?.code, 'VIEW_ONLY')
  })

  test('act-for is refused for a manufacturer that is not enabled and allowed for one that is', async () => {
    const { master, enabled, plain } = await world()
    const no = await as(master).post('/api/auth/view-as', { userId: String(plain._id), act: true })
    assert.equal(no.status, 403)
    assert.equal(no.body.code, 'NOT_TRADIO_ENABLED')
    const yes = await as(master).post('/api/auth/view-as', { userId: String(enabled._id), act: true })
    assert.equal(yes.status, 200)
    assert.equal(yes.body.user.actingFor, true)
  })

  test('acting for an enabled manufacturer can make changes, attributed to the master admin', async () => {
    const { master, enabled } = await world()
    const r = await as(master).post('/api/auth/view-as', { userId: String(enabled._id), act: true })
    const upd = await req('POST', `/api/orders/ORD-EN/assignments/${enabled._id}/stages/0`, { token: tokenFrom(r), body: { unitsDone: 7 } })
    assert.equal(upd.status, 200, JSON.stringify(upd.body))
    const entry = await AuditLog.findOne({ action: 'Stage Updated' }).lean()
    assert.equal(String(entry.viewAsBy), String(master._id))
  })

  test('viewing without act-for is still read-only on an enabled manufacturer', async () => {
    const { master, enabled } = await world()
    const r = await as(master).post('/api/auth/view-as', { userId: String(enabled._id) })
    const upd = await req('POST', `/api/orders/ORD-EN/assignments/${enabled._id}/stages/0`, { token: tokenFrom(r), body: { unitsDone: 7 } })
    assert.equal(upd.status, 403)
  })

  test('a forged act-for claim does not work on a manufacturer that is not enabled', async () => {
    const { master, plain } = await world()
    const forged = jwt.sign({
      id: String(plain._id), email: plain.email, role: 'manufacturer', adminType: null, name: plain.name, company: plain.company, code: plain.code,
      viewAsBy: String(master._id), viewAsByName: master.name, actingFor: true,
    }, process.env.JWT_SECRET, { expiresIn: '10m' })
    const upd = await req('POST', `/api/orders/ORD-PL/assignments/${plain._id}/stages/0`, { token: forged, body: { unitsDone: 7 } })
    assert.equal(upd.status, 403)
    assert.equal(upd.body.code, 'VIEW_ONLY')
  })

  test('act-for stops working the moment the manufacturer is no longer enabled', async () => {
    const { master, enabled } = await world()
    const r = await as(master).post('/api/auth/view-as', { userId: String(enabled._id), act: true })
    await setOrg(enabled, { tradioEnabled: false })
    const upd = await req('POST', `/api/orders/ORD-EN/assignments/${enabled._id}/stages/0`, { token: tokenFrom(r), body: { unitsDone: 7 } })
    assert.equal(upd.status, 403)
  })

  test('a teammate is opened as their company, never as themself', async () => {
    const { master, enabled } = await world()
    const member = await makeMember(enabled)
    const r = await as(master).post('/api/auth/view-as', { userId: String(member._id) })
    assert.equal(r.status, 200)
    assert.equal(r.body.user.id, String(enabled._id))
  })

  test('the options list names every company with its Tradio switches', async () => {
    const { master, enabled, plain } = await world()
    await as(plain).post('/api/orgs/me/privacy', { tradioCanView: false })
    const opts = (await as(master).get('/api/auth/view-as/options')).body
    const byId = Object.fromEntries(opts.map(o => [o.id, o]))
    assert.equal(byId[String(enabled._id)].tradioEnabled, true)
    assert.equal(byId[String(plain._id)].tradioCanView, false)
  })
})

describe('who hears about an update', () => {
  test('the brand always hears; Tradio only for manufacturers it may act for', async () => {
    const { admin, brand, enabled, plain } = await world()
    await as(plain).post(`/api/orders/ORD-PL/assignments/${plain._id}/stages/0`, { unitsDone: 5 })
    assert.equal(await Notification.countDocuments({ toUser: brand._id }), 1)
    assert.equal(await Notification.countDocuments({ toUser: admin._id }), 0)
    await as(enabled).post(`/api/orders/ORD-EN/assignments/${enabled._id}/stages/0`, { unitsDone: 5 })
    assert.equal(await Notification.countDocuments({ toUser: admin._id }), 1)
  })

  test('a brand\'s change goes to the order\'s manufacturers and never to another manufacturer\'s side', async () => {
    const { brand, enabled, plain } = await world()
    await makeOrder({ id: 'ORD-TWO', buyer: brand, mfrs: [enabled, plain] })
    // Hand the first manufacturer's Cutting step to the brand, then let the brand update it.
    await Order.updateOne({ _id: 'ORD-TWO' }, { $set: { 'assignments.0.stages.0.responsibleId': brand._id, 'assignments.0.stages.0.kind': 'milestone' } })
    const r = await as(brand).post(`/api/orders/ORD-TWO/assignments/${enabled._id}/stages/0`, { status: 'done' })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    // The brand notifies the order's manufacturers (both are its suppliers), never itself.
    assert.equal(await Notification.countDocuments({ toUser: brand._id }), 0)
    assert.ok(await Notification.countDocuments({ toUser: enabled._id }) >= 1)
  })
})

void orderPayload
