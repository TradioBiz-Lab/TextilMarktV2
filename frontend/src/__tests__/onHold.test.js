import { describe, test, expect } from 'vitest'
import { styleOnHold } from '../constants.js'

describe('styleOnHold', () => {
  test('a style is on hold only when every split is', () => {
    expect(styleOnHold({ assignments: [{ status: 'On Hold' }, { status: 'On Hold' }] })).toBe(true)
    expect(styleOnHold({ assignments: [{ status: 'On Hold' }, { status: 'Processing' }] })).toBe(false)
    expect(styleOnHold({ assignments: [] })).toBe(false)
    expect(styleOnHold({})).toBe(false)
  })
})
