import { describe, test, expect } from 'vitest'
import { pickPrimaryColumn, resolveRowKey, resolveAlign, mobileLabel, cellClasses, cellContent, EMPTY_CELL } from '../lib/dataTable.js'

describe('pickPrimaryColumn', () => {
  test('uses the column marked primary, wherever it is', () => {
    const cols = [{ key: 'a' }, { key: 'b', primary: true }, { key: 'c' }]
    expect(pickPrimaryColumn(cols).key).toBe('b')
  })

  test('the first column marked primary wins when several are', () => {
    const cols = [{ key: 'a' }, { key: 'b', primary: true }, { key: 'c', primary: true }]
    expect(pickPrimaryColumn(cols).key).toBe('b')
  })

  test('a primary column wins even if it is numeric or hidden on mobile', () => {
    expect(pickPrimaryColumn([{ key: 'a' }, { key: 'n', primary: true, numeric: true }]).key).toBe('n')
    expect(pickPrimaryColumn([{ key: 'a' }, { key: 'h', primary: true, hideOnMobile: true }]).key).toBe('h')
  })

  test('without one, takes the first column that is neither numeric nor hidden on mobile', () => {
    const cols = [{ key: 'qty', numeric: true }, { key: 'notes', hideOnMobile: true }, { key: 'style' }, { key: 'mfr' }]
    expect(pickPrimaryColumn(cols).key).toBe('style')
  })

  test('falls back to the first column when every column is numeric or hidden', () => {
    const cols = [{ key: 'qty', numeric: true }, { key: 'price', numeric: true }]
    expect(pickPrimaryColumn(cols).key).toBe('qty')
  })

  test('no columns, nothing to pick', () => {
    expect(pickPrimaryColumn([])).toBeUndefined()
    expect(pickPrimaryColumn(undefined)).toBeUndefined()
    expect(pickPrimaryColumn(null)).toBeUndefined()
  })

  test('returns the column object itself, so callers can compare by identity', () => {
    const cols = [{ key: 'a' }, { key: 'b' }]
    expect(pickPrimaryColumn(cols)).toBe(cols[0])
  })
})

describe('resolveRowKey', () => {
  test('reads a property by name', () => {
    expect(resolveRowKey('orderId', { orderId: 'ZAR-1' }, 0)).toBe('ZAR-1')
  })

  test('calls a function with the row and its index', () => {
    const seen = []
    const key = resolveRowKey((row, i) => { seen.push([row, i]); return `${row.a}-${i}` }, { a: 'x' }, 4)
    expect(key).toBe('x-4')
    expect(seen).toEqual([[{ a: 'x' }, 4]])
  })

  test('defaults to the row id', () => {
    expect(resolveRowKey(undefined, { id: 7 }, 0)).toBe('7')
    expect(resolveRowKey(null, { id: 'abc' }, 0)).toBe('abc')
  })

  test('always returns a string, including for numbers and zero', () => {
    expect(resolveRowKey('id', { id: 12 }, 0)).toBe('12')
    expect(resolveRowKey('id', { id: 0 }, 3)).toBe('0')
  })

  test('falls back to the index when the key is missing or empty', () => {
    expect(resolveRowKey('id', {}, 2)).toBe('row-2')
    expect(resolveRowKey('id', { id: null }, 5)).toBe('row-5')
    expect(resolveRowKey('id', { id: '' }, 1)).toBe('row-1')
    expect(resolveRowKey(() => undefined, { id: 1 }, 9)).toBe('row-9')
    expect(resolveRowKey('id', undefined, 0)).toBe('row-0')
  })
})

describe('resolveAlign', () => {
  test('uses an explicit align', () => {
    expect(resolveAlign({ align: 'center' })).toBe('center')
    expect(resolveAlign({ align: 'right' })).toBe('right')
    expect(resolveAlign({ align: 'left', numeric: true })).toBe('left')
  })

  test('numeric columns are right-aligned, everything else left', () => {
    expect(resolveAlign({ numeric: true })).toBe('right')
    expect(resolveAlign({})).toBe('left')
    expect(resolveAlign({ align: 'nonsense' })).toBe('left')
    expect(resolveAlign(undefined)).toBe('left')
  })
})

describe('mobileLabel', () => {
  test('uses the header when it is text or a number', () => {
    expect(mobileLabel({ key: 'qty', header: 'Quantity' })).toBe('Quantity')
    expect(mobileLabel({ key: 'y', header: 2026 })).toBe('2026')
  })

  test('falls back to the key for a blank header or a header that is not text', () => {
    expect(mobileLabel({ key: 'qty', header: '  ' })).toBe('qty')
    expect(mobileLabel({ key: 'qty' })).toBe('qty')
    expect(mobileLabel({ key: 'qty', header: { type: 'span' } })).toBe('qty')
  })
})

describe('cellClasses', () => {
  test('a plain column has no classes', () => {
    expect(cellClasses({ key: 'a' }, false)).toBe('')
  })

  test('marks the card title, numeric and mobile-hidden columns', () => {
    expect(cellClasses({ key: 'a' }, true)).toBe('dt-primary')
    expect(cellClasses({ key: 'q', numeric: true }, false)).toBe('dt-num')
    expect(cellClasses({ key: 'n', hideOnMobile: true }, false)).toBe('dt-hide-mobile')
    expect(cellClasses({ key: 'q', numeric: true, hideOnMobile: true }, false)).toBe('dt-num dt-hide-mobile')
  })

  test('the primary column is never hidden on mobile', () => {
    expect(cellClasses({ key: 'a', hideOnMobile: true }, true)).toBe('dt-primary')
  })
})

describe('cellContent', () => {
  const row = { id: 1, name: 'Aero Windbreaker', qty: 0, note: '', gone: null, flag: false }

  test('reads row[key] when there is no render function', () => {
    expect(cellContent({ key: 'name' }, row)).toBe('Aero Windbreaker')
  })

  test('uses render(row) when there is one', () => {
    expect(cellContent({ key: 'name', render: r => r.name.toUpperCase() }, row)).toBe('AERO WINDBREAKER')
  })

  test('zero is a value, not an empty cell', () => {
    expect(cellContent({ key: 'qty' }, row)).toBe(0)
  })

  test('empty strings, null, undefined and booleans show a hyphen', () => {
    expect(EMPTY_CELL).toBe('-')
    expect(cellContent({ key: 'note' }, row)).toBe(EMPTY_CELL)
    expect(cellContent({ key: 'gone' }, row)).toBe(EMPTY_CELL)
    expect(cellContent({ key: 'missing' }, row)).toBe(EMPTY_CELL)
    expect(cellContent({ key: 'flag' }, row)).toBe(EMPTY_CELL)
    expect(cellContent({ key: 'x', render: () => false }, row)).toBe(EMPTY_CELL)
  })

  test('survives a missing row', () => {
    expect(cellContent({ key: 'name' }, undefined)).toBe(EMPTY_CELL)
  })
})
