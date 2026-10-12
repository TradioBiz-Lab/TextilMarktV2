import mongoose from 'mongoose'

// A cost sheet's life. Only the factory sees a draft. Sharing makes a version the brand can read, and it can
// no longer be edited: the factory revises it into the next version instead. The brand comments (which flips
// 'shared' to 'commented') and approves a version; a newer shared version supersedes the older ones.
export const COST_STATUSES = ['draft', 'shared', 'commented', 'approved', 'superseded']

// One material line (fabric, a process, a trim, a label): per piece, quantity times rate, with wastage,
// and freight and duty for imported goods. The amount is computed (lib/costing.js), never stored here.
const materialSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  spec: { type: String, default: '', maxlength: 200 },
  unit: { type: String, default: '', maxlength: 20 },
  consumption: { type: Number, default: 1, min: 0 },
  wastagePct: { type: Number, default: 0, min: 0, max: 100 },
  rate: { type: Number, default: 0, min: 0 },
  freight: { type: Number, default: 0, min: 0 },
  dutyPct: { type: Number, default: 0, min: 0, max: 200 },
  // A remark the brand reads next to the line ("all black", "provided by brand").
  note: { type: String, default: '', maxlength: 200 },
}, { _id: false })

const commentSchema = new mongoose.Schema({
  at: { type: Date, default: Date.now },
  byUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  byName: { type: String, default: '' },
  byRole: { type: String, enum: ['manufacturer', 'buyer'], required: true },
  kind: { type: String, enum: ['comment', 'changes'], default: 'comment' },
  text: { type: String, required: true, maxlength: 2000 },
}, { _id: true })

const costSheetSchema = new mongoose.Schema({
  ownerOrgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
  // The factory (party id) and the brand it is costing for. The brand sees a version only once it is shared.
  mfrId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  brandOrgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
  brandId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  // CS-<company code>-<financial year>-NNNN: one per sheet, shared by all its versions.
  chainId: { type: String, required: true },
  version: { type: Number, default: 1, min: 1 },
  status: { type: String, enum: COST_STATUSES, default: 'draft' },

  styleName: { type: String, required: true, trim: true, maxlength: 120 },
  styleCode: { type: String, default: '', trim: true, maxlength: 60 },
  // Optional ties: the order it became (or is for), and the bill of materials it was seeded from.
  orderId: { type: String, default: null },
  bomId: { type: mongoose.Schema.Types.ObjectId, ref: 'Bom', default: null },
  qty: { type: Number, default: 0, min: 0 },

  fabric: { type: [materialSchema], default: [] },
  process: { type: [materialSchema], default: [] },
  trims: { type: [materialSchema], default: [] },
  labelsPackaging: { type: [materialSchema], default: [] },
  labour: {
    type: new mongoose.Schema({
      cuttingThreads: { type: Number, default: 0, min: 0 },
      making: { type: Number, default: 0, min: 0 },
      finishingPacking: { type: Number, default: 0, min: 0 },
    }, { _id: false }),
    default: () => ({}),
  },
  overheadPct: { type: Number, default: 5, min: 0, max: 100 },
  rejectionPct: { type: Number, default: 3, min: 0, max: 100 },
  marginPct: { type: Number, default: 20, min: 0, max: 500 },
  // Tradio's fee line: 0 unless the factory is managed by Tradio (the server enforces it).
  tradioPct: { type: Number, default: 0, min: 0, max: 100 },
  discountPct: { type: Number, default: 0, min: 0, max: 100 },
  // What lib/costing.js made of the inputs when last saved; the figures shared and approved.
  computed: { type: mongoose.Schema.Types.Mixed, default: null },
  internalNote: { type: String, default: '', maxlength: 1000 },

  comments: { type: [commentSchema], default: [] },
  sharedAt: { type: Date, default: null },
  sharedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  sharedMessage: { type: String, default: '', maxlength: 1000 },
  approvedAt: { type: Date, default: null },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  approvedByName: { type: String, default: '' },
  // The negotiated price per piece the brand agreed to (the sheet's price when no discount).
  approvedPrice: { type: Number, default: null },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true })

costSheetSchema.index({ ownerOrgId: 1, chainId: 1, version: -1 }, { unique: true })
costSheetSchema.index({ ownerOrgId: 1, updatedAt: -1 })
costSheetSchema.index({ brandOrgId: 1, sharedAt: -1 })

export const CostSheet = mongoose.model('CostSheet', costSheetSchema)
