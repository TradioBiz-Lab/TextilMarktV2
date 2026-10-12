// Organizations: the company behind a buyer or manufacturer account.
//
// Orders, assignments, documents and stage owners reference a single user id per company (they
// predate organizations). That id is the organization's "party" id: the owner account's user id.
// A teammate's session is resolved to it in requireAuth, so every existing check that compares a
// user id with a party id keeps working for the whole team without being touched.
import { User, Organization, Partnership } from '../db/index.js'

const ORG_TYPE_BY_ROLE = { buyer: 'brand', manufacturer: 'manufacturer' }
export const isPartyRole = role => role === 'buyer' || role === 'manufacturer'
export const roleForOrgType = type => (type === 'brand' ? 'buyer' : 'manufacturer')

const idStr = v => (v == null ? null : String(v._id ?? v))

/**
 * The organization a buyer or manufacturer belongs to. An account that predates organizations gets
 * one created on first sight (one atomic upsert keyed on the owner, so two simultaneous requests
 * cannot create two). It starts with Tradio access OFF: enabling Tradio to act for a factory is
 * always a deliberate switch, never a side effect of migrating data.
 */
export async function ensureOrgForUser(user) {
  if (!user || !isPartyRole(user.role)) return null
  if (user.orgId) {
    const existing = await Organization.findById(user.orgId).lean()
    if (existing) return existing
  }
  const ownerFilter = { ownerUserId: user._id }
  let org = await Organization.findOne(ownerFilter).lean()
  if (!org) {
    try {
      org = (await Organization.create({
        name: user.company, type: ORG_TYPE_BY_ROLE[user.role], code: user.code, ownerUserId: user._id,
      })).toObject()
    } catch (err) {
      // Lost the race to another request, which created it: read theirs.
      if (err?.code !== 11000) throw err
      org = await Organization.findOne(ownerFilter).lean()
      if (!org) throw err
    }
  }
  await User.updateOne({ _id: user._id, orgId: null }, { $set: { orgId: org._id, orgRole: 'owner' } })
  return org
}

/** Map of owner (party) user id -> organization, for the given party ids. Missing owners are absent. */
export async function orgsByPartyIds(partyIds) {
  const ids = [...new Set((partyIds || []).map(idStr).filter(Boolean))]
  if (ids.length === 0) return new Map()
  const orgs = await Organization.find({ ownerUserId: { $in: ids } }).lean()
  return new Map(orgs.map(o => [String(o.ownerUserId), o]))
}

/**
 * Like orgsByPartyIds, but creates the organization for any account that predates them, so a
 * caller never has to treat "no organization yet" as a special case.
 */
export async function ensureOrgsByPartyIds(partyIds) {
  const ids = [...new Set((partyIds || []).map(idStr).filter(Boolean))]
  const found = await orgsByPartyIds(ids)
  const missing = ids.filter(id => !found.has(id))
  if (missing.length) {
    const users = await User.find({ _id: { $in: missing }, role: { $in: ['buyer', 'manufacturer'] } }).lean()
    for (const u of users) {
      const org = await ensureOrgForUser(u)
      if (org) found.set(String(u._id), org)
    }
  }
  return found
}

/**
 * The party id a user acts as: their organization's owner for a teammate, themself otherwise.
 * For lookups that start from some other identifier than a session (a WhatsApp number).
 */
export async function partyIdOfUser(userOrId) {
  const user = userOrId?._id ? userOrId : await User.findById(userOrId, 'role orgId orgRole').lean()
  if (!user) return null
  if (user.orgRole === 'member' && user.orgId) {
    const org = await Organization.findById(user.orgId, 'ownerUserId').lean()
    if (org?.ownerUserId) return String(org.ownerUserId)
  }
  return String(user._id)
}

/**
 * The party id of the company with this code ("TPR"), for a role. Codes are shared by a company's
 * whole team, so looking a user up by code could return a teammate instead of the account orders
 * reference; this always answers with the organization's primary account.
 */
export async function partyIdByCode(code, role) {
  const c = String(code || '').toUpperCase().trim()
  if (!c || !isPartyRole(role)) return null
  const org = await Organization.findOne({ code: c, type: ORG_TYPE_BY_ROLE[role] }, 'ownerUserId').lean()
  if (org) return String(org.ownerUserId)
  // An account that predates organizations (no teammates are possible without one).
  const user = await User.findOne({ code: c, role, orgRole: { $ne: 'member' } }, '_id').lean()
  return user ? String(user._id) : null
}

/** Party ids of organizations that have switched Tradio's view access off. */
export async function privatePartyIds() {
  const orgs = await Organization.find({ tradioCanView: false }, 'ownerUserId').lean()
  return orgs.map(o => String(o.ownerUserId))
}

/** True when a brand and a manufacturer (given by party id) have an active partnership. */
export async function arePartnered(brandPartyId, mfrPartyId) {
  const orgs = await orgsByPartyIds([brandPartyId, mfrPartyId])
  const brand = orgs.get(String(brandPartyId)), mfr = orgs.get(String(mfrPartyId))
  if (!brand || !mfr) return false
  return !!(await Partnership.exists({ brandOrgId: brand._id, mfrOrgId: mfr._id, status: 'active' }))
}

/**
 * The subset of `mfrPartyIds` that the brand `brandPartyId` is NOT partnered with (empty = all fine).
 * One round trip for a whole assignment list.
 */
export async function unpartneredMfrs(brandPartyId, mfrPartyIds) {
  const wanted = [...new Set(mfrPartyIds.map(String))]
  const orgs = await ensureOrgsByPartyIds([brandPartyId, ...wanted])
  const brand = orgs.get(String(brandPartyId))
  if (!brand) return wanted
  const mfrOrgIds = wanted.map(id => orgs.get(id)?._id).filter(Boolean)
  const links = await Partnership.find({ brandOrgId: brand._id, mfrOrgId: { $in: mfrOrgIds }, status: 'active' }, 'mfrOrgId').lean()
  const linked = new Set(links.map(l => String(l.mfrOrgId)))
  return wanted.filter(id => !orgs.get(id) || !linked.has(String(orgs.get(id)._id)))
}

/** Record that Tradio put a brand and a manufacturer together (idempotent; revives a revoked link). */
export async function ensurePartnership(brandPartyId, mfrPartyId, { source = 'order', createdBy = null } = {}) {
  const orgs = await ensureOrgsByPartyIds([brandPartyId, mfrPartyId])
  const brand = orgs.get(String(brandPartyId)), mfr = orgs.get(String(mfrPartyId))
  if (!brand || !mfr) return null
  return Partnership.findOneAndUpdate(
    { brandOrgId: brand._id, mfrOrgId: mfr._id },
    { $setOnInsert: { source, createdBy }, $set: { status: 'active' } },
    { upsert: true, new: true, lean: true },
  )
}
