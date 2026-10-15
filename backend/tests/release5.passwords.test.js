// Getting back in: a person asks for a reset link (one use, 30 minutes, the same answer for unknown emails), Tradio's own
// reset hands over the temporary password when it cannot be emailed, and the masters manage each other with one always active.

import test, { before, after, beforeEach, afterEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as, req } from './helpers/client.js'
import { makeMaster, makeBuyer } from './helpers/factories.js'
import { setMailerForTests } from '../src/lib/email.js'
import { User } from '../src/models/User.js'

before(async () => { await startTestDb(); await startServer() })
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(clearDb)

let sent = []
const fakeMailer = { emails: { send: async m => { sent.push(m); return { data: { id: 'x' }, error: null } } } }
afterEach(() => setMailerForTests(null))
const tokenFrom = m => decodeURIComponent(/[?&]reset=([^"&]+)/.exec(m.html)[1])

describe('forgotten password', () => {
  test('a known email gets a one-use link; an unknown one gets the same answer and nothing is sent', async () => {
    setMailerForTests(fakeMailer); sent = []
    const buyer = await makeBuyer({ email: 'ana@brand.test' })
    const a = await req('POST', '/api/auth/forgot-password', { body: { email: 'ANA@brand.test ' } })
    const b = await req('POST', '/api/auth/forgot-password', { body: { email: 'nobody@brand.test' } })
    assert.deepEqual([a.status, a.body], [200, { ok: true, emailEnabled: true }])
    assert.deepEqual(b.body, a.body)
    await new Promise(r => setTimeout(r, 20))
    assert.equal(sent.length, 1)
    assert.deepEqual(sent[0].to, ['ana@brand.test'])
    const token = tokenFrom(sent[0])
    assert.notEqual((await User.findById(buyer._id).lean()).resetTokenHash, token)   // only a hash is kept

    assert.equal((await req('POST', '/api/auth/reset-password', { body: { token, password: 'weak' } })).status, 400)
    assert.equal((await req('POST', '/api/auth/reset-password', { body: { token, password: 'New@Pass123' } })).status, 200)
    assert.equal((await req('POST', '/api/auth/reset-password', { body: { token, password: 'New@Pass456' } })).status, 400)   // used up
    assert.equal((await req('POST', '/api/auth/login', { body: { email: 'ana@brand.test', password: 'New@Pass123' } })).status, 200)
  })

  test('an expired link does not work, and an inactive account gets no link', async () => {
    setMailerForTests(fakeMailer); sent = []
    const buyer = await makeBuyer({ email: 'old@brand.test' })
    await req('POST', '/api/auth/forgot-password', { body: { email: 'old@brand.test' } })
    await new Promise(r => setTimeout(r, 20))
    await User.updateOne({ _id: buyer._id }, { $set: { resetTokenExpires: new Date(Date.now() - 1000) } })
    assert.equal((await req('POST', '/api/auth/reset-password', { body: { token: tokenFrom(sent[0]), password: 'New@Pass123' } })).status, 400)
    await makeBuyer({ email: 'gone@brand.test', isActive: false })
    sent = []
    await req('POST', '/api/auth/forgot-password', { body: { email: 'gone@brand.test' } })
    await new Promise(r => setTimeout(r, 20))
    assert.equal(sent.length, 0)
  })

  test('with no email set up the answer says so', async () => {
    await makeBuyer({ email: 'ana@brand.test' })
    const r = await req('POST', '/api/auth/forgot-password', { body: { email: 'ana@brand.test' } })
    assert.deepEqual(r.body, { ok: true, emailEnabled: false })
  })
})

describe("Tradio's reset", () => {
  test('hands the master the temporary password only when it cannot be emailed', async () => {
    const master = await makeMaster(); const buyer = await makeBuyer()
    const noMail = await as(master).post(`/api/users/${buyer._id}/reset-password`, {})
    assert.equal(noMail.body.emailed, false)
    assert.match(noMail.body.tempPassword, /^.{14}$/)
    setMailerForTests(fakeMailer); sent = []
    const mailed = await as(master).post(`/api/users/${buyer._id}/reset-password`, {})
    assert.deepEqual(mailed.body, { ok: true, emailed: true })
    assert.equal(sent.length, 1)
  })
})

describe('master admins', () => {
  test('manage each other, but one always stays active and nobody switches off their own account', async () => {
    const a = await makeMaster(); const b = await makeMaster()
    assert.equal((await as(a).post(`/api/users/${a._id}/toggle`, {})).status, 400)
    const off = await as(a).post(`/api/users/${b._id}/toggle`, {})
    assert.equal(off.status, 200); assert.equal(off.body.isActive, false)
    assert.equal((await as(a).post(`/api/users/${b._id}/toggle`, {})).body.isActive, true)
    assert.equal((await as(a).post(`/api/users/${b._id}`, { name: 'Renamed master' })).body.name, 'Renamed master')
  })
})
