import mongoose from 'mongoose'

export const ITEM_CATEGORIES = ['fabric', 'trim', 'other']

// One thing a supplier sells, as a structured record rather than free text: "Single jersey, 100%
// cotton, 180 GSM, 72 in" is composition, weight and width, so it can be searched, compared across
// suppliers and, later, listed in a marketplace. It also carries the defaults a PO line starts from
// (rate, unit, GST rate, HSN code) and the supplier's minimum order quantity.
const supplierItemSchema = new mongoose.Schema({
  ownerOrgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
  supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true },
  category: { type: String, enum: ITEM_CATEGORIES, default: 'fabric' },
  name: { type: String, required: true, trim: true, maxlength: 200 },
  specs: {
    composition:  { type: String, default: '', trim: true, maxlength: 120 },   // 100% cotton
    gsm:          { type: Number, default: null, min: 0, max: 2000 },
    widthInches:  { type: Number, default: null, min: 0, max: 400 },
    construction: { type: String, default: '', trim: true, maxlength: 80 },    // single jersey, twill, rib 2x2
    colour:       { type: String, default: '', trim: true, maxlength: 80 },
  },
  unit: { type: String, default: 'm', trim: true, maxlength: 20 },
  defaultRate: { type: Number, default: 0, min: 0 },
  moq: { type: Number, default: 0, min: 0 },                                   // minimum order quantity, in `unit`
  leadTimeDays: { type: Number, default: null, min: 0, max: 365 },
  hsnCode: { type: String, default: '', trim: true, maxlength: 8 },
  taxPct: { type: Number, default: 5, min: 0, max: 40 },
  isActive: { type: Boolean, default: true },
  visibility: { type: String, enum: ['private'], default: 'private' },
}, { timestamps: true })

supplierItemSchema.index({ ownerOrgId: 1, supplierId: 1, isActive: 1 })

export const SupplierItem = mongoose.model('SupplierItem', supplierItemSchema)
