import { describe, test, expect } from 'vitest'
import { parseSizes, breakupTotals, editorGrid, editorPayload, fitRows, totalNote } from '../sizeBreakup.js'
import { capsFor } from '../caps.js'

const TROUSERS = { sizes: ['28', '30', '32', '34', '36'], rows: [
  { colour: 'Camel Brown', qty: [28, 41, 46, 23, 12] }, { colour: 'Jet Black', qty: [28, 41, 46, 23, 12] }, { colour: 'Marshmallow', qty: [28, 41, 46, 23, 12] },
] }

describe('the grid and its totals', () => {
  test('Cocoblu\'s trousers add up as their own sheet does', () => {
    expect(breakupTotals(TROUSERS)).toEqual({ bySize: [84, 123, 138, 69, 36], byColour: [150, 150, 150], total: 450 })
  })
  test('blank and half-typed cells count as zero; no breakup is all zeros', () => {
    expect(breakupTotals({ sizes: ['S', 'M'], rows: [{ colour: 'A', qty: ['12', ''] }, { colour: 'B', qty: ['x', '3'] }] })).toEqual({ bySize: [12, 3], byColour: [12, 3], total: 15 })
    expect(breakupTotals(null)).toEqual({ bySize: [], byColour: [], total: 0 })
  })
  test('sizes are typed as one line', () => {
    expect(parseSizes(' S, M ,, 2XL ')).toEqual(['S', 'M', '2XL'])
    expect(parseSizes('')).toEqual([])
  })
})

describe('the editor', () => {
  test('opens on the saved breakup, or on a row for each of the style\'s colours', () => {
    expect(editorGrid({ sizeBreakup: { sizes: ['S', 'M'], rows: [{ colour: 'Olivine', qty: [4, 0] }] } })).toEqual({ sizes: 'S, M', rows: [{ colour: 'Olivine', qty: ['4', '0'] }] })
    expect(editorGrid({ colourways: [{ name: 'Olivine' }, { name: 'Peacot' }] })).toEqual({ sizes: '', rows: [{ colour: 'Olivine', qty: [] }, { colour: 'Peacot', qty: [] }] })
    expect(editorGrid({})).toEqual({ sizes: '', rows: [{ colour: '', qty: [] }] })
  })
  test('adding a size keeps what was typed and leaves the new cell blank', () => {
    expect(fitRows([{ colour: 'A', qty: ['1', '2'] }], 3)).toEqual([{ colour: 'A', qty: ['1', '2', ''] }])
    expect(fitRows([{ colour: 'A', qty: ['1', '2'] }], 1)).toEqual([{ colour: 'A', qty: ['1'] }])
  })
  test('what is sent: numbers for cells, blanks as zero, a spare empty row left out', () => {
    const r = editorPayload({ sizes: 'S, M', rows: [{ colour: ' Olivine ', qty: ['40', ''] }, { colour: '', qty: ['', ''] }] })
    expect(r).toEqual({ body: { sizes: ['S', 'M'], rows: [{ colour: 'Olivine', qty: [40, 0] }] } })
  })
  test('nothing typed at all clears the breakup', () => {
    expect(editorPayload({ sizes: '', rows: [{ colour: '', qty: [] }] })).toEqual({ body: { sizes: [], rows: [] } })
  })
  test('what stops a save, in plain words', () => {
    expect(editorPayload({ sizes: '', rows: [{ colour: 'Olivine', qty: [] }] }).error).toMatch(/Type the sizes first/)
    expect(editorPayload({ sizes: 'S, M', rows: [{ colour: '', qty: ['', ''] }] }).error).toMatch(/at least one colour/)
    expect(editorPayload({ sizes: 'S, s', rows: [{ colour: 'A', qty: ['1', '1'] }] }).error).toMatch(/twice/)
    expect(editorPayload({ sizes: 'S', rows: [{ colour: 'A', qty: ['1'] }, { colour: '', qty: ['2'] }] }).error).toMatch(/Name every colour/)
    expect(editorPayload({ sizes: 'S', rows: [{ colour: 'A', qty: ['1.5'] }] }).error).toMatch(/whole numbers/)
  })
})

describe('when the breakup and the style\'s quantity differ', () => {
  test('it is said, either way round, and only when both are known', () => {
    expect(totalNote(447, 450)).toBe("The breakup adds up to 447 pieces, 3 fewer than the style's quantity of 450.")
    expect(totalNote(460, 450)).toMatch(/10 more than/)
    expect(totalNote(450, 450)).toBe('')
    expect(totalNote(450, null)).toBe('')
    expect(totalNote(0, 450)).toBe('')
  })
})

describe('who may change it', () => {
  test('Tradio and a customer; a factory reads it', () => {
    expect(capsFor({ role: 'admin', adminType: 'user' }).editSizeBreakup).toBe(true)
    expect(capsFor({ role: 'buyer' }).editSizeBreakup).toBe(true)
    expect(capsFor({ role: 'manufacturer' }).editSizeBreakup).toBe(false)
  })
})
