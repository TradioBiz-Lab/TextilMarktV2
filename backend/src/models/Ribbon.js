import mongoose from 'mongoose'

const ribbonSchema = new mongoose.Schema({
  message:   { type: String, required: true, maxlength: 160 },
  type:      { type: String, enum: ['urgent', 'warning', 'info'], default: 'info' },
  audience:  { type: String, enum: ['all', 'buyer', 'manufacturer'], required: true },
  targetUserIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  isActive:  { type: Boolean, default: true },
  expiresAt: { type: Date, default: null },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true })

ribbonSchema.index({ isActive: 1, audience: 1 })

export const Ribbon = mongoose.model('Ribbon', ribbonSchema)
