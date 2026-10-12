import mongoose from 'mongoose'

const notificationSchema = new mongoose.Schema({
  toUser:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type:    { type: String, enum: ['status', 'order', 'alert', 'costing'], required: true },
  msg:     { type: String, required: true },
  orderId: { type: String, ref: 'Order', default: null },
  // Where tapping it goes when it is not an order: a deep link such as '#cost=<id>' (see the frontend's deepLink.js).
  link:    { type: String, default: null, maxlength: 200 },
  isRead:  { type: Boolean, default: false },
}, { timestamps: true })

notificationSchema.index({ toUser: 1, isRead: 1 })
notificationSchema.index({ toUser: 1, createdAt: -1 })
notificationSchema.index({ type: 1, createdAt: -1 })   // for cert-expiry duplicate check

export const Notification = mongoose.model('Notification', notificationSchema)
