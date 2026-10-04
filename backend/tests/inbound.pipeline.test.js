import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as } from './helpers/client.js'
import { makeAdmin, makeBuyer, makeMfr, orderPayload } from './helpers/factories.js'
import { DEFAULT_STAGE_NAMES, Order } from '../src/models/Order.js'
import { InboundMessage } from '../src/models/InboundMessage.js'
import { Document } from '../src/models/Document.js'

let ingestMessage, setPipelineDeps
before(async () => {
  await startTestDb()
  await startServer()
  ;({ ingestMessage, setPipelineDeps } = await import('../src/lib/inbound/pipeline.js'))
})
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(clearDb)

async function arrange({ orders = 1 } = {}) {
  const admin = await makeAdmin()
  const buyer = await makeBuyer()
  const mfr = await makeMfr()
  mfr.whatsappNumber = '+91 98765 43210'; await mfr.save()
  const master = (await import('./helpers/factories.js')).makeMaster
  const m = await master()
  const ids = []
  for (let i = 0; i < orders; i++) {
    const id = `INB-TEST-00${i + 1}`
    const r = await as(m).post('/api/orders', orderPayload({ id, buyerId: buyer._id, mfrId: mfr._id, product: i ? 'Cava Polo' : 'Cava Tee', styleNumber: i ? 'POLO-02' : 'TEE-01', stageNames: DEFAULT_STAGE_NAMES }))
    assert.equal(r.status, 201, JSON.stringify(r.body))
    ids.push(id)
  }
  return { admin, buyer, mfr, ids }
}

const photo = (o = {}) => ({ extractPhoto: async () => ({ stage: 'cutting', confidence: 0.92, issues: [], description: 'cutting table', style_hint: null, ...o }) })
const stageOf = async (id, name) => (await Order.findById(id).lean()).assignments[0].stages.find(s => s.name === name)
const img = { channel: 'web', type: 'image', buffer: Buffer.from('x'), mimeType: 'image/jpeg' }

describe('ingestMessage', () => {
  test('confident cutting photo marks Cutting done and keeps raw media + parsed JSON', async () => {
    const { mfr, ids } = await arrange()
    const msg = await ingestMessage({ ...img, factoryId: mfr._id }, photo())
    assert.equal(msg.state, 'auto_applied')
    assert.equal((await stageOf(ids[0], 'Cutting')).status, 'done')
    const saved = await InboundMessage.findById(msg._id).lean()
    assert.ok(saved.dataUrl.startsWith('data:image/jpeg;base64,'))
    assert.equal(saved.parsed.stage, 'cutting')
    // Evidence is filed against the exact TNA stage, not a separate surface.
    const ev = await Document.find({ sourceMessageId: msg._id }).lean()
    assert.equal(ev.length, 1)
    assert.equal(ev[0].type, 'floor_evidence')
    assert.equal(ev[0].orderId, ids[0])
    assert.equal(ev[0].stageIndex, DEFAULT_STAGE_NAMES.indexOf('Cutting'))
    assert.equal(String(ev[0].mfrId), String(mfr._id))
    assert.ok(ev[0].dataUrl.startsWith('data:image/jpeg'))
  })

  test('low confidence never changes the order', async () => {
    const { mfr, ids } = await arrange()
    const msg = await ingestMessage({ ...img, factoryId: mfr._id }, photo({ confidence: 0.5 }))
    assert.equal(msg.state, 'needs_review')
    assert.notEqual((await stageOf(ids[0], 'Cutting')).status, 'done')
    assert.equal(await Document.countDocuments({ sourceMessageId: msg._id }), 0)   // no evidence until a human approves
  })

  test('unmatched with two active orders goes to review, nothing written', async () => {
    const { mfr, ids } = await arrange({ orders: 2 })
    const msg = await ingestMessage({ ...img, factoryId: mfr._id }, photo())
    assert.equal(msg.state, 'needs_review')
    assert.notEqual((await stageOf(ids[0], 'Cutting')).status, 'done')
    assert.notEqual((await stageOf(ids[1], 'Cutting')).status, 'done')
  })

  test('style hint resolves the order among several', async () => {
    const { mfr, ids } = await arrange({ orders: 2 })
    const msg = await ingestMessage({ ...img, factoryId: mfr._id }, photo({ style_hint: 'POLO-02' }))
    assert.equal(msg.state, 'auto_applied')
    assert.equal((await stageOf(ids[1], 'Cutting')).status, 'done')
  })

  test('defect flags the stage blocked and always lands in review', async () => {
    const { mfr, ids } = await arrange()
    const msg = await ingestMessage({ ...img, factoryId: mfr._id }, photo({ stage: 'fabric_inspected', issues: ['shade variation'] }))
    assert.equal(msg.state, 'needs_review')
    const s = await stageOf(ids[0], 'Material Sourcing')
    assert.equal(s.blocked, true)
    assert.match(s.blockedReason, /shade/)
  })

  test('unknown sender is stored and sent to review', async () => {
    await arrange()
    const msg = await ingestMessage({ channel: 'whatsapp', senderNumber: '+910000000000', type: 'text', text: 'cutting ho gaya' }, {})
    assert.equal(msg.state, 'needs_review')
    assert.equal(msg.factoryId, null)
  })

  test('Hindi voice note: cutting done, stitching in progress', async () => {
    const { mfr, ids } = await arrange()
    const msg = await ingestMessage({ channel: 'web', type: 'audio', factoryId: mfr._id, buffer: Buffer.from('a'), mimeType: 'audio/webm' }, {
      transcribeAudio: async () => ({ transcript: 'cutting ho gaya, kal stitching start' }),
      extractText: async () => ({ confidence: 0.9, updates: [
        { style_hint: null, stage: 'cutting', status: 'done', expected_date: null, note: '' },
        { style_hint: null, stage: 'stitching', status: 'in_progress', expected_date: null, note: '' },
      ] }),
    })
    assert.equal(msg.state, 'auto_applied')
    assert.equal(msg.rawText, 'cutting ho gaya, kal stitching start')
    assert.equal((await stageOf(ids[0], 'Cutting')).status, 'done')
    assert.equal((await stageOf(ids[0], 'Stitching')).status, 'in_progress')
  })

  test('challan implies Dispatch done', async () => {
    const { mfr, ids } = await arrange()
    const msg = await ingestMessage({ channel: 'web', type: 'document', factoryId: mfr._id, buffer: Buffer.from('d'), mimeType: 'application/pdf' }, {
      extractDocument: async () => ({ doc_type: 'challan', date: '2026-10-01', style_codes: ['TEE-01'], items: [], implied_stage: 'dispatched', confidence: 0.9 }),
    })
    assert.equal(msg.state, 'auto_applied')
    assert.equal((await stageOf(ids[0], 'Dispatch')).status, 'done')
  })

  test('AI failure (null parse) goes to review', async () => {
    const { mfr } = await arrange()
    const msg = await ingestMessage({ ...img, factoryId: mfr._id }, { extractPhoto: async () => null })
    assert.equal(msg.state, 'needs_review')
  })
})

describe('review + webhook + feed routes', () => {
  test('reject reverts what the AI wrote; correct applies the coordinator choice', async () => {
    const { admin, mfr, ids } = await arrange()
    const m1 = await ingestMessage({ ...img, factoryId: mfr._id }, photo({ stage: 'fabric_inspected', issues: ['stain'] }))
    assert.equal((await stageOf(ids[0], 'Material Sourcing')).blocked, true)
    const rej = await as(admin).post(`/api/review/${m1._id}/reject`, {})
    assert.equal(rej.status, 200)
    assert.equal((await stageOf(ids[0], 'Material Sourcing')).blocked, false)
    assert.equal(await Document.countDocuments({ sourceMessageId: m1._id, isActive: true }), 0)   // evidence retracted

    const m2 = await ingestMessage({ ...img, factoryId: mfr._id }, photo({ confidence: 0.3 }))
    const q = await as(admin).get('/api/review/queue')
    assert.equal(q.body.length, 1)
    const cor = await as(admin).post(`/api/review/${m2._id}/correct`, { orderId: ids[0], stage: 'Stitching', status: 'in_progress' })
    assert.equal(cor.status, 200, JSON.stringify(cor.body))
    assert.equal((await stageOf(ids[0], 'Stitching')).status, 'in_progress')
    const ev = await Document.findOne({ sourceMessageId: m2._id, isActive: true }).lean()
    assert.equal(ev.stageIndex, DEFAULT_STAGE_NAMES.indexOf('Stitching'))
    assert.equal((await as(admin).get('/api/review/queue')).body.length, 0)
  })

  test('webhook needs the secret, then runs the same pipeline', async () => {
    const { mfr } = await arrange()
    const { startServer: s } = await import('./helpers/client.js')
    const base = await s()
    process.env.INBOUND_WEBHOOK_SECRET = 'sekret'
    setPipelineDeps({ extractText: async () => ({ confidence: 0.9, updates: [{ style_hint: null, stage: 'cutting', status: 'done', expected_date: null, note: '' }] }) })
    const post = (headers, body) => fetch(`${base}/api/inbound/webhook/mock`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
    const body = { sender_number: '919876543210', type: 'text', text: 'cutting ho gaya' }
    assert.equal((await post({}, body)).status, 401)
    const ok = await post({ 'x-webhook-secret': 'sekret' }, body)
    assert.equal(ok.status, 200)
    const saved = await InboundMessage.findOne({ channel: 'whatsapp' }).lean()
    assert.equal(String(saved.factoryId), String(mfr._id))   // sender matched by number
    assert.equal((await post({ 'x-webhook-secret': 'sekret' }, { type: 'text' })).status, 400)
    assert.equal(saved.state, 'auto_applied')
    setPipelineDeps({})
    delete process.env.INBOUND_WEBHOOK_SECRET
  })

  test('buyer feed is scoped to the buyer\'s own orders', async () => {
    const { buyer, mfr } = await arrange()
    await ingestMessage({ ...img, factoryId: mfr._id }, photo())
    const other = await makeBuyer()
    assert.equal((await as(buyer).get('/api/floor/feed')).body.items.length, 1)
    assert.equal((await as(other).get('/api/floor/feed')).body.items.length, 0)
  })
})
