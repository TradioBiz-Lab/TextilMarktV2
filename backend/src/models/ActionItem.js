import mongoose from 'mongoose'

// One timestamped free-text note per progress update — the "ticket" thread.
// No _id needed, order is chronological by push.
const updateSchema = new mongoose.Schema({
  text:   { type: String, required: true, maxlength: 1000 },
  byUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  at:     { type: Date, default: Date.now },
}, { _id: false })

const actionItemSchema = new mongoose.Schema({
  title:      { type: String, required: true, maxlength: 200, trim: true },
  detail:     { type: String, default: '' },
  assigneeId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, // admin responsible
  createdBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  buyerId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // customer; null = Internal
  orderId:    { type: String, ref: 'Order', default: null }, // set when lifted from a TNA stage
  stageName:  { type: String, default: null }, // which stage, when lifted from TNA
  source:     { type: String, enum: ['custom', 'tna'], default: 'custom' },
  priority:   { type: String, enum: ['high', 'medium', 'low'], default: 'medium' },
  eta:        { type: Date, default: null },
  status:     { type: String, enum: ['open', 'done'], default: 'open' },
  updates:    [updateSchema],
  closedAt:   { type: Date, default: null },
}, { timestamps: true })

actionItemSchema.index({ assigneeId: 1, status: 1 })
actionItemSchema.index({ buyerId: 1, status: 1 })

export const ActionItem = mongoose.model('ActionItem', actionItemSchema)
