import { describe, test, expect } from 'vitest'
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
