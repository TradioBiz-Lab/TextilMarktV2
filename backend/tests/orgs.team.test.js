// Organizations and team accounts: a teammate signs in as themself but acts as their company.
import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as, req, tokenFor } from './helpers/client.js'
import { makeAdmin, makeBuyer, makeMfr, makeMember, setOrg, orderPayload, TEST_PASSWORD } from './helpers/factories.js'
import { User } from '../src/models/User.js'
import { AuditLog } from '../src/models/AuditLog.js'
import { Organization } from '../src/models/Organization.js'

before(async () => { await startTestDb(); await startServer() })
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(async () => { await clearDb() })

async function seedOrder(admin, buyer, mfr, id = 'TEAM-1') {
  const r = await as(admin).post('/api/orders', orderPayload({ id, buyerId: buyer._id, mfrId: mfr._id, stageNames: ['Cutting'] }))
  assert.equal(r.status, 201, JSON.stringify(r.body))
  return id
}

describe('an account that predates organizations', () => {
  test('gets an organization the first time it makes a request', async () => {
    const mfr = await makeMfr()
    assert.equal(await Organization.countDocuments(), 0)
    assert.equal((await as(mfr).get('/api/orders')).status, 200)
    const org = await Organization.findOne({ ownerUserId: mfr._id }).lean()
    assert.equal(org.type, 'manufacturer')
    assert.equal(org.name, mfr.company)
    // Tradio access is never switched on as a side effect of creating the organization.
    assert.equal(org.tradioEnabled, false)
    assert.equal(org.tradioCanView, true)
    const u = await User.findById(mfr._id).lean()
    assert.equal(String(u.orgId), String(org._id))
    assert.equal(u.orgRole, 'owner')
  })

  test('two simultaneous first requests still produce exactly one organization', async () => {
    const buyer = await makeBuyer()
    const t = as(buyer)
    await Promise.all([t.get('/api/orders'), t.get('/api/orders'), t.get('/api/orders'), t.get('/api/orders')])
    assert.equal(await Organization.countDocuments({ ownerUserId: buyer._id }), 1)
  })

  test('a brand gets a brand organization and admins get none', async () => {
    const buyer = await makeBuyer(), admin = await makeAdmin()
    await as(buyer).get('/api/orders'); await as(admin).get('/api/orders')
    assert.equal((await Organization.findOne({ ownerUserId: buyer._id }).lean()).type, 'brand')
    assert.equal(await Organization.countDocuments(), 1)
  })
})

describe('a teammate acts as their company', () => {
  test('sees the company\'s orders and only the company\'s own assignment', async () => {
    const admin = await makeAdmin(), buyer = await makeBuyer(), mfr = await makeMfr(), otherMfr = await makeMfr()
    const member = await makeMember(mfr)
    await seedOrder(admin, buyer, mfr, 'TEAM-A')
    await seedOrder(admin, buyer, otherMfr, 'TEAM-B')
    const list = await as(member).get('/api/orders')
    assert.deepEqual(list.body.map(o => o.id), ['TEAM-A'])
    // Not the other factory's split, and not another company's order by direct id either.
    assert.equal((await as(member).get('/api/orders/TEAM-A')).status, 200)
    assert.equal((await as(member).get('/api/orders/TEAM-B')).status, 403)
  })

  test('can write for the company, and the audit log names the person, not the owner', async () => {
    const admin = await makeAdmin(), buyer = await makeBuyer(), mfr = await makeMfr()
    const member = await makeMember(mfr, { name: 'Store Keeper' })
    await seedOrder(admin, buyer, mfr)
    const r = await as(member).post(`/api/orders/TEAM-1/assignments/${mfr._id}/stages/0`, { unitsDone: 10 })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const entry = await AuditLog.findOne({ action: 'Stage Updated' }).lean()
    assert.equal(String(entry.byUser), String(member._id))
    assert.notEqual(String(entry.byUser), String(mfr._id))
    assert.match(entry.detail, /by Store Keeper/)
  })

  test('the user object says who the party is and who the person is', async () => {
    const mfr = await makeMfr(), member = await makeMember(mfr, { name: 'Merchandiser' })
    const me = await as(member).get('/api/auth/me')
    assert.equal(me.body.user.id, String(mfr._id))            // the company: what orders reference
    assert.equal(me.body.user.actorId, String(member._id))    // the person
    assert.equal(me.body.user.name, 'Merchandiser')
    assert.equal(me.body.user.orgRole, 'member')
    assert.equal(me.body.user.orgType, 'manufacturer')
  })

  test('refreshing the session never turns a teammate into the owner', async () => {
    const mfr = await makeMfr(), member = await makeMember(mfr, { name: 'Merchandiser' })
    let token = tokenFor(member)
    for (let i = 0; i < 3; i++) {
      const me = await req('GET', '/api/auth/me', { token })
      assert.equal(me.status, 200)
      assert.equal(me.body.user.actorId, String(member._id), `refresh ${i + 1}`)
      assert.equal(me.body.user.name, 'Merchandiser')
      token = me.body.token
    }
  })

  test('login returns the same shape as /me for a teammate', async () => {
    const mfr = await makeMfr(), member = await makeMember(mfr)
    const login = await req('POST', '/api/auth/login', { body: { email: member.email, password: TEST_PASSWORD } })
    assert.equal(login.status, 200, JSON.stringify(login.body))
    assert.equal(login.body.user.id, String(mfr._id))
    assert.equal(login.body.user.actorId, String(member._id))
  })

  test('a password change changes the teammate\'s own password, never the owner\'s', async () => {
    const mfr = await makeMfr(), member = await makeMember(mfr)
    const before = (await User.findById(mfr._id).lean()).passwordHash
    const r = await as(member).post('/api/auth/change-password', { currentPassword: TEST_PASSWORD, newPassword: 'Newpass@123' })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.ok(await bcrypt.compare('Newpass@123', (await User.findById(member._id).lean()).passwordHash))
    assert.equal((await User.findById(mfr._id).lean()).passwordHash, before)
  })

  test('a teammate of one company cannot reach another company\'s order', async () => {
    const admin = await makeAdmin(), buyer = await makeBuyer(), mfrA = await makeMfr(), mfrB = await makeMfr()
    const memberA = await makeMember(mfrA)
    await seedOrder(admin, buyer, mfrB, 'ONLY-B')
    assert.equal((await as(memberA).get('/api/orders/ONLY-B')).status, 403)
    assert.equal((await as(memberA).post(`/api/orders/ONLY-B/assignments/${mfrB._id}/stages/0`, { unitsDone: 1 })).status, 403)
  })

  test('a brand teammate sees the brand\'s orders', async () => {
    const admin = await makeAdmin(), buyer = await makeBuyer(), mfr = await makeMfr()
    const member = await makeMember(buyer)
    await seedOrder(admin, buyer, mfr, 'BRAND-1')
    assert.deepEqual((await as(member).get('/api/orders')).body.map(o => o.id), ['BRAND-1'])
  })

  test('teammates share their company\'s code (no duplicate-code error)', async () => {
    const mfr = await makeMfr()
    const a = await makeMember(mfr), b = await makeMember(mfr)
    assert.equal(a.code, mfr.code)
    assert.equal(b.code, mfr.code)
  })
})

describe('deactivating', () => {
  test('an organization signs out everyone on its team at once', async () => {
    const mfr = await makeMfr(), member = await makeMember(mfr)
    assert.equal((await as(member).get('/api/orders')).status, 200)
    await setOrg(mfr, { isActive: false })
    assert.equal((await as(member).get('/api/orders')).status, 401)
    assert.equal((await as(mfr).get('/api/orders')).status, 401)
    const login = await req('POST', '/api/auth/login', { body: { email: member.email, password: TEST_PASSWORD } })
    assert.equal(login.status, 401)
  })

  test('one teammate leaves the rest of the team untouched', async () => {
    const mfr = await makeMfr(), a = await makeMember(mfr), b = await makeMember(mfr)
    await User.updateOne({ _id: a._id }, { $set: { isActive: false } })
    assert.equal((await as(a).get('/api/orders')).status, 401)
    assert.equal((await as(b).get('/api/orders')).status, 200)
    assert.equal((await as(mfr).get('/api/orders')).status, 200)
  })
})
