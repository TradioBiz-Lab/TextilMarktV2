import mongoose from 'mongoose'

// One line the requirement was pushed onto — a real, stable stage material line
// (materialLineId, not a positional index: stage-insert, stage-delete and
// material-line-delete all shift array positions elsewhere in Order.js, so any
// stored index would silently mis-point). Array because a split order can need
// the same requirement sourced independently by more than one manufacturer.
// Always empty for mfr_project lines — there's no TNA/stage system to push into.
const pushedToSchema = new mongoose.Schema({
  mfrId:          { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  stageIndex:     { type: Number, required: true },
  materialLineId: { type: mongoose.Schema.Types.ObjectId, required: true },
  pushedAt:       { type: Date, default: Date.now },
  pushedBy:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { _id: false })

const requirementLineSchema = new mongoose.Schema({
  category: { type: String, enum: ['fabric', 'trim', 'accessory', 'other'], required: true },
  name:     { type: String, required: true, maxlength: 200 },
  materialDefinitionId: { type: mongoose.Schema.Types.ObjectId, ref: 'MaterialDefinition', default: null },
  colourway: { type: String, default: '' }, // '' = applies to all colourways
  requiredQty: { type: Number, required: true, min: 0 },
  unit:     { type: String, default: '' },
  supplier: { type: String, default: '' },
  note:     { type: String, default: '' },
  // Receiving fields — AUTHORITATIVE FOR mfr_project SCOPE ONLY. For tradio_order
  // lines these stay at their defaults and are never read: the pushed stage
  // material line (Order.js) is the single source of truth for receiving, and
  // enrichMaterialRequirement resolves these by following pushedTo[] into the
  // Order at read time. Keeping them here too (rather than a second schema)
  // is what lets a standalone mfr_project line work with no stage to push into.
  status:      { type: String, enum: ['pending', 'ordered', 'received'], default: 'pending' },
  orderedQty:  { type: Number, default: 0, min: 0 },
  receivedQty: { type: Number, default: 0, min: 0 },
  poNumber:    { type: String, default: '' },
  pushedTo: [pushedToSchema],
})

// One document per Order or per MfrProject — the planning layer for materials,
// separate from the per-stage execution checklist that already exists on Order.
const materialRequirementSchema = new mongoose.Schema({
  scopeType: { type: String, enum: ['tradio_order', 'mfr_project'], required: true },
  // Exactly one of these is set — enforced in the route via assertScopeShape,
  // same pattern this app already uses for its other scope/id pairings.
  orderId:       { type: String, ref: 'Order', default: null },
  mfrProjectId:  { type: mongoose.Schema.Types.ObjectId, ref: 'MfrProject', default: null },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  lines: [requirementLineSchema],
}, { timestamps: true })

// Exactly one document per scope. Partial indexes so the two scopes never
// collide on each other's always-null discriminator field.
materialRequirementSchema.index(
  { orderId: 1 },
  { unique: true, partialFilterExpression: { scopeType: 'tradio_order' } }
)
materialRequirementSchema.index(
  { mfrProjectId: 1 },
  { unique: true, partialFilterExpression: { scopeType: 'mfr_project' } }
)

export const MaterialRequirement = mongoose.model('MaterialRequirement', materialRequirementSchema)
