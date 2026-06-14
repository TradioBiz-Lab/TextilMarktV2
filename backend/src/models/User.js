import mongoose from 'mongoose'

const userSchema = new mongoose.Schema({
  email:        { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  role:         { type: String, required: true, enum: ['admin', 'buyer', 'manufacturer'] },
  adminType:    { type: String, enum: ['master', 'user'], default: null },
  company:      { type: String, required: true, trim: true },
  name:         { type: String, required: true, trim: true },
  phone:        { type: String, default: null },
  code:         { type: String, required: true, maxlength: 5, uppercase: true },
  isActive:     { type: Boolean, default: true },
  mustChangePw:      { type: Boolean, default: false },
  passwordChangedAt: { type: Date, default: null },
}, { timestamps: true })

// Ensure admin users cannot have buyer/manufacturer roles and vice versa
userSchema.index({ role: 1, isActive: 1 })
// Code must be unique across buyers and manufacturers (used in order IDs); admins all share 'TRD'
userSchema.index({ code: 1 }, { unique: true, partialFilterExpression: { role: { $in: ['buyer', 'manufacturer'] } } })

export const User = mongoose.model('User', userSchema)
