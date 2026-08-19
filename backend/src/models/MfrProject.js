import mongoose from 'mongoose'
import { stageSchema } from './shared/stage.js'

// One style of a manufacturer's own non-Tradio work.
//
// Deliberately NOT an Order: no buyerId (that's a real Tradio account), no
// assignments[] — a manufacturer's own project has exactly one owner and no
// manufacturer-split concept. It DOES carry real TNA stages[] (Order Setup
// Wizard, Phase 4) using the exact same stage machinery as a Tradio Order —
// see routes/mfrProjectStages.js, which mirrors routes/orders.js's stage
// surface with the assignment/buyer/responsibleId indirection stripped out
// (single owner, no accountability-delegation across roles).
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
  // Same shape/1MB cap as Order.imageDataUrl/imageUrl — see lib/imagePayload.js.
  imageDataUrl: { type: String, default: null },
  imageUrl:     { type: String, default: null, trim: true },
  // TNA — same stageSchema as Order.js's assignments[].stages, just not nested
  // in an assignments array (no split, no buyer party for this scope).
  stages: [stageSchema],
  isActive: { type: Boolean, default: true },
}, { timestamps: true })

mfrProjectSchema.index({ mfrId: 1, isActive: 1, createdAt: -1 })
mfrProjectSchema.index({ mfrMasterProjectId: 1 })

export const MfrProject = mongoose.model('MfrProject', mfrProjectSchema)
