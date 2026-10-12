import mongoose from 'mongoose'

export const SUPPLIER_TYPES = ['fabric_supplier', 'dyer', 'trims_supplier', 'other']

// A person at the supplier worth calling or copying on a PO.
const contactSchema = new mongoose.Schema({
  name:  { type: String, default: '', trim: true, maxlength: 120 },
  role:  { type: String, default: '', trim: true, maxlength: 80 },
  phone: { type: String, default: '', trim: true, maxlength: 40 },
  email: { type: String, default: '', trim: true, lowercase: true, maxlength: 254 },
}, { _id: false })

// A manufacturer's private supplier book: the mills, dyers and trims shops it buys from.
//
// Every supplier belongs to exactly one organization (`ownerOrgId`) and is never visible to anyone
// else: not to other factories, and not to the brands the factory makes for (a brand sees what an
// order costs only through a cost sheet the factory chooses to share). `visibility` is reserved so a
// future fabric and trims marketplace can list opted-in suppliers across companies without
// remodelling; today the only value is 'private' and the API refuses anything else.
const supplierSchema = new mongoose.Schema({
  ownerOrgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
  name: { type: String, required: true, trim: true, maxlength: 200 },
  type: { type: String, enum: SUPPLIER_TYPES, default: 'fabric_supplier' },
  email: { type: String, default: '', trim: true, lowercase: true, maxlength: 254 },
  phone: { type: String, default: '', trim: true, maxlength: 40 },
  contacts: { type: [contactSchema], default: [] },
  gstin: { type: String, default: '', uppercase: true, trim: true, maxlength: 15 },
  // GST state code of the supplier ('33'), from the GSTIN when there is one.
  stateCode: { type: String, default: '', trim: true, maxlength: 2 },
  address: { type: String, default: '', trim: true, maxlength: 400 },
  city: { type: String, default: '', trim: true, maxlength: 80 },
  pincode: { type: String, default: '', trim: true, maxlength: 6 },
  paymentTerms: { type: String, default: '', trim: true, maxlength: 200 },
  deliveryTerms: { type: String, default: '', trim: true, maxlength: 200 },
  notes: { type: String, default: '', trim: true, maxlength: 1000 },
  isActive: { type: Boolean, default: true },
  visibility: { type: String, enum: ['private'], default: 'private' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true })

// One supplier name per company, however it is capitalised.
supplierSchema.index({ ownerOrgId: 1, name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } })
supplierSchema.index({ ownerOrgId: 1, isActive: 1, type: 1 })

export const Supplier = mongoose.model('Supplier', supplierSchema)
