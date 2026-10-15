import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { generateSummary, rowCallout } from '../dashboardSummary.js'
import { splitDue } from '../constants.js'

// A split whose Delivery step was moved from the promised 15 Dec to 20 Dec.
const delivery = { name: 'Delivery', isDelivery: true, kind: 'milestone', status: 'not_started', unitsDone: 0, totalUnits: 1, baselineEta: '2026-12-15', eta: '2026-12-20' }
const asgn = { mid: 'm1', qty: 100, mfrCompany: 'T', status: 'Processing', stages: [{ name: 'Cutting', kind: 'milestone', status: 'not_started', unitsDone: 0, totalUnits: 1, baselineEta: '2026-11-01', eta: null }, delivery] }
const order = { id: 'ORD-1', product: 'Heavy sweatshirt', buyerCompany: 'Zara India', delivery: '2026-12-15', assignments: [asgn] }

describe('the AI summary counts to the revised delivery date', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-15T10:00:00Z')) })
  afterEach(() => vi.useRealTimers())

  test('a split is due on its Delivery step\'s current date, else on the promised one', () => {
    expect(splitDue(order, asgn)).toEqual({ date: '2026-12-20', expected: '2026-12-20', promised: '2026-12-15', revised: true })
    expect(splitDue(order, { stages: [] }).date).toBe('2026-12-15')
  })

  test('the dashboard names the revised date and still mentions the promise', async () => {
    const text = (await generateSummary({ role: 'admin', user: { id: 'a1' }, orders: [order], actionItems: [] })).lines.join('\n')
    expect(text).toMatch(/Next delivery: \*\*Heavy sweatshirt\*\* for Zara India on 20 Dec 2026 \(in 66 days; promised 15 Dec 2026\)/)
  })

  test("a style's one-liner in Reports uses the revised date", () => {
    const line = rowCallout({ order, stages: asgn.stages, live: [], blocked: [], late: [], working: [], upcoming: null, health: 'ontrack', doneCount: 0, daysToDelivery: 66, due: splitDue(order, asgn) })
    expect(line).not.toMatch(/15 Dec/)
    expect(rowCallout({ order, stages: asgn.stages, live: [], blocked: [], late: [], working: [], upcoming: { stage: asgn.stages[0] }, health: 'ontrack', doneCount: 1, daysToDelivery: 66, due: splitDue(order, asgn) })).toMatch(/delivery 20 Dec 2026 \(66d\)/)
  })
})
