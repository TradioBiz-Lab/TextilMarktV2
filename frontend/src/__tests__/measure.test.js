import { describe, test, expect } from 'vitest'
import { tabForStage, defaultSize, keyTerms, parseTyped, judge, mergeRead, summary, pointsPayload, show, valuesOf, draftFor, lastDoneFor, latestDraft, resumeFrom } from '../measure.js'

const tab = { name: 'PP', stage: 'pp', sizes: ['S', 'M', 'L'], sampleSize: 'M', points: [
  { name: 'SHOULDER SEAM TO SEAM @ BACK', tol: 0.38, values: { S: 17.5, M: 18, L: 18.5 } },
  { name: 'CHEST 1” BELOW ARM HOLE ALL AROUND', tol: 0.5, values: { S: 41, M: 43, L: 45 } },
  { name: 'SLEEVE PLACKET LENGTH X WIDTH', tol: 0.13, values: { M: '6 X 1' } },
  { name: 'CUFF HEIGHT', tol: null, values: { S: 2.5, M: 2.5, L: 2.5 } },
] }

describe('measuring a garment against the sheet', () => {
  test('the tab for a stage is the sheet\'s own, else the first; the size starts on the sample size', () => {
    const fit = { name: 'FIT', stage: 'fit', sizes: ['XS', 'S', 'M', 'L', 'XL'], sampleSize: null, points: [] }
    expect(tabForStage([fit, tab], 'pp').name).toBe('PP')
    expect(tabForStage([fit, tab], 'final').name).toBe('FIT')
    expect(tabForStage([], 'pp')).toBe(null)
    expect([defaultSize(tab), defaultSize(fit), defaultSize(null)]).toEqual(['M', 'M', ''])
  })
  test('the transcriber is given short forms of the point names', () => {
    expect(keyTerms(tab)).toEqual(['SHOULDER SEAM TO SEAM', 'CHEST 1 BELOW ARM', 'SLEEVE PLACKET LENGTH X', 'CUFF HEIGHT'])
  })
  test('typed values: decimals, fractions, a comma; anything else is not a number', () => {
    expect(['16.5', ' 16 1/2 ', '3/8', '16,25', '18', '', 'ok', '-1', '1/0'].map(parseTyped)).toEqual([16.5, 16.5, 0.375, 16.25, 18, null, null, null, null])
  })
  test('the verdict matches the server\'s', () => {
    expect(judge(18, 0.38, 18.38)).toEqual({ diff: 0.38, ok: true })
    expect(judge(43, 0.5, 42)).toEqual({ diff: -1, ok: false })
    expect(judge(2.5, null, 2.75)).toEqual({ diff: 0.25, ok: null })
    expect(judge('6 X 1', 0.13, 6)).toEqual({ diff: null, ok: null })
  })
  test('a second recording changes only the points he named; the count says what is left', () => {
    const first = mergeRead({}, [{ index: 0, value: 18 }, { index: 1, value: 42 }])
    const second = mergeRead(first, [{ index: 1, value: 43.25 }, { index: 3, value: 2.5 }])
    expect(second).toEqual({ 0: '18', 1: '43.25', 3: '2.5' })
    expect(summary(tab, 'M', first)).toEqual({ filled: 2, missing: 2, out: 1, bad: 0, total: 4 })
    expect(summary(tab, 'M', { ...second, 2: 'six' })).toEqual({ filled: 3, missing: 0, out: 0, bad: 1, total: 4 })
    expect(pointsPayload(tab, { ...second, 2: '' })).toEqual([{ index: 0, measured: 18 }, { index: 1, measured: 43.25 }, { index: 3, measured: 2.5 }])
    expect([show(29.875), show(18), show(-0.25), show(null), show('6 X 1')]).toEqual(['29.875', '18', '-0.25', '', '6 X 1'])
  })

  test('picking up an unfinished garment: the session for the same factory, stage and size; the device copy when it is newer', () => {
    const pts = m => m.map(x => ({ name: 'p', measured: x }))
    const sessions = [
      { id: 'd1', status: 'draft', mfrId: 'f1', stage: 'pp', size: 'M', updatedAt: '2026-11-26T10:00:00Z', at: '2026-11-26T09:00:00Z', points: pts([18, null, 25.5]) },
      { id: 'd2', status: 'draft', mfrId: 'f1', stage: 'fit', size: 'L', updatedAt: '2026-11-26T11:00:00Z', at: '2026-11-26T11:00:00Z', points: pts([1]) },
      { id: 'f1', status: 'final', mfrId: 'f1', stage: 'pp', size: 'M', updatedAt: '2026-11-20T10:00:00Z', at: '2026-11-20T10:00:00Z', points: pts([18, 43, 25.5]) },
      { id: 'f0', status: 'final', mfrId: 'f1', stage: 'pp', size: 'M', updatedAt: '2026-11-10T10:00:00Z', at: '2026-11-10T10:00:00Z', points: pts([17]) },
      { id: 'x', status: 'draft', mfrId: 'f2', stage: 'pp', size: 'M', updatedAt: '2026-11-26T12:00:00Z', at: '2026-11-26T12:00:00Z', points: pts([9]) },
    ]
    const key = { mfrId: 'f1', stage: 'pp', size: 'M' }
    expect(draftFor(sessions, key).id).toBe('d1')
    expect(draftFor(sessions, { ...key, size: 'S' })).toBe(null)
    expect(lastDoneFor(sessions, key).id).toBe('f1')
    expect([latestDraft(sessions, 'f1').id, latestDraft(sessions, null).id, latestDraft([], 'f1')]).toEqual(['d2', 'x', null])
    expect(valuesOf(sessions[0])).toEqual({ 0: '18', 2: '25.5' })
    const older = { values: { 0: '17' }, transcript: '', at: Date.parse('2026-11-26T09:30:00Z') }
    const newer = { values: { 0: '18', 1: '42' }, transcript: 'chest 42', at: Date.parse('2026-11-26T10:05:00Z') }
    expect(resumeFrom(sessions[0], older)).toEqual({ values: { 0: '18', 2: '25.5' }, transcript: '', from: 'server' })
    expect(resumeFrom(sessions[0], newer)).toEqual({ values: { 0: '18', 1: '42' }, transcript: 'chest 42', from: 'device' })
    expect(resumeFrom(null, newer).from).toBe('device')
    expect(resumeFrom(null, null)).toBe(null)
    expect(resumeFrom(null, { values: {}, transcript: '', at: Date.now() })).toBe(null)
  })
})
