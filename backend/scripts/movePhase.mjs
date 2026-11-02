// One-off: move styles from one stage to another (for example New Product Development -> Replen) when they were filed in
// the wrong one. Only the stage changes: NPD and Replen behave the same (no delivery date, no Delivery step, quantity can
// wait), so nothing else on the style needs touching. Moving to or from Production is refused here: that needs a quantity,
// a delivery date and a plan, which is what Move to production on the style page does.
//
//   node --env-file=.env.sandbox scripts/movePhase.mjs --from=development --to=replen                   dry run: list the styles in --from
//   node --env-file=.env.sandbox scripts/movePhase.mjs --from=development --to=replen --ids=A,B          dry run: show what would move
//   node --env-file=.env.sandbox scripts/movePhase.mjs --from=development --to=replen --ids=A,B --apply  move exactly those
//
// --apply needs --ids, so nothing is ever moved by a filter. Idempotent: a style already in --to is reported and left alone.
// Production needs CONFIRM_DB=<its exact name> as well (see partners-shared.mjs), and nobody should do that without asking.
import mongoose from 'mongoose'
import { Order } from '../src/models/Order.js'
import { AuditLog } from '../src/models/AuditLog.js'
import { connectGuarded, disconnect, apply, flag } from './partners-shared.mjs'

const PRE = ['development', 'replen']
const from = flag('from'), to = flag('to')
const ids = (flag('ids') || '').split(',').map(s => s.trim()).filter(Boolean)
if (!PRE.includes(from) || !PRE.includes(to) || from === to) {
  console.error(`[phase] --from and --to must be two different stages out of: ${PRE.join(', ')}.`)
  process.exit(1)
}
if (apply && !ids.length) {
  console.error('[phase] --apply needs --ids=ID1,ID2 (run without --apply first to see the ids).')
  process.exit(1)
}

await connectGuarded()
// Read raw so a style that predates a field cannot trip a validator on the way.
const col = mongoose.connection.collection('orders')
const styles = await col.find(ids.length ? { _id: { $in: ids } } : { phase: from }, { projection: { product: 1, styleNumber: 1, phase: 1, masterOrderId: 1, buyerId: 1, totalQty: 1, brand: 1, createdAt: 1, 'assignments.mfrId': 1 } }).sort({ createdAt: 1 }).toArray()

const missing = ids.filter(id => !styles.some(s => s._id === id))
for (const id of missing) console.log(`[phase] ${id}: not found`)
const moves = []
for (const s of styles) {
  const line = `${s._id}  ${s.product}${s.styleNumber ? ` (${s.styleNumber})` : ''}  [${s.masterOrderId || 'no master order'}]${s.brand ? `  brand ${s.brand}` : ''}${s.totalQty ? `  ${s.totalQty} pcs` : ''}${(s.assignments || []).length ? `  ${s.assignments.length} factory split(s)` : ''}  stage: ${s.phase || 'production'}`
  if (ids.length && (s.phase || 'production') !== from) { console.log(`[phase] ${line}  -> left alone (not in ${from})`); continue }
  console.log(`[phase] ${ids.length ? (apply ? 'move' : 'would move') : 'in ' + from}: ${line}`)
  if (ids.length) moves.push(s)
}

if (apply && moves.length) {
  for (const s of moves) await Order.updateOne({ _id: s._id, phase: from }, { $set: { phase: to } }, { runValidators: false })
  await AuditLog.create({ byUser: null, action: 'Style Stage Changed', detail: `${moves.length} style${moves.length === 1 ? '' : 's'} moved from ${from} to ${to} (script, on Ankit's instruction): ${moves.map(s => s._id).join(', ')}` })
}
console.log(`[phase] ${styles.length} style${styles.length === 1 ? '' : 's'} ${ids.length ? 'looked at' : `in ${from}`}${ids.length ? `: ${moves.length} ${apply ? 'moved' : 'to move'}` : ''}.`)
if (!apply && moves.length) console.log('[phase] dry run only. Re-run with --apply to write.')
if (!ids.length && styles.length) console.log('[phase] to move some of them, re-run with --ids=<ids from above>.')
await disconnect()
