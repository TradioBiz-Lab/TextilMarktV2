import { describe, test, expect } from 'vitest'
import { evidenceTypesFor, productDocForStep, DEFAULT_STAGE_NAMES } from '../constants.js'

const plan = names => names.map(name => ({ name }))
const cocoblu = plan(['Fit Sample/Fabric (Resampling)', 'Trims Order', 'Lab Dip/Cutting to be shared', 'Lab Dip Receipt', 'NB Approval (Lab Dip)', 'Greige Fabric (Inhouse)', 'Dyeing Start', 'Final Fabric Ready (Inhouse)', 'FPT Sent', 'PP +Fit Sample Sent', 'GPT Sent', 'FPT Approval', 'PP Approval', 'GPT Approval', 'Production Start', 'Inspection', 'Delivery'])
const typeAt = (stages, name) => evidenceTypesFor(stages.findIndex(s => s.name === name), stages)

describe('evidence on lab dip and test steps is also the product document', () => {
  test('every lab dip step files as a lab dip receipt', () => {
    for (const n of ['Lab Dip/Cutting to be shared', 'Lab Dip Receipt', 'NB Approval (Lab Dip)'])
      expect(typeAt(cocoblu, n)).toEqual([expect.objectContaining({ v: 'lab_dip', l: 'Lab Dip Receipt' })])
  })

  test('every FPT and GPT step files as a test report', () => {
    for (const n of ['FPT Sent', 'GPT Sent', 'FPT Approval', 'GPT Approval'])
      expect(typeAt(cocoblu, n)).toEqual([expect.objectContaining({ v: 'test_report', l: 'Test Report' })])
  })

  test('other steps keep the generic type, so nothing else changes', () => {
    for (const n of ['Greige Fabric (Inhouse)', 'Dyeing Start', 'PP +Fit Sample Sent', 'PP Approval', 'Inspection', 'Delivery'])
      expect(typeAt(cocoblu, n)[0].v).toBe('floor_evidence')
  })

  test('the standard plan\'s Lab Dip Approval step files as a lab dip too, its other steps are untouched', () => {
    const std = plan(DEFAULT_STAGE_NAMES)
    expect(typeAt(std, 'Lab Dip Approval')[0].v).toBe('lab_dip')
    expect(typeAt(std, 'Cutting')[0].v).toBe('cutting_qc')
    expect(typeAt(std, 'PP Sample')[0].v).toBe('floor_evidence')
  })

  test('step names are matched loosely but not by accident', () => {
    expect(productDocForStep('  lab   dip approval ')?.type).toBe('lab_dip')
    expect(productDocForStep('fpt/gpt tests')?.type).toBe('test_report')
    expect(productDocForStep('Gptx')).toBeNull()
    expect(productDocForStep('Dip dyeing')).toBeNull()
    expect(productDocForStep(undefined)).toBeNull()
  })
})

describe('stageNameForDoc', () => {
  const stages = ['Trims Order', 'Lab Dip Receipt', 'FPT Sent', 'FPT Approval', 'GPT Approval', 'Delivery'].map(name => ({ name }))
  const orders = [
    { id: 'O-1', assignments: [{ mid: 'm1', stages }] },
    { id: 'O-2', assignments: [{ mid: 'a', stages: plan(['One', 'Two']) }, { mid: 'b', stages: plan(['Cut', 'Sew']) }] },
  ]
  const doc = (over = {}) => ({ orderId: 'O-1', mfrId: 'm1', stageIndex: 3, ...over })

  test('names the step from the order\'s own plan, not the standard 13-step list', async () => {
    const { stageNameForDoc } = await import('../constants.js')
    expect(stageNameForDoc(orders, doc())).toBe('FPT Approval')
    expect(stageNameForDoc(orders, doc({ stageIndex: 4 }))).toBe('GPT Approval')
  })

  test('finds the right manufacturer\'s plan on a split order, and the only plan when no manufacturer is set', async () => {
    const { stageNameForDoc } = await import('../constants.js')
    expect(stageNameForDoc(orders, { orderId: 'O-2', mfrId: 'b', stageIndex: 1 })).toBe('Sew')
    expect(stageNameForDoc(orders, { orderId: 'O-2', mfrId: null, stageIndex: 1 })).toBeNull()
    expect(stageNameForDoc(orders, { orderId: 'O-1', mfrId: null, stageIndex: 5 })).toBe('Delivery')
  })

  test('nothing for a document with no step, an unknown order or a step past the end', async () => {
    const { stageNameForDoc } = await import('../constants.js')
    expect(stageNameForDoc(orders, { orderId: 'O-1', stageIndex: null })).toBeNull()
    expect(stageNameForDoc(orders, doc({ orderId: 'NOPE' }))).toBeNull()
    expect(stageNameForDoc(orders, doc({ stageIndex: 99 }))).toBeNull()
  })
})
