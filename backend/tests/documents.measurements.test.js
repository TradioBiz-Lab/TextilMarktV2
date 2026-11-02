// Measurement sheets carry a label (Customer Submission, Fit Approval, PP Approval), and a master admin can lock one as the
// style's Locked Measurement. Nobody else can lock; a locked sheet cannot be replaced, relabelled or deleted.

import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as } from './helpers/client.js'
import { makeMaster, makeAdmin, makeBuyer, makeMfr, orderPayload } from './helpers/factories.js'
import { Document } from '../src/models/Document.js'
import { Notification } from '../src/models/Notification.js'
import { AuditLog } from '../src/models/AuditLog.js'

before(async () => { await startTestDb(); await startServer() })
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(clearDb)

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const sheet = (name = 'spec.xlsx') => ({ dataUrl: `data:${XLSX};base64,${Buffer.from('PK spec').toString('base64')}`, fileName: name, mimeType: XLSX })
const ORDER_ID = 'MEAS-001'

async function arrange() {
  const master = await makeMaster(); const other = await makeAdmin(); const buyer = await makeBuyer(); const mfr = await makeMfr()
  const res = await as(master).post('/api/orders', orderPayload({ id: ORDER_ID, buyerId: buyer._id, mfrId: mfr._id }))
  assert.equal(res.status, 201, JSON.stringify(res.body))
  const up = (who, extra = {}) => as(who).post('/api/documents', { type: 'measurements', name: 'Measurements, MEAS-001', orderId: ORDER_ID, ...sheet(), ...extra })
  return { master, other, buyer, mfr, up }
}

describe('the label on a measurement sheet', () => {
  test('is required on upload, and has to be one of the three', async () => {
    const { master, buyer, up } = await arrange()
    for (const who of [master, buyer]) {
      assert.equal((await up(who)).status, 400)
      assert.equal((await up(who, { measurementLabel: '' })).status, 400)
      assert.equal((await up(who, { measurementLabel: 'final' })).status, 400)
    }
    for (const label of ['customer_submission', 'fit_approval', 'pp_approval']) {
      const r = await up(buyer, { measurementLabel: label })
      assert.equal(r.status, 201, JSON.stringify(r.body))
      assert.equal(r.body.measurementLabel, label)
      assert.equal(r.body.locked, false, 'nothing is locked on upload')
    }
  })

  test('belongs to measurement sheets only', async () => {
    const { master } = await arrange()
    const r = await as(master).post('/api/documents', { type: 'tech_pack', name: 'Tech pack', orderId: ORDER_ID, ...sheet(), measurementLabel: 'fit_approval' })
    assert.equal(r.status, 400)
    assert.equal((await as(master).post('/api/documents', { type: 'tech_pack', name: 'Tech pack', orderId: ORDER_ID, ...sheet() })).status, 201)
  })

  test('can be corrected by the uploader or Tradio, and is listed with the sheet', async () => {
    const { master, buyer, mfr, up } = await arrange()
    const id = (await up(buyer, { measurementLabel: 'customer_submission' })).body.id
    const fixed = await as(buyer).post(`/api/documents/${id}`, { measurementLabel: 'fit_approval' })
    assert.equal(fixed.status, 200, JSON.stringify(fixed.body))
    assert.equal(fixed.body.measurementLabel, 'fit_approval')
    assert.equal((await as(master).post(`/api/documents/${id}`, { measurementLabel: 'nonsense' })).status, 400)
    assert.equal((await as(mfr).post(`/api/documents/${id}`, { measurementLabel: 'pp_approval' })).status, 403)
    const listed = (await as(mfr).get('/api/documents')).body.find(d => d.id === id)
    assert.equal(listed.measurementLabel, 'fit_approval')
    assert.equal(listed.locked, false)
  })
})

describe('the Locked Measurement', () => {
  test('only a master admin can lock or unlock', async () => {
    const { master, other, buyer, mfr, up } = await arrange()
    const id = (await up(master, { measurementLabel: 'fit_approval' })).body.id
    for (const who of [other, buyer, mfr]) assert.equal((await as(who).post(`/api/documents/${id}/lock`, { locked: true })).status, 403)
    assert.equal((await Document.findById(id).lean()).locked, false)
    const r = await as(master).post(`/api/documents/${id}/lock`, { locked: true })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.locked, true)
    for (const who of [other, buyer, mfr]) assert.equal((await as(who).post(`/api/documents/${id}/lock`, { locked: false })).status, 403)
    assert.equal((await Document.findById(id).lean()).locked, true)
    assert.equal((await as(master).post(`/api/documents/${id}/lock`, { locked: false })).body.locked, false)
  })

  test('is one per style: locking another sheet moves the lock', async () => {
    const { master, up } = await arrange()
    const a = (await up(master, { measurementLabel: 'customer_submission' })).body.id
    const b = (await up(master, { measurementLabel: 'pp_approval' })).body.id
    await as(master).post(`/api/documents/${a}/lock`, { locked: true })
    const moved = await as(master).post(`/api/documents/${b}/lock`, { locked: true })
    assert.equal(moved.status, 200)
    assert.deepEqual([(await Document.findById(a).lean()).locked, (await Document.findById(b).lean()).locked], [false, true])
    assert.equal(await Document.countDocuments({ orderId: ORDER_ID, locked: true }), 1)
  })

  test('a locked sheet cannot be replaced, relabelled or deleted until it is unlocked; its name can still be fixed', async () => {
    const { master, buyer, up } = await arrange()
    const id = (await up(buyer, { measurementLabel: 'fit_approval' })).body.id
    await as(master).post(`/api/documents/${id}/lock`, { locked: true })
    assert.equal((await as(buyer).post(`/api/documents/${id}`, { ...sheet('new.xlsx') })).status, 409)
    assert.equal((await as(master).post(`/api/documents/${id}`, { ...sheet('new.xlsx') })).status, 409)
    assert.equal((await as(buyer).post(`/api/documents/${id}`, { measurementLabel: 'pp_approval' })).status, 409)
    assert.equal((await as(buyer).post(`/api/documents/${id}`, { externalUrl: 'https://drive.example.com/x' })).status, 409)
    assert.equal((await as(buyer).post(`/api/documents/${id}/delete`)).status, 409)
    assert.equal((await as(master).post(`/api/documents/${id}/delete`)).status, 409)
    assert.equal((await as(buyer).post(`/api/documents/${id}`, { name: 'Measurements, FYL-1' })).status, 200)
    await as(master).post(`/api/documents/${id}/lock`, { locked: false })
    assert.equal((await as(buyer).post(`/api/documents/${id}`, { ...sheet('new.xlsx') })).status, 200)
    assert.equal((await as(buyer).post(`/api/documents/${id}/delete`)).status, 200)
  })

  test('refused for anything that is not a labelled measurement sheet on a style', async () => {
    const { master, up } = await arrange()
    const tech = (await as(master).post('/api/documents', { type: 'tech_pack', name: 'Tech pack', orderId: ORDER_ID, ...sheet() })).body.id
    assert.equal((await as(master).post(`/api/documents/${tech}/lock`, { locked: true })).status, 400)
    // a sheet filed before labels existed has none: it needs one first
    const old = await Document.create({ type: 'measurements', name: 'old', orderId: ORDER_ID, uploadedBy: master._id, ...sheet() })
    const r = await as(master).post(`/api/documents/${old._id}/lock`, { locked: true })
    assert.equal(r.status, 400)
    assert.match(r.body.error, /label/)
    assert.equal((await as(master).post(`/api/documents/${tech}/lock`, {})).status, 400)
    assert.equal((await as(master).post('/api/documents/64b000000000000000000000/lock', { locked: true })).status, 404)
    void up
  })

  test('is recorded and the customer and admins are told; the old file of a replaced sheet is never locked', async () => {
    const { master, other, buyer, up } = await arrange()
    const id = (await up(buyer, { measurementLabel: 'pp_approval' })).body.id
    await as(master).post(`/api/documents/${id}/lock`, { locked: true })
    assert.equal(await AuditLog.countDocuments({ action: 'Measurement Locked' }), 1)
    assert.equal(await Notification.countDocuments({ toUser: buyer._id, msg: /Locked Measurement/ }), 1)
    assert.equal(await Notification.countDocuments({ toUser: other._id, msg: /Locked Measurement/ }), 1)
    await as(master).post(`/api/documents/${id}/lock`, { locked: false })
    assert.equal(await AuditLog.countDocuments({ action: 'Measurement Unlocked' }), 1)
    await as(master).post(`/api/documents/${id}/lock`, { locked: true })
    await as(master).post(`/api/documents/${id}/lock`, { locked: false })
    await as(buyer).post(`/api/documents/${id}`, { ...sheet('v2.xlsx') })
    assert.equal(await Document.countDocuments({ orderId: ORDER_ID, locked: true }), 0)
  })
})
