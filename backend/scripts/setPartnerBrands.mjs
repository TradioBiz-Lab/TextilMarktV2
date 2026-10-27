// Fills the "brands they work with" field of partners already on file:
//   - a partner that came from the Cocoblu vendor file gets "Cocoblu";
//   - a manufacturer on the platform gets the customers whose orders it has (the buyer companies on those orders),
//     with "Cocoblu-Neobrands" shown as "Cocoblu" so one brand has one name.
// It only adds: brands already typed in are kept, and nothing is removed. Idempotent.
//
//   node --env-file=.env.sandbox scripts/setPartnerBrands.mjs            dry run: list what would be added
//   node --env-file=.env.sandbox scripts/setPartnerBrands.mjs --apply    add them
import { Manufacturer } from '../src/models/Manufacturer.js'
import { Order } from '../src/models/Order.js'
import { User } from '../src/models/User.js'
import { AuditLog } from '../src/models/AuditLog.js'
import { connectGuarded, disconnect, apply } from './partners-shared.mjs'

const BRAND_NAME = { 'cocoblu-neobrands': 'Cocoblu' }
const brandOf = company => BRAND_NAME[String(company).trim().toLowerCase()] || String(company).trim()

await connectGuarded()
const buyers = new Map((await User.find({ role: 'buyer' }, 'company').lean()).map(u => [String(u._id), u.company]))
const partners = await Manufacturer.find({}, 'name source linkedUserId brands').lean()
let changed = 0
for (const p of partners) {
  const want = []
  if (/Cocoblu vendor file/i.test(p.source || '')) want.push('Cocoblu')
  if (p.linkedUserId) {
    const orders = await Order.find({ 'assignments.mfrId': p.linkedUserId }, 'buyerId').lean()
    for (const o of orders) { const c = buyers.get(String(o.buyerId)); if (c) want.push(brandOf(c)) }
  }
  const have = p.brands || []
  const add = [...new Set(want)].filter(b => !have.some(h => h.toLowerCase() === b.toLowerCase()))
  if (!add.length) continue
  changed++
  console.log(`[partners] ${apply ? 'add' : 'would add'} to "${p.name}": ${add.join(', ')}${have.length ? ` (already: ${have.join(', ')})` : ''}`)
  if (apply) await Manufacturer.updateOne({ _id: p._id }, { $set: { brands: [...have, ...add] } })
}
if (apply && changed) await AuditLog.create({ byUser: null, action: 'Partner Updated', detail: `Brands: filled in for ${changed} partner${changed === 1 ? '' : 's'} (the Cocoblu vendor file, and the customers of the platform manufacturers) (script, on Ankit's instruction)` })
console.log(`[partners] ${partners.length} partners: ${changed} ${apply ? 'updated' : 'to update'}, ${partners.length - changed} already right.`)
if (!apply && changed) console.log('[partners] dry run only. Re-run with --apply to write.')
await disconnect()
