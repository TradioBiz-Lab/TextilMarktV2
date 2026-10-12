import { describe, test, expect } from 'vitest'
import { kindForCustomerOwner } from '../constants.js'

describe('kindForCustomerOwner', () => {
  test('a quantity step handed to the customer becomes a milestone', () => {
    expect(kindForCustomerOwner({ kind: 'quantity', totalUnits: 604 })).toEqual({ kind: 'milestone' })
  })
  test('a legacy step with no kind is a quantity step', () => {
    expect(kindForCustomerOwner({ totalUnits: 453 })).toEqual({ kind: 'milestone' })
  })
  test('milestones and checklists keep their shape', () => {
    expect(kindForCustomerOwner({ kind: 'milestone' })).toEqual({})
    expect(kindForCustomerOwner({ kind: 'checklist' })).toEqual({})
  })
})
