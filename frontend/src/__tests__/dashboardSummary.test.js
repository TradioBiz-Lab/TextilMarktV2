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

  // The server works Delayed out from the plan (an open step past its date, revised or not); the summary reads it.
  test('a split the server reports as Delayed is counted as delayed, and a held one is left out', async () => {
    const late = order({ assignments: [{ mid: 'm1', qty: 100, mfrCompany: 'T', status: 'Delayed', stages: [stage({ baselineEta: '2026-10-01' })] }] })
    expect(await run([late])).toMatch(/1 delayed/)
    const held = order({ id: 'ORD-H', assignments: [{ mid: 'm1', qty: 100, mfrCompany: 'T', status: 'On Hold', stages: [stage({ baselineEta: '2026-10-01' })] }] })
    expect(await run([held])).not.toMatch(/1 delayed/)
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

describe('dashboard summary: Replen and New Product Development', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-03T10:00:00Z')) })
  afterEach(() => vi.useRealTimers())
  const runPre = (orders, preOrders, role = 'buyer') => generateSummary({ role, user: { id: 'b1', name: 'Buyer' }, orders, preOrders, actionItems: [] }).then(r => r.lines.join('\n'))
  const replen = (over = {}) => order({ id: `R-${Math.random()}`, phase: 'replen', totalQty: null, delivery: null, assignments: [], ...over })

  test('says how many replen styles there are, which have a factory, what is late and what lands first', async () => {
    const pre = [
      replen({ product: 'Flared Top', totalQty: 1200, delivery: '2026-12-15', assignments: [{ mid: 'm1', qty: 1200, status: 'Processing', stages: [stage({ baselineEta: '2026-10-25' })] }] }),
      replen({ product: 'Midi Dress', totalQty: 500, delivery: '2027-01-10' }),
      replen({ product: 'Skirt' }),
    ]
    const text = await runPre([order({ delivery: '2026-12-31' })], pre)
    expect(text).toMatch(/Replen: \*\*3 styles\*\* \(1,700 pcs\), 1 with a factory and 2 waiting for one; 1 step past plan\. Earliest expected delivery: \*\*Flared Top\*\* on 15 Dec 2026\./)
  })

  test('New Product Development gets its own line, and nothing is said for an empty stage', async () => {
    const text = await runPre([], [replen({ phase: 'development', product: 'Wrap Dress' })])
    expect(text).toMatch(/New product development: \*\*1 style\*\*, none with a factory yet\./)
    expect(text).not.toMatch(/Replen:/)
    expect(text).not.toMatch(/No orders yet/)
  })

  test('with everything in production delivered, the replen line still comes through', async () => {
    const done = order({ assignments: [{ mid: 'm1', qty: 100, status: 'Delivered', stages: [stage({ isDelivery: true, status: 'done', unitsDone: 1 })] }] })
    const text = await runPre([done], [replen({ product: 'Flared Top' })])
    expect(text).toMatch(/delivered, nothing is in progress/)
    expect(text).toMatch(/Replen: \*\*1 style\*\*/)
  })

  test('with production delivered but a style on hold or waiting for a factory, it says so instead of "nothing is in progress"', async () => {
    const done = order({ assignments: [{ mid: 'm1', qty: 100, status: 'Delivered', stages: [stage({ isDelivery: true, status: 'done', unitsDone: 1 })] }] })
    const held = order({ id: 'H', assignments: [{ mid: 'm1', qty: 10, status: 'On Hold', stages: [stage()] }] })
    const text = await runPre([done, held, order({ id: 'U', assignments: [] })], [])
    expect(text).toMatch(/1 order delivered; nothing else in production is moving \(1 on hold and 1 style waiting for a factory\)\./)
    expect(text).not.toMatch(/nothing is in progress/)
  })
})
