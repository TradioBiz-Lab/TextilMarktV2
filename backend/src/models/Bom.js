import mongoose from 'mongoose'

// The sections of a bill of materials, in the order a factory reads them. 'labels_packaging' is the
// costing sheet's "labels, tags and packaging"; 'other' is for anything that has no costing block.
export const BOM_SECTIONS = ['fabric', 'process', 'trims', 'labels_packaging', 'other']
export const BOM_STATUSES = ['draft', 'frozen']

const lineSchema = new mongoose.Schema({
  // A stable id, kept across versions, so a purchase order and a cost sheet can point at the line.
  lineId: { type: String, required: true },
  section: { type: String, enum: BOM_SECTIONS, required: true },
  item: { type: String, required: true, trim: true, maxlength: 200 },
  spec: { type: String, default: '', maxlength: 300 },
  unit: { type: String, default: 'pcs', maxlength: 20 },
  // Per piece. perSize holds a figure for each size (null where the base figure applies), parallel to sizes.
  consumption: { type: Number, default: 0, min: 0 },
  perSize: { type: [mongoose.Schema.Types.Mixed], default: [] },
  wastagePct: { type: Number, default: 0, min: 0, max: 100 },
  // True when the quantity depends on colour (cloth, dyed trims): worked and ordered per colour.
  perColour: { type: Boolean, default: false },
  supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', default: null },
  itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'SupplierItem', default: null },
  rate: { type: Number, default: 0, min: 0 },
  note: { type: String, default: '', maxlength: 300 },
  // Where the line came from, so an AI draft can be told from what a person entered. A line from the
  // AI starts needing review and stays flagged until it is edited.
  source: { type: String, enum: ['manual', 'ai', 'import'], default: 'manual' },
  confidence: { type: Number, min: 0, max: 1, default: null },
  needsReview: { type: Boolean, default: false },
  evidence: { type: String, default: '', maxlength: 120 },
}, { _id: false })

const bomSchema = new mongoose.Schema({
  ownerOrgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
  // The factory (party id) whose split of the order this is for.
  mfrId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  orderId: { type: String, required: true },
  version: { type: Number, default: 1, min: 1 },
  status: { type: String, enum: BOM_STATUSES, default: 'draft' },
  sizes: { type: [String], default: [] },
  sizeRatio: { type: [Number], default: [] },
  colours: { type: [new mongoose.Schema({ name: { type: String, required: true, maxlength: 60 }, qty: { type: Number, default: 0, min: 0 } }, { _id: false })], default: [] },
  totalQty: { type: Number, default: 0, min: 0 },
  lines: { type: [lineSchema], default: [] },
  // The tech pack this was drafted from, and how the draft went.
  techPackDocumentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Document', default: null },
  extraction: {
    type: new mongoose.Schema({
      at: { type: Date }, model: { type: String, default: '' }, confidence: { type: Number, default: null },
      notes: { type: [String], default: [] },
    }, { _id: false }),
    default: null,
  },
  frozenAt: { type: Date, default: null },
  frozenBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true })

bomSchema.index({ ownerOrgId: 1, orderId: 1, version: -1 }, { unique: true })
bomSchema.index({ ownerOrgId: 1, updatedAt: -1 })

export const Bom = mongoose.model('Bom', bomSchema)
