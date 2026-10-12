// Organization management: companies, their teams, who they are connected with, and the two
// Tradio switches. Master admin manages companies; a company's owner alone controls its privacy.
import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as, req, tokenFor } from './helpers/client.js'
import { makeAdmin, makeMaster, makeBuyer, makeMfr, makeMember, setOrg, link } from './helpers/factories.js'
import { User } from '../src/models/User.js'
import { Organization } from '../src/models/Organization.js'
import { Partnership } from '../src/models/Partnership.js'

before(async () => { await startTestDb(); await startServer() })
after(async () => { delete process.env.PLATFORM_MODE; await stopServer(); await stopTestDb() })
beforeEach(async () => { await clearDb(); delete process.env.PLATFORM_MODE })

const newCompany = (o = {}) => ({ type: 'manufacturer', company: 'Tiruppur Textiles', code: 'tpr', owner: { name: 'Raj Kumar', email: 'raj@tiruppur.test' }, ...o })

describe('creating a company', () => {
  test('creates the organization and its owner; the code is upper-cased and the owner must change the temporary password', async () => {
    const master = await makeMaster()
    const r = await as(master).post('/api/orgs', newCompany({ tradioEnabled: true }))
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.equal(r.body.code, 'TPR')
    assert.equal(r.body.type, 'manufacturer')
    assert.equal(r.body.tradioEnabled, true)
    assert.equal(r.body.members.length, 1)
    const owner = await User.findOne({ email: 'raj@tiruppur.test' }).lean()
    assert.equal(owner.role, 'manufacturer')
    assert.equal(owner.orgRole, 'owner')
    assert.equal(owner.mustChangePw, true)
    assert.equal(String(owner._id), r.body.ownerUserId)
  })

  test('a brand gets a brand organization, and Tradio can be enabled only for manufacturers', async () => {
    const master = await makeMaster()
    const r = await as(master).post('/api/orgs', newCompany({ type: 'brand', company: 'Zara India', code: 'ZAR', tradioEnabled: true, owner: { name: 'S', email: 's@zara.test' } }))
    assert.equal(r.status, 201)
    assert.equal(r.body.tradioEnabled, false)
    assert.equal((await as(master).post(`/api/orgs/${r.body.id}`, { tradioEnabled: true })).status, 400)
  })

  test('refuses a duplicate code or email, a bad code, a bad type', async () => {
    const master = await makeMaster()
    assert.equal((await as(master).post('/api/orgs', newCompany())).status, 201)
    assert.equal((await as(master).post('/api/orgs', newCompany({ owner: { name: 'X', email: 'other@x.test' } }))).status, 409)
    assert.equal((await as(master).post('/api/orgs', newCompany({ code: 'NEW', owner: { name: 'X', email: 'raj@tiruppur.test' } }))).status, 409)
    assert.equal((await as(master).post('/api/orgs', newCompany({ code: 'AB', owner: { name: 'X', email: 'a@x.test' } }))).status, 400)
    assert.equal((await as(master).post('/api/orgs', newCompany({ type: 'tradio' }))).status, 400)
  })

  test('a code already used by an account that predates organizations counts as taken', async () => {
    const master = await makeMaster()
    await makeMfr({ code: 'OLD' })
    assert.equal((await as(master).post('/api/orgs', newCompany({ code: 'OLD' }))).status, 409)
  })

  test('only the master admin creates companies; any admin can list them; companies cannot', async () => {
    const admin = await makeAdmin(), buyer = await makeBuyer(), mfr = await makeMfr()
    assert.equal((await as(admin).post('/api/orgs', newCompany())).status, 403)
    assert.equal((await as(buyer).post('/api/orgs', newCompany())).status, 403)
    assert.equal((await as(admin).get('/api/orgs')).status, 200)
    assert.equal((await as(buyer).get('/api/orgs')).status, 403)
    assert.equal((await as(mfr).get('/api/orgs')).status, 403)
  })
})

describe('teams', () => {
  test('adding a teammate gives them the company\'s code and name, and they act as the company', async () => {
    const master = await makeMaster(), mfr = await makeMfr({ company: 'Tiruppur Textiles', code: 'TPR' })
    const org = (await as(master).get('/api/orgs')).body.find(o => o.ownerUserId === String(mfr._id))
    const r = await as(master).post(`/api/orgs/${org.id}/members`, { name: 'Store Keeper', email: 'store@tiruppur.test' })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.equal(r.body.members.length, 2)
    const member = await User.findOne({ email: 'store@tiruppur.test' }).lean()
    assert.deepEqual([member.code, member.company, member.orgRole, member.role], ['TPR', 'Tiruppur Textiles', 'member', 'manufacturer'])
    const me = await req('GET', '/api/auth/me', { token: tokenFor(member) })
    assert.equal(me.body.user.id, String(mfr._id))
    assert.equal((await as(master).post(`/api/orgs/${org.id}/members`, { name: 'Dup', email: 'store@tiruppur.test' })).status, 409)
  })

  test('a company sees its own team, and a teammate sees the same company', async () => {
    const mfr = await makeMfr(), member = await makeMember(mfr)
    const a = (await as(mfr).get('/api/orgs/me')).body, b = (await as(member).get('/api/orgs/me')).body
    assert.equal(a.id, b.id)
    assert.equal(a.members.length, 2)
  })

  test('the primary account cannot be deactivated while teammates remain; the whole company can', async () => {
    const master = await makeMaster(), mfr = await makeMfr(), member = await makeMember(mfr)
    const blocked = await as(master).post(`/api/users/${mfr._id}/toggle`, {})
    assert.equal(blocked.status, 400)
    assert.match(blocked.body.error, /primary account/)
    const org = (await as(master).get('/api/orgs')).body.find(o => o.ownerUserId === String(mfr._id))
    assert.equal((await as(master).post(`/api/orgs/${org.id}`, { isActive: false })).status, 200)
    assert.equal((await as(member).get('/api/orders')).status, 401)
    assert.equal((await as(mfr).get('/api/orders')).status, 401)
  })

  test('creating a buyer or manufacturer through the users route creates its organization too', async () => {
    const master = await makeMaster()
    const r = await as(master).post('/api/users', { email: 'new@x.test', password: 'Newpass@123', role: 'manufacturer', company: 'New Mills', name: 'N', code: 'NEW', tradioEnabled: true })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    const org = await Organization.findOne({ code: 'NEW' }).lean()
    assert.equal(org.tradioEnabled, true)
    assert.equal(r.body.orgRole, 'owner')
    assert.equal((await as(master).post('/api/users', { email: 'n2@x.test', password: 'Newpass@123', role: 'buyer', company: 'Clash', name: 'N', code: 'NEW' })).status, 409)
  })
})

describe('connections', () => {
  const orgOf = async (master, user) => (await as(master).get('/api/orgs')).body.find(o => o.ownerUserId === String(user._id))

  test('Tradio connects a brand and a manufacturer, either way round, and can disconnect them', async () => {
    const master = await makeMaster(), brand = await makeBuyer(), mfr = await makeMfr()
    const b = await orgOf(master, brand), m = await orgOf(master, mfr)
    assert.equal((await as(master).post(`/api/orgs/${m.id}/partners`, { partnerOrgId: b.id })).status, 200)
    assert.equal(await Partnership.countDocuments({ status: 'active' }), 1)
    assert.deepEqual((await as(brand).get('/api/partners')).body.map(p => p.id), [String(mfr._id)])
    assert.equal((await as(master).post(`/api/orgs/${b.id}/partners/${m.id}/revoke`, {})).status, 200)
    assert.deepEqual((await as(brand).get('/api/partners')).body, [])
    assert.equal((await as(master).post(`/api/orgs/${b.id}/partners/${m.id}/revoke`, {})).status, 404)
  })

  test('two brands, or two manufacturers, cannot be connected', async () => {
    const master = await makeMaster(), a = await makeBuyer(), b = await makeBuyer()
    const oa = await orgOf(master, a), ob = await orgOf(master, b)
    assert.equal((await as(master).post(`/api/orgs/${oa.id}/partners`, { partnerOrgId: ob.id })).status, 400)
  })

  test('once disconnected, neither side can create a new order for the other', async () => {
    process.env.PLATFORM_MODE = 'standalone'
    const master = await makeMaster(), brand = await makeBuyer(), mfr = await makeMfr()
    await link(brand, mfr)
    const make = () => as(mfr).post('/api/orders', { buyerId: String(brand._id), product: 'T', category: 'TSHRT', season: 'FW26', totalQty: 10, delivery: '2026-12-31' })
    assert.equal((await make()).status, 201)
    const b = await orgOf(master, brand), m = await orgOf(master, mfr)
    await as(master).post(`/api/orgs/${b.id}/partners/${m.id}/revoke`, {})
    const again = await make()
    assert.equal(again.status, 403)
    assert.equal(again.body.code, 'NOT_CONNECTED')
  })

  test('only the master admin manages connections', async () => {
    const admin = await makeAdmin(), brand = await makeBuyer(), mfr = await makeMfr()
    await setOrg(brand, {}); await setOrg(mfr, {})
    const orgs = await Organization.find().lean()
    assert.equal((await as(admin).post(`/api/orgs/${orgs[0]._id}/partners`, { partnerOrgId: String(orgs[1]._id) })).status, 403)
    assert.equal((await as(brand).post(`/api/orgs/${orgs[0]._id}/partners`, { partnerOrgId: String(orgs[1]._id) })).status, 403)
  })
})
