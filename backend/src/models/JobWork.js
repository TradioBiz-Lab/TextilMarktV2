import mongoose from 'mongoose'

// 'open' from the day goods are sent; 'partially_returned' once something has come back; 'closed' when every
// line is accounted for (returned, or written off with a reason); 'cancelled' when it was sent in error before
// anything came back.
export const JOBWORK_STATUSES = ['open', 'partially_returned', 'closed', 'cancelled']

const lineSchema = new mongoose.Schema({
  lineId: { type: String, required: true },
  itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItem', required: true },
  // As written when it was sent, so the challan reads the same whatever the item is later renamed.
  name: { type: String, required: true, maxlength: 300 },
  unit: { type: String, default: 'pcs', maxlength: 20 },
  hsnCode: { type: String, default: '', maxlength: 8 },
  qty: { type: Number, required: true, min: 0 },
  // What the goods are worth per unit (the challan states a value), a figure the person gives.
  rate: { type: Number, default: 0, min: 0 },
  // How much of the quantity sent has been accounted for by goods coming back, and how much written off.
  returnedQty: { type: Number, default: 0, min: 0 },
  writtenOffQty: { type: Number, default: 0, min: 0 },
}, { _id: false })

const returnSchema = new mongoose.Schema({
  at: { type: Date, default: Date.now },
  by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  note: { type: String, default: '', maxlength: 500 },
  // Per sent line: how much of it this delivery accounts for, and what came back in its place (dyed cloth for grey,
  // for instance), which went into the store.
  lines: [{
    _id: false, lineId: String, inputQty: Number,
    outputs: [{ _id: false, itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItem' }, name: String, unit: String, qty: Number }],
  }],
}, { _id: false })

const partySchema = new mongoose.Schema({
  name: { type: String, default: '' }, gstin: { type: String, default: '' }, stateCode: { type: String, default: '' },
  address: { type: String, default: '' }, city: { type: String, default: '' }, pincode: { type: String, default: '' },
  phone: { type: String, default: '' }, contactName: { type: String, default: '' },
}, { _id: false })

// Goods a factory sent to a job worker (a dyer, printer, embroiderer, washer) under a delivery challan: still the
// factory's, now at the job worker, until they come back processed. Sending moves stock from the store to the job
// worker's location in the ledger; every return moves it on. Private to the company (`ownerOrgId`).
const jobWorkSchema = new mongoose.Schema({
  ownerOrgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
  number: { type: String, required: true },
  status: { type: String, enum: JOBWORK_STATUSES, default: 'open' },
  supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true },
  supplierSnapshot: { type: partySchema, default: () => ({}) },
  consignorSnapshot: { type: partySchema, default: () => ({}) },
  process: { type: String, default: '', trim: true, maxlength: 80 },
  orderId: { type: String, default: null },
  sentOn: { type: String, required: true },
  expectedBack: { type: String, default: null },
  vehicleNo: { type: String, default: '', trim: true, maxlength: 20 },
  note: { type: String, default: '', trim: true, maxlength: 1000 },
  lines: { type: [lineSchema], default: [] },
  returns: { type: [returnSchema], default: [] },
  documentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Document', default: null },
  closedReason: { type: String, default: '', maxlength: 500 },
  cancelReason: { type: String, default: '', maxlength: 500 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true })

jobWorkSchema.index({ ownerOrgId: 1, number: 1 }, { unique: true })
jobWorkSchema.index({ ownerOrgId: 1, status: 1, createdAt: -1 })
jobWorkSchema.index({ ownerOrgId: 1, supplierId: 1 })

export const JobWork = mongoose.model('JobWork', jobWorkSchema)
