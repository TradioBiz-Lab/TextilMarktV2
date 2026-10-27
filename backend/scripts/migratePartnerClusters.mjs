// One-off: Noida and Delhi became one NCR cluster, and Jaipur and Kolkata became clusters of their own. This moves the
// partners already on file: noida_ncr and delhi_ncr become ncr, and a partner filed under "other" (or no cluster) whose
// city is Jaipur, Kolkata or in the NCR is filed there. Idempotent; a partner that is already right is left alone.
//
//   node --env-file=.env.sandbox scripts/migratePartnerClusters.mjs            dry run: list what would move
//   node --env-file=.env.sandbox scripts/migratePartnerClusters.mjs --apply    move them
import { Manufacturer } from '../src/models/Manufacturer.js'
import { AuditLog } from '../src/models/AuditLog.js'
import { normalizeCluster } from '../src/lib/partners.js'
import { connectGuarded, disconnect, apply } from './partners-shared.mjs'

await connectGuarded()
const partners = await Manufacturer.find({}, 'name city cluster').lean()
const moves = []
for (const p of partners) {
  let to = null
  if (p.cluster === 'noida_ncr' || p.cluster === 'delhi_ncr') to = 'ncr'
  else if (!p.cluster || p.cluster === 'other') {
    const fromCity = normalizeCluster('', p.city)
    if (fromCity && fromCity !== 'other' && fromCity !== p.cluster) to = fromCity
  }
  if (to) moves.push({ p, to })
}
for (const { p, to } of moves) console.log(`[partners] ${apply ? 'move' : 'would move'} "${p.name}" (${p.city || 'no city'}): ${p.cluster || 'no cluster'} -> ${to}`)
if (apply && moves.length) {
  for (const { p, to } of moves) await Manufacturer.updateOne({ _id: p._id }, { $set: { cluster: to } })
  await AuditLog.create({ byUser: null, action: 'Partner Updated', detail: `Clusters: ${moves.length} partner${moves.length === 1 ? '' : 's'} moved to the new clusters (NCR, Jaipur, Kolkata) (script, on Ankit's instruction)` })
}
console.log(`[partners] ${partners.length} partners: ${moves.length} ${apply ? 'moved' : 'to move'}, ${partners.length - moves.length} already right.`)
if (!apply && moves.length) console.log('[partners] dry run only. Re-run with --apply to write.')
await disconnect()
