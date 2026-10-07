// Cross-user notifications are created by the server when the change is saved, and the
// audit entries for order creation and user management are written by the server too.

import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as } from './helpers/client.js'
import { makeMaster, makeAdmin, makeBuyer, makeMfr, orderPayload } from './helpers/factories.js'
import { Notification } from '../src/models/Notification.js'
import { AuditLog } from '../src/models/AuditLog.js'

before(async () => { await startTestDb(); await startServer() })
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(clearDb)

const ORDER_ID = 'NTF-TEST-001'

async function arrange() {
  const master = await makeMaster()
  const otherAdmin = await makeAdmin()
  const buyer = await makeBuyer()
  const mfr = await makeMfr()
  const res = await as(master).post('/api/orders', orderPayload({
    id: ORDER_ID, buyerId: buyer._id, mfrId: mfr._id, stageNames: ['Cutting'],
    stageStartDates: ['2026-07-01'], stageEtas: ['2026-07-10'],
  }))
  assert.equal(res.status, 201, JSON.stringify(res.body))
  await Notification.deleteMany({}) // creation notifications are tested separately
  const base = `/api/orders/${ORDER_ID}/assignments/${mfr._id}`
  const inbox = async user => (await Notification.find({ toUser: user._id }).lean()).map(n => n.msg)
  return { master, otherAdmin, buyer, mfr, base, inbox, m: as(mfr), a: as(master) }
}

describe('stage and status notifications', () => {
  test('a manufacturer update notifies the buyer and every admin, not the manufacturer', async () => {
    const { master, otherAdmin, buyer, mfr, base, inbox, m } = await arrange()
    assert.equal((await m.post(`${base}/stages/0`, { note: 'started cutting' })).status, 200)
    for (const who of [buyer, master, otherAdmin])
      assert.ok((await inbox(who)).some(x => x.includes('Production update')), `${who.role} should be told`)
    assert.deepEqual(await inbox(mfr), [])
  })

  test('an admin update notifies the buyer only', async () => {
    const { master, otherAdmin, buyer, base, inbox, a } = await arrange()
    assert.equal((await a.post(`${base}/stages/0`, { note: 'checked' })).status, 200)
    assert.equal((await inbox(buyer)).length, 1)
    assert.deepEqual(await inbox(master), [])
    assert.deepEqual(await inbox(otherAdmin), [])
  })

  test('an admin status change tells the buyer and the manufacturer', async () => {
    const { buyer, mfr, base, inbox, a } = await arrange()
    assert.equal((await a.post(base, { status: 'On Hold', note: 'fabric delay' })).status, 200)
    assert.ok((await inbox(buyer)).some(x => x.includes('On Hold')))
    assert.ok((await inbox(mfr)).some(x => x.includes('Your order')))
  })

  test('a manufacturer status change tells the buyer and admins', async () => {
    const { master, buyer, base, inbox, m } = await arrange()
    assert.equal((await m.post(base, { status: 'Delayed' })).status, 200)
    assert.ok((await inbox(buyer)).some(x => x.includes('Delayed')))
    assert.ok((await inbox(master)).some(x => x.includes('Delayed')))
  })
})

describe('document and order notifications', () => {
  test('a manufacturer upload tells the buyer and admins, not the uploader', async () => {
    const { master, buyer, mfr, inbox, m } = await arrange()
    const res = await m.post('/api/documents', { type: 'tech_pack', name: 'Spec v2', externalUrl: 'https://example.com/s', orderId: ORDER_ID })
    assert.equal(res.status, 201, JSON.stringify(res.body))
    assert.ok((await inbox(buyer)).some(x => x.includes('Spec v2')))
    assert.ok((await inbox(master)).some(x => x.includes('Spec v2')))
    assert.deepEqual(await inbox(mfr), [])
  })

  test('creating an order tells the buyer and the manufacturer, and is audited by the server', async () => {
    const master = await makeMaster()
    const buyer = await makeBuyer()
    const mfr = await makeMfr()
    const res = await as(master).post('/api/orders', orderPayload({ id: 'NTF-NEW-001', buyerId: buyer._id, mfrId: mfr._id }))
    assert.equal(res.status, 201, JSON.stringify(res.body))
    const msgs = async u => (await Notification.find({ toUser: u._id }).lean()).map(n => n.msg)
    assert.ok((await msgs(buyer)).some(x => x.includes('New order created')))
    assert.ok((await msgs(mfr)).some(x => x.includes('assigned to you')))
    assert.deepEqual(await msgs(master), [])
    assert.equal(await AuditLog.countDocuments({ action: 'Order Created', detail: /NTF-NEW-001/ }), 1)
  })
})

describe('user management is audited by the server', () => {
  test('create, update, deactivate, reactivate and reset each leave one entry, never a password', async () => {
    const master = await makeMaster()
    const api = as(master)
    const created = await api.post('/api/users', {
      email: 'new.buyer@test.local', name: 'New Buyer', company: 'Acme Retail', role: 'buyer', code: 'ACM', password: 'Str0ng!Passw0rd',
    })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const id = created.body.id
    assert.equal((await api.post(`/api/users/${id}`, { name: 'New Buyer Two' })).status, 200)
    assert.equal((await api.post(`/api/users/${id}/toggle`, {})).status, 200)
    assert.equal((await api.post(`/api/users/${id}/toggle`, {})).status, 200)
    assert.equal((await api.post(`/api/users/${id}/reset-password`, {})).status, 200)

    for (const action of ['User Created', 'User Updated', 'User Deactivated', 'User Activated', 'Password Reset'])
      assert.equal(await AuditLog.countDocuments({ action }), 1, action)
    const all = (await AuditLog.find({}).lean()).map(x => x.detail).join('\n')
    assert.ok(!all.includes('Str0ng!Passw0rd'), 'no password in the log')
  })
})

describe('audit paging', () => {
  test('the list reports the true total and honours skip and limit', async () => {
    const master = await makeMaster()
    for (let i = 0; i < 5; i++) await AuditLog.create({ byUser: master._id, action: 'Test', detail: `n${i}` })
    const page = await as(master).get('/api/audit?limit=2&skip=1')
    assert.equal(page.status, 200)
    assert.equal(page.body.total, 5)
    assert.equal(page.body.items.length, 2)
  })
})
