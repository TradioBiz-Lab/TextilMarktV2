import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { generateSummary } from '../dashboardSummary.js'

const stage = (over = {}) => ({ name: 'Cutting', kind: 'milestone', status: 'in_progress', unitsDone: 0, totalUnits: 1, eta: null, baselineEta: '2026-10-20', blocked: false, ...over })
const order = (over = {}) => ({
  id: 'ORD-1', product: 'Slim Jeans', buyerCompany: 'Zara India', delivery: '2026-12-31',
  assignments: [{ mid: 'm1', qty: 100, mfrCompany: 'Tiruppur Textiles', status: 'Processing', stages: [stage()] }],
  ...over,
})
const run = (orders, role = 'admin') => generateSummary({ role, user: { id: 'a1', name: 'Admin' }, orders, actionItems: [] }).then(r => r.lines.join('\n'))

describe('dashboard summary', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-07T10:00:00Z')) })
  afterEach(() => vi.useRealTimers())

  test('with no orders it says there is nothing to summarise', async () => {
    expect(await run([])).toMatch(/No orders yet/)
  })

  test('styles with no manufacturer yet are not reported as "no orders"', async () => {
    const text = await run([order({ assignments: [] }), order({ id: 'ORD-2', assignments: [] })])
    expect(text).toMatch(/2 styles have been created but no manufacturer is assigned/)
    expect(text).not.toMatch(/No orders yet/)
  })

  test('a stage past its baseline date counts as late even though it was never revised', async () => {
    const late = order({ assignments: [{ mid: 'm1', qty: 100, mfrCompany: 'T', status: 'Processing', stages: [stage({ baselineEta: '2026-10-01' })] }] })
    expect(await run([late])).toMatch(/1 late/)
  })

  test('a missing customer name does not print "(null)"', async () => {
    const blocked = order({ buyerCompany: null, assignments: [{ mid: 'm1', qty: 100, mfrCompany: 'T', status: 'Processing',
      stages: [stage({ blocked: true, blockedReason: 'Waiting on trims' })] }] })
    const text = await run([blocked])
    expect(text).not.toMatch(/null|undefined/)
    expect(text).toMatch(/unknown customer/)
  })

  test('a manufacturer only hears about their own splits', async () => {
    const mixed = order({ assignments: [
      { mid: 'm1', qty: 100, mfrCompany: 'Mine', status: 'Processing', stages: [stage()] },
      { mid: 'm2', qty: 100, mfrCompany: 'Theirs', status: 'Processing', stages: [stage({ blocked: true, blockedReason: 'Fabric delay' })] },
    ] })
    const text = await generateSummary({ role: 'manufacturer', user: { id: 'm1' }, orders: [mixed], actionItems: [] }).then(r => r.lines.join('\n'))
    expect(text).toMatch(/0 blocked/)          // the other factory's blocked step is not counted
    expect(text).not.toMatch(/Fabric delay|Theirs/)
  })
})
