import mongoose from 'mongoose'

// 'posting' is the moment goods are being booked in: it is what stops a double tap posting twice, and
// a GRN stuck in it (the server died midway) is picked up and finished by the next attempt.
export const GRN_STATUSES = ['draft', 'posting', 'posted']
// Where the receipt came from: a person on the web, a WhatsApp message, Kriyaa, or a document the AI read
// that a person then confirmed.
export const GRN_SOURCES = ['web', 'whatsapp', 'kriyaa', 'ai_review']

const grnLineSchema = new mongoose.Schema({
  lineId: { type: String, required: true },
  // The purchase order line this is against, when there is one.
  poLineId: { type: String, default: null },
  description: { type: String, required: true, trim: true, maxlength: 300 },
  // The inventory item it books into. Filled when posting if the line only has a description.
  itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItem', default: null },
  unit: { type: String, default: 'pcs', trim: true, maxlength: 20 },
  // What the purchase order said, for the person to compare with (informational).
  orderedQty: { type: Number, default: null },
  // What arrived, what was turned away, and what went into stock (qty less rejectedQty).
  qty: { type: Number, required: true, min: 0 },
  rejectedQty: { type: Number, default: 0, min: 0 },
  rejectReason: { type: String, default: '', trim: true, maxlength: 200 },
  rate: { type: Number, default: 0, min: 0 },
  // Lot, batch or shade number as written on the goods or the challan.
  lot: { type: String, default: '', trim: true, maxlength: 60 },
  note: { type: String, default: '', trim: true, maxlength: 300 },
}, { _id: false })

// A goods received note: what came in from a supplier, checked against its purchase order. Posting it
// adds the accepted quantities to stock, advances the PO and brings the order's material lines in.
// Private to the company (`ownerOrgId`); the number is given when it is posted, not when a draft is begun.
const grnSchema = new mongoose.Schema({
  ownerOrgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
  number: { type: String, default: null },
  status: { type: String, enum: GRN_STATUSES, default: 'draft' },
  source: { type: String, enum: GRN_SOURCES, default: 'web' },
  poId: { type: String, default: null },
  supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', default: null },
  supplierName: { type: String, default: '', trim: true, maxlength: 200 },
  supplierGstin: { type: String, default: '', trim: true, uppercase: true, maxlength: 15 },
  // The supplier's own delivery challan or invoice.
  challanNo: { type: String, default: '', trim: true, maxlength: 60 },
  challanDate: { type: String, default: null },
  vehicleNo: { type: String, default: '', trim: true, maxlength: 20 },
  receivedOn: { type: String, default: null },
  lines: { type: [grnLineSchema], default: [] },
  note: { type: String, default: '', trim: true, maxlength: 1000 },
  // The PDF of the posted GRN (a system document).
  documentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Document', default: null },
  // For a receipt that came in as a message, and what the AI read from it (kept so a person's corrections can be audited).
  inboundMessageId: { type: mongoose.Schema.Types.ObjectId, ref: 'InboundMessage', default: null },
  extraction: { type: mongoose.Schema.Types.Mixed, default: null },
  postingAt: { type: Date, default: null },
  postedAt: { type: Date, default: null },
  postedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true })

grnSchema.index({ ownerOrgId: 1, createdAt: -1 })
grnSchema.index({ ownerOrgId: 1, status: 1 })
grnSchema.index({ ownerOrgId: 1, poId: 1 })
grnSchema.index({ ownerOrgId: 1, number: 1 }, { unique: true, partialFilterExpression: { number: { $type: 'string' } } })

export const Grn = mongoose.model('Grn', grnSchema)
