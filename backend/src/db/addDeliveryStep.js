// One-off migration: give every existing manufacturer split the mandatory
// Delivery step that new plans get at creation.
//
// DRY RUN BY DEFAULT. It prints what it would change and writes nothing.
//   node --env-file=.env src/db/addDeliveryStep.js
// To write, name the database you mean (a guard against the wrong .env):
//   CONFIRM_DB=<database name shown by the dry run> node --env-file=.env src/db/addDeliveryStep.js --apply
//
// Per split:
//   - already has a flagged Delivery step ........ left alone
//   - last step is already called "Delivery" ..... that step gets the flag, nothing is added
//   - a "Delivery" step that is not last ......... left alone and reported for a human
//   - otherwise .................................. a Delivery step is appended
// The step is appended at the end, so no stage index moves and no document is
// re-pointed. It is planned for the order's promised delivery date. A split that
// is already Delivered gets it already done; any other split gets it not started.
// Safe to run twice: the second run finds every split already done and does nothing.

import mongoose from 'mongoose'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Order, deriveStageStatus } from '../models/Order.js'
import { makeDeliveryStage, isDeliveryName, deliveryStageIndex } from '../lib/stageMath.js'

const isStageDone = s => deriveStageStatus(s) === 'done'
const isoDate = d => new Date(d).toISOString().slice(0, 10)

/** What to do for one split. Pure: reads the order and the split, touches nothing. */
export function planAssignment(order, asgn) {
  const stages = asgn.stages || []
  if (deliveryStageIndex(stages) !== -1) return { action: 'skip', reason: 'already has a Delivery step' }

  const named = stages.findIndex(s => isDeliveryName(s.name))
  if (named !== -1 && named === stages.length - 1) return { action: 'flag', index: named, reason: 'last step is already called Delivery' }
  if (named !== -1) return { action: 'attention', reason: `a step called Delivery is at position ${named + 1} of ${stages.length}, not last` }

  const delivered = asgn.status === 'Delivered'
  const stage = makeDeliveryStage(isoDate(order.delivery))
  if (delivered) {
    stage.status = 'done'
    stage.unitsDone = 1
    stage.actualEnd = isoDate(asgn.updatedAt || order.updatedAt || order.delivery)
  }
  // A split whose steps are all done but which was never marked Delivered reads as
  // complete today. Adding an unfinished Delivery step reopens it, so say so.
  const reopens = !delivered && stages.length > 0 && stages.every(isStageDone)
  return { action: 'add', stage, reopens, reason: delivered ? 'split is Delivered, so the new step is added already done' : 'new step added, not started' }
}

/** Plan (and with apply=true, write) every split in the connected database. */
export async function run({ apply = false, log = () => {} } = {}) {
  const orders = await Order.find({}).lean()
  const summary = { orders: orders.length, splits: 0, add: 0, flag: 0, skip: 0, attention: [], reopens: [], written: 0 }
  for (const order of orders) {
    for (const asgn of order.assignments || []) {
      summary.splits++
      const plan = planAssignment(order, asgn)
      const label = `${order._id} / ${asgn.sub || asgn._id}`
      if (plan.action === 'skip') { summary.skip++; continue }
      if (plan.action === 'attention') { summary.attention.push(`${label}: ${plan.reason}`); log(`  ATTENTION ${label}: ${plan.reason}`); continue }
      summary[plan.action]++
      if (plan.reopens) summary.reopens.push(label)
      log(`  ${plan.action.toUpperCase().padEnd(5)} ${label} (${(asgn.stages || []).length} steps, status ${asgn.status}): ${plan.reason}${plan.reopens ? '  [REOPENS: all steps were done]' : ''}`)
      if (!apply) continue
      const filter = { _id: order._id, 'assignments._id': asgn._id }
      const update = plan.action === 'add'
        ? { $push: { 'assignments.$.stages': plan.stage }, $set: { 'assignments.$.updatedAt': new Date() } }
        : { $set: { [`assignments.$.stages.${plan.index}.isDelivery`]: true } }
      const res = await Order.updateOne(filter, update)
      if (res.modifiedCount === 1) summary.written++
    }
  }
  return summary
}

async function main() {
  const apply = process.argv.includes('--apply')
  if (!process.env.MONGO_DB_URI) { console.error('MONGO_DB_URI is not set.'); process.exit(1) }
  await mongoose.connect(process.env.MONGO_DB_URI, { serverSelectionTimeoutMS: 20000 })
  const dbName = mongoose.connection.db.databaseName
  console.log(`Database: ${dbName}`)
  console.log(apply ? 'Mode: APPLY (writing)' : 'Mode: DRY RUN (nothing will be written)')
  if (apply && process.env.CONFIRM_DB !== dbName) {
    console.error(`Refusing to write: set CONFIRM_DB=${dbName} to confirm this is the database you mean.`)
    await mongoose.disconnect(); process.exit(1)
  }
  const s = await run({ apply, log: console.log })
  console.log(`\n${s.orders} orders, ${s.splits} manufacturer splits`)
  console.log(`  would add a step: ${s.add}   would flag an existing one: ${s.flag}   already fine: ${s.skip}   needs a human: ${s.attention.length}`)
  if (s.reopens.length) console.log(`  ${s.reopens.length} split(s) have every step done but were never marked Delivered, and will show as awaiting delivery:\n    ${s.reopens.join('\n    ')}`)
  if (apply) console.log(`\nWrote ${s.written} change(s).`)
  else console.log('\nDry run only. Nothing was changed.')
  await mongoose.disconnect()
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(err => { console.error(err.message); process.exit(1) })
}
