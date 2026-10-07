import { describe, test, expect } from 'vitest'
import { capsFor, canWriteStage, canSetAssignmentStatus } from '../caps.js'

const admin = { id: 'a1', role: 'admin', adminType: 'master' }
const buyer = { id: 'b1', role: 'buyer' }
const mfr = { id: 'm1', role: 'manufacturer' }
const asgn = { mid: 'm1' }

describe('what each role may do', () => {
  test('only admins edit the plan; manufacturers manage materials, buyers do not', () => {
    expect(capsFor(admin).editPlan).toBe(true)
    expect(capsFor(mfr).editPlan).toBe(false)
    expect(capsFor(buyer).editPlan).toBe(false)
    expect(capsFor(mfr).manageMaterials).toBe(true)
    expect(capsFor(buyer).manageMaterials).toBe(false)
  })

  test('a manufacturer writes only its own split', () => {
    expect(canWriteStage(mfr, asgn, { name: 'Cutting' })).toBe(true)
    expect(canWriteStage(mfr, { mid: 'someone-else' }, { name: 'Cutting' })).toBe(false)
  })

  test('a buyer writes only a stage they own, and never the Delivery step', () => {
    expect(canWriteStage(buyer, asgn, { name: 'PP Approval', responsibleId: 'b1' })).toBe(true)
    expect(canWriteStage(buyer, asgn, { name: 'PP Approval', responsibleId: 'other' })).toBe(false)
    expect(canWriteStage(buyer, asgn, { name: 'Delivery', isDelivery: true, responsibleId: 'b1' })).toBe(false)
  })

  test('only admins and the split owner set the overall status', () => {
    expect(canSetAssignmentStatus(admin, asgn)).toBe(true)
    expect(canSetAssignmentStatus(mfr, asgn)).toBe(true)
    expect(canSetAssignmentStatus(mfr, { mid: 'x' })).toBe(false)
    expect(canSetAssignmentStatus(buyer, asgn)).toBe(false)
  })

  test('no user means no access', () => {
    expect(canWriteStage(null, asgn, {})).toBe(false)
  })
})
