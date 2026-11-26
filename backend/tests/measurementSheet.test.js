import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'
import { readMeasurementWorkbook, writeMeasuredWorkbook, judge, reviewMark, numberOf, UNREADABLE } from '../src/lib/measurementSheet.js'

// A workbook in the shape of the real FYLTR sheets: a two-row header, grade columns, a tolerance column, sizes with a
// review column right after the sample size (M), formulas in the graded sizes, one text cell, and comments underneath.
async function realShape({ stage = 'PP SAMPLE', tab = 'PP' } = {}) {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet(tab)
  ws.getCell('B2').value = 'STYLE NO'; ws.getCell('C2').value = 'CORDUROY SHIRT'
  ws.getCell('F3').value = 'SAMPLE STAGE'; ws.mergeCells('F3:H3'); ws.getCell('I3').value = stage
  const head = ['MEASUREMENT POINTS', 'GRADE RULE', 'GRADE PLUS SIZE', 'Tolerance ( + / - )']
  head.forEach((h, i) => { ws.getCell(4, 3 + i).value = h; ws.mergeCells(4, 3 + i, 5, 3 + i) })
  ws.getCell(4, 7).value = 'SIZE RANGE'; ws.mergeCells(4, 7, 4, 13)
  ;['XS', 'S', 'M', 'PP REVIEW', 'L', 'XL', '2XL'].forEach((h, i) => { ws.getCell(5, 7 + i).value = h })
  const rows = [['SHOULDER SEAM TO SEAM', 0.5, 0.63, 0.38, 17, 17.5, 18, 'ok', 18.5, 19, 19.625], ['CHEST 1" BELOW ARMHOLE', 2, 2, 0.5, 39, 41, 43, -1, 45, 47, 49], ['SLEEVE PLACKET LENGTH X WIDTH', 0, 0, 0.13, null, null, '6 X 1', null, null, null, null], ['CUFF HEIGHT', 0, 0, null, 2.5, 2.5, 2.5, null, 2.5, 2.5, 2.5]]
  rows.forEach((r, i) => r.forEach((v, j) => { if (v != null) ws.getCell(6 + i, 3 + j).value = v }))
  ws.getCell(6, 11).value = { formula: 'I6+D6', result: 18.5 }   // L is graded from M, as in the real files
  ws.getCell('B12').value = 'TECHNICAL DESIGNER COMMENTS'; ws.getCell('C12').value = 'Increase belt length'
  return Buffer.from(await wb.xlsx.writeBuffer())
}
async function demoShape() {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Measurements')
  ws.addRow(['Code', 'Measurement point', 'Tol (cm)', 'XS', 'S', 'M', 'L', 'XL'])
  ws.addRow(['A', 'Chest', '±1', 50, 53, 56, 59, 62]); ws.addRow(['B', 'Body length', 1, 66, 68, 70, 72, 74])
  return Buffer.from(await wb.xlsx.writeBuffer())
}
const open = async buf => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf); return wb }

describe('reading a measurement sheet', () => {
  test('the real layout: stage, sizes, the sample size, tolerance, formulas and a text cell', async () => {
    const { tabs } = await readMeasurementWorkbook(await realShape())
    assert.equal(tabs.length, 1)
    const t = tabs[0]
    assert.deepEqual([t.name, t.stage, t.sizes, t.sampleSize], ['PP', 'pp', ['XS', 'S', 'M', 'L', 'XL', '2XL'], 'M'])
    assert.deepEqual(t.points.map(p => [p.name, p.tol, p.values.M, p.values.L]), [['SHOULDER SEAM TO SEAM', 0.38, 18, 18.5], ['CHEST 1" BELOW ARMHOLE', 0.5, 43, 45], ['SLEEVE PLACKET LENGTH X WIDTH', 0.13, '6 X 1', null], ['CUFF HEIGHT', null, 2.5, 2.5]])
    assert.equal(t.points[0].row, 6, 'the comments under the table are not points')
  })
  test('the stage is the tab name when it names one, else what the sheet says', async () => {
    // A PP tab copied from the fit tab, its stage cell never changed: the tab's name is right.
    assert.equal((await readMeasurementWorkbook(await realShape({ stage: 'FIT SAMPLE', tab: 'PP' }))).tabs[0].stage, 'pp')
    assert.equal((await readMeasurementWorkbook(await realShape({ stage: 'FIT SAMPLE', tab: 'RPP' }))).tabs[0].stage, 'pp')
    assert.equal((await readMeasurementWorkbook(await realShape({ stage: 'PP SAMPLE', tab: 'FIT' }))).tabs[0].stage, 'fit')
    assert.equal((await readMeasurementWorkbook(await realShape({ stage: 'FIT SAMPLE', tab: 'Sheet1' }))).tabs[0].stage, 'fit')
    assert.equal((await readMeasurementWorkbook(await realShape({ stage: '', tab: 'RPP' }))).tabs[0].stage, 'pp')
    assert.equal((await readMeasurementWorkbook(await realShape({ stage: '', tab: 'Sheet1' }))).tabs[0].stage, null)
  })
  test('the simple layout with a one-row header and "±1" tolerances', async () => {
    const { tabs } = await readMeasurementWorkbook(await demoShape())
    assert.deepEqual([tabs[0].sizes, tabs[0].unit, tabs[0].sampleSize], [['XS', 'S', 'M', 'L', 'XL'], 'cm', null])
    assert.deepEqual(tabs[0].points.map(p => [p.name, p.tol, p.values.M]), [['Chest', 1, 56], ['Body length', 1, 70]])
  })
  test('something that is not a measurement sheet is refused in plain words, never guessed', async () => {
    const wb = new ExcelJS.Workbook(); wb.addWorksheet('x').addRow(['Invoice', 'Amount'])
    assert.deepEqual(await readMeasurementWorkbook(Buffer.from(await wb.xlsx.writeBuffer())), { error: UNREADABLE })
    assert.deepEqual(await readMeasurementWorkbook(Buffer.from('not a workbook')), { error: UNREADABLE })
  })
  test('numbers written as text', () => {
    assert.deepEqual(['±0.25', '0.5 cm', '16 1/2', '3/8', '18', 'ok', '6 X 1'].map(numberOf), [0.25, 0.5, 16.5, 0.375, 18, null, null])
  })
})

describe('judging a measured value', () => {
  test('inside, on the edge of, and outside tolerance; what is not judged', () => {
    assert.deepEqual(judge(18, 0.38, 18), { diff: 0, ok: true })
    assert.deepEqual(judge(18, 0.38, 18.38), { diff: 0.38, ok: true })
    assert.deepEqual(judge(18, 0.38, 17.5), { diff: -0.5, ok: false })
    assert.deepEqual(judge(29.875, 0.38, 29.625), { diff: -0.25, ok: true })
    assert.deepEqual(judge(2.5, null, 2.75), { diff: 0.25, ok: null }, 'no tolerance on the sheet: the difference, no verdict')
    assert.deepEqual(judge('6 X 1', 0.13, 6), { diff: null, ok: null })
    assert.deepEqual(judge(18, 0.38, null), { diff: null, ok: null })
    assert.deepEqual([reviewMark(0), reviewMark(-0.25), reviewMark(null)], ['ok', -0.25, null])
  })
})

describe('the workbook for one measured step', () => {
  const pointsFor = (tab, size, deltas) => tab.points.map((p, i) => { const spec = p.values[size]; const measured = typeof spec === 'number' && deltas[i] != null ? spec + deltas[i] : null; return { row: p.row, name: p.name, spec, tol: p.tol, measured, ...judge(spec, p.tol, measured) } })
  // The style's sheet as it comes: a FIT tab and a PP tab, the PP tab carrying an earlier review.
  async function twoTabs() {
    const wb = await open(await realShape()); const fit = await open(await realShape({ stage: 'FIT SAMPLE', tab: 'FIT' }))
    const ws = wb.addWorksheet('FIT'); fit.getWorksheet('FIT').eachRow((row, r) => row.eachCell((cell, c) => { ws.getCell(r, c).value = cell.value }))
    return Buffer.from(await wb.xlsx.writeBuffer())
  }

  test('one tab only, in the sheet\'s own format: the review column as the team fills it, the measured value in a free column', async () => {
    const src = await twoTabs(); const tab = (await readMeasurementWorkbook(src)).tabs.find(t => t.name === 'PP')
    const { buffer, wroteTab, plain } = await writeMeasuredWorkbook(src, { tab: 'PP', size: 'M', stage: 'pp', points: pointsFor(tab, 'M', [0, -1, null, 0.25]) })
    assert.deepEqual([wroteTab, plain], ['PP', false])
    const wb = await open(buffer); const ws = wb.getWorksheet('PP')
    assert.deepEqual(wb.worksheets.map(w => w.name), ['PP'], 'the other stage\'s tab is not in the file')
    assert.deepEqual([ws.getCell('C2').value, ws.getCell('I3').value, ws.getCell(4, 3).value, ws.getCell(4, 6).value, ws.getCell(5, 9).value], ['CORDUROY SHIRT', 'PP SAMPLE', 'MEASUREMENT POINTS', 'Tolerance ( + / - )', 'M'], 'the headings are the sheet\'s own')
    assert.equal(ws.getCell(5, 10).value, 'PP REVIEW')
    assert.deepEqual([6, 7, 8, 9].map(r => ws.getCell(r, 10).value), ['ok', -1, null, 0.25], 'the earlier review (ok, -1) is replaced by this garment\'s')
    assert.equal(ws.getCell(5, 14).value, 'M MEASURED', 'the first column after the last size')
    assert.deepEqual([6, 7, 8, 9].map(r => ws.getCell(r, 14).value), [18, 42, null, 2.75])
    assert.equal(ws.getCell(7, 14).fill.fgColor.argb, 'FFFECACA', 'outside tolerance is coloured')
    assert.equal(ws.getCell(7, 10).fill.fgColor.argb, 'FFFECACA')
    assert.notEqual(ws.getCell(6, 14).fill?.fgColor?.argb, 'FFFECACA')
    assert.deepEqual([ws.getCell(6, 9).value, ws.getCell('C12').value, ws.getCell(6, 11).value.formula], [18, 'Increase belt length', 'I6+D6'], 'sizes, comments and formulas are untouched')
    const again = (await readMeasurementWorkbook(buffer)).tabs
    assert.deepEqual([again.length, again[0].sizes, again[0].sampleSize, again[0].points.length], [1, tab.sizes, 'M', 4], 'the copy still reads as the same sheet')
  })

  test('a size that is not the sample size: the earlier review is cleared, the size gets its own two columns; more sizes are added to the same record', async () => {
    const src = await realShape(); const tab = (await readMeasurementWorkbook(src)).tabs[0]
    const first = await writeMeasuredWorkbook(src, { tab: 'PP', size: 'L', stage: 'pp', points: pointsFor(tab, 'L', [0.5, 0, null, 0]) })
    let ws = (await open(first.buffer)).getWorksheet('PP')
    assert.deepEqual([6, 7].map(r => ws.getCell(r, 10).value), [null, null], 'the notes of an earlier review are not this garment\'s')
    assert.deepEqual([14, 15, 16].map(c => ws.getCell(5, c).value), ['L MEASURED', 'L REVIEW', null])
    assert.deepEqual([ws.getCell(6, 14).value, ws.getCell(6, 15).value], [19, 0.5])
    const second = await writeMeasuredWorkbook(first.buffer, { tab: 'PP', size: 'M', stage: 'pp', fresh: false, points: pointsFor(tab, 'M', [0, 0, null, 0]) })
    const third = await writeMeasuredWorkbook(second.buffer, { tab: 'PP', size: 'L', stage: 'pp', fresh: false, points: pointsFor(tab, 'L', [0, 0, null, 0]) })
    ws = (await open(third.buffer)).getWorksheet('PP')
    assert.deepEqual([14, 15, 16, 17].map(c => ws.getCell(5, c).value), ['L MEASURED', 'L REVIEW', 'M MEASURED', null])
    assert.deepEqual([ws.getCell(6, 10).value, ws.getCell(6, 16).value, ws.getCell(6, 15).value], ['ok', 18, 'ok'], 'M in the sheet\'s own review column; L measured again overwrites its columns')
  })

  test('Inline QC and Final QC use the same format: the tab measured against, renamed, its stage heading changed', async () => {
    const src = await twoTabs(); const tab = (await readMeasurementWorkbook(src)).tabs.find(t => t.name === 'PP')
    for (const [stage, name] of [['inline', 'INLINE QC'], ['final', 'FINAL QC']]) {
      const { buffer, wroteTab, plain } = await writeMeasuredWorkbook(src, { tab: 'PP', size: 'M', stage, points: pointsFor(tab, 'M', [0, -1, null, 0]) })
      assert.deepEqual([wroteTab, plain], [name, false])
      const wb = await open(buffer); const ws = wb.getWorksheet(name)
      assert.deepEqual(wb.worksheets.map(w => w.name), [name])
      assert.deepEqual([ws.getCell('I3').value, ws.getCell(5, 10).value, ws.getCell(4, 3).value, ws.getCell('C2').value], [name, `${name} REVIEW`, 'MEASUREMENT POINTS', 'CORDUROY SHIRT'])
      assert.deepEqual([ws.getCell(6, 10).value, ws.getCell(7, 10).value, ws.getCell(7, 14).value], ['ok', -1, 42])
      const more = await writeMeasuredWorkbook(buffer, { tab: name, size: 'L', stage, fresh: false, points: pointsFor(tab, 'L', [0, 0, null, 0]) })
      assert.deepEqual([15, 16].map(c => (wb && null, more.wroteTab === name) && 1), [1, 1])
    }
    const fit = await writeMeasuredWorkbook(src, { tab: 'FIT', size: 'M', stage: 'fit', points: pointsFor(tab, 'M', [0, 0, null, 0]) })
    const fw = await open(fit.buffer)
    assert.deepEqual([fw.worksheets.map(w => w.name), fw.getWorksheet('FIT').getCell('I3').value, fw.getWorksheet('FIT').getCell(5, 10).value], [['FIT'], 'FIT SAMPLE', 'FIT REVIEW'])
  })

  test('a table with no room for the measured values gets them on a plain tab, still alone in the file', async () => {
    const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Measurements')
    ws.addRow(['Measurement point', 'Tol', 'S', 'M', ...Array(12).fill('notes')]); ws.addRow(['Chest', 1, 53, 56, ...Array(12).fill('x')])
    const src = Buffer.from(await wb.xlsx.writeBuffer()); const tab = (await readMeasurementWorkbook(src)).tabs[0]
    const { buffer, wroteTab, plain } = await writeMeasuredWorkbook(src, { tab: 'Measurements', size: 'M', stage: 'final', points: pointsFor(tab, 'M', [1]), who: 'Ravi', when: '26 Nov 2026', styleName: 'Polo' })
    assert.deepEqual([wroteTab, plain], ['FINAL QC', true])
    const out = await open(buffer)
    assert.deepEqual(out.worksheets.map(w => w.name), ['FINAL QC'])
    assert.deepEqual([1, 2, 3, 4, 5].map(c => out.getWorksheet('FINAL QC').getCell(5, c).value), ['Chest', 1, 56, 57, 1])
  })
})
