// Pure-function tests for backend/src/lib/stageMath.js — no DB, no server.
// These are the same functions/semantics as frontend/src/constants.js
// (dayNumber, getToday, stageActualVariance, deliveryOverrunDays); tested here
// so the backend copy used by the assistant's check_delivery_risk tool is
// independently verified.

import test, { describe } from 'node:test'
import assert from 'node:assert/strict'

import { dayNumber, getToday, stageActualVariance, deliveryOverrunDays } from '../src/lib/stageMath.js'

describe('dayNumber', () => {
  test('parses a plain YYYY-MM-DD string', () => {
    assert.equal(dayNumber('2026-08-15'), Date.UTC(2026, 7, 15) / 86400000)
  })

  test('parses the date component of a full ISO datetime string', () => {
    assert.equal(dayNumber('2026-08-15T10:30:00.000Z'), Date.UTC(2026, 7, 15) / 86400000)
  })

  test('two consecutive days differ by exactly 1', () => {
    assert.equal(dayNumber('2026-08-16') - dayNumber('2026-08-15'), 1)
  })

  test('null/undefined/empty return null', () => {
    assert.equal(dayNumber(null), null)
    assert.equal(dayNumber(undefined), null)
    assert.equal(dayNumber(''), null)
  })

  test('malformed input returns null', () => {
    assert.equal(dayNumber('not-a-date'), null)
    assert.equal(dayNumber('NA'), null)
  })
})

describe('getToday', () => {
  test('returns a YYYY-MM-DD string', () => {
    assert.match(getToday(), /^\d{4}-\d{2}-\d{2}$/)
  })

  test('is IST-anchored (UTC+5:30, no DST)', () => {
    const expected = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10)
    assert.equal(getToday(), expected)
  })
})

describe('stageActualVariance', () => {
  test('null when the stage has no actualEnd yet', () => {
    assert.equal(stageActualVariance({ baselineEta: '2026-08-15', actualEnd: null }), null)
  })

  test('null when baselineEta is missing or "NA"', () => {
    assert.equal(stageActualVariance({ baselineEta: null, actualEnd: '2026-08-15' }), null)
    assert.equal(stageActualVariance({ baselineEta: 'NA', actualEnd: '2026-08-15' }), null)
  })

  test('positive when it finished later than the original plan', () => {
    assert.equal(stageActualVariance({ baselineEta: '2026-08-15', actualEnd: '2026-08-18' }), 3)
  })

  test('negative when it finished earlier than the original plan', () => {
    assert.equal(stageActualVariance({ baselineEta: '2026-08-15', actualEnd: '2026-08-12' }), -3)
  })

  test('zero when it finished exactly on the original plan', () => {
    assert.equal(stageActualVariance({ baselineEta: '2026-08-15', actualEnd: '2026-08-15' }), 0)
  })

  test('measures against baselineEta even when eta has since been revised', () => {
    // The plan moved to 08-20 after the fact, but the stage actually finished
    // 3 days later than what was ORIGINALLY promised (08-15) — that's the
    // number that matters, not how it compares to the since-revised target.
    assert.equal(stageActualVariance({ baselineEta: '2026-08-15', eta: '2026-08-20', actualEnd: '2026-08-18' }), 3)
  })
})

describe('deliveryOverrunDays', () => {
  const order = delivery => ({
    delivery,
    assignments: [
      { mfrId: 'a', stages: [{ eta: '2026-08-10' }, { eta: '2026-08-20' }] },
      { mfrId: 'b', stages: [{ eta: '2026-08-25' }] },
    ],
  })

  test('null when the order has no delivery date', () => {
    assert.equal(deliveryOverrunDays({ assignments: [] }), null)
  })

  test('null when no stage has a real eta', () => {
    assert.equal(deliveryOverrunDays({ delivery: '2026-08-01', assignments: [{ stages: [{ eta: 'NA' }, { eta: null }] }] }), null)
  })

  test('finds the max eta across ALL assignments when none is passed', () => {
    // max eta across both assignments is 2026-08-25; delivery is 2026-08-20 -> +5
    assert.equal(deliveryOverrunDays(order('2026-08-20')), 5)
  })

  test('scopes to a single assignment when one is passed', () => {
    const o = order('2026-08-15')
    // assignment 'a' alone: max eta 2026-08-20 vs delivery 2026-08-15 -> +5
    assert.equal(deliveryOverrunDays(o, o.assignments[0]), 5)
  })

  test('null when the plan does not overrun delivery', () => {
    assert.equal(deliveryOverrunDays(order('2026-09-01')), null)
  })
})
