// One-off: set the brand on every style of one customer (for example FYLTR on all of Cocoblu's). The customer is found by part
// of its company name (case does not matter), and exactly one has to match; every style it owns gets the brand, whatever stage
// it is in. Idempotent.
//
//   node --env-file=.env.sandbox scripts/setBrand.mjs --customer=Cocoblu --brand=FYLTR            dry run: list what would change
//   node --env-file=.env.sandbox scripts/setBrand.mjs --customer=Cocoblu --brand=FYLTR --apply    change them
//
// Production needs CONFIRM_DB=<its exact name> as well (see partners-shared.mjs), and nobody should do that without asking.
import mongoose from 'mongoose'
import { AuditLog } from '../src/models/AuditLog.js'
import { connectGuarded, disconnect, apply, flag } from './partners-shared.mjs'

const customer = (flag('customer') || '').trim(), brand = (flag('brand') || '').trim()
if (!customer || !brand || brand.length > 60) { console.error('[brand] --customer and --brand (60 characters at most) are required.'); process.exit(1) }

await connectGuarded()
const db = mongoose.connection
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const buyers = await db.collection('users').find({ role: 'buyer', company: { $regex: escape(customer), $options: 'i' } }, { projection: { company: 1, email: 1 } }).toArray()
if (buyers.length !== 1) { console.error(`[brand] ${buyers.length ? `"${customer}" matches ${buyers.length} customers (${buyers.map(b => b.company).join(', ')}): be more exact` : `no customer named like "${customer}"`}`); await disconnect(); process.exit(1) }
console.log(`[brand] customer: ${buyers.map(b => `${b.company} (${b.email})`).join(', ')}`)
const styles = await db.collection('orders').find({ buyerId: { $in: buyers.map(b => b._id) } }, { projection: { product: 1, styleNumber: 1, brand: 1, phase: 1 } }).sort({ _id: 1 }).toArray()
const changes = styles.filter(s => (s.brand || '') !== brand)
for (const s of changes) console.log(`[brand] ${apply ? 'set' : 'would set'} ${s._id} ${s.styleNumber || ''} (${s.product}) [${s.phase || 'production'}]: ${s.brand ? `"${s.brand}"` : 'no brand'} -> ${brand}`)
if (apply && changes.length) {
  await db.collection('orders').updateMany({ _id: { $in: changes.map(s => s._id) } }, { $set: { brand } })
  await AuditLog.create({ byUser: null, action: 'Order Edited', detail: `Brand set to ${brand} on ${changes.length} of ${buyers[0].company}'s styles (script, on Ankit's instruction): ${changes.map(s => s._id).join(', ')}` })
}
console.log(`[brand] ${styles.length} styles: ${changes.length} ${apply ? 'changed' : 'to change'}, ${styles.length - changes.length} already ${brand}.`)
if (!apply && changes.length) console.log('[brand] dry run only. Re-run with --apply to write.')
await disconnect()
