// Builders for the minimum viable User / MasterOrder / Order documents.
//
// Orders are created through the API (not written directly) wherever the test
// is about creation rules. These factories exist for the *arrange* step, where
// the point is to have something to act on.

import bcrypt from 'bcryptjs'
import { User } from '../../src/models/User.js'
import { MasterOrder } from '../../src/models/MasterOrder.js'

export const TEST_PASSWORD = 'Test@1234'

let codeSeq = 0
const nextCode = prefix => `${prefix}${String(++codeSeq).padStart(2, '0')}`.slice(0, 5)

// bcrypt is deliberately slow; one shared hash keeps suite runtime sane since
// every factory user has the same password anyway.
let sharedHash = null
async function passwordHash() {
  if (!sharedHash) sharedHash = await bcrypt.hash(TEST_PASSWORD, 4)
  return sharedHash
}

export async function makeUser({ role = 'admin', adminType = null, company, name, email, code, isActive = true } = {}) {
  const seq = ++codeSeq
  return User.create({
    email: email || `${role}${seq}@test.local`,
    passwordHash: await passwordHash(),
    role,
    adminType: role === 'admin' ? (adminType || 'user') : null,
    company: company || `${role} Co ${seq}`,
    name: name || `${role} ${seq}`,
    code: code || nextCode(role.slice(0, 2).toUpperCase()),
    isActive,
  })
}

export const makeAdmin  = (o = {}) => makeUser({ ...o, role: 'admin', adminType: o.adminType || 'user' })
export const makeMaster = (o = {}) => makeUser({ ...o, role: 'admin', adminType: 'master' })
export const makeBuyer  = (o = {}) => makeUser({ ...o, role: 'buyer' })
export const makeMfr    = (o = {}) => makeUser({ ...o, role: 'manufacturer' })

export function makeMasterOrder({ buyerId, createdBy, id, orderName = 'Test Master Order', season = 'FW26' }) {
  return MasterOrder.create({ _id: id || `MO-TEST-${Date.now()}-${++codeSeq}`, buyerId, createdBy, orderName, season })
}

/**
 * Body for POST /api/orders. Stage arrays are index-aligned, matching
 * validateAndCreateOrder's contract.
 */
export function orderPayload({
  id = `TST-MFR-SHIRT-FW26-${String(++codeSeq).padStart(3, '0')}`,
  buyerId,
  mfrId,
  product = 'Test Shirt',
  category = 'SHIRT',
  season = 'FW26',
  totalQty = 100,
  delivery = '2026-12-31',
  masterOrderId = null,
  stageNames = ['Stage One', 'Stage Two', 'Stage Three'],
  stageStartDates,
  stageEtas,
  ...rest
} = {}) {
  const n = stageNames.length
  return {
    id,
    buyerId: String(buyerId),
    product,
    category,
    season,
    totalQty,
    delivery,
    ...(masterOrderId ? { masterOrderId } : {}),
    assignments: [{ mid: String(mfrId), qty: totalQty }],
    stageNames,
    stageStartDates: stageStartDates || Array.from({ length: n }, (_, i) => `2026-0${(i % 9) + 1}-01`),
    stageEtas: stageEtas || Array.from({ length: n }, (_, i) => `2026-0${(i % 9) + 1}-15`),
    ...rest,
  }
}
