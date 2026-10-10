// Changing the manufacturer of a split: the plan stays, ownership moves, and the guards hold.

import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as } from './helpers/client.js'
import { makeAdmin, makeMaster, makeBuyer, makeMfr, orderPayload } from './helpers/factories.js'
import { Order } from '../src/models/Order.js'
import { Document } from '../src/models/Document.js'
import { Notification } from '../src/models/Notification.js'
import { AuditLog } from '../src/models/AuditLog.js'

before(async () => { await startTestDb(); await startServer() })
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(clearDb)

const ORDER_ID = 'RAS-TEST-001'

async function arrange() {
  const master = await makeMaster()
  const buyer = await makeBuyer()
  const oldMfr = await makeMfr({ company: 'Old Mills' })
  const newMfr = await makeMfr({ company: 'New Mills' })
  const res = await as(master).post('/api/orders', orderPayload({
    id: ORDER_ID, buyerId: buyer._id, mfrId: oldMfr._id, totalQty: 100, stageNames: ['Cutting', 'Stitching'],
    stageStartDates: ['2026-07-01', '2026-07-10'], stageEtas: ['2026-07-09', '2026-07-20'],
  }))
  assert.equal(res.status, 201, JSON.stringify(res.body))
  const url = `/api/orders/${ORDER_ID}/assignments/${oldMfr._id}/reassign`
  return { master, buyer, oldMfr, newMfr, url, api: as(master) }
}

const asgnOf = async () => (await Order.findById(ORDER_ID).lean()).assignments

describe('reassigning a split to another manufacturer', () => {
  test('moves ownership but keeps the plan, progress and the split label', async () => {
    const { oldMfr, newMfr, url, api, master } = await arrange()
    // Cutting is the old manufacturer's, Stitching is an admin's: only the first should move.
    await Order.updateOne({ _id: ORDER_ID }, { $set: {
      'assignments.0.stages.0.responsibleId': oldMfr._id, 'assignments.0.stages.0.status': 'in_progress', 'assignments.0.stages.0.unitsDone': 40,
      'assignments.0.stages.1.responsibleId': master._id,
    } })
    const before = (await asgnOf())[0]

    const res = await api.post(url, { newMfrId: String(newMfr._id) })
    assert.equal(res.status, 200, JSON.stringify(res.body))

    const [a] = await asgnOf()
    assert.equal(String(a.mfrId), String(newMfr._id))
    assert.equal(a.sub, before.sub)
    assert.equal(a.qty, before.qty)
    assert.equal(a.stages.length, 3) // two steps plus the mandatory Delivery step
    assert.equal(a.stages[0].unitsDone, 40)
    assert.equal(a.stages[0].status, 'in_progress')
    assert.equal(String(a.stages[0].responsibleId), String(newMfr._id), 'the old manufacturer\'s step moves with the split')
    assert.equal(String(a.stages[1].responsibleId), String(master._id), 'an admin\'s step stays with the admin')
  })

  test('the new manufacturer gains access and the old one loses it', async () => {
    const { oldMfr, newMfr, url, api } = await arrange()
    assert.equal((await as(oldMfr).get(`/api/orders/${ORDER_ID}`)).status, 200)
    assert.equal((await api.post(url, { newMfrId: String(newMfr._id) })).status, 200)
    assert.equal((await as(newMfr).get(`/api/orders/${ORDER_ID}`)).status, 200)
    assert.notEqual((await as(oldMfr).get(`/api/orders/${ORDER_ID}`)).status, 200)
  })

  test('the split\'s documents follow it, other orders\' do not', async () => {
    const { oldMfr, newMfr, master, url, api } = await arrange()
    await Document.create([
      { type: 'material_po', name: 'PO for this style', orderId: ORDER_ID, mfrId: oldMfr._id, uploadedBy: master._id, stageIndex: 0 },
      { type: 'mfr_profile', name: 'Old Mills profile', orderId: null, mfrId: oldMfr._id, uploadedBy: master._id },
    ])
    assert.equal((await api.post(url, { newMfrId: String(newMfr._id) })).status, 200)
    assert.equal(String((await Document.findOne({ name: 'PO for this style' })).mfrId), String(newMfr._id))
    assert.equal(String((await Document.findOne({ name: 'Old Mills profile' })).mfrId), String(oldMfr._id), 'a manufacturer\'s own profile stays theirs')
  })

  test('can change the quantity in the same step', async () => {
    const { newMfr, url, api } = await arrange()
    assert.equal((await api.post(url, { newMfrId: String(newMfr._id), qty: 80 })).status, 200)
    assert.equal((await asgnOf())[0].qty, 80)
  })

  test('records the change and tells both manufacturers', async () => {
    const { oldMfr, newMfr, url, api } = await arrange()
    await Notification.deleteMany({})
    assert.equal((await api.post(url, { newMfrId: String(newMfr._id) })).status, 200)
    const log = await AuditLog.findOne({ action: 'Manufacturer Reassigned' }).lean()
    assert.match(log.detail, /Old Mills to New Mills/)
    const mine = async u => (await Notification.find({ toUser: u._id }).lean()).map(n => n.msg)
    assert.ok((await mine(newMfr)).some(m => m.includes('assigned to you')))
    assert.ok((await mine(oldMfr)).some(m => m.includes('reassigned to another manufacturer')))
  })
})

describe('reassignment guards', () => {
  test('only an admin may do it', async () => {
    const { oldMfr, buyer, newMfr, url } = await arrange()
    for (const who of [oldMfr, buyer, newMfr])
      assert.equal((await as(who).post(url, { newMfrId: String(newMfr._id) })).status, 403)
    assert.equal(String((await asgnOf())[0].mfrId), String(oldMfr._id))
  })

  test('rejects the same manufacturer, one already on the order, inactive and non-manufacturers', async () => {
    const { oldMfr, newMfr, buyer, url, api } = await arrange()
    assert.equal((await api.post(url, { newMfrId: String(oldMfr._id) })).status, 400)
    assert.equal((await api.post(url, { newMfrId: String(buyer._id) })).status, 400)
    assert.equal((await api.post(url, {})).status, 400)
    const inactive = await makeMfr({ isActive: false })
    assert.equal((await api.post(url, { newMfrId: String(inactive._id) })).status, 400)

    // Add the second manufacturer as another split, then try to hand the first split to them.
    assert.equal((await api.post(`/api/orders/${ORDER_ID}/assignments`, { mfrId: String(newMfr._id), qty: 10 })).status, 201)
    const dup = await api.post(url, { newMfrId: String(newMfr._id) })
    assert.equal(dup.status, 400)
    assert.match(dup.body.error, /already assigned/)
    assert.equal(String((await asgnOf())[0].mfrId), String(oldMfr._id))
  })

  test('rejects a bad quantity and a delivered split', async () => {
    const { newMfr, url, api } = await arrange()
    for (const qty of [0, -5, 2.5, 'abc'])
      assert.equal((await api.post(url, { newMfrId: String(newMfr._id), qty })).status, 400, `qty ${qty}`)
    await Order.updateOne({ _id: ORDER_ID }, { $set: { 'assignments.0.status': 'Delivered' } })
    const res = await api.post(url, { newMfrId: String(newMfr._id) })
    assert.equal(res.status, 400)
    assert.match(res.body.error, /already delivered/)
  })

  test('404s for an unknown order or split', async () => {
    const { newMfr, oldMfr, api } = await arrange()
    assert.equal((await api.post(`/api/orders/NOPE/assignments/${oldMfr._id}/reassign`, { newMfrId: String(newMfr._id) })).status, 404)
    assert.equal((await api.post(`/api/orders/${ORDER_ID}/assignments/${newMfr._id}/reassign`, { newMfrId: String(oldMfr._id) })).status, 404)
  })
})
