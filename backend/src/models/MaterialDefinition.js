import mongoose from 'mongoose'

// A reusable fabric/trim/accessory definition — the catalog this app never had.
// Deliberately NOT a hard foreign key: every material line in the system stays
// free-text-first (see stageMaterialSchema.supplier's own comment on why there is
// no Supplier collection), and materialDefinitionId is an optional soft link.
// Typing a material that isn't in the catalog must keep working exactly as today.
const materialDefinitionSchema = new mongoose.Schema({
  name:     { type: String, required: true, trim: true, maxlength: 200 },
  category: { type: String, enum: ['fabric', 'trim', 'accessory', 'other'], required: true },
  defaultUnit:     { type: String, default: '' },  // 'm', 'kg', 'pcs' — free text
  defaultSupplier: { type: String, default: '' },
  // Free text — GSM, width, composition, colour code. Not parsed, just carried.
  spec:      { type: String, default: '', maxlength: 500 },
  isActive:  { type: Boolean, default: true },     // soft delete, matches User.isActive
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true })

materialDefinitionSchema.index({ category: 1, isActive: 1 })

export const MaterialDefinition = mongoose.model('MaterialDefinition', materialDefinitionSchema)
