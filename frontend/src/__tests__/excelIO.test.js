import { describe, test, expect } from 'vitest'
import { readSheet } from 'read-excel-file/node'
import { mapRows, sheetKind, templateSheet, buildTemplateBlob } from '../lib/excelIO.js'

const COLUMNS = [
  { key: 'style', header: 'Style Code', required: true, aliases: ['Style', 'Article'] },
  { key: 'qty', header: 'Quantity', type: 'number', aliases: ['Qty', 'Pcs'] },
  { key: 'delivery', header: 'Delivery Date', type: 'date', aliases: ['Delivery', 'Ex-factory'] },
  { key: 'stage', header: 'Stage', type: 'enum', options: ['Cutting', 'Stitching', 'Packing'] },
  { key: 'notes', header: 'Notes' },
]
const HEADER = ['Style Code', 'Quantity', 'Delivery Date', 'Stage', 'Notes']
const utc = (y, m, d) => new Date(Date.UTC(y, m - 1, d))

describe('mapRows: finding and matching headers', () => {
  test('matches headers ignoring case, spaces and repeated spaces', () => {
    const { rows, unknownHeaders, errors } = mapRows([['  STYLE   code ', 'quantity', ' delivery DATE'], ['A-1', 5, '2026-01-05']], COLUMNS)
    expect(errors).toEqual([])
    expect(unknownHeaders).toEqual([])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ style: 'A-1', qty: 5, delivery: '2026-01-05' })
  })

  test('matches aliases', () => {
    const { rows, errors } = mapRows([['Article', 'Pcs', 'Ex-factory'], ['B-2', '300', '10/02/2026']], COLUMNS)
    expect(errors).toEqual([])
    expect(rows[0]).toMatchObject({ style: 'B-2', qty: 300, delivery: '2026-02-10' })
  })

  test('aliases are matched ignoring case and spaces too', () => {
    const { rows } = mapRows([[' ARTICLE ', ' qty '], ['C-3', 7]], COLUMNS)
    expect(rows[0]).toMatchObject({ style: 'C-3', qty: 7 })
  })

  test('also matches a column by its key, as a last resort', () => {
    const { rows } = mapRows([['style', 'qty'], ['D-4', 9]], [{ key: 'style', header: 'Style Code' }, { key: 'qty', header: 'Quantity', type: 'number' }])
    expect(rows[0]).toMatchObject({ style: 'D-4', qty: 9 })
  })

  test("a column's own header beats another column's alias", () => {
    const cols = [{ key: 'a', header: 'Code', aliases: ['Name'] }, { key: 'b', header: 'Name' }]
    const { rows } = mapRows([['Name', 'Code'], ['n', 'c']], cols)
    expect(rows[0]).toMatchObject({ a: 'c', b: 'n' })
  })

  test('columns can come in any order, and with extra columns around them', () => {
    const { rows, unknownHeaders } = mapRows([['Colour', 'Quantity', 'Style Code', 'Remarks'], ['red', 4, 'E-5', 'x']], COLUMNS)
    expect(rows[0]).toMatchObject({ style: 'E-5', qty: 4 })
    expect(unknownHeaders).toEqual(['Colour', 'Remarks'])
  })

  test('finds the header row below a title and blank lines, and numbers rows by their place in the sheet', () => {
    const raw = [
      ['Order import', null, null],
      [null, null, null],
      ['Fill in one row per style', null, null],
      ['Style Code', 'Quantity', 'Delivery Date'], // sheet row 4
      ['F-6', 10, '2026-03-01'], // sheet row 5
      ['G-7', 20, '2026-03-02'], // sheet row 6
    ]
    const out = mapRows(raw, COLUMNS)
    expect(out.headerRow).toBe(4)
    expect(out.rows.map(r => r._row)).toEqual([5, 6])
    expect(out.rows.map(r => r.style)).toEqual(['F-6', 'G-7'])
    expect(out.errors).toEqual([])
  })

  test('a title row that happens to match one header does not beat the real header', () => {
    const out = mapRows([['Notes', null, null, null], ['Style Code', 'Quantity', 'Delivery Date', 'Stage'], ['H-8', 1, '2026-01-01', 'Cutting']], COLUMNS)
    expect(out.headerRow).toBe(2)
    expect(out.rows).toHaveLength(1)
  })

  test('reports headers that match nothing, once, in sheet order', () => {
    const out = mapRows([['Style Code', 'Mystery', 'Quantity', '', 'Other', 'Mystery'], ['I-9', 'x', 1, 'y', 'z', 'w']], COLUMNS)
    expect(out.unknownHeaders).toEqual(['Mystery', 'Other', 'Mystery']) // the repeat of a header is not a second match, so it is unknown as well
  })

  test('a repeated header uses the first occurrence', () => {
    const out = mapRows([['Style Code', 'Style Code'], ['first', 'second']], COLUMNS)
    expect(out.rows[0].style).toBe('first')
    expect(out.unknownHeaders).toEqual(['Style Code'])
  })

  test('ignores a byte order mark on the first header (CSV from Excel)', () => {
    const out = mapRows([['﻿Style Code', 'Quantity'], ['J-10', 2]], COLUMNS)
    expect(out.errors).toEqual([])
    expect(out.rows[0].style).toBe('J-10')
  })

  test('non-breaking spaces in a header do not stop it matching', () => {
    const out = mapRows([['Style Code', 'Quantity'], ['K-11', 3]], COLUMNS)
    expect(out.rows[0].style).toBe('K-11')
  })

  test('no header row at all is one clear error and no rows', () => {
    const out = mapRows([['foo', 'bar'], ['1', '2']], COLUMNS)
    expect(out.rows).toEqual([])
    expect(out.headerRow).toBe(null)
    expect(out.errors).toHaveLength(1)
    expect(out.errors[0].message).toMatch(/header row/i)
    expect(out.errors[0].message).toMatch(/Style Code/)
  })

  test('an empty file is an error, not a crash', () => {
    for (const raw of [[], undefined, null]) {
      const out = mapRows(raw, COLUMNS)
      expect(out.rows).toEqual([])
      expect(out.errors).toHaveLength(1)
      expect(out.errors[0].message).toMatch(/empty/i)
    }
  })

  test('no columns, nothing to map', () => {
    expect(mapRows([['a'], ['b']], [])).toEqual({ rows: [], errors: [], unknownHeaders: [], missingColumns: [], headerRow: null })
  })
})

describe('mapRows: numbers', () => {
  const num = cell => mapRows([['Quantity'], [cell]], [{ key: 'qty', header: 'Quantity', type: 'number' }])

  test.each([
    ['1,200', 1200],
    ['12.5', 12.5],
    ['1,200.50', 1200.5],
    ['1,20,000', 120000], // Indian grouping
    ['12,34,567.5', 1234567.5],
    ['1,234,567', 1234567],
    ['-3', -3],
    ['-1,200', -1200],
    ['.5', 0.5],
    [' 42 ', 42],
    ['+7', 7],
    ['0', 0],
    [1200, 1200],
    [12.5, 12.5],
    [0, 0],
    [-4, -4],
  ])('%j reads as %j', (cell, expected) => {
    const out = num(cell)
    expect(out.errors).toEqual([])
    expect(out.rows[0].qty).toBe(expected)
  })

  test.each(['12,5', '1,23', '1,2345', '1.2.3', 'abc', '12 kg', '1 200', '--5', '1e3x', '$100', '12%'])('%j is an error, not a guess', cell => {
    const out = num(cell)
    expect(out.errors).toHaveLength(1)
    expect(out.errors[0]).toMatchObject({ row: 2, column: 'Quantity', key: 'qty', value: cell })
    expect(out.errors[0].message).toMatch(/number/i)
    expect(out.rows[0].qty).toBe(null)
  })

  test('numbers that are not finite, booleans and dates are errors', () => {
    expect(num(NaN).errors).toHaveLength(1)
    expect(num(Infinity).errors).toHaveLength(1)
    expect(num(true).errors).toHaveLength(1)
    expect(num(utc(2026, 1, 5)).errors).toHaveLength(1)
  })

  test('the error names the offending value', () => {
    expect(num('twelve').errors[0].message).toContain('twelve')
  })
})

describe('mapRows: dates', () => {
  const date = (cell, extra = {}) => mapRows([['Delivery Date'], [cell]], [{ key: 'd', header: 'Delivery Date', type: 'date', ...extra }])

  test.each([
    ['2026-01-05', '2026-01-05'],
    ['2026-1-5', '2026-01-05'],
    ['05/01/2026', '2026-01-05'], // day first
    ['5/1/2026', '2026-01-05'],
    ['05-01-2026', '2026-01-05'],
    ['05.01.2026', '2026-01-05'],
    ['31/12/2026', '2026-12-31'],
    ['29/02/2028', '2028-02-29'], // a leap day
    ['5-Jan-26', '2026-01-05'],
    ['5 January 2026', '2026-01-05'],
    ['2026-01-05T00:00:00.000Z', '2026-01-05'],
    ['2026-01-05 14:30', '2026-01-05'],
    ['  2026-01-05  ', '2026-01-05'],
  ])('%j reads as %s', (cell, expected) => {
    const out = date(cell)
    expect(out.errors).toEqual([])
    expect(out.rows[0].d).toBe(expected)
  })

  test('a real Excel date (a Date at UTC midnight) reads as that calendar day', () => {
    expect(date(utc(2026, 1, 5)).rows[0].d).toBe('2026-01-05')
    expect(date(utc(2026, 12, 31)).rows[0].d).toBe('2026-12-31')
  })

  test('an Excel day count is read as a date when it lands in 2000 to 2099', () => {
    const serial = (Date.UTC(2026, 0, 5) - Date.UTC(1899, 11, 30)) / 86400000
    expect(date(serial).rows[0].d).toBe('2026-01-05')
    expect(date(serial + 0.75).rows[0].d).toBe('2026-01-05') // a time of day is dropped
  })

  test('a bare number outside that window is an error, so a year or yyyymmdd is not guessed', () => {
    expect(date(2026).errors).toHaveLength(1)
    expect(date(20260105).errors).toHaveLength(1)
    expect(date(100).errors).toHaveLength(1)
  })

  test.each(['31/02/2026', '2026-13-01', '12/25/2026', '00/01/2026'])('%s is not a real date', cell => {
    const out = date(cell)
    expect(out.errors).toHaveLength(1)
    expect(out.errors[0].message).toMatch(/real date/i)
    expect(out.rows[0].d).toBe(null)
  })

  test.each(['tomorrow', 'Jan 5', '5-Foo-26', '2026'])('%s is not a date', cell => {
    const out = date(cell)
    expect(out.errors).toHaveLength(1)
    expect(out.errors[0]).toMatchObject({ row: 2, column: 'Delivery Date', key: 'd' })
    expect(out.errors[0].message).toMatch(/date/i)
  })

  test('an invalid Date object and a boolean are errors', () => {
    expect(date(new Date('nope')).errors).toHaveLength(1)
    expect(date(true).errors).toHaveLength(1)
  })

  test('NA is an error unless the column allows it', () => {
    expect(date('NA').errors).toHaveLength(1)
    const ok = date('na', { allowNA: true })
    expect(ok.errors).toEqual([])
    expect(ok.rows[0].d).toBe('NA')
  })
})

describe('mapRows: enums', () => {
  const stage = cell => mapRows([['Stage'], [cell]], [{ key: 'stage', header: 'Stage', type: 'enum', options: ['Cutting', 'Stitching', 'Final QC'] }])

  test('matches an option ignoring case and spaces, and returns the option as spelled in options', () => {
    expect(stage('cutting').rows[0].stage).toBe('Cutting')
    expect(stage('STITCHING').rows[0].stage).toBe('Stitching')
    expect(stage('  final   qc ').rows[0].stage).toBe('Final QC')
    expect(stage('Cutting').errors).toEqual([])
  })

  test('a value that is not an option is an error that lists the options', () => {
    const out = stage('Pressing')
    expect(out.errors).toHaveLength(1)
    expect(out.errors[0]).toMatchObject({ row: 2, column: 'Stage', key: 'stage', value: 'Pressing' })
    expect(out.errors[0].message).toContain('Cutting, Stitching, Final QC')
    expect(out.errors[0].message).toContain('Pressing')
    expect(out.rows[0].stage).toBe(null)
  })

  test('a close but wrong value is still an error', () => {
    expect(stage('Cutting.').errors).toHaveLength(1)
    expect(stage('Cut').errors).toHaveLength(1)
  })

  test('an enum with no options accepts any text', () => {
    const out = mapRows([['Stage'], ['whatever']], [{ key: 'stage', header: 'Stage', type: 'enum' }])
    expect(out.errors).toEqual([])
    expect(out.rows[0].stage).toBe('whatever')
  })

  test('numeric options match numeric cells', () => {
    const out = mapRows([['Grade'], [2]], [{ key: 'g', header: 'Grade', type: 'enum', options: ['1', '2', '3'] }])
    expect(out.errors).toEqual([])
    expect(out.rows[0].g).toBe('2')
  })
})

describe('mapRows: required fields', () => {
  test('an empty required cell is an error with its row and column', () => {
    const out = mapRows([HEADER, ['A-1', 5, '2026-01-05', 'Cutting', ''], [null, 6, '2026-01-06', 'Packing', ''], ['', 7, '2026-01-07', 'Packing', 'x']], COLUMNS)
    expect(out.errors).toEqual([
      { row: 3, column: 'Style Code', key: 'style', message: 'This field is required.' },
      { row: 4, column: 'Style Code', key: 'style', message: 'This field is required.' },
    ])
    expect(out.rows).toHaveLength(3) // the rows are still there, beside their errors
    expect(out.rows[1].style).toBe(null)
  })

  test('a cell of only spaces counts as empty', () => {
    const out = mapRows([HEADER, ['   ', 5]], COLUMNS)
    expect(out.errors).toHaveLength(1)
    expect(out.errors[0].message).toMatch(/required/i)
  })

  test('zero is a value, not an empty cell', () => {
    const out = mapRows([['Quantity'], [0]], [{ key: 'qty', header: 'Quantity', type: 'number', required: true }])
    expect(out.errors).toEqual([])
    expect(out.rows[0].qty).toBe(0)
  })

  test('false and a bare 0 in a text column are values, not empty', () => {
    const out = mapRows([['Code'], [0], [false]], [{ key: 'code', header: 'Code', required: true }])
    expect(out.errors).toEqual([])
    expect(out.rows.map(r => r.code)).toEqual(['0', 'false'])
  })

  test('an empty optional cell is null and not an error', () => {
    const out = mapRows([HEADER, ['A-1', '', '', '', '']], COLUMNS)
    expect(out.errors).toEqual([])
    expect(out.rows[0]).toEqual({ _row: 2, style: 'A-1', qty: null, delivery: null, stage: null, notes: null })
  })

  test('a required column missing from the sheet is reported once, at the header row, not once per row', () => {
    const out = mapRows([['Quantity'], [1], [2], [3]], COLUMNS)
    expect(out.missingColumns).toEqual(['Style Code'])
    expect(out.errors).toHaveLength(1)
    expect(out.errors[0]).toMatchObject({ row: 1, column: 'Style Code', key: 'style' })
    expect(out.errors[0].message).toMatch(/missing/i)
    expect(out.rows).toHaveLength(3)
  })

  test('an optional column missing from the sheet is fine', () => {
    const out = mapRows([['Style Code'], ['A-1']], COLUMNS)
    expect(out.errors).toEqual([])
    expect(out.missingColumns).toEqual([])
    expect(out.rows[0]).toEqual({ _row: 2, style: 'A-1', qty: null, delivery: null, stage: null, notes: null })
  })

  test('every error carries its sheet row, so several in one row and in many rows are all kept, in order', () => {
    const out = mapRows([HEADER, ['', 'many', '31/02/2026', 'Pressing', ''], ['B-2', '3', '2026-01-02', 'Cutting', '']], COLUMNS)
    expect(out.errors.map(e => [e.row, e.key])).toEqual([[2, 'style'], [2, 'qty'], [2, 'delivery'], [2, 'stage']])
  })
})

describe('mapRows: empty rows', () => {
  test('skips fully empty rows, in the middle and at the end, and keeps the others numbered by sheet row', () => {
    const out = mapRows([HEADER, ['A-1', 1], [null, null, null], ['', '  ', ''], ['B-2', 2], [], ['']], COLUMNS)
    expect(out.rows.map(r => [r._row, r.style])).toEqual([[2, 'A-1'], [5, 'B-2']])
    expect(out.errors).toEqual([])
  })

  test('a row with values only in columns we do not map is skipped, not reported as missing its required fields', () => {
    const out = mapRows([['Style Code', 'Quantity', 'Comment'], ['A-1', 1, 'ok'], [null, null, 'Prepared by Meena']], COLUMNS)
    expect(out.rows).toHaveLength(1)
    expect(out.errors).toEqual([])
  })

  test('a header-only sheet gives no rows and no errors', () => {
    const out = mapRows([HEADER], COLUMNS)
    expect(out.rows).toEqual([])
    expect(out.errors).toEqual([])
  })

  test('a short row, as CSV produces, counts the missing cells as empty', () => {
    const out = mapRows([HEADER, ['A-1']], COLUMNS)
    expect(out.errors).toEqual([])
    expect(out.rows[0].qty).toBe(null)
  })

  test('non-array rows are treated as empty', () => {
    const out = mapRows([HEADER, 'junk', null, ['A-1', 1]], COLUMNS)
    expect(out.rows.map(r => r.style)).toEqual(['A-1'])
  })
})

describe('mapRows: text and result shape', () => {
  test('text is trimmed; numbers and dates in a text column become text', () => {
    const out = mapRows([['Style Code', 'Notes'], ['  A-1  ', 1200], ['B-2', utc(2026, 1, 5)], [3004, 12.5]], COLUMNS)
    expect(out.rows.map(r => r.style)).toEqual(['A-1', 'B-2', '3004'])
    expect(out.rows.map(r => r.notes)).toEqual(['1200', '2026-01-05', '12.5'])
  })

  test('every record has every column key, plus _row', () => {
    const out = mapRows([['Style Code'], ['A-1']], COLUMNS)
    expect(Object.keys(out.rows[0]).sort()).toEqual(['_row', 'delivery', 'notes', 'qty', 'stage', 'style'])
  })

  test('a bad value is null in its record, so nothing mistyped slips through', () => {
    const out = mapRows([HEADER, ['A-1', 'lots', 'soon', 'Pressing', '']], COLUMNS)
    expect(out.rows[0]).toMatchObject({ style: 'A-1', qty: null, delivery: null, stage: null })
    expect(out.errors).toHaveLength(3)
  })

  test('a full realistic sheet', () => {
    const raw = [
      HEADER,
      ['AER-001', '1,200', '15/02/2026', 'cutting', 'rush'],
      ['AER-002', 850, utc(2026, 2, 20), 'Stitching', null],
      ['AER-003', '2,40,000', '2026-03-01', 'Packing', ''],
    ]
    const out = mapRows(raw, COLUMNS)
    expect(out.errors).toEqual([])
    expect(out.rows).toEqual([
      { _row: 2, style: 'AER-001', qty: 1200, delivery: '2026-02-15', stage: 'Cutting', notes: 'rush' },
      { _row: 3, style: 'AER-002', qty: 850, delivery: '2026-02-20', stage: 'Stitching', notes: null },
      { _row: 4, style: 'AER-003', qty: 240000, delivery: '2026-03-01', stage: 'Packing', notes: null },
    ])
    expect(out.headerRow).toBe(1)
  })
})

describe('sheetKind', () => {
  test('goes by the extension first', () => {
    expect(sheetKind({ name: 'a.xlsx' })).toBe('xlsx')
    expect(sheetKind({ name: 'A.XLSX' })).toBe('xlsx')
    expect(sheetKind({ name: 'a.csv', type: 'application/vnd.ms-excel' })).toBe('csv') // Windows reports CSV like this
    expect(sheetKind({ name: 'a.CSV' })).toBe('csv')
    expect(sheetKind({ name: 'a.tsv' })).toBe('csv')
    expect(sheetKind({ name: 'a.txt' })).toBe('csv')
    expect(sheetKind({ name: 'a.xls' })).toBe('xls')
  })

  test('falls back to the reported type', () => {
    expect(sheetKind({ name: 'download', type: 'text/csv' })).toBe('csv')
    expect(sheetKind({ name: 'download', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })).toBe('xlsx')
  })

  test('anything else is null', () => {
    expect(sheetKind({ name: 'a.pdf', type: 'application/pdf' })).toBe(null)
    expect(sheetKind({ name: 'a.docx' })).toBe(null)
    expect(sheetKind(null)).toBe(null)
    expect(sheetKind({})).toBe(null)
  })
})

describe('templates', () => {
  test('templateSheet: navy header row, italic example row, frozen header, sized columns', () => {
    const sheet = templateSheet({ sheetName: 'Orders', columns: COLUMNS, example: { style: 'AER-001', qty: 1200, delivery: '2026-02-15', stage: 'Cutting' } })
    expect(sheet.sheet).toBe('Orders')
    expect(sheet.stickyRowsCount).toBe(1)
    expect(sheet.data).toHaveLength(2)
    expect(sheet.data[0].map(c => c.value)).toEqual(HEADER)
    expect(sheet.data[0][0]).toMatchObject({ fontWeight: 'bold', backgroundColor: '#1D2D50', textColor: '#FFFFFF' })
    const ex = sheet.data[1]
    expect(ex[0]).toMatchObject({ value: 'AER-001', type: String, fontStyle: 'italic' })
    expect(ex[1]).toMatchObject({ value: 1200, type: Number })
    expect(ex[2]).toMatchObject({ type: Date, format: 'dd-mm-yyyy' })
    expect(ex[2].value.toISOString()).toBe('2026-02-15T00:00:00.000Z')
    expect(ex[3]).toMatchObject({ value: 'Cutting', type: String })
    expect(ex[4]).toBe(null) // no example given for Notes
    expect(sheet.columns).toHaveLength(COLUMNS.length)
    expect(sheet.columns.every(c => c.width >= 12 && c.width <= 40)).toBe(true)
  })

  test('templateSheet without an example is just the header row', () => {
    expect(templateSheet({ columns: COLUMNS }).data).toHaveLength(1)
  })

  test('templateSheet cleans up the sheet name', () => {
    expect(templateSheet({ sheetName: 'A/B: C?[x]*', columns: [] }).sheet).toBe('A B C x')
    expect(templateSheet({ sheetName: 'x'.repeat(50), columns: [] }).sheet).toHaveLength(31)
    expect(templateSheet({ columns: [] }).sheet).toBe('Template')
    expect(templateSheet({ sheetName: '///', columns: [] }).sheet).toBe('Template')
  })

  test('an example that does not fit its column type is kept as text rather than lost', () => {
    const ex = templateSheet({ columns: COLUMNS, example: { qty: 'lots', delivery: 'soon' } }).data[1]
    expect(ex[1]).toMatchObject({ value: 'lots', type: String })
    expect(ex[2]).toMatchObject({ value: 'soon', type: String })
  })

  test('round trip: a downloaded template reads back and maps to the example, typed', async () => {
    const example = { style: 'AER-001', qty: 1200, delivery: '2026-02-15', stage: 'cutting', notes: 'sample row' }
    const blob = await buildTemplateBlob({ sheetName: 'Orders', columns: COLUMNS, example })
    const raw = await readSheet(blob)
    expect(raw[0]).toEqual(HEADER)
    const out = mapRows(raw, COLUMNS)
    expect(out.errors).toEqual([])
    expect(out.unknownHeaders).toEqual([])
    expect(out.rows).toEqual([{ _row: 2, style: 'AER-001', qty: 1200, delivery: '2026-02-15', stage: 'Cutting', notes: 'sample row' }])
  })

  test('round trip: a sheet with a title above the header keeps true row numbers through xlsx', async () => {
    const { default: writeXlsx } = await import('write-excel-file/universal')
    const data = [
      [{ value: 'Order import', type: String }, null],
      [null, null],
      ['Style Code', 'Quantity'],
      ['A-1', { value: 5, type: Number }],
      [null, null],
      ['B-2', { value: 6, type: Number }],
    ]
    const raw = await readSheet(await writeXlsx([{ data, sheet: 'Orders' }]).toBlob())
    const out = mapRows(raw, COLUMNS)
    expect(out.headerRow).toBe(3)
    expect(out.rows.map(r => [r._row, r.style, r.qty])).toEqual([[4, 'A-1', 5], [6, 'B-2', 6]])
  })
})
