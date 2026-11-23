import { describe, test, expect } from 'vitest'
import { suggestionsFor, stageOfUpdate, waitingText, isStale } from '../fieldUpdates.js'

const stages = [
  { name: 'Fabric Inhouse', kind: 'milestone', status: 'done' },
  { name: 'Cutting', kind: 'milestone', status: 'not_started' },
  { name: 'Stitching', kind: 'quantity', status: 'in_progress', unitsDone: 180, totalUnits: 600 },
  { name: 'Delivery', kind: 'milestone', status: 'not_started', isDelivery: true },
]
const upd = (ai, stageIndex = 2) => ({ id: 'u1', orderId: 'S-1', factoryId: 'fA', stageIndex, ai: { state: 'done', issues: [], colours: [], ...ai } })
const kinds = list => list.map(s => [s.key, s.kind])

describe('what the account manager can confirm from the AI\'s reading', () => {
  test('a count on a step that counts pieces becomes a one-tap change', () => {
    const [s] = suggestionsFor(upd({ units: 240 }), stages[2], stages)
    expect(s).toMatchObject({ key: 'units', kind: 'apply', label: 'Count 240 of 600', apply: { unitsDone: 240 }, was: 'now 180' })
  })
  test('a count that cannot be applied is shown, never applied: over the plan, or on a step that does not count', () => {
    expect(suggestionsFor(upd({ units: 700 }), stages[2], stages)[0]).toMatchObject({ kind: 'info', why: 'more than the 600 planned' })
    expect(suggestionsFor(upd({ units: 40 }, 1), stages[1], stages)[0]).toMatchObject({ kind: 'info', why: 'this step does not count pieces' })
  })
  test('started and finished apply to a milestone step only, and not when it is already there', () => {
    expect(suggestionsFor(upd({ statusHint: 'started' }, 1), stages[1], stages)[0]).toMatchObject({ kind: 'apply', apply: { status: 'in_progress' } })
    expect(suggestionsFor(upd({ statusHint: 'finished' }, 1), stages[1], stages)[0]).toMatchObject({ kind: 'apply', apply: { status: 'done' } })
    expect(suggestionsFor(upd({ statusHint: 'started' }, 0), stages[0], stages)).toEqual([])
    expect(suggestionsFor(upd({ statusHint: 'finished' }), stages[2], stages)[0]).toMatchObject({ kind: 'info' })
    expect(suggestionsFor(upd({ statusHint: 'finished' }, 3), stages[3], stages)).toEqual([])
  })
  test('an issue offers to block the step, unless it is blocked already', () => {
    expect(suggestionsFor(upd({ issues: ['blue shade is off'] }), stages[2], stages)[0]).toMatchObject({ kind: 'apply', apply: { blocked: true, blockedReason: 'blue shade is off' } })
    expect(suggestionsFor(upd({ issues: ['x'] }), { ...stages[2], blocked: true }, stages)[0]).toMatchObject({ kind: 'info', why: 'the step is already blocked' })
  })
  test('a different step is offered as a move, first; a pass or fail and colour notes are only shown', () => {
    const list = suggestionsFor(upd({ suggestedStageIndex: 0, units: 240, result: 'fail', colours: [{ name: 'Olivine', note: 'in house' }, { name: 'Peacot', note: '' }] }), stages[2], stages)
    expect(kinds(list)).toEqual([['move', 'move'], ['units', 'apply'], ['result', 'info'], ['colour0', 'info']])
    expect(list[0]).toMatchObject({ toIndex: 0, label: 'Looks like it is about Fabric Inhouse. Move it there' })
  })
  test('nothing is offered until the AI has read it, or for a step that is no longer on the plan', () => {
    expect(suggestionsFor({ stageIndex: 2, ai: { state: 'pending', units: 5 } }, stages[2], stages)).toEqual([])
    expect(suggestionsFor({ stageIndex: 2, ai: { state: 'off' } }, stages[2], stages)).toEqual([])
    expect(suggestionsFor(upd({ units: 240, statusHint: 'started' }), null, [])).toEqual([])
    expect(suggestionsFor(upd({ suggestedStageIndex: 9 }), stages[2], stages)).toEqual([])
  })
})

describe('finding an update\'s step on the style', () => {
  test('by the style, the factory\'s split and the step\'s place', () => {
    const orders = [{ id: 'S-1', assignments: [{ mid: 'fB', stages: [] }, { mid: 'fA', stages }] }]
    const r = stageOfUpdate(orders, { orderId: 'S-1', factoryId: 'fA', stageIndex: 2 })
    expect(r.stage.name).toBe('Stitching')
    expect(r.stages.length).toBe(4)
    expect(stageOfUpdate(orders, { orderId: 'NOPE', factoryId: 'fA', stageIndex: 2 })).toMatchObject({ order: null, stage: null, stages: [] })
  })
})

describe('how long an update has waited', () => {
  test('minutes, hours, days; a day or more is stale', () => {
    expect(waitingText(0)).toBe('1 min')
    expect(waitingText(40)).toBe('40 min')
    expect(waitingText(300)).toBe('5 h')
    expect(waitingText(3 * 24 * 60)).toBe('3 d')
    expect(waitingText(null)).toBe('')
    expect([isStale(60), isStale(24 * 60), isStale(null)]).toEqual([false, true, false])
  })
})
