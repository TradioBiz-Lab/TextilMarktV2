import { describe, test, expect } from 'vitest'
import { defaultStepOwner, stepOwnerOptions } from '../constants.js'

const order = { buyerId: 'B1' }
const users = [
  { id: 'B1', role: 'buyer', company: 'Konexx' }, { id: 'B2', role: 'buyer', company: 'Other brand' },
  { id: 'A1', role: 'admin', name: 'Ankit' },
  { id: 'M1', role: 'manufacturer', company: 'Fibrewear' }, { id: 'M2', role: 'manufacturer', company: 'Elsewhere' },
]

describe('defaultStepOwner', () => {
  test('approvals go to the customer, Tradio steps stay open, the rest is the split factory', () => {
    expect(defaultStepOwner('Lab Dip Approval', order, 'M1')).toBe('B1')
    expect(defaultStepOwner('Fit Sample Approved', order, 'M1')).toBe('B1')
    expect(defaultStepOwner('Inspection', order, 'M1')).toBe(null)
    expect(defaultStepOwner('Manufacturer Matching', order, 'M1')).toBe(null)
    expect(defaultStepOwner('Final Fabric Inhouse', order, 'M1')).toBe('M1')
  })
})

describe('stepOwnerOptions', () => {
  test("only this style's customer, Tradio staff and this split's factory", () => {
    expect(stepOwnerOptions(users, order, 'M1').map(o => o.value)).toEqual(['B1', 'A1', 'M1'])
  })
  test('the customer never owns Delivery; an existing owner off the split stays visible', () => {
    expect(stepOwnerOptions(users, order, 'M1', { isDelivery: true }).map(o => o.value)).toEqual(['A1', 'M1'])
    const withOld = stepOwnerOptions(users, order, 'M1', { currentId: 'M2' })
    expect(withOld.at(-1)).toMatchObject({ value: 'M2', label: 'Factory: Elsewhere (not on this split)' })
  })
})
