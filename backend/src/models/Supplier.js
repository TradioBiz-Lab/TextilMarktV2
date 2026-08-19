import mongoose from 'mongoose'

// A lightweight supplier catalog — the thing "create/add suppliers" in the
// wizard's Materials step actually means. Deliberately not a hard foreign key
// everywhere `supplier` already appears as free text (stageMaterialSchema,
// MaterialDefinition.defaultSupplier, MaterialRequirement/CostSheet lines) —
// this is a typeahead source layered on top of that free text, not a
// migration of it; every existing free-text field keeps working unmodified.
//
// Ownership: admin-created suppliers are Tradio-shared (global) — Tradio
// already has real relationships with fabric mills etc. that every
// manufacturer benefits from seeing. Manufacturer-created suppliers are
// private to that manufacturer, consistent with the mfr_project privacy
// principle elsewhere in this codebase (a manufacturer's own supplier book
// for their private non-Tradio business is never Tradio's to see).
const supplierSchema = new mongoose.Schema({
  name:        { type: String, required: true, trim: true, maxlength: 200 },
  category:    { type: String, enum: ['fabric', 'trim', 'accessory', 'other'], default: 'other' },
  contactName: { type: String, default: '', trim: true, maxlength: 200 },
  phone:       { type: String, default: '', trim: true, maxlength: 40 },
  email:       { type: String, default: '', trim: true, maxlength: 200 },
  address:     { type: String, default: '', maxlength: 500 },
  ownerType:   { type: String, enum: ['tradio', 'manufacturer'], required: true },
  // Required iff ownerType === 'manufacturer' — validated in the route, not
  // here, same pattern as the wikiScope/buyerId pairing this app already uses.
  mfrId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  createdBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  isActive:    { type: Boolean, default: true },
}, { timestamps: true })

supplierSchema.index({ ownerType: 1, isActive: 1 })
supplierSchema.index({ mfrId: 1, isActive: 1 })

export const Supplier = mongoose.model('Supplier', supplierSchema)
