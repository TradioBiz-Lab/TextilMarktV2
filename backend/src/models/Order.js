import mongoose from 'mongoose'

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

// One entry per production stage — no _id needed, count varies per order
const stageSchema = new mongoose.Schema({
  name:       { type: String, required: true },
  unitsDone:  { type: Number, default: 0, min: 0 },
  totalUnits: { type: Number, required: true, min: 0 },
  startDate:  { type: String, default: null }, // ISO date string or 'NA' — required at creation (routes/orders.js), null only on legacy pre-existing data
  eta:        { type: String, default: null }, // ISO date string or 'NA' — required at creation (routes/orders.js), null only on legacy pre-existing data. Planned end date.
  stageDate:  { type: String, default: null }, // date set by manufacturer for this stage
  note:       { type: String, default: '' },
}, { _id: false })

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
  imageDataUrl: { type: String, default: null }, // base64 data URL — uploaded photo, capped small (see MAX_PRODUCT_PHOTO_SIZE)
  imageUrl:     { type: String, default: null, trim: true }, // optional external link fallback, e.g. a pasted public URL
  assignments: [assignmentSchema],
}, { timestamps: true })

orderSchema.index({ buyerId: 1, createdAt: -1 })
orderSchema.index({ 'assignments.mfrId': 1, createdAt: -1 })

export const Order = mongoose.model('Order', orderSchema)
