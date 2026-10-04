import mongoose from 'mongoose'
import { Order, deriveStageStatus, mirroredUnits, deriveActualEnd, stageKindOf } from '../../models/Order.js'

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
  await Order.updateOne(
    { _id: orderId, 'assignments.mfrId': mfrObjectId },
    { $set: set },
    { arrayFilters: [{ 'asgn.mfrId': mfrObjectId }] },
  )
  return { before, after: next, stageName: stage.name }
}

/** Restores a stage to a stored "before" snapshot (coordinator rejected the AI's write). */
export async function revertStageChange({ orderId, mfrId, stageIndex, before }) {
  const mfrObjectId = new mongoose.Types.ObjectId(String(mfrId))
  const p = `assignments.$[asgn].stages.${stageIndex}`
  const set = { 'assignments.$[asgn].updatedAt': new Date() }
  for (const k of FIELDS) set[`${p}.${k}`] = before[k] ?? (k === 'blocked' ? false : null)
  await Order.updateOne(
    { _id: orderId, 'assignments.mfrId': mfrObjectId },
    { $set: set },
    { arrayFilters: [{ 'asgn.mfrId': mfrObjectId }] },
  )
}
