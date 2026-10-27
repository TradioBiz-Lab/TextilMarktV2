// One-off: "Onboarded" and "On platform" were two ways of saying the same thing, so there is now one status, Live. This moves
// the partners already on file: a partner that was marked live (isLive) or onboarded with a platform account becomes
// status live; any other "onboarded" becomes pilot (it has no account to be live with). Idempotent.
//
//   node --env-file=.env.sandbox scripts/migratePartnerStatuses.mjs            dry run: list what would change
//   node --env-file=.env.sandbox scripts/migratePartnerStatuses.mjs --apply    change them
import mongoose from 'mongoose'
import { Manufacturer } from '../src/models/Manufacturer.js'
import { AuditLog } from '../src/models/AuditLog.js'
import { connectGuarded, disconnect, apply } from './partners-shared.mjs'

await connectGuarded()
// Read raw: 'onboarded' is no longer a valid status, so the model would refuse to hand these over.
const partners = await mongoose.connection.collection('manufacturers').find({}, { projection: { name: 1, status: 1, isLive: 1, linkedUserId: 1 } }).toArray()
const moves = []
for (const p of partners) {
  let to = null
  if (p.status === 'onboarded') to = p.linkedUserId && p.isLive ? 'live' : 'pilot'
  else if (p.isLive && p.linkedUserId && p.status !== 'live') to = 'live'
  if (to) moves.push({ p, to })
}
for (const { p, to } of moves) console.log(`[partners] ${apply ? 'move' : 'would move'} "${p.name}": ${p.status}${p.isLive ? ' (was marked live)' : ''} -> ${to}`)
if (apply && moves.length) {
  // updateOne through the model, so isLive follows the status
  for (const { p, to } of moves) await Manufacturer.updateOne({ _id: p._id }, { $set: { status: to } }, { runValidators: false })
  await AuditLog.create({ byUser: null, action: 'Partner Updated', detail: `Status: ${moves.length} partner${moves.length === 1 ? '' : 's'} moved from Onboarded / marked live to the single status Live or Pilot (script, on Ankit's instruction)` })
}
console.log(`[partners] ${partners.length} partners: ${moves.length} ${apply ? 'moved' : 'to move'}, ${partners.length - moves.length} already right.`)
if (!apply && moves.length) console.log('[partners] dry run only. Re-run with --apply to write.')
await disconnect()
