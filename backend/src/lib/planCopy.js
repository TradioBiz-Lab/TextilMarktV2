// Starting a split's production plan from another one: a sibling style's plan in the same master order, or the
// customer's saved template. Both give plain steps that go in front of the Delivery step, not started. Owners follow
// the new split (the customer stays the customer, the source factory becomes this split's factory, a Tradio admin
// stays if still active); quantity targets follow this split's quantity unless they were a count of their own.
import { User } from '../models/User.js'
import { stageKindOf } from '../models/Order.js'
import { effectiveEta } from './stageMath.js'

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/
const isoOf = v => (v && v !== 'NA' ? (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10) : null)
const dayNum = iso => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000
const isoFromDay = n => new Date(n * 86400000).toISOString().slice(0, 10)

/** The steps of a plan worth copying: everything but the Delivery step. */
export const planSteps = stages => (stages || []).filter(s => !s.isDelivery)

function ownerRoleOf(stage, order, asgn, adminIds) {
  const id = stage.responsibleId?._id?.toString?.() ?? stage.responsibleId?.toString?.() ?? null
  if (!id) return { owner: null }
  if (id === String(order.buyerId?._id ?? order.buyerId)) return { owner: 'buyer' }
  if (id === String(asgn.mfrId?._id ?? asgn.mfrId)) return { owner: 'manufacturer' }
  if (adminIds.has(id)) return { owner: 'admin', adminId: id }
  return { owner: null }   // someone else (another factory): not carried over
}

const fixedUnitsOf = (stage, asgn) =>
  (stageKindOf(stage) === 'quantity' && stage.totalUnits != null && stage.totalUnits !== asgn.qty ? stage.totalUnits : null)

async function activeAdminIds(ids) {
  const list = [...new Set(ids.filter(Boolean).map(String))]
  if (!list.length) return new Set()
  const admins = await User.find({ _id: { $in: list }, role: 'admin', isActive: true }, { _id: 1 }).lean()
  return new Set(admins.map(a => String(a._id)))
}

/** A plan as template steps, with dates as day offsets from its first real date. */
export async function templateStepsFrom(order, asgn) {
  const steps = planSteps(asgn.stages)
  const adminIds = await activeAdminIds(steps.map(s => s.responsibleId?._id ?? s.responsibleId))
  const days = steps.flatMap(s => [isoOf(s.startDate), isoOf(effectiveEta(s))]).filter(Boolean).map(dayNum)
  const day0 = days.length ? Math.min(...days) : null
  const off = v => (isoOf(v) && day0 != null ? dayNum(isoOf(v)) - day0 : null)
  return steps.map(s => ({
    name: s.name, kind: stageKindOf(s), startOffset: off(s.startDate), endOffset: off(effectiveEta(s)),
    ...ownerRoleOf(s, order, asgn, adminIds), description: s.description || '', fixedUnits: fixedUnitsOf(s, asgn),
  }))
}

function newStage({ name, kind, startDate, end, responsibleId, description, totalUnits }) {
  return {
    name, unitsDone: 0, totalUnits, startDate, eta: null, baselineEta: end, stageDate: null, note: '',
    description: description || '', responsibleId: responsibleId || null, kind, status: 'not_started',
    blocked: false, blockedReason: '', isDelivery: false, updates: [], materials: [], items: [], actualEnd: null,
  }
}

function unitsFor(kind, fixedUnits, asgn) {
  if (kind !== 'quantity') return 1
  return fixedUnits || asgn.qty || 1
}

async function ownerIdFor(step, order, asgn) {
  if (step.owner === 'buyer') return order.buyerId?._id ?? order.buyerId
  if (step.owner === 'manufacturer') return asgn.mfrId?._id ?? asgn.mfrId
  if (step.owner === 'admin' && step.adminId) return (await activeAdminIds([step.adminId])).has(String(step.adminId)) ? step.adminId : null
  return null
}

/** New stages from template steps, dated from `startISO` (an NA offset stays NA). */
export async function stagesFromTemplate(steps, { order, asgn, startISO }) {
  if (!ISO_RE.test(startISO || '')) throw Object.assign(new Error('Give the date the plan starts (YYYY-MM-DD)'), { status: 400 })
  const start = dayNum(startISO)
  const at = o => (o == null ? 'NA' : isoFromDay(start + o))
  const out = []
  for (const st of steps) {
    out.push(newStage({ name: st.name, kind: st.kind, startDate: at(st.startOffset), end: at(st.endOffset),
      responsibleId: await ownerIdFor(st, order, asgn), description: st.description, totalUnits: unitsFor(st.kind, st.fixedUnits, asgn) }))
  }
  return out
}

/** New stages copied from a sibling split's plan, on the same dates (styles in one buy run on one timeline). */
export async function stagesFromSibling(srcOrder, srcAsgn, { order, asgn }) {
  const steps = await templateStepsFrom(srcOrder, srcAsgn)
  const src = planSteps(srcAsgn.stages)
  const out = []
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i], s = src[i]
    out.push(newStage({ name: st.name, kind: st.kind, startDate: isoOf(s.startDate) || 'NA', end: isoOf(effectiveEta(s)) || 'NA',
      responsibleId: await ownerIdFor(st, order, asgn), description: st.description, totalUnits: unitsFor(st.kind, st.fixedUnits, asgn) }))
  }
  return out
}
