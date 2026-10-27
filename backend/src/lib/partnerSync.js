import { Manufacturer } from '../models/Manufacturer.js'
import { nameKey } from './partners.js'

// A manufacturer-role user and its Partner Directory record. Linking changes nothing about what the user can see.
// Shared by scripts/syncPlatformManufacturers.mjs and the route that creates a manufacturer account, so a new
// manufacturer shows up in the directory (not live) the moment its account exists.

const contactOf = u => ({ name: u.name || '', role: '', phone: u.phone || '', email: u.email || '', whatsapp: u.whatsappNumber || '' })

/**
 * Makes sure `user` (a manufacturer) has a directory record. Idempotent on linkedUserId. A record of the same name that
 * has no link yet (it came from a spreadsheet) is linked instead of duplicated.
 * @returns {{ action: 'exists' | 'linked' | 'created' | 'skipped', partner?: object, reason?: string }}
 */
export async function ensurePartnerForUser(user, { today = new Date().toISOString().slice(0, 10), dryRun = false } = {}) {
  const have = await Manufacturer.findOne({ linkedUserId: user._id }, 'name').lean()
  if (have) return { action: 'exists', partner: have }
  const sameName = (await Manufacturer.find({}, 'name linkedUserId').lean()).find(p => nameKey(p.name) === nameKey(user.company))
  if (sameName) {
    if (sameName.linkedUserId) return { action: 'skipped', reason: 'the record of that name is linked to another user' }
    if (!dryRun) await Manufacturer.updateOne({ _id: sameName._id }, { $set: { linkedUserId: user._id, status: 'onboarded' } })
    return { action: 'linked', partner: sameName }
  }
  if (dryRun) return { action: 'created' }
  const c = contactOf(user)
  const partner = await Manufacturer.create({
    name: user.company, type: 'garment_manufacturer', status: 'onboarded', isActive: true,
    contacts: Object.values(c).some(Boolean) ? [c] : [],
    source: `TextilMarkt platform (synced ${today})`,
    linkedUserId: user._id,
  })
  return { action: 'created', partner }
}
