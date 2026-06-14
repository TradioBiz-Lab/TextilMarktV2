import mongoose from 'mongoose'

const notificationSchema = new mongoose.Schema({
  toUser:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type:    { type: String, enum: ['status', 'order', 'alert'], required: true },
  msg:     { type: String, required: true },
  orderId: { type: String, ref: 'Order', default: null },
  isRead:  { type: Boolean, default: false },
}, { timestamps: true })

notificationSchema.index({ toUser: 1, isRead: 1 })
notificationSchema.index({ toUser: 1, createdAt: -1 })
notificationSchema.index({ type: 1, createdAt: -1 })   // for cert-expiry duplicate check

export const Notification = mongoose.model('Notification', notificationSchema)
