import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'
import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as, req, tokenFor } from './helpers/client.js'
import { makeAdmin, makeMaster, makeBuyer, makeMfr, makeCoordinator, orderPayload } from './helpers/factories.js'
import { coordinatorMay } from '../src/lib/coordinator.js'
import { User } from '../src/models/User.js'
import { Order } from '../src/models/Order.js'
import { FactoryVisit } from '../src/models/FactoryVisit.js'

before(async () => { await startTestDb(); await startServer(); await FactoryVisit.init() })
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(clearDb)

const ID = '6650f0f0f0f0f0f0f0f0f0f0'

describe('the list of what a coordinator may ask for', () => {
  test('exact paths only, by method', () => {
    assert.equal(coordinatorMay('GET', '/api/visits/mine'), true)
    assert.equal(coordinatorMay('GET', '/api/visits/mine?x=1'), true)
    assert.equal(coordinatorMay('GET', '/api/visits/mine/'), true)
    assert.equal(coordinatorMay('POST', '/api/visits/check-in'), true)
    assert.equal(coordinatorMay('POST', `/api/visits/${ID}/check-out`), true)
    assert.equal(coordinatorMay('GET', '/api/visits'), false, 'the admin list')
    assert.equal(coordinatorMay('POST', '/api/visits/mine'), false)
    assert.equal(coordinatorMay('GET', '/api/visits/mine/../../users'), false)
    assert.equal(coordinatorMay('POST', '/api/auth/change-password'), true)
    assert.equal(coordinatorMay('POST', '/api/notifications'), false, 'creating a notification')
    assert.equal(coordinatorMay('DELETE', '/api/visits/mine'), false)
  })
})

describe('a coordinator is refused everything not on the list', () => {
  test('writes and admin reads get 403 COORDINATOR_NOT_ALLOWED and change nothing', async () => {
    const admin = await makeAdmin(); const buyer = await makeBuyer(); const mfr = await makeMfr()
    const created = await as(admin).post('/api/orders', orderPayload({ buyerId: buyer._id, mfrId: mfr._id }))
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const oid = created.body.id
    const coord = await makeCoordinator({ assignedFactories: [mfr] })
    const api = as(coord)
    const stage = `/api/orders/${oid}/assignments/${mfr._id}/stages/0`
    const refused = [
      ['POST', '/api/orders', orderPayload({ buyerId: buyer._id, mfrId: mfr._id })],
      ['POST', '/api/orders/bulk', {}],
      ['POST', `/api/orders/${oid}`, { product: 'Changed' }],
      ['POST', `/api/orders/${oid}/delete`, {}],
      ['POST', `/api/orders/${oid}/assignments/${mfr._id}`, { status: 'Delivered' }],
      ['POST', `/api/orders/${oid}/assignments`, { mid: String(mfr._id), qty: 1 }],
      ['POST', `/api/orders/${oid}/assignments/${mfr._id}/reassign`, {}],
      ['POST', `/api/orders/${oid}/assignments/${mfr._id}/stages/start-plan`, {}],
      ['POST', `/api/orders/${oid}/assignments/${mfr._id}/stages/insert`, {}],
      ['POST', `${stage}/move`, {}],
      ['POST', `${stage}/delete`, {}],
      ['POST', '/api/orders/materials/bulk', {}],
      ['POST', `/api/orders/${oid}/product-link`, {}],
      ['POST', `/api/orders/${oid}/replen`, {}],
      ['POST', `/api/orders/${oid}/assignments/${mfr._id}/delivered-qty`, { deliveredQty: 5 }],
      ['POST', stage, { status: 'done' }],
      ['POST', stage, { unitsDone: 5 }],
      ['POST', `${stage}/eta`, { eta: '2027-01-01' }],
      ['POST', `${stage}/updates`, { text: 'hello' }],
      ['POST', `${stage}/items`, { name: 'x' }],
      ['POST', `${stage}/materials`, { name: 'x' }],
      ['POST', `/api/orders/${oid}/assignments/${mfr._id}/stages/bulk`, { stages: [] }],
      ['POST', `/api/orders/${oid}/photos`, { photos: [] }],
      ['POST', `/api/orders/${oid}/escalate`, { message: 'x' }],
      ['POST', '/api/documents', { type: 'tech_pack', name: 'x', orderId: oid, notes: 'n' }],
      ['POST', `/api/documents/${ID}`, { name: 'y' }],
      ['POST', `/api/documents/${ID}/delete`, {}],
      ['POST', '/api/master-orders', { orderName: 'x' }],
      ['POST', '/api/users', { email: 'a@b.co' }],
      ['POST', `/api/users/${coord._id}`, { assignedFactories: [] }],
      ['POST', `/api/users/${coord._id}/toggle`, {}],
      ['POST', '/api/manufacturers', { name: 'x', type: 'garment_manufacturer' }],
      ['POST', '/api/action-items', { title: 'x' }],
      ['POST', '/api/ribbons', { message: 'x' }],
      ['POST', '/api/notifications', { userId: String(admin._id), msg: 'x' }],
      ['POST', '/api/inbound/upload', { type: 'text', text: 'x' }],
      ['POST', '/api/style-requests', {}],
      ['POST', '/api/style-imports', {}],
      ['POST', '/api/style-requests/direct-replen', {}],
      ['POST', `/api/plan-templates/${ID}`, {}],
      ['POST', `/api/review/${ID}/approve`, {}],
      ['GET', '/api/users'],
      ['GET', '/api/audit'],
      ['GET', '/api/manufacturers'],
      ['GET', '/api/action-items'],
      ['GET', '/api/style-requests'],
      ['GET', '/api/review/queue'],
      ['GET', '/api/dropped'],
      ['GET', '/api/visits'],
    ]
    for (const [method, path, body] of refused) {
      const res = await req(method, path, { token: api.token, body })
      assert.equal(res.status, 403, `${method} ${path} -> ${res.status} ${JSON.stringify(res.body)}`)
      assert.equal(res.body.code, 'COORDINATOR_NOT_ALLOWED', `${method} ${path}`)
    }
    const after = await Order.findById(oid).lean()
    assert.equal(after.product, 'Test Shirt')
    assert.equal(after.assignments[0].stages[0].status ?? 'not_started', 'not_started')
    assert.equal(await Order.countDocuments(), 1)
    assert.equal(await User.countDocuments({ email: 'a@b.co' }), 0)
  })

  test('what is on the list works, and other roles are untouched by the gate', async () => {
    const mfr = await makeMfr()
    const coord = await makeCoordinator({ assignedFactories: [mfr] })
    const me = await as(coord).get('/api/auth/me')
    assert.equal(me.status, 200)
    assert.equal(me.body.user.role, 'coordinator')
    assert.deepEqual(me.body.user.factoryIds, [String(mfr._id)])
    assert.equal((await as(coord).get('/api/notifications')).status, 200)
    assert.equal((await as(coord).get('/api/ribbons')).status, 200)
    assert.equal((await as(coord).get('/api/visits/mine')).status, 200)
    assert.equal((await as(coord).post('/api/auth/language', { language: 'en' })).status, 200)
    assert.equal((await User.findById(coord._id).lean()).language, 'en')
    assert.equal((await as(coord).post('/api/auth/language', { language: 'fr' })).status, 400)

    assert.equal((await as(await makeAdmin()).get('/api/orders')).status, 200)
    assert.equal((await as(await makeBuyer()).get('/api/orders')).status, 200)
    assert.equal((await as(mfr).get('/api/orders')).status, 200)
  })

  test('a role in the token does not help: the database decides', async () => {
    const coord = await makeCoordinator()
    const forged = tokenFor({ ...coord.toObject(), role: 'admin', adminType: 'master' })
    const res = await req('GET', '/api/users', { token: forged })
    assert.equal(res.status, 403)
    assert.equal(res.body.code, 'COORDINATOR_NOT_ALLOWED')
  })
})

describe('the coordinator account', () => {
  const body = (o = {}) => ({ email: 'ravi@tradio.test', password: 'Coord@12345', role: 'coordinator', company: 'Tradio', name: 'Ravi', ...o })

  test('a master creates one with its factories; it is Tradio staff (code TRD, no admin type)', async () => {
    const master = await makeMaster(); const f1 = await makeMfr(); const f2 = await makeMfr()
    const res = await as(master).post('/api/users', body({ adminType: 'master', assignedFactories: [String(f1._id), String(f2._id)] }))
    assert.equal(res.status, 201, JSON.stringify(res.body))
    assert.equal(res.body.role, 'coordinator')
    assert.equal(res.body.code, 'TRD')
    assert.equal(res.body.adminType, null, 'an admin type sent for a coordinator is ignored')
    assert.deepEqual(res.body.assignedFactories.sort(), [String(f1._id), String(f2._id)].sort())
    const second = await as(master).post('/api/users', body({ email: 'sita@tradio.test', name: 'Sita' }))
    assert.equal(second.status, 201, 'two coordinators share the code TRD')
  })

  test('only active manufacturer accounts can be allocated', async () => {
    const master = await makeMaster(); const buyer = await makeBuyer(); const off = await makeMfr({ isActive: false })
    for (const bad of [[String(buyer._id)], [String(off._id)], ['nope'], 'x', [{ $ne: null }]]) {
      const res = await as(master).post('/api/users', body({ assignedFactories: bad }))
      assert.equal(res.status, 400, JSON.stringify(bad))
    }
    assert.equal(await User.countDocuments({ role: 'coordinator' }), 0)
  })

  test('the allocation can be changed later, by a master only, and only on a coordinator', async () => {
    const master = await makeMaster(); const admin = await makeAdmin(); const f1 = await makeMfr(); const f2 = await makeMfr()
    const coord = await makeCoordinator({ assignedFactories: [f1] })
    assert.equal((await as(admin).post(`/api/users/${coord._id}`, { assignedFactories: [String(f2._id)] })).status, 403)
    const res = await as(master).post(`/api/users/${coord._id}`, { assignedFactories: [String(f2._id)] })
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.assignedFactories, [String(f2._id)])
    assert.equal((await as(master).post(`/api/users/${admin._id}`, { assignedFactories: [String(f2._id)] })).status, 400)
    // He loses the old factory on his very next request.
    const mine = await as(coord).get('/api/visits/mine')
    assert.deepEqual(mine.body.factories.map(f => f.id), [String(f2._id)])
  })

  test('switching the account off ends its access at once', async () => {
    const master = await makeMaster(); const coord = await makeCoordinator()
    const api = as(coord)
    assert.equal((await api.get('/api/visits/mine')).status, 200)
    assert.equal((await as(master).post(`/api/users/${coord._id}/toggle`, {})).status, 200)
    assert.equal((await api.get('/api/visits/mine')).status, 401)
  })
})
