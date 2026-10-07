// Auth hardening: the database decides who a user is, temporary passwords are enforced by the
// server, sessions have a hard end, login answers do not reveal which accounts exist, and the
// request log never carries a body's values.

import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'
import jwt from 'jsonwebtoken'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as, req, tokenFor } from './helpers/client.js'
import { makeMaster, makeAdmin, makeBuyer, makeMfr, TEST_PASSWORD } from './helpers/factories.js'
import { User } from '../src/models/User.js'
import { AuditLog } from '../src/models/AuditLog.js'
import { redact } from '../src/lib/redact.js'

before(async () => { await startTestDb(); await startServer() })
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(clearDb)

const login = (email, password) => req('POST', '/api/auth/login', { body: { email, password } })

describe('the database is the authority on who a user is', () => {
  test('a demoted admin loses admin access on the next request, even with an old token', async () => {
    const master = await makeMaster()
    const api = as(master) // token minted while still master
    assert.equal((await api.get('/api/users')).status, 200)
    await User.updateOne({ _id: master._id }, { $set: { role: 'buyer', adminType: null } })
    assert.equal((await api.get('/api/users')).status, 403)
  })

  test('a deactivated user is locked out at once', async () => {
    const buyer = await makeBuyer()
    const api = as(buyer)
    assert.equal((await api.get('/api/orders')).status, 200)
    await User.updateOne({ _id: buyer._id }, { $set: { isActive: false } })
    assert.equal((await api.get('/api/orders')).status, 401)
  })
})

describe('temporary passwords are enforced by the server', () => {
  test('a user who must change their password can reach nothing else', async () => {
    const mfr = await makeMfr()
    await User.updateOne({ _id: mfr._id }, { $set: { mustChangePw: true } })
    const api = as(mfr)
    const blocked = await api.get('/api/orders')
    assert.equal(blocked.status, 403)
    assert.equal(blocked.body.code, 'MUST_CHANGE_PW')
    assert.equal((await api.get('/api/auth/me')).status, 200, 'can still restore the session')
    // Reaches the handler (a wrong current password is a 400), so the gate let it through.
    assert.equal((await api.post('/api/auth/change-password', { currentPassword: 'wrong', newPassword: 'N3w!Passw0rd' })).status, 400)
  })

  test('changing it lifts the restriction', async () => {
    const mfr = await makeMfr()
    await User.updateOne({ _id: mfr._id }, { $set: { mustChangePw: true } })
    const done = await as(mfr).post('/api/auth/change-password', { currentPassword: TEST_PASSWORD, newPassword: 'N3w!Passw0rd' })
    assert.equal(done.status, 200, JSON.stringify(done.body))
    await new Promise(r => setTimeout(r, 1100)) // the old token is invalidated by the change
    const again = await login(mfr.email, 'N3w!Passw0rd')
    assert.equal(again.status, 200)
    assert.equal((await req('GET', '/api/orders', { token: again.body.token })).status, 200)
  })
})

describe('sessions', () => {
  test('/me refuses to extend a session past its absolute lifetime', async () => {
    const buyer = await makeBuyer()
    const long = jwt.sign({ id: String(buyer._id), role: 'buyer', oiat: Math.floor(Date.now() / 1000) - 13 * 3600 }, process.env.JWT_SECRET, { expiresIn: '60m' })
    assert.equal((await req('GET', '/api/auth/me', { token: long })).status, 401)
    const fresh = jwt.sign({ id: String(buyer._id), role: 'buyer', oiat: Math.floor(Date.now() / 1000) - 3600 }, process.env.JWT_SECRET, { expiresIn: '60m' })
    const ok = await req('GET', '/api/auth/me', { token: fresh })
    assert.equal(ok.status, 200)
    const carried = jwt.decode(ok.body.token)
    assert.ok(carried.oiat <= Math.floor(Date.now() / 1000) - 3600 + 2, 'the original start time is carried forward')
  })

  test('/me reports the database role, not the token claim', async () => {
    const buyer = await makeBuyer()
    const forged = jwt.sign({ id: String(buyer._id), role: 'admin', adminType: 'master' }, process.env.JWT_SECRET, { expiresIn: '60m' })
    const r = await req('GET', '/api/auth/me', { token: forged })
    assert.equal(r.status, 200)
    assert.equal(r.body.user.role, 'buyer')
    assert.equal((await req('GET', '/api/users', { token: forged })).status, 403)
  })
})

describe('login does not reveal which accounts exist', () => {
  test('unknown email, wrong password and a deactivated account all answer the same', async () => {
    const buyer = await makeBuyer()
    const gone = await makeBuyer()
    await User.updateOne({ _id: gone._id }, { $set: { isActive: false } })
    const answers = [
      await login('nobody@test.local', 'whatever'),
      await login(buyer.email, 'wrong-password'),
      await login(gone.email, TEST_PASSWORD), // right password, deactivated
    ]
    assert.deepEqual(answers.map(a => a.status), [401, 401, 401])
    assert.equal(new Set(answers.map(a => JSON.stringify(a.body))).size, 1)
    assert.equal((await login(buyer.email, TEST_PASSWORD)).status, 200, 'a correct login still works')
  })

  test('a long unknown email is capped before it reaches the audit log', async () => {
    const r = await login(`${'a'.repeat(200)}@test.local`, 'x')
    assert.equal(r.status, 401)
    const entry = await AuditLog.findOne({ action: 'Login Failed' }).lean()
    assert.ok(entry.detail.length < 140, `detail was ${entry.detail.length} chars`)
  })

  test('the login endpoint rejects an oversized body', async () => {
    const r = await req('POST', '/api/auth/login', { body: { email: 'a@b.c', password: 'x'.repeat(200 * 1024) } })
    assert.equal(r.status, 413)
  })
})

describe('the audit log cannot be written by a client', () => {
  test('POST /api/audit does not exist', async () => {
    const admin = await makeAdmin()
    const r = await as(admin).post('/api/audit', { action: 'Fake Entry', detail: 'forged' })
    assert.ok([404, 405].includes(r.status), `status ${r.status}`)
    assert.equal(await AuditLog.countDocuments({ action: 'Fake Entry' }), 0)
  })
})

describe('request logging', () => {
  test('describes a body without printing its values', () => {
    const out = redact({
      email: 'someone@test.local', phone: '+91 98765 43210', password: 'hunter2',
      dataUrl: `data:application/pdf;base64,${'A'.repeat(5000)}`, notes: 'private note',
      items: [1, 2, 3], nested: { a: 1 }, orderId: 'ORD-1', status: 'done', count: 3,
    })
    assert.equal(out.password, '[REDACTED]')
    assert.equal(out.email, `string(${'someone@test.local'.length})`)
    assert.equal(out.phone, `string(${'+91 98765 43210'.length})`)
    assert.equal(out.notes, `string(${'private note'.length})`)
    assert.match(out.dataUrl, /^string\(\d+\)$/)
    assert.equal(out.items, 'array(3)')
    assert.equal(out.nested, 'object(1 keys)')
    assert.equal(out.orderId, 'ORD-1')
    assert.equal(out.status, 'done')
    assert.equal(out.count, 'number')
    const text = JSON.stringify(out)
    for (const secret of ['someone@test.local', '98765', 'hunter2', 'private note', 'AAAA']) assert.ok(!text.includes(secret), secret)
  })
})

describe('uploads are checked against their content', () => {
  const doc = (dataUrl, extra = {}) => ({ type: 'tech_pack', name: 'Spec', dataUrl, fileName: 'spec.pdf', mimeType: 'application/pdf', ...extra })
  const b64 = s => Buffer.from(s, 'latin1').toString('base64')

  test('a PDF must start like a PDF', async () => {
    const admin = await makeMaster()
    const api = as(admin)
    assert.equal((await api.post('/api/documents', doc(`data:application/pdf;base64,${b64('<html><script>alert(1)</script>')}`))).status, 400)
    assert.equal((await api.post('/api/documents', doc(`data:application/pdf;base64,${b64('%PDF-1.4\n1 0 obj\n')}`))).status, 201)
  })

  test('an image must start like its declared type', async () => {
    const admin = await makeMaster()
    const api = as(admin)
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64')
    const fake = (type) => doc(`data:${type};base64,${b64('GIF89a not really')}`, { fileName: 'a.png', mimeType: type })
    assert.equal((await api.post('/api/documents', fake('image/png'))).status, 400)
    assert.equal((await api.post('/api/documents', doc(`data:image/png;base64,${png}`, { fileName: 'a.png', mimeType: 'image/png' }))).status, 201)
  })
})
