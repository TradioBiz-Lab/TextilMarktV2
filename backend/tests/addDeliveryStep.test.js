// The migration that gives existing plans their mandatory Delivery step. Runs
// against the in-memory database like every other test, never a real one.

import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'
import mongoose from 'mongoose'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { makeAdmin, makeBuyer, makeMfr } from './helpers/factories.js'
import { Order } from '../src/models/Order.js'
import { planAssignment, run } from '../src/db/addDeliveryStep.js'

before(async () => { await startTestDb() })
after(async () => { await stopTestDb() })
beforeEach(clearDb)

const stage = (name, status = 'not_started', extra = {}) => ({
  name, totalUnits: 1, unitsDone: status === 'done' ? 1 : 0, kind: 'milestone', status,
  startDate: '2026-07-01', baselineEta: '2026-07-15', eta: null, ...extra,
})

// Writes the order straight to the database, the way a plan from before this
// feature looks: no isDelivery anywhere.
async function legacy(id, { stages, status = 'Processing', delivery = '2026-12-20' }) {
  const buyer = await makeBuyer(); const mfr = await makeMfr(); await makeAdmin()
  await Order.collection.insertOne({
    _id: id, buyerId: buyer._id, product: 'Legacy Tee', category: 'TEE', season: 'FW26', totalQty: 100,
    delivery: new Date(delivery), baselineDelivery: new Date(delivery), createdAt: new Date(), updatedAt: new Date(),
    assignments: [{ _id: new mongoose.Types.ObjectId(), mfrId: mfr._id, qty: 100, status, sub: 'M1', note: '', updatedAt: new Date('2026-11-02'), stages }],
  })
}
const stagesOf = async id => (await Order.findById(id).lean()).assignments[0].stages
const statusOf = async id => (await Order.findById(id).lean()).assignments[0].status

describe('planAssignment', () => {
  const order = { delivery: new Date('2026-12-20'), updatedAt: new Date('2026-11-01') }

  test('appends a not-started Delivery step planned for the delivery date', () => {
    const p = planAssignment(order, { status: 'Processing', stages: [stage('Cutting')] })
    assert.equal(p.action, 'add')
    assert.equal(p.stage.status, 'not_started')
    assert.equal(p.stage.baselineEta, '2026-12-20')
    assert.equal(p.stage.isDelivery, true)
    assert.equal(p.reopens, false)
  })

  test('a split that is already Delivered gets the step already done', () => {
    const p = planAssignment(order, { status: 'Delivered', updatedAt: new Date('2026-11-02'), stages: [stage('Cutting', 'done')] })
    assert.equal(p.action, 'add')
    assert.equal(p.stage.status, 'done')
    assert.equal(p.stage.actualEnd, '2026-11-02')
  })

  test('flags a split whose steps are all done but was never marked Delivered as reopening', () => {
    const p = planAssignment(order, { status: 'Processing', stages: [stage('Cutting', 'done'), stage('Dispatch', 'done')] })
    assert.equal(p.reopens, true)
  })

  test('an empty plan just gets the Delivery step', () => {
    const p = planAssignment(order, { status: 'Processing', stages: [] })
    assert.equal(p.action, 'add')
    assert.equal(p.reopens, false)
  })

  test('skips a split that already has a flagged Delivery step', () => {
    assert.equal(planAssignment(order, { stages: [stage('Delivery', 'not_started', { isDelivery: true })] }).action, 'skip')
  })

  test('flags, rather than duplicates, a last step already called Delivery', () => {
    const p = planAssignment(order, { stages: [stage('Cutting'), stage('delivery')] })
    assert.equal(p.action, 'flag')
    assert.equal(p.index, 1)
  })

  test('leaves a Delivery step that is not last for a human', () => {
    assert.equal(planAssignment(order, { stages: [stage('Delivery'), stage('Cutting')] }).action, 'attention')
  })
})

describe('run', () => {
  test('a dry run writes nothing', async () => {
    await legacy('MIG-1', { stages: [stage('Cutting')] })
    const s = await run({ apply: false })
    assert.equal(s.add, 1)
    assert.equal(s.written, 0)
    assert.equal((await stagesOf('MIG-1')).length, 1)
  })

  test('apply appends the step at the end and leaves earlier steps and the status untouched', async () => {
    await legacy('MIG-2', { stages: [stage('Cutting', 'done'), stage('Packing')] })
    const before = await stagesOf('MIG-2')
    const s = await run({ apply: true })
    assert.equal(s.written, 1)
    const after = await stagesOf('MIG-2')
    assert.equal(after.length, 3)
    assert.deepEqual(after.slice(0, 2).map(x => x.name), before.map(x => x.name))
    assert.equal(after[0].status, 'done')
    assert.equal(after[2].name, 'Delivery')
    assert.equal(after[2].isDelivery, true)
    assert.equal(await statusOf('MIG-2'), 'Processing')
  })

  test('a Delivered split gets a done Delivery step and stays Delivered', async () => {
    await legacy('MIG-3', { stages: [stage('Cutting', 'done')], status: 'Delivered' })
    await run({ apply: true })
    const after = await stagesOf('MIG-3')
    assert.equal(after.at(-1).status, 'done')
    assert.equal(await statusOf('MIG-3'), 'Delivered')
  })

  test('flags an existing last Delivery step without adding another', async () => {
    await legacy('MIG-4', { stages: [stage('Cutting'), stage('Delivery')] })
    const s = await run({ apply: true })
    assert.equal(s.flag, 1)
    const after = await stagesOf('MIG-4')
    assert.equal(after.length, 2)
    assert.equal(after[1].isDelivery, true)
  })

  test('running it twice changes nothing the second time', async () => {
    await legacy('MIG-5', { stages: [stage('Cutting')] })
    await run({ apply: true })
    const once = await stagesOf('MIG-5')
    const s = await run({ apply: true })
    assert.equal(s.written, 0)
    assert.equal(s.skip, 1)
    assert.deepEqual(await stagesOf('MIG-5'), once)
  })

  test('reports a split that would reopen and a Delivery step that is out of place', async () => {
    await legacy('MIG-6', { stages: [stage('Cutting', 'done')] })
    await legacy('MIG-7', { stages: [stage('Delivery'), stage('Cutting')] })
    const s = await run({ apply: false })
    assert.equal(s.reopens.length, 1)
    assert.equal(s.attention.length, 1)
  })
})
