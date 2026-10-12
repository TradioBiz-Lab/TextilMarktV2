import mongoose from 'mongoose'
import { TAX_MODES } from '../lib/poMath.js'

// A purchase order's life. 'sending' is the few seconds while the email goes out: it is what stops a
// double click sending a supplier two copies, and it falls back to 'draft' if the email fails.
export const PO_STATUSES = ['draft', 'sending', 'sent', 'acknowledged', 'partially_received', 'closed', 'cancelled']
export const PO_TRANSITIONS = {
  draft: ['sending', 'cancelled'],
  sending: ['sent', 'draft'],
  sent: ['acknowledged', 'partially_received', 'closed', 'cancelled'],
  acknowledged: ['partially_received', 'closed', 'cancelled'],
  partially_received: ['closed'],
  closed: [],
  cancelled: [],
}
export const canTransition = (from, to) => (PO_TRANSITIONS[from] || []).includes(to)

// The details of one side of the PO, frozen when it is sent so the document the supplier holds can
// never change underneath them if the supplier's record or the company's address is edited later.
const partySnapshotSchema = new mongoose.Schema({
  name: { type: String, default: '' }, email: { type: String, default: '' }, phone: { type: String, default: '' },
  gstin: { type: String, default: '' }, pan: { type: String, default: '' }, stateCode: { type: String, default: '' },
  address: { type: String, default: '' }, city: { type: String, default: '' }, pincode: { type: String, default: '' },
  contactName: { type: String, default: '' },
}, { _id: false })

const poLineSchema = new mongoose.Schema({
  // A stable id for the line, so a receipt names the line it is for even after the others are edited.
  lineId: { type: String, required: true },
  description: { type: String, required: true, maxlength: 300 },
  itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'SupplierItem', default: null },
  hsnCode: { type: String, default: '' },
  unit: { type: String, default: 'pcs', maxlength: 20 },
  qty: { type: Number, required: true, min: 0 },
  rate: { type: Number, default: 0, min: 0 },
  discountPct: { type: Number, default: 0, min: 0, max: 100 },
  taxPct: { type: Number, default: 0, min: 0, max: 40 },
  // Computed on the server from the five numbers above (lib/poMath.js); never taken from a request.
  amount: { type: Number, default: 0 },
  taxAmount: { type: Number, default: 0 },
  lineTotal: { type: Number, default: 0 },
  expectedDate: { type: String, default: null },
  // The material line on one of the factory's own orders this buys for (see lib/poSync.js).
  materialRef: {
    type: new mongoose.Schema({
      orderId: { type: String, required: true }, stageIndex: { type: Number, required: true }, materialIndex: { type: Number, required: true },
      name: { type: String, default: '' },
    }, { _id: false }),
    default: null,
  },
  // The bill of materials lines this buys for: one entry per style and colour, with the part of this
  // line's quantity that is for it. Only the server's "generate POs" sets these (lib/poDraft.js), and the
  // BOM aggregate counts them so the same requirement is not ordered twice.
  bomRefs: {
    type: [new mongoose.Schema({
      bomId: { type: mongoose.Schema.Types.ObjectId, ref: 'Bom' },
      orderId: { type: String, required: true }, lineId: { type: String, required: true },
      colour: { type: String, default: '' }, qty: { type: Number, required: true, min: 0 },
    }, { _id: false })],
    default: [],
  },
  receivedQty: { type: Number, default: 0, min: 0 },
  note: { type: String, default: '', maxlength: 300 },
}, { _id: false })

const receiptSchema = new mongoose.Schema({
  at: { type: Date, default: Date.now },
  by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  note: { type: String, default: '', maxlength: 500 },
  lines: [{ _id: false, lineId: String, qty: Number }],
  // The goods received note this came from, so posting the same GRN twice cannot receive twice.
  grnId: { type: String, default: null },
}, { _id: false })

const timelineSchema = new mongoose.Schema({
  at: { type: Date, default: Date.now },
  by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  byName: { type: String, default: '' },
  action: { type: String, required: true },
  note: { type: String, default: '', maxlength: 500 },
}, { _id: false })

// Numbered per factory per Indian financial year, like PO-TPR-2627-0001 (see lib/counters.js).
// Everything on a PO belongs to the factory that raised it (`ownerOrgId`). Brands never see one.
const purchaseOrderSchema = new mongoose.Schema({
  _id: { type: String },
  ownerOrgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
  supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true },
  supplierSnapshot: { type: partySnapshotSchema, default: () => ({}) },
  buyerSnapshot: { type: partySnapshotSchema, default: () => ({}) },
  status: { type: String, enum: PO_STATUSES, default: 'draft' },
  lines: { type: [poLineSchema], default: [] },
  taxMode: { type: String, enum: TAX_MODES, default: 'unknown' },
  totals: {
    subtotal: { type: Number, default: 0 }, discount: { type: Number, default: 0 }, taxable: { type: Number, default: 0 },
    cgst: { type: Number, default: 0 }, sgst: { type: Number, default: 0 }, igst: { type: Number, default: 0 }, gst: { type: Number, default: 0 },
    taxTotal: { type: Number, default: 0 }, roundOff: { type: Number, default: 0 }, grandTotal: { type: Number, default: 0 },
    byRate: { type: [{ _id: false, rate: Number, taxable: Number, cgst: Number, sgst: Number, igst: Number, gst: Number }], default: [] },
  },
  expectedDate: { type: String, default: null },
  shipTo: { type: String, default: '', maxlength: 400 },
  paymentTerms: { type: String, default: '', maxlength: 200 },
  terms: { type: String, default: '', maxlength: 2000 },
  // For the factory's own use: never printed on the PDF or emailed.
  internalNote: { type: String, default: '', maxlength: 1000 },
  sentAt: { type: Date, default: null },
  sentBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  sentTo: { type: [String], default: [] },
  sendingAt: { type: Date, default: null },
  // The PDF the supplier was sent, kept as the record of what was agreed.
  documentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Document', default: null },
  receipts: { type: [receiptSchema], default: [] },
  timeline: { type: [timelineSchema], default: [] },
  cancelReason: { type: String, default: '', maxlength: 500 },
  closedReason: { type: String, default: '', maxlength: 500 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true })

purchaseOrderSchema.index({ ownerOrgId: 1, createdAt: -1 })
purchaseOrderSchema.index({ ownerOrgId: 1, status: 1 })
purchaseOrderSchema.index({ ownerOrgId: 1, supplierId: 1 })
purchaseOrderSchema.index({ ownerOrgId: 1, 'lines.materialRef.orderId': 1 })

export const PurchaseOrder = mongoose.model('PurchaseOrder', purchaseOrderSchema)
