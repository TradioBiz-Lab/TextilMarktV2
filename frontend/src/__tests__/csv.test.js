import { describe, test, expect } from 'vitest'
import { normalizeCsvDate } from '../csvDates.js'
import { toCsvCell } from '../csvCell.js'

describe('normalizeCsvDate', () => {
  test.each([
    ['2026-01-05', '2026-01-05'],
    ['05-01-2026', '2026-01-05'],        // day first, as in India: never read as year 5
    ['5/1/2026', '2026-01-05'],
    ['05.01.2026', '2026-01-05'],
    ['5-Jan-26', '2026-01-05'],
    ['5 January 2026', '2026-01-05'],
    ['NA', 'NA'],
    ['na', 'NA'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeCsvDate(input)).toEqual({ value: expected })
  })

  test.each(['31/02/2026', '2026-13-01', '12/25/2026', 'Jan 5', '5-Foo-26', 'tomorrow'])('rejects %s instead of guessing', input => {
    expect(normalizeCsvDate(input).error).toBeTruthy()
  })

  test('a blank cell is reported as missing', () => {
    expect(normalizeCsvDate('  ')).toEqual({ error: 'missing' })
    expect(normalizeCsvDate(undefined)).toEqual({ error: 'missing' })
  })
})

describe('toCsvCell', () => {
  test('neutralises text a spreadsheet would run as a formula', () => {
    for (const evil of ['=SUM(A1)', '+1+1', '@cmd', '\tTab', '- dash text']) expect(toCsvCell(evil).startsWith("'")).toBe(true)
  })

  test('leaves real numbers, including negative variances, alone', () => {
    expect(toCsvCell(-5)).toBe('-5')
    expect(toCsvCell('-5')).toBe('-5')
    expect(toCsvCell('-2.5')).toBe('-2.5')
    expect(toCsvCell(0)).toBe('0')
  })

  test('quotes commas, quotes and line breaks, and handles empty values', () => {
    expect(toCsvCell('a,b')).toBe('"a,b"')
    expect(toCsvCell('say "hi"')).toBe('"say ""hi"""')
    expect(toCsvCell('two\nlines')).toBe('"two\nlines"')
    expect(toCsvCell(null)).toBe('')
    expect(toCsvCell(undefined)).toBe('')
  })
})
