import mongoose from 'mongoose'

// A minimal, append-only ledger — the Finance-module data seam. Capture
// inventory/order-value data now so a future Finance module can compute off it
// later, without building any inventory UI or valuation logic in this feature.
//
// Unlike ConsumptionRecord, this DOES carry scopeType — a manufacturer's own
// stock ledger must span all their work (Tradio and non-Tradio alike) to be
// useful to them, even though Tradio itself can never read the mfr_project half
// (enforced the same owner-only way as everywhere else this feature touches
// mfr_project data).
const inventoryMovementSchema = new mongoose.Schema({
  mfrId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  materialDefinitionId: { type: mongoose.Schema.Types.ObjectId, ref: 'MaterialDefinition', default: null },
  materialName: { type: String, required: true }, // denormalized — works even for a free-text material

  direction: { type: String, enum: ['in', 'out'], required: true },
  qty: { type: Number, required: true },
  unit: { type: String, default: '' },

  scopeType: { type: String, enum: ['tradio_order', 'mfr_project'], required: true },
  orderId:      { type: String, ref: 'Order', default: null },
  orderRef:     { type: String, default: null }, // denormalized label, survives an order deletion
  mfrProjectId: { type: mongoose.Schema.Types.ObjectId, ref: 'MfrProject', default: null },

  // 'in'  — a receiving delta on a material line (never the running total).
  // 'out' — written from exactly ONE place: the ConsumptionRecord capture. Never
  //         also from the actuals-save route — both would read the same figure,
  //         double-booking every consumption event.
  sourceType: { type: String, enum: ['material_receipt', 'consumption', 'manual_adjustment'], required: true },
  sourceRef: {
    stageIndex:     { type: Number, default: null },
    materialLineId: { type: mongoose.Schema.Types.ObjectId, default: null },
    costSheetId:    { type: mongoose.Schema.Types.ObjectId, ref: 'CostSheet', default: null },
  },

  occurredAt: { type: Date, default: Date.now },
  note: { type: String, default: '' },
}, { timestamps: true })

// Idempotency for 'out' rows: one movement per consumption event. The write is
// an upsert against this key, so a corrected actual REPLACES its movement
// rather than stacking a second one on every edit.
inventoryMovementSchema.index(
  { sourceType: 1, 'sourceRef.costSheetId': 1, direction: 1 },
  { unique: true, partialFilterExpression: { sourceType: 'consumption' } }
)
inventoryMovementSchema.index({ mfrId: 1, materialName: 1, occurredAt: -1 })

export const InventoryMovement = mongoose.model('InventoryMovement', inventoryMovementSchema)
