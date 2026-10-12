// One-time data fixes that run at startup. Each step is idempotent (safe on every boot) and a
// failure in one is logged and skipped rather than stopping the server: the app copes without any
// of them (organizations are also created on first sight in requireAuth), they just make the data
// complete up front.
import { User, Order, Organization, Partnership } from '../db/index.js'
import { ensureOrgForUser, ensureOrgsByPartyIds } from './orgs.js'

/**
 * Drop the old unique index on users.code. A company code used to belong to exactly one user; now
 * every teammate in an organization carries its code, and Organization.code is where it is unique.
 * Mongoose cannot change an existing index's options on its own (it would error and skip), so the
 * old one is removed and the schema's non-unique replacement is built.
 */
export async function migrateIndexes() {
  const indexes = await User.collection.indexes().catch(() => [])   // no collection yet: nothing to do
  const legacy = indexes.find(i => i.name === 'code_1' && i.unique)
  if (!legacy) return null
  await User.collection.dropIndex('code_1')
  await User.createIndexes()
  return 'dropped the unique users.code index'
}

/** Give every buyer and manufacturer account that predates organizations one (Tradio access starts off). */
export async function backfillOrgs() {
  const users = await User.find({ role: { $in: ['buyer', 'manufacturer'] }, orgId: null }).lean()
  for (const u of users) await ensureOrgForUser(u)
  return users.length ? `created ${users.length} organization(s)` : null
}

/** Existing orders already link a brand to a manufacturer; make each pair a partnership. */
export async function backfillPartnerships() {
  const pairs = await Order.aggregate([
    { $unwind: '$assignments' },
    { $group: { _id: { buyer: '$buyerId', mfr: '$assignments.mfrId' } } },
  ])
  if (pairs.length === 0) return null
  const orgs = await ensureOrgsByPartyIds(pairs.flatMap(p => [p._id.buyer, p._id.mfr]))
  const ops = []
  for (const { _id } of pairs) {
    const brand = orgs.get(String(_id.buyer)), mfr = orgs.get(String(_id.mfr))
    if (!brand || !mfr) continue
    ops.push({ updateOne: {
      filter: { brandOrgId: brand._id, mfrOrgId: mfr._id },
      update: { $setOnInsert: { source: 'order', status: 'active' } },
      upsert: true,
    } })
  }
  if (ops.length === 0) return null
  const res = await Partnership.bulkWrite(ops, { ordered: false })
  return res.upsertedCount ? `linked ${res.upsertedCount} brand-manufacturer pair(s) from existing orders` : null
}

export async function runStartupMigrations(log = console) {
  const steps = [['indexes', migrateIndexes], ['organizations', backfillOrgs], ['partnerships', backfillPartnerships]]
  for (const [step, fn] of steps) {
    try {
      const result = await fn()
      if (result) log.log(JSON.stringify({ ts: new Date().toISOString(), event: 'migration', step, result }))
    } catch (err) {
      log.error(JSON.stringify({ ts: new Date().toISOString(), event: 'migration_failed', step, error: err.message }))
    }
  }
}
