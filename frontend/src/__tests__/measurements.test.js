import { describe, test, expect } from 'vitest'
import { MEASUREMENT_LABELS, MEASUREMENT_LABEL_NAME } from '../constants.js'

describe('the labels on a measurement sheet', () => {
  test('are the three the process uses, in order, each with a readable name', () => {
    expect(MEASUREMENT_LABELS.map(([v]) => v)).toEqual(['customer_submission', 'fit_approval', 'pp_approval'])
    expect(MEASUREMENT_LABEL_NAME).toEqual({ customer_submission: 'Customer Submission', fit_approval: 'Fit Approval', pp_approval: 'PP Approval' })
  })
})
