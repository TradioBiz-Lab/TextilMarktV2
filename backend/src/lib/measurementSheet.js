import ExcelJS from 'exceljs'

// A style's measurement sheet as a quality person uses it: the workbook's tabs (one per sample stage), each with its
// points of measure, the tolerance, and the required value in every size. This file reads that out of the workbook, says
// whether a measured value is inside tolerance, and writes the measured values back into a copy of the same workbook.
//
// The real sheets (FYLTR, Nov 2026): a two-row header ("MEASUREMENT POINTS", grade rules, "Tolerance ( + / - )", then
// "SIZE RANGE" over XS..4XL), a "PP REVIEW" column right after the sample size that the team fills with "ok" or the
// difference, 20 to 30 point rows, then comments. Size cells are linked formulas, so a column cannot be inserted in the
// middle (exceljs refuses); measured values go in the first free column of the table instead. The simpler demo layout
// (Code | Measurement point | Tol (cm) | sizes) reads the same way.
// The four steps a garment is measured at (Ankit, 26 Nov 2026). 'inline' is a production garment taken off the line
// while it runs, 'final' one at final inspection; the real sheets have no tab for either.
export const MEASURE_STAGES = ['fit', 'pp', 'inline', 'final']
export const STAGE_NAMES = { fit: 'Fit sample', pp: 'PP sample', inline: 'Inline QC', final: 'Final QC' }
export const UNREADABLE = 'This measurement sheet could not be read. It needs a table with a "Measurement points" column, a tolerance column and one column per size.'

const SIZE_RE = /^(xxs|xs|s|m|l|xl|xxl|xxxl|[2-6]xl|[2-6]x|\d{2})$/i
const POINT_RE = /measurement\s*points?|points?\s*of\s*measure|^\s*pom\s*$|^\s*description\s*$/i
const ADDED_RE = /^(.+) (MEASURED|REVIEW)$/
const round3 = n => Math.round(n * 1000) / 1000

/** What a cell holds, as plain text or a number: formulas give their result, rich text its words. */
export function cellValue(cell) {
  let v = cell?.value
  if (v == null) return null
  if (typeof v === 'object' && !(v instanceof Date)) {
    if (v.richText) v = v.richText.map(r => r.text).join('')
    else if (v.result !== undefined) v = v.result
    else if (v.text !== undefined) v = v.text
    else return null
  }
  if (v == null || v instanceof Date || typeof v === 'object') return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const s = String(v).replace(/\s+/g, ' ').trim()
  return s === '' ? null : s
}
const text = cell => { const v = cellValue(cell); return v == null ? '' : String(v) }
/** A number out of a cell that may say "±0.25", "0.5 cm" or 1/2; null when it is not one number. */
export function numberOf(v) {
  if (typeof v === 'number') return v
  if (typeof v !== 'string') return null
  const s = v.replace(/[±+]/g, '').replace(/(cm|in|inch|inches|")\s*$/i, '').trim()
  const frac = /^(\d+)?\s*(\d+)\s*\/\s*(\d+)$/.exec(s)
  if (frac && Number(frac[3])) return (Number(frac[1] || 0)) + Number(frac[2]) / Number(frac[3])
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null
}

// Where the table sits on one tab: header rows, the columns, the point rows. null when the tab has no such table.
function layoutOf(ws) {
  let headerRow = 0; let pointCol = 0
  for (let r = 1; r <= Math.min(ws.rowCount, 20) && !headerRow; r++) {
    ws.getRow(r).eachCell({ includeEmpty: false }, (cell, col) => { if (!headerRow && POINT_RE.test(text(cell))) { headerRow = r; pointCol = col } })
  }
  if (!headerRow) return null
  const lastCol = Math.min(ws.columnCount + 8, 60)
  // The sizes are on the header row itself, or on the row under it when the header is two rows deep ("SIZE RANGE" over
  // the sizes). The row under a one-row header holds numbers (waist 50, 53...) that only look like sizes, so it is
  // read only when the header row names fewer than two.
  let sizeRow = 0; let sizes = []
  for (const r of [headerRow, headerRow + 1]) {
    const found = []; const seen = new Set()
    for (let c = pointCol + 1; c <= lastCol; c++) { const t = text(ws.getRow(r).getCell(c)); if (SIZE_RE.test(t) && !seen.has(t.toUpperCase())) { seen.add(t.toUpperCase()); found.push({ label: t.toUpperCase(), col: c }) } }
    if (found.length > sizes.length) { sizes = found; sizeRow = r }
    if (sizes.length >= 2) break
  }
  if (!sizes.length) return null
  let tolCol = 0; let reviewCol = 0; const added = {}
  for (const r of new Set([headerRow, sizeRow])) {
    for (let c = pointCol + 1; c <= lastCol; c++) {
      const t = text(ws.getRow(r).getCell(c)); if (!t) continue
      // A column this module added earlier is headed "<SIZE> MEASURED" or "<SIZE> REVIEW"; the sheet's own "PP REVIEW" is not one.
      const mine = ADDED_RE.exec(t)
      if (mine && SIZE_RE.test(mine[1])) { added[`${mine[1].toUpperCase()} ${mine[2]}`] = c; continue }
      if (!tolCol && /tol/i.test(t)) tolCol = c
      if (!reviewCol && r === sizeRow && /review|actual|measured/i.test(t)) reviewCol = c
    }
  }
  // Merged header cells repeat their text down the merge, so a tolerance column found twice is still one column.
  const points = []
  for (let r = sizeRow + 1; r <= ws.rowCount; r++) {
    const name = text(ws.getRow(r).getCell(pointCol))
    if (!name) { if (points.length) break; continue }
    if (POINT_RE.test(name)) continue
    points.push({ row: r, name })
    if (points.length >= 150) break
  }
  if (!points.length) return null
  return { headerRow, sizeRow, pointCol, tolCol, reviewCol, sizes, points, added, lastSizeCol: Math.max(...sizes.map(s => s.col)) }
}

function stageOf(ws, layout) {
  for (let r = 1; r <= layout.headerRow; r++) {
    const cells = []; ws.getRow(r).eachCell({ includeEmpty: false }, cell => cells.push(text(cell)))
    const i = cells.findIndex(t => /sample\s*stage/i.test(t))
    const said = i === -1 ? '' : (cells.slice(i + 1).find(t => t && !/sample\s*stage/i.test(t)) || '')
    if (/\bfit\b/i.test(said)) return 'fit'
    if (/\bpp\b|pre.?production/i.test(said)) return 'pp'
  }
  if (/fit/i.test(ws.name)) return 'fit'
  if (/pp/i.test(ws.name)) return 'pp'
  return null
}

// The size the sheet was reviewed in: the one whose column sits immediately left of the review column.
const sampleSizeOf = layout => layout.sizes.find(s => layout.reviewCol && s.col === layout.reviewCol - 1)?.label || null

function tabOut(ws) {
  const layout = layoutOf(ws); if (!layout) return null
  return {
    name: ws.name, stage: stageOf(ws, layout), sizes: layout.sizes.map(s => s.label), sampleSize: sampleSizeOf(layout),
    unit: layout.tolCol && /cm/i.test(text(ws.getRow(layout.headerRow).getCell(layout.tolCol))) ? 'cm' : null,
    points: layout.points.map(p => {
      const row = ws.getRow(p.row)
      const values = {}
      for (const s of layout.sizes) { const v = cellValue(row.getCell(s.col)); values[s.label] = typeof v === 'string' ? (numberOf(v) ?? v) : v }
      return { row: p.row, name: p.name, tol: layout.tolCol ? numberOf(cellValue(row.getCell(layout.tolCol))) : null, values }
    }),
  }
}

async function load(buffer) { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buffer); return wb }

/** The workbook's readable tabs: `{ tabs: [{ name, stage, sizes, sampleSize, unit, points: [{ row, name, tol, values }] }] }` or `{ error }`. */
export async function readMeasurementWorkbook(buffer) {
  let wb
  try { wb = await load(buffer) } catch { return { error: UNREADABLE } }
  const tabs = wb.worksheets.filter(ws => ws.state !== 'hidden' && ws.state !== 'veryHidden').map(tabOut).filter(Boolean)
  return tabs.length ? { tabs } : { error: UNREADABLE }
}

/**
 * Is a measured value inside tolerance? `{ diff, ok }`: the difference from the required value (3 decimals), and ok when
 * it is within the tolerance. A required value that is not a number (text such as "6 X 1"), or nothing measured, is not
 * judged: both come back null. A sheet that gives no tolerance for the point gets the difference and no verdict.
 */
export function judge(spec, tol, measured) {
  if (typeof spec !== 'number' || typeof measured !== 'number' || !Number.isFinite(measured)) return { diff: null, ok: null }
  const diff = round3(measured - spec)
  return { diff, ok: typeof tol === 'number' ? Math.abs(diff) <= tol + 1e-9 : null }
}
/** What the team writes in the review column: "ok" when it is exactly right, else the difference. */
export const reviewMark = diff => (diff == null ? null : diff === 0 ? 'ok' : diff)

const OUT_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFECACA' } }
const HEAD_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDBEAFE' } }
const THIN = { style: 'thin', color: { argb: 'FF94A3B8' } }
const BOX = { top: THIN, left: THIN, bottom: THIN, right: THIN }

// A column of the table nobody uses: empty in the header rows and every point row, and not under a picture.
function freeColumn(ws, layout, taken) {
  const last = layout.points[layout.points.length - 1].row
  const pictures = ws.getImages().map(i => ({ c0: i.range.tl.nativeCol + 1, c1: (i.range.br?.nativeCol ?? i.range.tl.nativeCol) + 1, r0: i.range.tl.nativeRow + 1, r1: (i.range.br?.nativeRow ?? i.range.tl.nativeRow) + 1 }))
  for (let c = layout.lastSizeCol + 1; c <= layout.lastSizeCol + 12; c++) {
    if (taken.has(c)) continue
    if (pictures.some(p => c >= p.c0 && c <= p.c1 && p.r0 <= last && p.r1 >= layout.headerRow)) continue
    let empty = !text(ws.getRow(layout.sizeRow).getCell(c))
    for (const p of layout.points) if (empty && cellValue(ws.getRow(p.row).getCell(c)) != null) empty = false
    if (empty) return c
  }
  return 0
}

function writeColumn(ws, layout, col, header, valueOf, like) {
  const head = ws.getRow(layout.sizeRow).getCell(col)
  head.value = header; head.style = { ...ws.getRow(layout.sizeRow).getCell(like).style }; head.fill = HEAD_FILL; head.border = BOX
  head.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
  if (!ws.getColumn(col).width || ws.getColumn(col).width < 12) ws.getColumn(col).width = 13
  for (const p of layout.points) {
    const cell = ws.getRow(p.row).getCell(col); const { value, out } = valueOf(p.row)
    cell.style = { ...ws.getRow(p.row).getCell(like).style }
    cell.value = value ?? null; cell.border = BOX; cell.alignment = { horizontal: 'center', vertical: 'middle' }
    cell.fill = out ? OUT_FILL : { type: 'pattern', pattern: 'none' }
  }
}

// A tab of its own, plain: used for a stage the workbook has no tab for (Final QC), or when the tab has no free column.
function writeNewTab(wb, { stage, size, points, who, when, styleName }) {
  const taken = new Set(wb.worksheets.map(w => w.name.toUpperCase()))
  const base = `${(STAGE_NAMES[stage] || 'Measured').toUpperCase()} ${size}`.replace(/[\\/?*[\]:]/g, ' ').slice(0, 27)
  let name = base; for (let n = 2; taken.has(name.toUpperCase()); n++) name = `${base} ${n}`
  const ws = wb.addWorksheet(name)
  ws.columns = [{ width: 44 }, { width: 13 }, { width: 13 }, { width: 13 }, { width: 13 }]
  ws.addRow([styleName || 'Measurement record']).font = { bold: true, size: 14 }
  ws.addRow([`${STAGE_NAMES[stage] || stage} · size ${size}${who ? ` · measured by ${who}` : ''}${when ? ` · ${when}` : ''}`])
  ws.addRow([])
  const head = ws.addRow(['Measurement point', 'Tolerance (+/-)', `Required (${size})`, 'Measured', 'Review'])
  head.eachCell(c => { c.font = { bold: true }; c.fill = HEAD_FILL; c.border = BOX; c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true } })
  for (const p of points) {
    const row = ws.addRow([p.name, p.tol ?? null, p.spec ?? null, p.measured ?? null, reviewMark(p.diff)])
    row.eachCell({ includeEmpty: true }, (c, i) => { c.border = BOX; if (i > 1) c.alignment = { horizontal: 'center' }; if (p.ok === false && i >= 4) c.fill = OUT_FILL })
  }
  return name
}

/**
 * A copy of the workbook with one measured garment written in. `points` is [{ row, name, spec, tol, measured, diff, ok }]
 * for the tab `tab` and the size `size`. When the tab is the stage's own, the difference goes in the review column
 * (the one beside that size, as the team fills it by hand; else a "<SIZE> REVIEW" column) and the measured value in a
 * "<SIZE> MEASURED" column, in free columns of the table; cells outside tolerance are coloured. Otherwise, or when the
 * table has no free column, the record is written on a new tab. Returns `{ buffer, wroteTab, newTab }`.
 */
export async function writeMeasuredWorkbook(buffer, { tab, size, stage, points, intoTab = true, who = '', when = '', styleName = '' }) {
  const wb = await load(buffer)
  const ws = wb.getWorksheet(tab)
  const layout = ws ? layoutOf(ws) : null
  const sizeCol = layout?.sizes.find(s => s.label === String(size).toUpperCase())?.col
  const byRow = new Map(points.map(p => [p.row, p]))
  let wroteTab = null; let newTab = false
  if (intoTab && layout && sizeCol) {
    const S = String(size).toUpperCase()
    const taken = new Set()
    const reviewCol = layout.reviewCol && layout.reviewCol === sizeCol + 1 ? layout.reviewCol : (layout.added[`${S} REVIEW`] || 0)
    const measuredCol = layout.added[`${S} MEASURED`] || freeColumn(ws, layout, taken)
    if (measuredCol) taken.add(measuredCol)
    const ownReview = reviewCol || freeColumn(ws, layout, taken)
    if (measuredCol && ownReview) {
      writeColumn(ws, layout, measuredCol, `${S} MEASURED`, row => { const p = byRow.get(row); return { value: p?.measured ?? null, out: p?.ok === false } }, sizeCol)
      if (reviewCol && reviewCol === layout.reviewCol) {
        // The sheet's own review column keeps its heading and look; only its values and the red marks change.
        for (const p of layout.points) { const got = byRow.get(p.row); const cell = ws.getRow(p.row).getCell(reviewCol); cell.value = reviewMark(got?.diff ?? null); cell.fill = got?.ok === false ? OUT_FILL : { type: 'pattern', pattern: 'none' } }
      } else {
        writeColumn(ws, layout, ownReview, `${S} REVIEW`, row => { const p = byRow.get(row); return { value: reviewMark(p?.diff ?? null), out: p?.ok === false } }, sizeCol)
      }
      wroteTab = ws.name
    }
  }
  if (!wroteTab) { wroteTab = writeNewTab(wb, { stage, size: String(size).toUpperCase(), points, who, when, styleName }); newTab = true }
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), wroteTab, newTab }
}
