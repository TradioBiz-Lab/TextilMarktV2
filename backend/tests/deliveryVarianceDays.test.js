// Pure-function tests for deliveryVarianceDays (backend/src/models/Order.js).
// Order-level counterpart to stageEtaVarianceDays: how far the delivery
// PROMISE has moved from baselineDelivery, independent of whether the
// current plan (deliveryOverrunDays) agrees with it right now.

import test, { describe } from 'node:test'
import assert from 'node:assert/strict'

import { deliveryVarianceDays } from '../src/models/Order.js'

describe('deliveryVarianceDays', () => {
  test('null when there is no baseline yet (never revised)', () => {
    assert.equal(deliveryVarianceDays({ delivery: new Date('2026-08-25'), baselineDelivery: null }), null)
  })

  test('null when there is no current delivery (should not happen, but defensive)', () => {
    assert.equal(deliveryVarianceDays({ delivery: null, baselineDelivery: new Date('2026-08-25') }), null)
  })

  test('positive when the promise moved later than originally committed', () => {
    assert.equal(deliveryVarianceDays({
      baselineDelivery: new Date('2026-08-25'), delivery: new Date('2026-09-02'),
    }), 8)
  })

  test('negative when the promise was pulled earlier', () => {
    assert.equal(deliveryVarianceDays({
      baselineDelivery: new Date('2026-12-01'), delivery: new Date('2026-10-20'),
    }), -42)
  })

  test('zero when delivery was "revised" to the same date', () => {
    assert.equal(deliveryVarianceDays({
      baselineDelivery: new Date('2026-08-25'), delivery: new Date('2026-08-25'),
    }), 0)
  })
})
