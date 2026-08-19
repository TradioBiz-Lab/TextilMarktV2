import mongoose from 'mongoose'
import {
  STAGE_KINDS, STAGE_STATUS_VALUES, stageSchema,
  stageKindOf, deriveStageStatus, mirroredUnits, deriveActualEnd, stageEtaVarianceDays,
} from './shared/stage.js'

// Re-exported verbatim so every existing `import { ... } from '../models/Order.js'`
// keeps working unchanged — the stage schema/helpers now live in shared/stage.js
// so MfrProject can reuse the exact same TNA machinery (see mfrProjectStages.js).
export {
  STAGE_KINDS, STAGE_STATUS_VALUES,
  stageKindOf, deriveStageStatus, mirroredUnits, deriveActualEnd, stageEtaVarianceDays,
}

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
