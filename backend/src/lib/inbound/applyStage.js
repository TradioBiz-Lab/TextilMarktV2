import mongoose from 'mongoose'
import { Order, deriveStageStatus, mirroredUnits, deriveActualEnd, stageKindOf } from '../../models/Order.js'
import { statusAfterDeliveryStep } from '../stageMath.js'

const FIELDS = ['unitsDone', 'status', 'actualEnd', 'blocked', 'blockedReason', 'note']
const snap = s => Object.fromEntries(FIELDS.map(k => [k, s[k] ?? null]))

/**
 * Writes one stage change straight to the order, keeping status and unitsDone
 * consistent the same way the stage-update route does. Returns the
 * before/after snapshots (for the audit trail and for revert), or {error}.
 *
 * opts: {status: 'done'|'in_progress', issue?: string, note?: string}
 */
export async function applyStageChange({ orderId, mfrId, stageIndex, status, issue, note }) {
  const mfrObjectId = new mongoose.Types.ObjectId(String(mfrId))
  const order = await Order.findById(orderId).lean()
  const asgn = order?.assignments?.find(a => String(a.mfrId) === String(mfrId))
  const stage = asgn?.stages?.[stageIndex]
  if (!stage) return { error: 'Stage not found' }

  const kind = stageKindOf(stage)
  const total = stage.totalUnits ?? 0
  const before = snap({ ...stage, status: deriveStageStatus(stage) })

  const next = { ...before, status }
  if (status === 'done') next.unitsDone = total
  else if (kind !== 'quantity') next.unitsDone = mirroredUnits(status, total)
  next.actualEnd = deriveActualEnd(status, stage.actualEnd)
  if (note) next.note = note
  if (issue) { next.blocked = true; next.blockedReason = issue.slice(0, 300) }

  const p = `assignments.$[asgn].stages.${stageIndex}`
  const set = { 'assignments.$[asgn].updatedAt': new Date() }
  for (const k of FIELDS) set[`${p}.${k}`] = next[k]
  // Closing the Delivery step is what marks the split Delivered (and reopening it puts it back),
  // so a person confirming Delivery from the review queue must move the split too. The split's
  // status rides along in the before/after snapshots so a revert can restore it.
  const nextAsgn = stage.isDelivery ? statusAfterDeliveryStep(asgn.status, status) : null
  if (nextAsgn) {
    set['assignments.$[asgn].status'] = nextAsgn
    before.asgnStatus = asgn.status
    next.asgnStatus = nextAsgn
  }
  await Order.updateOne(
    { _id: orderId, 'assignments.mfrId': mfrObjectId },
    { $set: set },
    { arrayFilters: [{ 'asgn.mfrId': mfrObjectId }] },
  )
  return { before, after: next, stageName: stage.name, splitStatus: nextAsgn }
}

/**
 * Restores a stage to a stored "before" snapshot (coordinator rejected or corrected the AI's write).
 *
 * The revert only applies while the stage still looks the way the AI left it (`after`). If someone
 * has updated the stage since, putting the old values back would erase their work, so it is left
 * alone and { reverted: false } tells the caller to say so.
 */
export async function revertStageChange({ orderId, mfrId, stageIndex, before, after }) {
  const mfrObjectId = new mongoose.Types.ObjectId(String(mfrId))
  const p = `assignments.$[asgn].stages.${stageIndex}`
  const set = { 'assignments.$[asgn].updatedAt': new Date() }
  for (const k of FIELDS) set[`${p}.${k}`] = before[k] ?? (k === 'blocked' ? false : null)
  if (before.asgnStatus) set['assignments.$[asgn].status'] = before.asgnStatus

  const match = { mfrId: mfrObjectId }
  if (after) {
    for (const k of FIELDS) match[`stages.${stageIndex}.${k}`] = after[k] ?? null
    if (after.asgnStatus) match.status = after.asgnStatus
  }
  const r = await Order.updateOne(
    { _id: orderId, assignments: { $elemMatch: match } },
    { $set: set },
    { arrayFilters: [{ 'asgn.mfrId': mfrObjectId }] },
  )
  return { reverted: r.modifiedCount > 0 }
}
