import { describe, it, expect } from 'vitest'
import { ownerForSplit, ownerCopyLabel } from '../ownerCopy.js'

const sibling = { id: 'S2', buyerId: 'buyer-1' }
const split = { mid: 'factory-B' }

describe('ownerForSplit', () => {
  it('gives a factory step the sibling split\'s own factory, never the id picked on the first style', () => {
    expect(ownerForSplit({ id: 'factory-A', role: 'manufacturer' }, sibling, split)).toBe('factory-B')
  })
  it('gives a customer step the sibling order\'s customer', () => {
    expect(ownerForSplit({ id: 'buyer-9', role: 'buyer' }, sibling, split)).toBe('buyer-1')
  })
  it('keeps a Tradio person as the same person', () => {
    expect(ownerForSplit({ id: 'admin-1', role: 'admin' }, sibling, split)).toBe('admin-1')
  })
  it('keeps unassigned unassigned', () => {
    expect(ownerForSplit(null, sibling, split)).toBe(null)
  })
  it('leaves a factory step unowned rather than guessing when the sibling has no factory', () => {
    expect(ownerForSplit({ id: 'factory-A', role: 'manufacturer' }, sibling, {})).toBe(null)
  })
})

describe('ownerCopyLabel', () => {
  const nameOf = id => (id === 'admin-1' ? 'Deepa' : null)
  it('reads by role for factory and customer', () => {
    expect(ownerCopyLabel({ id: 'f', role: 'manufacturer' }, nameOf)).toBe("Each style's own factory")
    expect(ownerCopyLabel({ id: 'b', role: 'buyer' }, nameOf)).toBe('The customer')
  })
  it('names a Tradio person and handles unassigned', () => {
    expect(ownerCopyLabel({ id: 'admin-1', role: 'admin' }, nameOf)).toBe('Deepa')
    expect(ownerCopyLabel(null, nameOf)).toBe('Unassigned')
  })
})
