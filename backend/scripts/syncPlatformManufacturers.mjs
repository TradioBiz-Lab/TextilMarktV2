// Gives every active manufacturer-role user on the platform a Partner Directory record, so the directory shows who is
// already onboarded. Idempotent on linkedUserId: a user that already has a record is left alone, so it is safe to
// re-run whenever manufacturers are added. Linking changes nothing about what a manufacturer-role user can see: the
// directory is admin-only and the user document is not touched.
//
//   node --env-file=.env.sandbox scripts/syncPlatformManufacturers.mjs            dry run: say what it would do
//   node --env-file=.env.sandbox scripts/syncPlatformManufacturers.mjs --apply    do it
import { User } from '../src/models/User.js'
import { Manufacturer } from '../src/models/Manufacturer.js'
import { ensurePartnerForUser } from '../src/lib/partnerSync.js'
import { connectGuarded, disconnect, apply, today } from './partners-shared.mjs'

await connectGuarded()
if (apply) await Manufacturer.init()

const users = await User.find({ role: 'manufacturer', isActive: true }).sort({ company: 1 }).lean()

let created = 0; let adopted = 0; let already = 0; let clash = 0
for (const u of users) {
  const r = await ensurePartnerForUser(u, { today: today(), dryRun: !apply })
  if (r.action === 'exists') already++
  else if (r.action === 'skipped') { console.log(`[partners] skip "${u.company}": ${r.reason}`); clash++ }
  else if (r.action === 'linked') { console.log(`[partners] ${apply ? 'link' : 'would link'} "${u.company}" to the existing record of that name`); adopted++ }
  else { console.log(`[partners] ${apply ? 'create' : 'would create'} "${u.company}" (${u.email})`); created++ }
}
console.log(`[partners] ${users.length} active manufacturer users: ${created} ${apply ? 'created' : 'to create'}, ${adopted} ${apply ? 'linked to an existing record' : 'to link to an existing record'}, ${already} already linked, ${clash} skipped.`)
if (!apply && created + adopted > 0) console.log('[partners] dry run only. Re-run with --apply to write.')
await disconnect()
