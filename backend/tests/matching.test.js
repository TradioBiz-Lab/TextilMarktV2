import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { mapStageIndex, matchOrder, gateChange } from '../src/lib/inbound/matching.js'
import { DEFAULT_STAGE_NAMES } from '../src/models/Order.js'

const stages = (statuses = {}) => DEFAULT_STAGE_NAMES.map((name, i) => ({ name, status: statuses[i] || 'not_started' }))

describe('mapStageIndex', () => {
  test('maps the 9 AI stages onto the 12-stage TNA', () => {
    const s = stages()
    assert.equal(s[mapStageIndex('cutting', s)].name, 'Cutting')
    assert.equal(s[mapStageIndex('stitching', s)].name, 'Stitching')
    assert.equal(s[mapStageIndex('qc', s)].name, 'QC')
    assert.equal(s[mapStageIndex('dispatched', s)].name, 'Dispatch')
    assert.equal(s[mapStageIndex('fabric_received', s)].name, 'Material Sourcing')
    assert.equal(mapStageIndex('unknown', s), -1)
  })
})

describe('matchOrder', () => {
  const orders = [
    { id: 'A-1', styleNumber: 'CAVA-TEE-01', product: 'Cava Tee' },
    { id: 'A-2', styleNumber: 'CAVA-POLO-02', product: 'Cava Polo' },
  ]
  test('exact style code', () => assert.equal(matchOrder(['cava tee 01'], orders).orderId, 'A-1'))
  test('single active order is used without a hint', () => assert.equal(matchOrder([], [orders[0]]).orderId, 'A-1'))
  test('ambiguous goes to review with candidates', () => {
    const r = matchOrder([], orders)
    assert.equal(r.orderId, null)
    assert.deepEqual(r.candidates, ['A-1', 'A-2'])
  })
  test('too-short hints never match', () => assert.equal(matchOrder(['a'], orders).orderId, null))
})

describe('gateChange', () => {
  test('applies when confident, forward and clean', () => {
    assert.equal(gateChange({ confidence: 0.9, stageIndex: 6, status: 'done', stages: stages({ 5: 'done' }), defect: false }).ok, true)
  })
  test('low confidence is held', () => {
    assert.equal(gateChange({ confidence: 0.79, stageIndex: 6, status: 'done', stages: stages(), defect: false }).ok, false)
  })
  test('defect always held', () => {
    assert.equal(gateChange({ confidence: 0.99, stageIndex: 6, status: 'done', stages: stages(), defect: true }).ok, false)
  })
  test('never moves a done stage backwards', () => {
    assert.equal(gateChange({ confidence: 0.99, stageIndex: 6, status: 'in_progress', stages: stages({ 6: 'done' }), defect: false }).ok, false)
  })
  test('earlier unstarted stage after later work started is held', () => {
    assert.equal(gateChange({ confidence: 0.99, stageIndex: 6, status: 'done', stages: stages({ 7: 'in_progress' }), defect: false }).ok, false)
  })
  test('same status is a no-op, not a rewrite', () => {
    const g = gateChange({ confidence: 0.99, stageIndex: 6, status: 'done', stages: stages({ 6: 'done' }), defect: false })
    assert.deepEqual([g.ok, g.noop], [true, true])
  })
  test('missing stage is held', () => assert.equal(gateChange({ confidence: 0.99, stageIndex: -1, status: 'done', stages: stages(), defect: false }).ok, false))
})
