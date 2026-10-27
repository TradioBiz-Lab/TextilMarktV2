// Gives every active manufacturer-role user on the platform a Partner Directory record, so the directory shows who is
// already onboarded. Idempotent on linkedUserId: a user that already has a record is left alone, so it is safe to
// re-run whenever manufacturers are added. Linking changes nothing about what a manufacturer-role user can see: the
// directory is admin-only and the user document is not touched.
//
//   node --env-file=.env.sandbox scripts/syncPlatformManufacturers.mjs            dry run: say what it would do
//   node --env-file=.env.sandbox scripts/syncPlatformManufacturers.mjs --apply    do it
import { User } from '../src/models/User.js'
import { Manufacturer } from '../src/models/Manufacturer.js'
import { nameKey } from '../src/lib/partners.js'
import { connectGuarded, disconnect, apply, today } from './partners-shared.mjs'

await connectGuarded()
if (apply) await Manufacturer.init()

const users = await User.find({ role: 'manufacturer', isActive: true }).sort({ company: 1 }).lean()
const linked = new Set((await Manufacturer.find({ linkedUserId: { $ne: null } }, 'linkedUserId').lean()).map(p => String(p.linkedUserId)))
const byName = new Map((await Manufacturer.find({}, 'name linkedUserId').lean()).map(p => [nameKey(p.name), p]))

let created = 0; let adopted = 0; let already = 0; let clash = 0
for (const u of users) {
  if (linked.has(String(u._id))) { already++; continue }
  const contact = { name: u.name || '', role: '', phone: u.phone || '', email: u.email || '', whatsapp: u.whatsappNumber || '' }
  const existing = byName.get(nameKey(u.company))
  if (existing) {
    // A record of that name came from a spreadsheet and has no platform link yet: link it rather than add a twin.
    if (existing.linkedUserId) { console.log(`[partners] skip "${u.company}": the record of that name is linked to another user`); clash++; continue }
    console.log(`[partners] ${apply ? 'link' : 'would link'} "${u.company}" to the existing record of that name`)
    if (apply) await Manufacturer.updateOne({ _id: existing._id }, { $set: { linkedUserId: u._id, status: 'onboarded' } })
    adopted++
    continue
  }
  console.log(`[partners] ${apply ? 'create' : 'would create'} "${u.company}" (${u.email})`)
  if (apply) {
    await Manufacturer.create({
      name: u.company, type: 'garment_manufacturer', status: 'onboarded', isActive: true,
      contacts: contact.name || contact.phone || contact.email || contact.whatsapp ? [contact] : [],
      source: `TextilMarkt platform (synced ${today()})`,
      linkedUserId: u._id,
    })
  }
  created++
}
console.log(`[partners] ${users.length} active manufacturer users: ${created} ${apply ? 'created' : 'to create'}, ${adopted} ${apply ? 'linked to an existing record' : 'to link to an existing record'}, ${already} already linked, ${clash} skipped.`)
if (!apply && created + adopted > 0) console.log('[partners] dry run only. Re-run with --apply to write.')
await disconnect()
