import { Manufacturer } from '../models/Manufacturer.js'
import { User } from '../models/User.js'

// Who may be given work. A manufacturer user can be assigned a style, or a split of one, only when its Partner
// Directory record is marked live (isLive, set by Tradio on the partner's page). Live means "has orders with us now".
// The check sits where assignments are made: creating a style (single or bulk), adding a manufacturer to a style, and
// handing a split to another one. Manufacturers already on an order are not affected; this only gates new assignments.

/** The manufacturer users among `userIds` that are not live: [{ id, company }]. */
export async function notLiveManufacturers(userIds) {
  const ids = [...new Set((userIds || []).map(String))]
  if (ids.length === 0) return []
  const live = new Set((await Manufacturer.find({ linkedUserId: { $in: ids }, isLive: true }, 'linkedUserId').lean()).map(p => String(p.linkedUserId)))
  const missing = ids.filter(id => !live.has(id))
  if (missing.length === 0) return []
  const users = await User.find({ _id: { $in: missing } }, 'company').lean()
  return users.map(u => ({ id: String(u._id), company: u.company }))
}

/** null when every one is live, else the sentence to show the admin. */
export async function liveGateMessage(userIds) {
  const blocked = await notLiveManufacturers(userIds)
  if (blocked.length === 0) return null
  const names = blocked.map(b => b.company).join(', ')
  return `${names} ${blocked.length === 1 ? 'is' : 'are'} not marked live in Partners yet. A manufacturer has to be marked live before it can be given a style.`
}
