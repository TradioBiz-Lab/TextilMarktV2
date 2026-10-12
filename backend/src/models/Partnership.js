import mongoose from 'mongoose'

// A working relationship between one brand and one manufacturer. Either side may create or assign
// orders for the other only while a partnership between them is active. Without it a manufacturer
// could name any brand on the platform and a brand could assign any manufacturer, and each side's
// partner list would expose every company on the platform.
const partnershipSchema = new mongoose.Schema({
  brandOrgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
  mfrOrgId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
  status:     { type: String, enum: ['active', 'revoked'], default: 'active' },
  // admin: Tradio linked them. order: formed automatically when Tradio assigned an order between them.
  source:     { type: String, enum: ['admin', 'order'], default: 'admin' },
  createdBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true })

partnershipSchema.index({ brandOrgId: 1, mfrOrgId: 1 }, { unique: true })
partnershipSchema.index({ mfrOrgId: 1, status: 1 })

export const Partnership = mongoose.model('Partnership', partnershipSchema)
