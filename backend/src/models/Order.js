import mongoose from 'mongoose'
import { getToday } from '../lib/stageMath.js'

// Default production stages — admin can override per order at creation time
export const DEFAULT_STAGE_NAMES = [
  'Lab Dip Approval', 'PP Sample',
  'Material Sourcing', 'Knitting', 'Dyeing', 'Processing',
  'Cutting', 'Stitching', 'Finishing', 'Packing', 'QC', 'Dispatch',
]

// BRD §4 — Order-level status overlay (separate from stage progress)
export const ORDER_STATUS_VALUES = ['Processing', 'On Hold', 'Delayed', 'Delivered']

// Categories — stored as free-text; this list is only a frontend suggestion
const CATEGORIES = ['TSHRT', 'JEANS', 'BEDSH', 'SHIRT', 'DRESS', 'JACKET', 'POLO', 'SHORTS', 'HOODIE']
const SEASONS    = ['SS26', 'FW26', 'SS27', 'FW27', 'SS28']

// One update note in a stage's ticket-style progress thread.
const stageUpdateSchema = new mongoose.Schema({
  text:   { type: String, required: true, maxlength: 1000 },
  byUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  at:     { type: Date, default: Date.now },
}, { _id: false })

// One raw-material/trim line to procure for a stage — tracked to PO/received level.
// Real _id (Mongoose's default for a subdocument array) so MaterialRequirement's
// pushedTo[] can reference a line stably — a positional index would silently
// mis-point after a stage-insert, stage-delete, or another material-line delete,
// all of which shift array positions elsewhere in this file.
const stageMaterialSchema = new mongoose.Schema({
  name:         { type: String, required: true, maxlength: 200 },
  // Planning metadata for the Materials Management module — deliberately NOT read
  // by the production gate below (isTrims/isTrimsOrderStage stay name-keyed only,
  // see routes/orders.js), so this never changes existing gating behavior.
  category:     { type: String, enum: ['fabric', 'trim', 'accessory', 'other'], default: 'other' },
  colourway:    { type: String, default: '' }, // matches order.colourways[].name; '' = not colourway-specific
  requiredQty:  { type: Number, required: true, min: 0 },
  unit:         { type: String, default: '' },   // 'm', 'pcs', 'kg' — free text
  supplier:     { type: String, default: '' },   // free text — no separate Supplier collection
  poNumber:     { type: String, default: '' },
  expectedDate: { type: String, default: null }, // ISO date string or 'NA'
  status:       { type: String, enum: ['pending', 'ordered', 'received'], default: 'pending' },
  orderedQty:   { type: Number, default: 0, min: 0 },
  receivedQty:  { type: Number, default: 0, min: 0 },
  note:         { type: String, default: '' },
})

// How a stage measures "done". Most real TNA steps are milestones — of the 16
// steps in a Cocoblu plan, only Production counts garments. A `checklist` stage
// holds its own short list of the actual deliverables (three lab dips, one per
// colourway), which is neither a single milestone nor an order-sized quantity.
export const STAGE_KINDS = ['milestone', 'checklist', 'quantity']
export const STAGE_STATUS_VALUES = ['not_started', 'in_progress', 'done']

// One deliverable inside a `checklist` stage — e.g. "Lab Dip — Peacot".
// Distinct from stageMaterialSchema: materials are procurement (supplier, PO,
// received qty) and gate production; items are the step's own output.
const stageItemSchema = new mongoose.Schema({
  name:      { type: String, required: true, maxlength: 200 },
  colourway: { type: String, default: '' },  // matches an order.colourways[].name when per-colour
  status:    { type: String, enum: ['pending', 'done'], default: 'pending' },
  // The originally planned due date, frozen. Captured lazily the first time
  // `dueDate` is revised (see the items update route) — same pattern as
  // stage.baselineEta vs stage.eta.
  plannedDate: { type: String, default: null },
  dueDate:   { type: String, default: null }, // ISO date string or 'NA' — the CURRENT (revised) due date
  doneDate:  { type: String, default: null },
  note:      { type: String, default: '' },
}, { _id: false })

// One entry per production stage — no _id needed, count varies per order
const stageSchema = new mongoose.Schema({
  name:       { type: String, required: true },
  unitsDone:  { type: Number, default: 0, min: 0 },
  totalUnits: { type: Number, required: true, min: 0 },
  startDate:  { type: String, default: null }, // ISO date string or 'NA' — required at creation (routes/orders.js), null only on legacy pre-existing data
  eta:        { type: String, default: null }, // ISO date string or 'NA' — the CURRENT (revised) end date. Required at creation; null only on legacy pre-existing data.
  // The originally planned end date, frozen. Set at creation, and — for stages
  // predating this field — captured lazily the first time `eta` is revised (see
  // the /eta route). Slippage is `eta - baselineEta`; overwriting `eta` without
  // this made it unmeasurable, which is why the team kept both columns in Excel.
  baselineEta: { type: String, default: null },
  // When the stage actually finished — auto-stamped/cleared alongside status,
  // never hand-edited (see deriveActualEnd). Distinct from `eta`, which is
  // when it's due; a step can close early, late, or exactly on time.
  actualEnd:  { type: String, default: null },
  stageDate:  { type: String, default: null }, // date set by manufacturer for this stage
  note:       { type: String, default: '' },
  description: { type: String, default: '', maxlength: 1000 }, // static description of what this stage involves — separate from `note`, which is the transient last-progress-update note
  responsibleId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // admin, manufacturer, or buyer accountable for this stage
  // null on documents predating these fields — read through stageKindOf() /
  // deriveStageStatus(), never raw, so legacy stages report the truth rather
  // than a default. See docs/SCHEMA.md.
  kind:       { type: String, enum: STAGE_KINDS, default: null },
  status:     { type: String, enum: STAGE_STATUS_VALUES, default: null },
  // Orthogonal to status: a stage can be in_progress AND blocked (two colourways
  // dyeing, the third waiting on a sample).
  blocked:       { type: Boolean, default: false },
  blockedReason: { type: String, default: '', maxlength: 300 },
  updates:    [stageUpdateSchema],
  // Materials/PO checklist for this stage (e.g. fabric/trims to procure). A stage with
  // 1+ material lines cannot advance unitsDone while any line isn't 'received' —
  // see the gating check in routes/orders.js.
  materials:  [stageMaterialSchema],
  items:      [stageItemSchema],
}, { _id: false })

// ── Stage derivation helpers ────────────────────────────────────────────────
// Every order read is .lean(), so Mongoose never applies schema defaults to
// documents written before a field existed — those come back undefined. These
// helpers are the single place that resolves that, and enrichOrder is the only
// serialization point, so normalizing there replaces a migration entirely.

/** Absent kind means the document predates the field: it behaves exactly as before. */
export function stageKindOf(stage) {
  return stage?.kind ?? 'quantity'
}

/** Never return the raw default for a legacy stage — a completed one would read as not_started. */
export function deriveStageStatus(stage) {
  if (stage?.status) return stage.status
  const done = stage?.unitsDone || 0
  const total = stage?.totalUnits || 0
  if (total > 0 && done >= total) return 'done'
  return done > 0 ? 'in_progress' : 'not_started'
}

/**
 * The `unitsDone` a non-quantity stage should carry for a given status.
 *
 * This mirror is load-bearing: five separate frontend surfaces find the active
 * stage with `unitsDone < totalUnits`, so keeping units in sync with status lets
 * them all keep working untouched. The frontend (Slate) auto-deploys on push
 * while the backend (AppSail) needs a manual deploy, so version skew is normal
 * during a rollout — without the mirror, a skewed pair breaks those surfaces.
 */
export function mirroredUnits(status, totalUnits) {
  return status === 'done' ? (totalUnits || 0) : 0
}

/**
 * `actualEnd` for a stage transitioning to the given status. Stamps today's
 * date (IST — see getToday(), matching every other day-boundary in this app;
 * new Date().toISOString() was UTC and could land a day behind IST between
 * ~18:30-24:00 UTC) the first time a stage reaches 'done' (keeps the original
 * stamp on a later no-op save), clears it on reopen. Same shape as
 * items[].doneDate.
 *
 * `explicitActualEnd`, when given, backdates the stamp to a date the caller
 * already validated (see the two call sites) — for "mark it done, it
 * actually finished on the 3rd" narration. Takes priority over both the
 * preserved stamp and today's date.
 */
export function deriveActualEnd(status, currentActualEnd, explicitActualEnd) {
  if (status !== 'done') return null
  if (explicitActualEnd) return explicitActualEnd
  return currentActualEnd || getToday()
}

/** Days of slippage: positive = late, negative = pulled in, null = not measurable. */
export function stageEtaVarianceDays(stage) {
  const base = stage?.baselineEta
  const now = stage?.eta
  if (!base || !now || base === 'NA' || now === 'NA') return null
  const a = new Date(base).getTime()
  const b = new Date(now).getTime()
  if (isNaN(a) || isNaN(b)) return null
  return Math.round((b - a) / 86400000)
}

/**
 * Days the order's delivery PROMISE has slipped from what was originally
 * committed (positive = later than first promised). Same shape as
 * stageEtaVarianceDays, one level up: `delivery` can be corrected to stay
 * honest with the current TNA plan (see deliveryOverrunDays in
 * frontend/src/constants.js and backend/src/lib/stageMath.js, which compares
 * the plan's last stage against `delivery` itself) — that correction would
 * otherwise erase the fact that the promise moved. null until `delivery` has
 * been revised at least once (baselineDelivery backfills lazily then, same
 * convention as baselineEta).
 */
export function deliveryVarianceDays(order) {
  const base = order?.baselineDelivery
  const now = order?.delivery
  if (!base || !now) return null
  const a = new Date(base).getTime()
  const b = new Date(now).getTime()
  if (isNaN(a) || isNaN(b)) return null
  return Math.round((b - a) / 86400000)
}

// One per manufacturer split on an order
const assignmentSchema = new mongoose.Schema({
  mfrId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  qty:    { type: Number, required: true, min: 1 },
  // Order-level status — overlays the stage grid (does not reset it)
  status: { type: String, enum: ORDER_STATUS_VALUES, default: 'Processing' },
  sub:    { type: String, required: true },   // M1, M2 … split label
  note:   { type: String, default: '' },       // latest free-text note
  stages: [stageSchema],                       // dynamic count per order
  updatedAt: { type: Date, default: Date.now },
}, { _id: true })

// A colourway this style is made in. Held at order level so per-colour stages
// (dyeing, lab dips, FPT/GPT) can generate their checklist items from one list
// instead of the same names being retyped on every step. Names only — a
// qty-per-colour-per-size grid is deliberately out of scope for now.
const colourwaySchema = new mongoose.Schema({
  name: { type: String, required: true, maxlength: 60 },
  code: { type: String, default: '' },
}, { _id: false })

// Orders use a custom human-readable string _id: ZAR-TPR-TSHRT-SS26-001
const orderSchema = new mongoose.Schema({
  _id:      { type: String },
  masterOrderId: { type: String, default: null }, // links to MasterOrder._id
  buyerId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  product:  { type: String, required: true, trim: true },
  category: { type: String, trim: true },  // free-text (not enum-restricted)
  season:   { type: String, enum: SEASONS },
  totalQty: { type: Number, required: true, min: 1 },
  delivery: { type: Date, required: true },
  // Frozen original delivery promise — same baselineEta/eta pattern as
  // stages: `delivery` is the current, kept-honest date (e.g. realigned to
  // match the TNA plan's last stage); `baselineDelivery` is what was first
  // committed, so slippage from the ORIGINAL promise stays measurable even
  // after `delivery` itself gets corrected. Backfilled lazily on first
  // revision (see the edit-order route), never backdated by hand.
  baselineDelivery: { type: Date, default: null },
  colourways: [colourwaySchema],
  // Order-level risk/escalation note — the "Callouts" column the team maintains
  // by hand today (e.g. "delayed by a week due to lab dip submission delay").
  callout:  { type: String, default: '', maxlength: 500 },
  imageDataUrl: { type: String, default: null }, // base64 data URL — uploaded photo, capped at 1MB (see MAX_PRODUCT_PHOTO_SIZE)
  imageUrl:     { type: String, default: null, trim: true }, // optional external link fallback, e.g. a pasted public URL
  assignments: [assignmentSchema],
}, { timestamps: true })

orderSchema.index({ buyerId: 1, createdAt: -1 })
orderSchema.index({ 'assignments.mfrId': 1, createdAt: -1 })

export const Order = mongoose.model('Order', orderSchema)
