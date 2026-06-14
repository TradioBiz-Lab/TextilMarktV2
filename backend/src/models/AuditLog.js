import mongoose from 'mongoose'

const auditLogSchema = new mongoose.Schema({
  byUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  action: { type: String, required: true },
  detail: { type: String, required: true },
}, { timestamps: true })

auditLogSchema.index({ byUser: 1 })
auditLogSchema.index({ createdAt: -1 })

export const AuditLog = mongoose.model('AuditLog', auditLogSchema)
