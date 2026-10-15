// The one email a customer's action sends: an escalation, to every active master admin. A factory's expiring certificate
// is an in-app alert only.

import test, { before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as } from './helpers/client.js'
import { makeMaster, makeBuyer, makeMfr, orderPayload } from './helpers/factories.js'
import { setMailerForTests } from '../src/lib/email.js'
import { Notification } from '../src/models/Notification.js'
import { Document } from '../src/models/Document.js'

before(async () => { await startTestDb(); await startServer() })
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(clearDb)
let sent = []
beforeEach(() => { sent = []; setMailerForTests({ emails: { send: async m => { sent.push(m); return { data: { id: 'x' }, error: null } } } }) })
afterEach(() => setMailerForTests(null))

test('a customer escalates its own style: the masters are told in the app and by email', async () => {
  const m1 = await makeMaster({ email: 'm1@tradio.test' }); await makeMaster({ email: 'm2@tradio.test' })
  const buyer = await makeBuyer(); const other = await makeBuyer(); const mfr = await makeMfr()
  assert.equal((await as(m1).post('/api/orders', orderPayload({ id: 'ESC-001', buyerId: buyer._id, mfrId: mfr._id }))).status, 201)
  const r = await as(buyer).post('/api/orders/ESC-001/escalate', { reason: 'Fabric is late and nobody has said why' })
  assert.deepEqual(r.body, { ok: true, notified: 2, emailed: true })
  await new Promise(res => setTimeout(res, 20))
  assert.deepEqual(sent.map(m => m.to[0]).sort(), ['m1@tradio.test', 'm2@tradio.test'])
  assert.match(sent[0].subject, /ESCALATION: Order ESC-001/)
  assert.equal(await Notification.countDocuments({ type: 'alert', orderId: 'ESC-001' }), 2)
  assert.equal((await as(other).post('/api/orders/ESC-001/escalate', { reason: 'x' })).status, 403)
  assert.equal((await as(mfr).post('/api/orders/ESC-001/escalate', { reason: 'x' })).status, 403)
})

test("a factory's expiring certificate is an in-app alert, never an email", async () => {
  const master = await makeMaster(); const mfr = await makeMfr()
  await Document.create({ type: 'compliance_cert', name: 'BSCI', mfrId: mfr._id, uploadedBy: master._id, expiryDate: new Date(Date.now() + 5 * 86400000), dataUrl: 'data:application/pdf;base64,JVBERg==' })
  assert.equal((await as(master).post('/api/documents/cert-expiry-check', {})).status, 200)
  await new Promise(res => setTimeout(res, 20))
  assert.equal(sent.length, 0)
  assert.ok(await Notification.exists({ toUser: mfr._id, type: 'alert' }))
})
