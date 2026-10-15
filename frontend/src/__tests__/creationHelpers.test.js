import { describe, test, expect } from 'vitest'
import { seasonsFor, sameStyleIdIn, siblingStepNames, stepNameWarning, SEASONS } from '../constants.js'

describe('seasonsFor', () => {
  test("a customer's own list, else the standard one; the value already on a record stays listed", () => {
    expect(seasonsFor({ seasons: ['H1', 'H2'] })).toEqual(['H1', 'H2'])
    expect(seasonsFor({ seasons: [] })).toEqual(SEASONS)
    expect(seasonsFor(null, 'SS26')).toEqual(SEASONS)
    expect(seasonsFor({ seasons: ['H2'] }, 'H1')).toEqual(['H2', 'H1'])
  })
})

describe('sameStyleIdIn', () => {
  const orders = [
    { id: 'A', masterOrderId: 'MO-1', product: 'Tee', styleNumber: 'FL-01' },
    { id: 'B', masterOrderId: 'MO-2', product: 'Polo', styleNumber: 'FL-02' },
  ]
  test('finds the same id (any case) in the same master order only, never the style itself', () => {
    expect(sameStyleIdIn(orders, { masterOrderId: 'MO-1', styleNumber: ' fl-01 ' })?.product).toBe('Tee')
    expect(sameStyleIdIn(orders, { masterOrderId: 'MO-1', styleNumber: 'FL-02' })).toBe(null)
    expect(sameStyleIdIn(orders, { masterOrderId: 'MO-1', styleNumber: 'FL-01', exceptId: 'A' })).toBe(null)
    expect(sameStyleIdIn(orders, { masterOrderId: 'MO-1', styleNumber: '' })).toBe(null)
  })
})

describe('step names across a master order', () => {
  const orders = [
    { id: 'A', masterOrderId: 'MO-1', assignments: [{ stages: [{ name: 'Lab Dip Approval' }, { name: 'Cutting' }, { name: 'Delivery', isDelivery: true }] }] },
    { id: 'B', masterOrderId: 'MO-1', assignments: [] },
  ]
  test('the other styles\' names, without Delivery', () => {
    expect(siblingStepNames(orders, orders[1]).sort()).toEqual(['Cutting', 'Lab Dip Approval'])
    expect(siblingStepNames(orders, { id: 'C', masterOrderId: null })).toEqual([])
  })
  test('a spelling variant names the step the others use; a matching name or no siblings gives no warning', () => {
    const names = ['Lab Dip Approval', 'Cutting']
    expect(stepNameWarning('lab dip approval', names)).toBe(null)
    expect(stepNameWarning('Lab Dip Aproval', names)).toMatch(/call it "Lab Dip Approval"/)
    expect(stepNameWarning('Embroidery', names)).toMatch(/No other style/)
    expect(stepNameWarning('Anything', [])).toBe(null)
  })
})
