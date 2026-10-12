import mongoose from 'mongoose'

export const ISSUE_TYPES = ['issue', 'return']

const issueLineSchema = new mongoose.Schema({
  lineId: { type: String, required: true },
  itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItem', required: true },
  // Kept as written at the time, so the slip reads the same whatever the item is later renamed.
  name: { type: String, default: '', maxlength: 300 },
  unit: { type: String, default: 'pcs', maxlength: 20 },
  qty: { type: Number, required: true, min: 0 },
}, { _id: false })

// Stock handed out of the store to one of the factory's orders (an issue), or brought back unused (a
// return). Each line is one row in the stock ledger. It is how what each order really used is known.
const stockIssueSchema = new mongoose.Schema({
  ownerOrgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
  number: { type: String, required: true },
  type: { type: String, enum: ISSUE_TYPES, default: 'issue' },
  orderId: { type: String, required: true },
  // The production step it was issued for (an index into the order's plan), when the person said.
  stageIndex: { type: Number, default: null, min: 0 },
  lines: { type: [issueLineSchema], default: [] },
  note: { type: String, default: '', trim: true, maxlength: 500 },
  issuedOn: { type: String, default: null },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true })

stockIssueSchema.index({ ownerOrgId: 1, number: 1 }, { unique: true })
stockIssueSchema.index({ ownerOrgId: 1, orderId: 1, createdAt: -1 })
stockIssueSchema.index({ ownerOrgId: 1, createdAt: -1 })

export const StockIssue = mongoose.model('StockIssue', stockIssueSchema)
