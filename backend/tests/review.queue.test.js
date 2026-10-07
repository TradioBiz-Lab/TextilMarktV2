// The coordinator's review queue: approve / correct / reject act on a message exactly once, never
// erase work done since the AI's update, never leave a message half-processed, and confirming the
// Delivery step marks the split Delivered.

import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as } from './helpers/client.js'
import { makeMaster, makeBuyer, makeMfr, orderPayload } from './helpers/factories.js'
import { Order } from '../src/models/Order.js'
import { InboundMessage } from '../src/models/InboundMessage.js'
import { applyStageChange } from '../src/lib/inbound/applyStage.js'

before(async () => { await startTestDb(); await startServer() })
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(clearDb)

const ORDER_ID = 'REV-TEST-001'

async function arrange() {
  const master = await makeMaster()
  const buyer = await makeBuyer()
  const mfr = await makeMfr()
  const api = as(master)
  const res = await api.post('/api/orders', orderPayload({
    id: ORDER_ID, buyerId: buyer._id, mfrId: mfr._id, stageNames: ['Cutting', 'Sewing'],
    stageStartDates: ['2026-07-01', '2026-07-05'], stageEtas: ['2026-07-03', '2026-07-10'],
  }))
  assert.equal(res.status, 201, JSON.stringify(res.body))
  const asgn = async () => (await Order.findById(ORDER_ID).lean()).assignments[0]
  const stage = async name => (await asgn()).stages.find(s => s.name === name)
  const message = (extra = {}) => InboundMessage.create({
    channel: 'web', type: 'text', state: 'needs_review', factoryId: mfr._id, orderId: ORDER_ID,
    rawText: 'cutting done', reviewReason: 'test', ...extra,
  })
  // A message whose AI write has already been applied, the way the pipeline leaves it.
  const withAiChange = async name => {
    const idx = (await asgn()).stages.findIndex(s => s.name === name)
    const r = await applyStageChange({ orderId: ORDER_ID, mfrId: mfr._id, stageIndex: idx, status: 'done' })
    return message({ stageApplied: name, changes: [{ orderId: ORDER_ID, mfrId: mfr._id, stageIndex: idx, stageName: name, before: r.before, after: r.after }] })
  }
  return { master, mfr, api, asgn, stage, message, withAiChange, mfrApi: as(mfr) }
}

describe('Delivery step', () => {
  test('correcting a message onto Delivery closes the step and marks the split Delivered', async () => {
    const { api, asgn, message } = await arrange()
    const msg = await message()
    const r = await api.post(`/api/review/${msg._id}/correct`, { orderId: ORDER_ID, stage: 'Delivery', status: 'done' })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const a = await asgn()
    assert.equal(a.stages.find(s => s.isDelivery).status, 'done')
    assert.equal(a.status, 'Delivered')
  })

  test('rejecting that message puts the split back to Processing', async () => {
    const { api, asgn, message, mfr } = await arrange()
    const msg = await message()
    assert.equal((await api.post(`/api/review/${msg._id}/correct`, { orderId: ORDER_ID, stage: 'Delivery', status: 'done' })).status, 200)
    // Correcting finished the message, so make a fresh one that carries the same change.
    const done = await InboundMessage.findById(msg._id).lean()
    const again = await InboundMessage.create({ channel: 'web', type: 'text', state: 'needs_review', factoryId: mfr._id, orderId: ORDER_ID, rawText: 'x', changes: done.changes })
    const r = await api.post(`/api/review/${again._id}/reject`, {})
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const a = await asgn()
    assert.equal(a.stages.find(s => s.isDelivery).status, 'not_started')
    assert.equal(a.status, 'Processing')
  })
})

describe('reverting', () => {
  test('reject undoes the AI update when nothing has changed since', async () => {
    const { api, stage, withAiChange } = await arrange()
    const msg = await withAiChange('Cutting')
    assert.equal((await stage('Cutting')).status, 'done')
    const r = await api.post(`/api/review/${msg._id}/reject`, {})
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.warnings, undefined)
    assert.equal((await stage('Cutting')).status, 'not_started')
  })

  test('reject leaves a stage alone that was updated after the AI, and says so', async () => {
    const { api, mfrApi, mfr, stage, withAiChange } = await arrange()
    const msg = await withAiChange('Cutting')
    const base = `/api/orders/${ORDER_ID}/assignments/${mfr._id}`
    assert.equal((await mfrApi.post(`${base}/stages/0`, { note: 'manufacturer edited this after the AI' })).status, 200)
    const r = await api.post(`/api/review/${msg._id}/reject`, {})
    assert.equal(r.status, 200)
    assert.match(r.body.warnings?.[0] || '', /Cutting/)
    const s = await stage('Cutting')
    assert.equal(s.note, 'manufacturer edited this after the AI')
    assert.equal(s.status, 'done')
    assert.equal((await InboundMessage.findById(msg._id).lean()).state, 'rejected')
  })
})

describe('correct', () => {
  test('a bad target leaves the AI update and the message untouched', async () => {
    const { api, stage, withAiChange } = await arrange()
    const msg = await withAiChange('Cutting')
    const r = await api.post(`/api/review/${msg._id}/correct`, { orderId: ORDER_ID, stage: 'No Such Stage', status: 'done' })
    assert.equal(r.status, 400)
    assert.equal((await stage('Cutting')).status, 'done', 'the AI update was not reverted')
    const saved = await InboundMessage.findById(msg._id).lean()
    assert.equal(saved.state, 'needs_review', 'handed back to the queue')
    assert.equal(saved.changes.length, 1)
  })

  test('moves the update from the AI guess to the coordinator pick', async () => {
    const { api, stage, withAiChange } = await arrange()
    const msg = await withAiChange('Cutting')
    const r = await api.post(`/api/review/${msg._id}/correct`, { orderId: ORDER_ID, stage: 'Sewing', status: 'in_progress' })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal((await stage('Cutting')).status, 'not_started')
    assert.equal((await stage('Sewing')).status, 'in_progress')
  })
})

describe('two admins at once', () => {
  test('only one approve of the same message goes through', async () => {
    const { api, message, stage } = await arrange()
    const msg = await message({ parsed: { stage: 'Cutting', updates: [{ stage: 'Cutting', status: 'done' }] } })
    const rs = await Promise.all([api.post(`/api/review/${msg._id}/approve`, {}), api.post(`/api/review/${msg._id}/approve`, {})])
    assert.deepEqual(rs.map(r => r.status).sort(), [200, 404], JSON.stringify(rs.map(r => r.body)))
    const saved = await InboundMessage.findById(msg._id).lean()
    assert.equal(saved.state, 'applied')
    assert.equal(saved.changes.length, 1, 'applied once')
    assert.equal((await stage('Cutting')).status, 'done')
  })

  test('a malformed id is a 404, not a hang', async () => {
    const { api } = await arrange()
    assert.equal((await api.post('/api/review/not-an-id/approve', {})).status, 404)
  })
})
