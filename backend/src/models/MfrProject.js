import mongoose from 'mongoose'

// One style of a manufacturer's own non-Tradio work.
//
// Deliberately NOT an Order: no buyerId (that's a real Tradio account), no
// assignments[], no TNA stages[]. Scope is materials + costing only — this is not
// a second, parallel order-tracking system. If manufacturers later want TNA for
// their own work, that's a separate feature decision, not an assumed extension.
//
// PRIVACY: same rule as MfrMasterProject — mfrId owns it, no admin override.
const mfrProjectSchema = new mongoose.Schema({
  mfrId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  // Optional grouping, exactly as Order.masterOrderId optionally groups an Order —
  // a standalone style with no parent is valid.
  mfrMasterProjectId: { type: mongoose.Schema.Types.ObjectId, ref: 'MfrMasterProject', default: null },

  styleName: { type: String, required: true, trim: true, maxlength: 200 },
  // Free text. When mfrMasterProjectId is set the UI defaults this from the parent,
  // but it is not constrained — a manufacturer may legitimately override per style.
  buyerName: { type: String, default: '', trim: true, maxlength: 200 },
  category:  { type: String, default: '', trim: true, maxlength: 60 },
  season:    { type: String, default: '', trim: true, maxlength: 60 },
  totalQty:  { type: Number, default: 0, min: 0 },
  delivery:  { type: Date, default: null },
  // Same shape as Order.colourways, reused verbatim so the colourway cascade
  // (requirement lines -> per-colour quantities) works identically in both scopes.
  colourways: [{
    name: { type: String, required: true, maxlength: 60 },
    code: { type: String, default: '' },
  }],
  notes:    { type: String, default: '', maxlength: 1000 },
  isActive: { type: Boolean, default: true },
}, { timestamps: true })

mfrProjectSchema.index({ mfrId: 1, isActive: 1, createdAt: -1 })
mfrProjectSchema.index({ mfrMasterProjectId: 1 })

export const MfrProject = mongoose.model('MfrProject', mfrProjectSchema)
