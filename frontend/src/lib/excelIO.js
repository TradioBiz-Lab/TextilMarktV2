// Excel and CSV in and out. Both are first-class ways to get data into the portal, so the same three
// steps serve every bulk upload:
//
//   downloadTemplate(...)   gives the user a ready-made .xlsx to fill in
//   readSheetFile(file)     reads their .xlsx or .csv into raw rows (arrays of cells)
//   mapRows(raw, columns)   turns raw rows into typed records, with an error for every bad cell
//
// The columns array describes the sheet once and drives all three:
//
//   { key, header, required?, type?: 'string'|'number'|'date'|'enum', options?: string[], aliases?: string[], allowNA?: boolean }
//
// mapRows is pure (no file or browser access), so the rules below are covered by unit tests. The
// reading and writing libraries are loaded on demand, so they cost nothing until someone uses them.

import { normalizeCsvDate } from '../csvDates.js'
import { BRAND_NAVY } from '../brandMark.js'

// ─── Reading cells ──────────────────────────────────────────────────────────

const isBlank = v => v == null || (typeof v === 'string' && v.trim() === '')

// Header text, flattened for matching: no BOM or zero-width characters, runs of spaces collapsed,
// trimmed, lower case.
const norm = v => String(v ?? '').replace(/[​-‍﻿]/g, '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()

const show = v => {
  const s = v instanceof Date ? (Number.isNaN(v.getTime()) ? 'invalid date' : v.toISOString().slice(0, 10)) : String(v)
  return s.length > 40 ? `${s.slice(0, 40)}...` : s
}

// A Date from a spreadsheet cell is the calendar day at UTC midnight, so the day is read in UTC.
const isoOfDate = d => (Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10))

// Excel stores a date as a day count from 1899-12-30. A bare number in a date column is taken as
// one only if it lands between the years 2000 and 2099; anything else (2026, 20260105) is far more
// likely a typo than a date, and is reported instead of guessed.
const SERIAL_MIN = 36526
const SERIAL_MAX = 73050
const isoOfSerial = n => new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000).toISOString().slice(0, 10)

// Numbers: plain ("12.5", "-3", ".5") or grouped with commas the Western way ("1,200") or the Indian
// way ("1,20,000"). A comma anywhere else ("12,5", "1,23") is refused: it could be a decimal comma,
// and reading it as 125 would be a silent mistake.
const PLAIN_NUMBER = /^-?(?:\d+\.?\d*|\.\d+)$/
const WESTERN_GROUPED = /^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/
const INDIAN_GROUPED = /^-?\d{1,2}(?:,\d{2})+,\d{3}(?:\.\d+)?$/

function toNumber(raw) {
  const bad = { error: `Must be a number (got "${show(raw)}").` }
  if (typeof raw === 'number') return Number.isFinite(raw) ? { value: raw } : bad
  if (typeof raw !== 'string') return bad
  const s = raw.replace(/ /g, ' ').trim().replace(/^\+/, '')
  if (!PLAIN_NUMBER.test(s) && !WESTERN_GROUPED.test(s) && !INDIAN_GROUPED.test(s)) return bad
  const n = Number(s.replace(/,/g, ''))
  return Number.isFinite(n) ? { value: n } : bad
}

function toDate(raw, col) {
  const hint = `Must be a date such as 2026-01-31 or 31/01/2026 (got "${show(raw)}").`
  if (raw instanceof Date) {
    const iso = isoOfDate(raw)
    return iso ? { value: iso } : { error: hint }
  }
  if (typeof raw === 'number') {
    return raw >= SERIAL_MIN && raw <= SERIAL_MAX ? { value: isoOfSerial(raw) } : { error: hint }
  }
  if (typeof raw !== 'string') return { error: hint }
  // An ISO date-time ("2026-01-05T00:00:00.000Z") is read as its date.
  const s = raw.trim().replace(/^(\d{4}-\d{2}-\d{2})[T ].*$/, '$1')
  const r = normalizeCsvDate(s)
  if (r.error === 'not a real date') return { error: `Not a real date (got "${show(raw)}").` }
  if (r.error) return { error: hint }
  if (r.value === 'NA') return col.allowNA ? { value: 'NA' } : { error: hint }
  return { value: r.value }
}

function toEnum(raw, col) {
  const s = String(raw).trim()
  const options = Array.isArray(col.options) ? col.options : []
  if (!options.length) return { value: s }
  const hit = options.find(o => norm(o) === norm(s))
  return hit !== undefined ? { value: String(hit) } : { error: `Must be one of: ${options.join(', ')} (got "${show(raw)}").` }
}

function toText(raw) {
  if (raw instanceof Date) { const iso = isoOfDate(raw); return { value: iso || '' } }
  return { value: String(raw).trim() }
}

// A blank cell comes back as { blank: true }, anything else as { value } or { error }.
function coerce(raw, col) {
  if (isBlank(raw)) return { blank: true }
  switch (col.type) {
    case 'number': return toNumber(raw)
    case 'date': return toDate(raw, col)
    case 'enum': return toEnum(raw, col)
    default: return toText(raw)
  }
}

// ─── Finding the columns ────────────────────────────────────────────────────

// The header row is the first one, within the top 30 rows, that matches the most columns, so a title
// or a few lines of instructions above the real header do not matter.
const HEADER_SCAN_ROWS = 30

const prepare = columns => columns.map((col, index) => ({
  col, index,
  header: norm(col.header),
  aliases: (Array.isArray(col.aliases) ? col.aliases : []).map(norm).filter(Boolean),
  key: norm(col.key),
}))

// The column a header cell belongs to, or -1. A column's own header wins over an alias, and an alias
// over its key; a column that already has a header cell is not offered again.
function matchColumn(cell, prepared, taken) {
  const h = norm(cell)
  if (!h) return -1
  for (const test of [p => p.header === h, p => p.aliases.includes(h), p => p.key === h]) {
    const hit = prepared.find(p => !taken.has(p.index) && test(p))
    if (hit) return hit.index
  }
  return -1
}

function findHeaderRow(rows, prepared) {
  let best = -1
  let bestScore = 0
  for (let r = 0; r < Math.min(rows.length, HEADER_SCAN_ROWS); r++) {
    const taken = new Set()
    for (const cell of Array.isArray(rows[r]) ? rows[r] : []) {
      const idx = matchColumn(cell, prepared, taken)
      if (idx >= 0) taken.add(idx)
    }
    if (taken.size > bestScore) { best = r; bestScore = taken.size }
  }
  return best
}

/**
 * Turn raw sheet rows (arrays of cells, as readSheetFile returns) into typed records.
 *
 * Headers are matched to columns ignoring case and extra spaces, against `header`, then any
 * `aliases`, then `key`. Values are converted by `type`:
 *   string (default)  trimmed text
 *   number            "1,200", "1,20,000" and "12.5" read as numbers; "12,5" is an error, not 125
 *   date              2026-01-31, 31/01/2026, 31-01-2026 (day first) and real Excel dates, as 'YYYY-MM-DD';
 *                     the text NA is accepted only on a column with `allowNA: true`
 *   enum              matched to `options` ignoring case, giving back the option as spelled in `options`
 * Rows with nothing in any mapped column are skipped. A bad or missing value becomes null in its
 * record and an entry in `errors`; the record is still returned, so a screen can show it beside its error.
 *
 * @returns {{
 *   rows: Array<Object>,           one per non-empty row: { ...values by key, _row } where _row is the row number in the sheet
 *   errors: Array<{ row: number, column: string, key: string, message: string, value?: any }>,
 *   unknownHeaders: string[],      header cells that matched no column
 *   missingColumns: string[],      headers of required columns the sheet does not have at all (also listed in errors, once, at the header row)
 *   headerRow: number|null,        sheet row number of the header, or null if none was found
 * }}
 */
export function mapRows(rawRows, columns) {
  const rows = Array.isArray(rawRows) ? rawRows : []
  const cols = Array.isArray(columns) ? columns : []
  const result = { rows: [], errors: [], unknownHeaders: [], missingColumns: [], headerRow: null }
  if (!cols.length) return result

  const fileError = message => ({ row: 1, column: '', key: '', message })
  if (!rows.length) { result.errors.push(fileError('The file is empty.')); return result }

  const prepared = prepare(cols)
  const h = findHeaderRow(rows, prepared)
  if (h < 0) {
    const sample = cols.slice(0, 6).map(c => c.header).join(', ')
    result.errors.push(fileError(`Could not find a header row. Expected columns such as: ${sample}.`))
    return result
  }
  result.headerRow = h + 1

  // Which sheet column holds each of our columns.
  const fileIndexOf = new Array(cols.length).fill(-1)
  const taken = new Set()
  ;(Array.isArray(rows[h]) ? rows[h] : []).forEach((cell, ci) => {
    if (isBlank(cell)) return
    const idx = matchColumn(cell, prepared, taken)
    if (idx >= 0) { taken.add(idx); fileIndexOf[idx] = ci } else result.unknownHeaders.push(String(cell).trim())
  })

  for (const p of prepared) {
    if (fileIndexOf[p.index] === -1 && p.col.required) {
      result.missingColumns.push(String(p.col.header))
      result.errors.push({ row: h + 1, column: String(p.col.header), key: p.col.key, message: 'This column is required but is missing from the file.' })
    }
  }

  const mapped = prepared.filter(p => fileIndexOf[p.index] !== -1)
  for (let r = h + 1; r < rows.length; r++) {
    const raw = Array.isArray(rows[r]) ? rows[r] : []
    // Nothing in any column we map: a blank line, or notes sitting outside the table.
    if (mapped.every(p => isBlank(raw[fileIndexOf[p.index]]))) continue
    const rec = { _row: r + 1 }
    for (const p of prepared) {
      const ci = fileIndexOf[p.index]
      rec[p.col.key] = null
      if (ci === -1) continue // a missing required column was reported once, above
      const cell = raw[ci]
      const out = coerce(cell, p.col)
      if (out.blank) {
        if (p.col.required) result.errors.push({ row: r + 1, column: String(p.col.header), key: p.col.key, message: 'This field is required.' })
      } else if (out.error) {
        result.errors.push({ row: r + 1, column: String(p.col.header), key: p.col.key, message: out.error, value: cell })
      } else {
        rec[p.col.key] = out.value
      }
    }
    result.rows.push(rec)
  }
  return result
}

// ─── Reading a file ─────────────────────────────────────────────────────────

/** 'xlsx', 'csv' or 'xls' (the old binary format, which cannot be read), or null for anything else. */
export function sheetKind(file) {
  const name = String(file?.name || '').toLowerCase()
  const type = String(file?.type || '').toLowerCase()
  if (name.endsWith('.xlsx')) return 'xlsx'
  if (/\.(csv|tsv|txt)$/.test(name)) return 'csv'
  if (name.endsWith('.xls')) return 'xls'
  // No telling extension: go by the type the browser reported.
  if (type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return 'xlsx'
  if (type === 'text/csv' || type === 'application/csv' || type === 'text/tab-separated-values') return 'csv'
  return null
}

const XLS_MESSAGE = 'Old .xls files cannot be read. Open the file in Excel, save it as .xlsx or .csv, and upload that.'

/**
 * Read an .xlsx or .csv File into raw rows: an array of rows, each an array of cells. The first
 * sheet of a workbook is read. Cells are strings, numbers, booleans or Dates (xlsx), or strings (csv);
 * hand the result to mapRows. Rows keep their sheet position, so row numbers in errors match the file.
 * Rejects with an Error whose message is fit to show to the user.
 */
export async function readSheetFile(file) {
  const kind = sheetKind(file)
  if (kind === 'xls') throw new Error(XLS_MESSAGE)
  if (kind === 'xlsx') {
    try {
      const { readSheet } = await import('read-excel-file/browser')
      return await readSheet(file)
    } catch (cause) {
      if (cause?.code === 'XLS_FILE_NOT_SUPPORTED') throw new Error(XLS_MESSAGE, { cause })
      throw new Error('This file could not be read as an Excel workbook. Check that it is a valid .xlsx file, or save it as .csv and upload that.', { cause })
    }
  }
  if (kind === 'csv') {
    const { default: Papa } = await import('papaparse')
    return new Promise((resolve, reject) => {
      Papa.parse(file, {
        header: false,
        skipEmptyLines: false, // keep blank lines so row numbers match the file
        complete: res => resolve(res.data),
        error: err => reject(new Error(err?.message ? `This file could not be read as CSV: ${err.message}` : 'This file could not be read as CSV.', { cause: err })),
      })
    })
  }
  throw new Error('Unsupported file type. Upload an .xlsx or .csv file.')
}

// ─── Templates ──────────────────────────────────────────────────────────────

const HEAD_STYLE = { fontWeight: 'bold', backgroundColor: BRAND_NAVY, textColor: '#FFFFFF', alignVertical: 'center', wrap: true }
const EXAMPLE_STYLE = { fontStyle: 'italic', textColor: '#64748B' }

// Sheet names are at most 31 characters and cannot contain : \ / ? * [ ]
const safeSheetName = name => String(name || 'Template').replace(/[:\\/?*[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31) || 'Template'

function exampleCell(col, v) {
  if (v == null || v === '') return null
  if (col.type === 'number') {
    const n = toNumber(v)
    if (n.value !== undefined) return { value: n.value, type: Number, ...EXAMPLE_STYLE }
  }
  if (col.type === 'date') {
    const d = toDate(v, { allowNA: true })
    if (d.value && d.value !== 'NA') {
      const [y, m, day] = d.value.split('-').map(Number)
      return { value: new Date(Date.UTC(y, m - 1, day)), type: Date, format: 'dd-mm-yyyy', ...EXAMPLE_STYLE }
    }
  }
  return { value: String(v), type: String, ...EXAMPLE_STYLE }
}

/**
 * The sheet definition for a template: a navy header row of the columns' headers and, if `example`
 * (an object keyed by column key) is given, one italic example row under it. The header row is
 * frozen. Pure; downloadTemplate hands this to the xlsx writer.
 */
export function templateSheet({ sheetName, columns, example } = {}) {
  const cols = Array.isArray(columns) ? columns : []
  const data = [cols.map(c => ({ value: String(c.header), ...HEAD_STYLE }))]
  if (example) data.push(cols.map(c => exampleCell(c, example[c.key])))
  return {
    data,
    sheet: safeSheetName(sheetName),
    stickyRowsCount: 1,
    columns: cols.map(c => ({ width: Math.min(40, Math.max(12, String(c.header).length + 4, String(example?.[c.key] ?? '').length + 2)) })),
  }
}

/** The template as an .xlsx Blob. */
export async function buildTemplateBlob(spec) {
  const { default: writeXlsx } = await import('write-excel-file/universal')
  return writeXlsx([templateSheet(spec)]).toBlob()
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * Build the template and download it as an .xlsx (".xlsx" is added to `filename` if missing).
 *
 *   downloadTemplate({
 *     filename: 'materials-template', sheetName: 'Materials',
 *     columns: [{ key: 'name', header: 'Material', required: true }, { key: 'qty', header: 'Quantity', type: 'number' }],
 *     example: { name: 'Cotton jersey 180 GSM', qty: 1200 },
 *   })
 */
export async function downloadTemplate({ filename = 'template', sheetName, columns, example }) {
  const blob = await buildTemplateBlob({ sheetName, columns, example })
  saveBlob(blob, /\.xlsx$/i.test(filename) ? filename : `${filename}.xlsx`)
}
