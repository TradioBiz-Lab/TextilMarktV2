import { describe, test, expect, vi } from 'vitest'
import { deliveryStatus } from '../constants.js'
import { rowCallout } from '../dashboardSummary.js'

const done = (name, over = {}) => ({ name, kind: 'milestone', status: 'done', unitsDone: 1, totalUnits: 1, ...over })
const open = name => ({ name, kind: 'quantity', status: 'not_started', unitsDone: 0, totalUnits: 453, eta: 'NA', baselineEta: 'NA' })
const order = { delivery: '2026-08-21T00:00:00.000Z' }

describe('deliveryStatus', () => {
  // The A-Line Smocked Pocket Dress: delivered on 6 Oct with one unrelated step never started.
  test('a done Delivery step means delivered, even with a step left open', () => {
    const asgn = { status: 'Delivered', stages: [open('Fit Sample'), done('Inspection'), done('Delivery', { isDelivery: true, actualEnd: '2026-10-06' })] }
    expect(deliveryStatus(order, asgn)).toEqual({ delivered: true, date: '2026-10-06', isActual: true })
  })

  // The Smocked Waist Top: promised 21 Aug, delivered 28 Aug. Show the real day, not the promise.
  test('shows the actual delivery day rather than the promised one', () => {
    const asgn = { status: 'Delivered', stages: [done('Inspection'), done('Delivery', { isDelivery: true, actualEnd: '2026-08-28' })] }
    expect(deliveryStatus(order, asgn).date).toBe('2026-08-28')
  })

  test('an open split shows the promised date', () => {
    const asgn = { status: 'Processing', stages: [done('Inspection'), { ...open('Delivery'), isDelivery: true }] }
    expect(deliveryStatus(order, asgn)).toEqual({ delivered: false, date: order.delivery, isActual: false })
  })

  test('plans without a Delivery step are delivered when every step is done', () => {
    expect(deliveryStatus(order, { stages: [done('A'), done('B')] }).delivered).toBe(true)
    expect(deliveryStatus(order, { stages: [done('A'), open('B')] }).delivered).toBe(false)
    expect(deliveryStatus(order, { stages: [] }).delivered).toBe(false)
  })
})

describe('rowCallout for a delivered split', () => {
  test('names the delivery day and any step left open', () => {
    const stages = [open('Fit Sample'), done('Delivery', { isDelivery: true, actualEnd: '2026-10-06' })]
    const text = rowCallout({ order, stages, live: [], blocked: [], late: [], working: [], upcoming: null, health: 'done', doneCount: 1, daysToDelivery: null, delivery: deliveryStatus(order, { stages }) })
    expect(text).toBe('Delivered on 6 Oct, due 21 Aug. 1 step left open in the plan.')
  })
})

describe('rowCallout for a delayed split', () => {
  const FIXED_TODAY = new Date('2026-10-20T06:00:00Z')
  const late = (over = {}) => ({ name: 'Stitching', kind: 'milestone', status: 'in_progress', unitsDone: 0, totalUnits: 1, startDate: '2026-10-01', baselineEta: '2026-10-12', eta: '2026-10-17', ...over })
  const deliveryStep = { name: 'Delivery', kind: 'milestone', status: 'not_started', isDelivery: true, baselineEta: '2026-10-21', eta: null }
  const row = (stages, delivery = '2026-10-21T00:00:00.000Z') => ({
    order: { delivery }, stages, live: [{ stage: stages[0], index: 0 }], blocked: [], late: [{ stage: stages[0], index: 0 }], working: [],
    upcoming: null, health: 'late', doneCount: 0, daysToDelivery: 1,
  })
  const at = fn => { vi.useFakeTimers(); vi.setSystemTime(FIXED_TODAY); try { return fn() } finally { vi.useRealTimers() } }

  test('gives the planned and revised dates of the late step', () => {
    at(() => expect(rowCallout(row([late(), deliveryStep]))).toMatch(/3 days behind at Stitching \(planned 12 Oct, revised to 17 Oct\)/))
  })

  test('an unrevised late step shows its due date', () => {
    at(() => expect(rowCallout(row([late({ eta: null, baselineEta: '2026-10-17' }), deliveryStep]))).toMatch(/behind at Stitching \(due 17 Oct\)\. Delivery 21 Oct \(1d\) at risk\./))
  })

  test('states the new expected delivery date when the plan now runs past the promise', () => {
    const pushed = { ...deliveryStep, eta: '2026-10-28' }
    at(() => expect(rowCallout(row([late(), pushed]))).toMatch(/Now expected 28 Oct, 7 days past the 21 Oct delivery date\./))
  })
})
