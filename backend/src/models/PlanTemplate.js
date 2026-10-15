import mongoose from 'mongoose'

// A customer's standard production plan (the Cocoblu plan, say), saved from a real style's plan so the next style
// for that customer starts from it instead of being typed in again. One per customer. Dates are kept as day offsets
// from the plan's first day, so a template fits any start date; owners are kept by who they are on the plan (the
// customer, the split's factory, or a named Tradio admin), so they map onto the new style's own customer and factory.
const templateStepSchema = new mongoose.Schema({
  name:        { type: String, required: true, trim: true, maxlength: 100 },
  kind:        { type: String, enum: ['quantity', 'milestone', 'checklist'], default: 'quantity' },
  startOffset: { type: Number, default: null },   // days from the plan's first day; null = NA
  endOffset:   { type: Number, default: null },
  owner:       { type: String, enum: ['buyer', 'manufacturer', 'admin', null], default: null },
  adminId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  description: { type: String, default: '', maxlength: 500 },
  fixedUnits:  { type: Number, default: null },   // a target that is not the split quantity (3 lab dips, say)
}, { _id: false })

const planTemplateSchema = new mongoose.Schema({
  buyerId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  steps:         { type: [templateStepSchema], default: [] },
  sourceOrderId: { type: String, default: null },
  savedBy:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  savedByName:   { type: String, default: '' },
}, { timestamps: true })

planTemplateSchema.index({ buyerId: 1 }, { unique: true })

export const PlanTemplate = mongoose.model('PlanTemplate', planTemplateSchema)
