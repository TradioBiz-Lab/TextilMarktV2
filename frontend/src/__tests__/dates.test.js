import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { getToday, dayNumber, effectiveEta, stageIsOverdue, isStageDone, stageStatusOf, planProgress } from '../constants.js'

describe('India-time day boundary', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('getToday follows IST, not UTC', () => {
    vi.setSystemTime(new Date('2026-10-07T20:00:00Z')) // 01:30 on the 8th in India
    expect(getToday()).toBe('2026-10-08')
    vi.setSystemTime(new Date('2026-10-07T18:29:00Z')) // 23:59 on the 7th in India
    expect(getToday()).toBe('2026-10-07')
  })

  test('dayNumber reads only the date part and rejects junk', () => {
    expect(dayNumber('2026-10-08') - dayNumber('2026-10-07')).toBe(1)
    expect(dayNumber('2026-10-07T23:59:59.000Z')).toBe(dayNumber('2026-10-07'))
    expect(dayNumber('NA')).toBeNull()
    expect(dayNumber('')).toBeNull()
    expect(dayNumber(null)).toBeNull()
  })

  test('a stage is overdue only after its end date has passed in India', () => {
    const stage = { status: 'in_progress', eta: '2026-10-07' }
    vi.setSystemTime(new Date('2026-10-07T20:00:00Z')) // already the 8th in India
    expect(stageIsOverdue(stage)).toBe(true)
    vi.setSystemTime(new Date('2026-10-07T10:00:00Z')) // still the 7th
    expect(stageIsOverdue(stage)).toBe(false)
  })
})

describe('effectiveEta', () => {
  test('uses the revised date, then the baseline, and ignores NA', () => {
    expect(effectiveEta({ eta: '2026-09-02', baselineEta: '2026-08-30' })).toBe('2026-09-02')
    expect(effectiveEta({ eta: null, baselineEta: '2026-08-30' })).toBe('2026-08-30') // an unrevised stage, e.g. the Delivery step
    expect(effectiveEta({ eta: 'NA', baselineEta: '2026-08-30' })).toBe('2026-08-30')
    expect(effectiveEta({ eta: null, baselineEta: 'NA' })).toBeNull()
    expect(effectiveEta({})).toBeNull()
  })

  test('an unrevised stage past its baseline date is overdue (it used to read as having no date)', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-07T10:00:00Z'))
    expect(stageIsOverdue({ status: 'not_started', eta: null, baselineEta: '2026-10-01' })).toBe(true)
    vi.useRealTimers()
  })

  test('a finished stage is never overdue', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-07T10:00:00Z'))
    expect(stageIsOverdue({ status: 'done', eta: '2026-09-01' })).toBe(false)
    vi.useRealTimers()
  })
})

describe('stage status', () => {
  test('falls back to units for a legacy stage with no status', () => {
    expect(stageStatusOf({ unitsDone: 0, totalUnits: 10 })).toBe('not_started')
    expect(stageStatusOf({ unitsDone: 4, totalUnits: 10 })).toBe('in_progress')
    expect(isStageDone({ unitsDone: 10, totalUnits: 10 })).toBe(true)
    expect(isStageDone({ status: 'done' })).toBe(true)
  })
})

describe('planProgress (the one definition of % complete: steps done)', () => {
  test('counts steps that are done, not units', () => {
    const stages = [
      { kind: 'quantity', status: 'in_progress', unitsDone: 900, totalUnits: 1000 }, // 90% of units, but not done
      { kind: 'milestone', status: 'done', unitsDone: 1, totalUnits: 1 },
      { kind: 'milestone', status: 'not_started', unitsDone: 0, totalUnits: 1 },
      { kind: 'milestone', status: 'done', unitsDone: 1, totalUnits: 1, isDelivery: true },
    ]
    expect(planProgress(stages)).toEqual({ done: 2, total: 4, pct: 50 })
  })

  test('uses the step status, so a done stage counts even if its units disagree', () => {
    expect(planProgress([{ status: 'done', unitsDone: 0, totalUnits: 5 }]).pct).toBe(100)
  })

  test('an empty or missing plan is 0%, not NaN', () => {
    expect(planProgress([])).toEqual({ done: 0, total: 0, pct: 0 })
    expect(planProgress(undefined)).toEqual({ done: 0, total: 0, pct: 0 })
  })
})
