// Pure-function tests for deriveActualEnd (backend/src/models/Order.js) — no
// DB/server. Covers the IST-vs-UTC fix and the new explicit-backdate param;
// the done/not-done/preserve-existing-stamp behavior is already exercised
// through the API in orders.tna.test.js's "actual end date" describe block.

import test, { describe } from 'node:test'
import assert from 'node:assert/strict'

import { deriveActualEnd } from '../src/models/Order.js'
import { getToday } from '../src/lib/stageMath.js'

describe('deriveActualEnd', () => {
  test('null when not transitioning to done', () => {
    assert.equal(deriveActualEnd('not_started', null), null)
    assert.equal(deriveActualEnd('in_progress', '2026-08-01'), null)
  })

  test('stamps IST "today" (not UTC) when newly done with no existing stamp or override', () => {
    // This is the actual regression: the old implementation used
    // new Date().toISOString().slice(0,10) — raw UTC — which lands a
    // calendar day behind IST for part of every day (~18:30-24:00 UTC).
    assert.equal(deriveActualEnd('done', null), getToday())
  })

  test('preserves an existing stamp on a no-op save', () => {
    assert.equal(deriveActualEnd('done', '2026-07-20'), '2026-07-20')
  })

  test('an explicit backdate takes priority over the preserved stamp', () => {
    assert.equal(deriveActualEnd('done', '2026-07-20', '2026-07-15'), '2026-07-15')
  })

  test('an explicit backdate takes priority over auto-stamping today', () => {
    assert.equal(deriveActualEnd('done', null, '2026-07-03'), '2026-07-03')
  })

  test('reopening (not done) clears the stamp even if an explicit date is (incorrectly) passed', () => {
    assert.equal(deriveActualEnd('not_started', '2026-07-20', '2026-07-15'), null)
  })
})
