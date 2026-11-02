// One-off: every NPD / Replen plan should end in "Ready for Production" (lib/stageMath.js DEVELOPMENT_PLAN: zero days after
// Pricing Approved). Plans made before that was settled ended in an undated "Order Confirmation" instead, so the TNA matrix
// shows both rows, each applicable to some styles and "NA" for the rest. This renames that last step to "Ready for
// Production" and dates it the way the standard plan does: it starts and is due on the day Pricing Approved is due, and it is
// not revised (eta null). Status, notes, owner and everything else on the step stay as they are. Idempotent.
//
//   node --env-file=.env.sandbox scripts/backfillReadyForProduction.mjs            dry run: list what would change
//   node --env-file=.env.sandbox scripts/backfillReadyForProduction.mjs --apply    change them
//
// Production needs CONFIRM_DB=<its exact name> as well (see partners-shared.mjs), and nobody should do that without asking.
import mongoose from 'mongoose'
import { AuditLog } from '../src/models/AuditLog.js'
import { connectGuarded, disconnect, apply } from './partners-shared.mjs'

const OLD = 'Order Confirmation', NEW = 'Ready for Production'
const isDay = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)
const today = new Date().toISOString().slice(0, 10)

await connectGuarded()
const col = mongoose.connection.collection('orders')
const styles = await col.find({ phase: { $in: ['development', 'replen'] } }, { projection: { product: 1, styleNumber: 1, phase: 1, assignments: 1 } }).sort({ createdAt: 1 }).toArray()

const changes = []
let already = 0
for (const o of styles) {
  for (const [ai, a] of (o.assignments || []).entries()) {
    const stages = a.stages || []
    if (stages.some(s => s.name === NEW)) { already++; continue }
    const si = stages.findIndex(s => s.name === OLD)
    if (si === -1) { console.log(`[plan] ${o._id}: has neither "${OLD}" nor "${NEW}", left alone`); continue }
    const pricing = stages.find(s => s.name === 'Pricing Approved')
    const due = pricing && isDay(pricing.baselineEta) ? pricing.baselineEta.slice(0, 10) : null
    if (!due) { console.log(`[plan] ${o._id}: Pricing Approved has no planned date to follow, left alone`); continue }
    changes.push({ o, ai, si, due, step: stages[si] })
  }
}
for (const { o, si, due, step } of changes) {
  console.log(`[plan] ${apply ? 'change' : 'would change'} ${o._id} ${o.styleNumber} [${o.phase}] step ${si + 1}: "${step.name}" start ${step.startDate} / due ${step.baselineEta} / revised ${step.eta} -> "${NEW}" start ${due} / due ${due} / revised none${due < today ? '  (that date is already past, so the step shows overdue)' : ''}`)
}
if (apply && changes.length) {
  for (const { o, ai, si, due, step } of changes) {
    const p = `assignments.${ai}.stages.${si}`
    // Only if the step is still the old one at that place: nothing else is overwritten, and a second run does nothing.
    const r = await col.updateOne({ _id: o._id, [`${p}.name`]: OLD }, { $set: { [`${p}.name`]: NEW, [`${p}.startDate`]: due, [`${p}.baselineEta`]: due, [`${p}.eta`]: null } })
    if (!r.modifiedCount) console.log(`[plan] ${o._id}: changed meanwhile, skipped`)
  }
  await AuditLog.create({ byUser: null, action: 'Plan Updated', detail: `${changes.length} NPD/Replen plan${changes.length === 1 ? '' : 's'}: last step "${OLD}" renamed "${NEW}" and dated like the standard plan (script, on Ankit's instruction): ${changes.map(c => c.o._id).join(', ')}` })
}
console.log(`[plan] ${styles.length} NPD/Replen styles: ${changes.length} ${apply ? 'changed' : 'to change'}, ${already} already end in "${NEW}".`)
if (!apply && changes.length) console.log('[plan] dry run only. Re-run with --apply to write.')
await disconnect()
