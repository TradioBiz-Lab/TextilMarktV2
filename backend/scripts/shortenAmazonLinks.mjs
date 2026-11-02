// One-off: save every Amazon product link already on a style in its short form (https://www.amazon.<site>/dp/<ASIN>), the
// way the app now does for a link typed or pasted. Anything that is not an Amazon product page is left alone. Idempotent.
//
//   node --env-file=.env.sandbox scripts/shortenAmazonLinks.mjs            dry run: list what would change
//   node --env-file=.env.sandbox scripts/shortenAmazonLinks.mjs --apply    change them
//
// Production needs CONFIRM_DB=<its exact name> as well (see partners-shared.mjs), and nobody should do that without asking.
import mongoose from 'mongoose'
import { AuditLog } from '../src/models/AuditLog.js'
import { normalizeLink } from '../src/lib/links.js'
import { connectGuarded, disconnect, apply } from './partners-shared.mjs'

await connectGuarded()
const col = mongoose.connection.collection('orders')
const styles = await col.find({ ecommerceLink: { $nin: ['', null] } }, { projection: { product: 1, styleNumber: 1, ecommerceLink: 1 } }).toArray()
const changes = styles.map(s => ({ s, to: normalizeLink(s.ecommerceLink) })).filter(c => c.to !== c.s.ecommerceLink)
for (const { s, to } of changes) console.log(`[links] ${apply ? 'shorten' : 'would shorten'} ${s._id} ${s.styleNumber || ''}\n         ${s.ecommerceLink}\n      -> ${to}`)
if (apply && changes.length) {
  for (const { s, to } of changes) await col.updateOne({ _id: s._id, ecommerceLink: s.ecommerceLink }, { $set: { ecommerceLink: to } })
  await AuditLog.create({ byUser: null, action: 'Order Edited', detail: `${changes.length} Amazon link${changes.length === 1 ? '' : 's'} saved in short form (script, on Ankit's instruction): ${changes.map(c => c.s._id).join(', ')}` })
}
console.log(`[links] ${styles.length} styles with a link: ${changes.length} ${apply ? 'shortened' : 'to shorten'}, ${styles.length - changes.length} already short or not Amazon product links.`)
if (!apply && changes.length) console.log('[links] dry run only. Re-run with --apply to write.')
await disconnect()
