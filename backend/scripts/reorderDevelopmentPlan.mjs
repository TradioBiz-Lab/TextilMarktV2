// One-off: the standard NPD / Replen plan now puts Pricing Approved third (after Manufacturer Matching), ahead of the sample
// steps (lib/stageMath.js DEVELOPMENT_PLAN). This puts the plans already on file in the same order.
//   * A plan where nothing has started (every step not started, no notes, nothing blocked) is dated afresh, step by step, the
//     way the standard plan is: each step starts where the one before it ends, from the first step's start date. Its last
//     date is unchanged, because the steps still add up to the same number of days.
//   * A plan with progress is only reordered. Each step keeps its own dates, status, notes and owner, so history is not
//     rewritten.
// Documents and factory messages filed on a step follow it (they point at a step by its position). A plan whose steps are not
// exactly the standard seven is left alone. Idempotent.
//
//   node --env-file=.env.sandbox scripts/reorderDevelopmentPlan.mjs            dry run: list what would change
//   node --env-file=.env.sandbox scripts/reorderDevelopmentPlan.mjs --apply    change them
//
// Production needs CONFIRM_DB=<its exact name> as well (see partners-shared.mjs), and nobody should do that without asking.
import mongoose from 'mongoose'
import { AuditLog } from '../src/models/AuditLog.js'
import { DEVELOPMENT_PLAN } from '../src/lib/stageMath.js'
import { connectGuarded, disconnect, apply } from './partners-shared.mjs'

const NAMES = DEVELOPMENT_PLAN.map(s => s.name)
const addDays = (iso, n) => { const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
const untouched = s => (s.status || 'not_started') === 'not_started' && !(s.updates || []).length && !s.blocked && !(s.materials || []).length && !(s.items || []).length && !(s.unitsDone > 0)
const day = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : v)

await connectGuarded()
const db = mongoose.connection
const styles = await db.collection('orders').find({ phase: { $in: ['development', 'replen'] } }).sort({ createdAt: 1 }).toArray()

const plans = []
let already = 0
for (const o of styles) {
  for (const [ai, a] of (o.assignments || []).entries()) {
    const stages = a.stages || []
    const names = stages.map(s => s.name)
    if (names.join('|') === NAMES.join('|')) { already++; continue }
    if ([...names].sort().join('|') !== [...NAMES].sort().join('|')) { console.log(`[plan] ${o._id}: its steps are not the standard seven, left alone`); continue }
    const next = NAMES.map(n => ({ ...stages[names.indexOf(n)] }))
    const fresh = stages.every(untouched)
    if (fresh) {
      let cursor = day(stages[0].startDate)
      next.forEach((s, i) => { s.startDate = cursor; cursor = addDays(cursor, DEVELOPMENT_PLAN[i].days); s.baselineEta = cursor; s.eta = null })
    }
    plans.push({ o, ai, a, stages, next, fresh, move: names.map(n => NAMES.indexOf(n)) })
  }
}

for (const { o, a, stages, next, fresh } of plans) {
  console.log(`[plan] ${apply ? 'change' : 'would change'} ${o._id} ${o.styleNumber} [${o.phase}] - ${fresh ? 'nothing started: dated afresh' : 'has progress: reordered, each step keeps its own dates'}`)
  stages.forEach((s, i) => console.log(`         before ${i + 1} ${s.name.padEnd(22)} ${String(day(s.startDate)).padEnd(10)} -> ${String(day(s.baselineEta)).padEnd(10)} eta ${String(day(s.eta)).padEnd(10)} ${s.status}`))
  next.forEach((s, i) => console.log(`         after  ${i + 1} ${s.name.padEnd(22)} ${String(day(s.startDate)).padEnd(10)} -> ${String(day(s.baselineEta)).padEnd(10)} eta ${String(day(s.eta)).padEnd(10)} ${s.status}`))
  const docs = await db.collection('documents').countDocuments({ orderId: o._id, mfrId: a.mfrId, stageIndex: { $ne: null } })
  const msgs = await db.collection('inboundmessages').countDocuments({ orderId: o._id })
  if (docs || msgs) console.log(`         ${docs} document(s) and ${msgs} factory message(s) point at steps of this style and follow them`)
}

if (apply && plans.length) {
  for (const { o, ai, a, stages, next, move } of plans) {
    const p = `assignments.${ai}.stages`
    // Only while the plan is still in the order it was read in, so nothing edited meanwhile is overwritten.
    const guard = Object.fromEntries(stages.map((s, i) => [`${p}.${i}.name`, s.name]))
    const r = await db.collection('orders').updateOne({ _id: o._id, ...guard }, { $set: { [p]: next } })
    if (!r.modifiedCount) { console.log(`[plan] ${o._id}: changed meanwhile, skipped (its documents were not touched)`); continue }
    // Re-point what was filed on a step: each is written once, guarded on its old position.
    const docs = await db.collection('documents').find({ orderId: o._id, mfrId: a.mfrId, stageIndex: { $ne: null } }, { projection: { stageIndex: 1 } }).toArray()
    const ops = docs.filter(d => move[d.stageIndex] != null && move[d.stageIndex] !== d.stageIndex).map(d => ({ updateOne: { filter: { _id: d._id, stageIndex: d.stageIndex }, update: { $set: { stageIndex: move[d.stageIndex] } } } }))
    if (ops.length) await db.collection('documents').bulkWrite(ops, { ordered: false })
    const msgs = await db.collection('inboundmessages').find({ orderId: o._id }, { projection: { stageIndex: 1 } }).toArray()
    const mops = msgs.filter(m => move[m.stageIndex] != null && move[m.stageIndex] !== m.stageIndex).map(m => ({ updateOne: { filter: { _id: m._id, stageIndex: m.stageIndex }, update: { $set: { stageIndex: move[m.stageIndex] } } } }))
    if (mops.length) await db.collection('inboundmessages').bulkWrite(mops, { ordered: false })
  }
  await AuditLog.create({ byUser: null, action: 'Plan Updated', detail: `${plans.length} NPD/Replen plan${plans.length === 1 ? '' : 's'} put in the standard order, Pricing Approved third (script, on Ankit's instruction): ${plans.map(p => p.o._id).join(', ')}` })
}
console.log(`[plan] ${styles.length} NPD/Replen styles: ${plans.length} ${apply ? 'changed' : 'to change'}, ${already} already in the standard order.`)
if (!apply && plans.length) console.log('[plan] dry run only. Re-run with --apply to write.')
await disconnect()
