import mongoose from 'mongoose'

// The strategic moat TRADIO.md names explicitly: a proprietary consumption
// database built from real production actuals. Minimal and denormalized on
// purpose — never depends on joins to documents that may later change or be
// deleted (orderRef survives an order deletion even though orderId, as a String
// ref, would otherwise dangle).
//
// Deliberately Tradio-brokered-only — no scopeType field, unlike every other
// scoped model in this feature. Harvesting consumption data out of a
// manufacturer's private non-Tradio business (MfrProject) would directly
// contradict that model's no-admin-visibility privacy promise. This is a
// privacy decision, not an oversight: the trigger below (the assignment
// 'Delivered' transition) structurally cannot fire for an MfrProject anyway,
// since it has no assignments/stages at all.
const consumptionRecordSchema = new mongoose.Schema({
  orderId: { type: String, ref: 'Order', default: null }, // may go stale if the order is deleted
  orderRef: { type: String, default: null },               // denormalized label, survives deletion
  mfrId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  costSheetId: { type: mongoose.Schema.Types.ObjectId, ref: 'CostSheet', required: true },
  capturedAt: { type: Date, default: Date.now },
  capturedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // null = system-triggered
  trigger: { type: String, enum: ['assignment_delivered'], required: true },

  garmentType: { type: String, default: '' },
  colourway:   { type: String, default: '' },
  fabricSource: { type: String, enum: ['tradio', 'buyer'], default: null },
  fabricWidth: { type: Number, default: null },
  fabricGsm:   { type: Number, default: null },
  sizeRatio:   { type: String, default: '' },
  unit:        { type: String, default: 'm' },

  plannedConsumptionPerUnit: { type: Number, default: null },
  actualConsumptionPerUnit:  { type: Number, default: null }, // the actual moat datapoint
  totalUnitsProduced:  { type: Number, default: null },
  totalActualConsumption: { type: Number, default: null },
  variancePct: { type: Number, default: null },

  materialRequirementLineId: { type: mongoose.Schema.Types.ObjectId, default: null },
  note: { type: String, default: '' },
}, { timestamps: true })

// Idempotent on (orderId, mfrId, costSheetId) — the Delivered transition can
// fire more than once (reopen + re-deliver); this must not duplicate rows.
consumptionRecordSchema.index({ orderId: 1, mfrId: 1, costSheetId: 1 }, { unique: true })
consumptionRecordSchema.index({ createdAt: -1 })

export const ConsumptionRecord = mongoose.model('ConsumptionRecord', consumptionRecordSchema)
