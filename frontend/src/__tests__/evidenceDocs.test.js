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
