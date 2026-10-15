import { describe, test, expect } from 'vitest'
import { kindForCustomerOwner } from '../constants.js'

describe('kindForCustomerOwner', () => {
  test('a quantity step handed to the customer becomes a milestone', () => {
    expect(kindForCustomerOwner({ kind: 'quantity', totalUnits: 604 })).toEqual({ kind: 'milestone' })
  })
  test('a legacy step with no kind is a quantity step', () => {
    expect(kindForCustomerOwner({ totalUnits: 453 })).toEqual({ kind: 'milestone' })
  })
  test('a customer gives one decision: a checklist becomes a milestone, a milestone stays one', () => {
    expect(kindForCustomerOwner({ kind: 'milestone' })).toEqual({})
    expect(kindForCustomerOwner({ kind: 'checklist' })).toEqual({ kind: 'milestone' })
  })
})
