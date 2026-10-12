// Builders for the minimum viable User / MasterOrder / Order documents.
//
// Orders are created through the API (not written directly) wherever the test
// is about creation rules. These factories exist for the *arrange* step, where
// the point is to have something to act on.

import bcrypt from 'bcryptjs'
import { User } from '../../src/models/User.js'
import { MasterOrder } from '../../src/models/MasterOrder.js'
import { Order } from '../../src/models/Order.js'
import { makeDeliveryStage } from '../../src/lib/stageMath.js'
import { Organization } from '../../src/models/Organization.js'
import { Partnership } from '../../src/models/Partnership.js'
import { ensureOrgForUser } from '../../src/lib/orgs.js'

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

/** A teammate in the same organization as `owner` (the organization is created if it does not exist yet). */
export async function makeMember(owner, { name, email } = {}) {
  const org = await ensureOrgForUser(owner)
  const seq = ++codeSeq
  return User.create({
    email: email || `member${seq}@test.local`, passwordHash: await passwordHash(), role: owner.role,
    company: owner.company, name: name || `member ${seq}`, code: owner.code,
    orgId: org._id, orgRole: 'member', isActive: true,
  })
}

/** Set an organization's flags (tradioEnabled, tradioCanView, isActive), creating it if needed. Returns the organization. */
export async function setOrg(user, flags) {
  const org = await ensureOrgForUser(user)
  await Organization.updateOne({ _id: org._id }, { $set: flags })
  return Organization.findById(org._id).lean()
}

/** Link a brand and a manufacturer so either may create or assign orders for the other. */
export async function link(brandUser, mfrUser) {
  const brand = await ensureOrgForUser(brandUser), mfr = await ensureOrgForUser(mfrUser)
  return Partnership.findOneAndUpdate(
    { brandOrgId: brand._id, mfrOrgId: mfr._id },
    { $setOnInsert: { source: 'admin' }, $set: { status: 'active' } },
    { upsert: true, new: true },
  )
}

export const makeAdmin  = (o = {}) => makeUser({ ...o, role: 'admin', adminType: o.adminType || 'user' })
export const makeMaster = (o = {}) => makeUser({ ...o, role: 'admin', adminType: 'master' })
export const makeBuyer  = (o = {}) => makeUser({ ...o, role: 'buyer' })
export const makeMfr    = (o = {}) => makeUser({ ...o, role: 'manufacturer' })

/**
 * An order written straight to the database, for the arrange step (it skips every creation rule on
 * purpose: tests of the rules create through the API). `mfrs` are manufacturer users; the quantity
 * is split evenly. Each split gets a "Cutting" step and the mandatory Delivery step.
 */
export function makeOrder({ id = `ORD-${++codeSeq}`, buyer, mfrs = [], product = 'Test Shirt', totalQty = 100, delivery = '2026-12-31', createdBy = null, createdByRole = null, masterOrderId = null } = {}) {
  const each = mfrs.length ? Math.floor(totalQty / mfrs.length) : 0
  return Order.create({
    _id: id, buyerId: buyer._id, product, category: 'SHIRT', season: 'FW26', totalQty,
    delivery: new Date(delivery), baselineDelivery: new Date(delivery),
    masterOrderId, createdBy, createdByRole,
    assignments: mfrs.map((m, i) => ({
      mfrId: m._id, qty: each, status: 'Processing', sub: `M${i + 1}`,
      stages: [
        { name: 'Cutting', kind: 'quantity', status: 'not_started', unitsDone: 0, totalUnits: each, startDate: '2026-10-01', baselineEta: '2026-10-10' },
        makeDeliveryStage('2026-12-31'),
      ],
    })),
  })
}

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
