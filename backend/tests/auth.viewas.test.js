// Sandbox-only "view as" for the master admin (routes/viewAs.js).
import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as, req } from './helpers/client.js'
import { makeAdmin, makeMaster, makeBuyer, makeMfr, orderPayload } from './helpers/factories.js'
import { AuditLog } from '../src/models/AuditLog.js'

before(async () => { await startTestDb(); await startServer() })
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(async () => { await clearDb(); process.env.ENABLE_VIEW_AS = 'true' })

// A token the way the frontend would hold it after view-as: the one in the response body.
const tokenFrom = r => r.body.token

describe('view as', () => {
  test('is invisible (404) unless ENABLE_VIEW_AS=true', async () => {
    const master = await makeMaster(), buyer = await makeBuyer()
    delete process.env.ENABLE_VIEW_AS
    assert.equal((await as(master).post('/api/auth/view-as', { userId: String(buyer._id) })).status, 404)
    assert.equal((await as(master).get('/api/auth/view-as/options')).status, 404)
    const me = await as(master).get('/api/auth/me')
    assert.equal(me.body.user.canViewAs, undefined)
  })

  test('master admin can list options and view as a customer', async () => {
    const master = await makeMaster(), buyer = await makeBuyer(), mfr = await makeMfr(), other = await makeAdmin()
    assert.equal((await as(master).get('/api/auth/me')).body.user.canViewAs, true)
    const opts = await as(master).get('/api/auth/view-as/options')
    assert.deepEqual(opts.body.map(o => o.id).sort(), [String(buyer._id), String(mfr._id)].sort())   // no admins in the list
    const r = await as(master).post('/api/auth/view-as', { userId: String(buyer._id) })
    assert.equal(r.status, 200)
    assert.equal(r.body.user.role, 'buyer')
    assert.equal(r.body.user.viewAsByName, master.name)
    const me = await req('GET', '/api/auth/me', { token: tokenFrom(r) })
    assert.equal(me.body.user.id, String(buyer._id))
    assert.equal(me.body.user.viewAsBy, String(master._id))
    assert.equal(me.body.user.canViewAs, true)
    // A refresh (/me re-signs the token) must not silently end the view-as.
    const again = await req('GET', '/api/auth/me', { token: me.body.token })
    assert.equal(again.body.user.viewAsBy, String(master._id))
    void other
  })

  test('only a master admin: regular admins, buyers and manufacturers are refused', async () => {
    const admin = await makeAdmin(), buyer = await makeBuyer(), mfr = await makeMfr()
    for (const u of [admin, buyer, mfr]) {
      assert.equal((await as(u).post('/api/auth/view-as', { userId: String(buyer._id) })).status, 403)
      assert.equal((await as(u).get('/api/auth/view-as/options')).status, 403)
    }
  })

  test('cannot view as an admin or an unknown/inactive user', async () => {
    const master = await makeMaster(), admin = await makeAdmin(), gone = await makeBuyer({ isActive: false })
    assert.equal((await as(master).post('/api/auth/view-as', { userId: String(admin._id) })).status, 400)
    assert.equal((await as(master).post('/api/auth/view-as', { userId: String(gone._id) })).status, 404)
    assert.equal((await as(master).post('/api/auth/view-as', { userId: 'nope' })).status, 400)
  })

  test('the session behaves exactly like that user: a manufacturer sees only their own assignment and no admin routes', async () => {
    const master = await makeMaster(), buyer = await makeBuyer(), mfr = await makeMfr(), otherMfr = await makeMfr()
    await as(master).post('/api/orders', orderPayload({ id: 'VA-1', buyerId: buyer._id, mfrId: mfr._id }))
    await as(master).post('/api/orders', orderPayload({ id: 'VA-2', buyerId: buyer._id, mfrId: otherMfr._id }))
    const r = await as(master).post('/api/auth/view-as', { userId: String(mfr._id) })
    const t = tokenFrom(r)
    const list = await req('GET', '/api/orders', { token: t })
    assert.deepEqual(list.body.map(o => o.id), ['VA-1'])
    assert.equal((await req('GET', '/api/users', { token: t })).status, 403)
    assert.equal((await req('GET', '/api/audit', { token: t })).status, 403)
  })

  test('can switch directly to another user, and exit back to the admin', async () => {
    const master = await makeMaster(), buyer = await makeBuyer(), mfr = await makeMfr()
    const a = await as(master).post('/api/auth/view-as', { userId: String(buyer._id) })
    const b = await req('POST', '/api/auth/view-as', { token: tokenFrom(a), body: { userId: String(mfr._id) } })
    assert.equal(b.body.user.role, 'manufacturer')
    assert.equal(b.body.user.viewAsBy, String(master._id))
    const out = await req('POST', '/api/auth/view-as/exit', { token: tokenFrom(b) })
    assert.equal(out.body.user.id, String(master._id))
    assert.equal(out.body.user.viewAsBy, undefined)
    const me = await req('GET', '/api/auth/me', { token: tokenFrom(out) })
    assert.equal(me.body.user.adminType, 'master')
    // Exiting when not viewing as anyone is rejected.
    assert.equal((await as(master).post('/api/auth/view-as/exit', {})).status, 400)
  })

  test('passwords cannot be changed while viewing as someone', async () => {
    const master = await makeMaster(), buyer = await makeBuyer()
    const r = await as(master).post('/api/auth/view-as', { userId: String(buyer._id) })
    const res = await req('POST', '/api/auth/change-password', { token: tokenFrom(r), body: { currentPassword: 'x', newPassword: 'Newpass@123' } })
    assert.equal(res.status, 403)
  })

  test('start and stop are audited under the real admin', async () => {
    const master = await makeMaster(), buyer = await makeBuyer()
    const a = await as(master).post('/api/auth/view-as', { userId: String(buyer._id) })
    await req('POST', '/api/auth/view-as/exit', { token: tokenFrom(a) })
    await new Promise(r => setTimeout(r, 100))
    const logs = await AuditLog.find({ action: /^View As/ }).sort({ createdAt: 1 }).lean()
    assert.deepEqual(logs.map(l => l.action), ['View As Started', 'View As Ended'])
    assert.ok(logs.every(l => String(l.byUser) === String(master._id)))
  })

  test('a demoted or deactivated admin loses the ability mid-session', async () => {
    const master = await makeMaster(), buyer = await makeBuyer()
    const a = await as(master).post('/api/auth/view-as', { userId: String(buyer._id) })
    master.adminType = 'user'; await master.save()
    assert.equal((await req('POST', '/api/auth/view-as', { token: tokenFrom(a), body: { userId: String(buyer._id) } })).status, 403)
    assert.equal((await req('POST', '/api/auth/view-as/exit', { token: tokenFrom(a) })).status, 403)
    assert.equal((await req('GET', '/api/auth/me', { token: tokenFrom(a) })).body.user.canViewAs, undefined)
  })
})
