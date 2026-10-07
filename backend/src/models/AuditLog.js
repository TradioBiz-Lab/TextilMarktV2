import mongoose from 'mongoose'
import { viewAsActor } from '../lib/requestContext.js'

const auditLogSchema = new mongoose.Schema({
  byUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  action: { type: String, required: true },
  detail: { type: String, required: true },
  // Set when the action was taken by a master admin using "view as": `byUser` is the person being
  // viewed as (whose permissions applied), this is who actually did it.
  viewAsBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true })

// Every route writes audit entries as `byUser: req.user.id`, which during view-as is the viewed
// user, so the log used to show their name with no trace of the admin. Stamp the real actor here,
// once, rather than in each of the many routes that write entries.
auditLogSchema.pre('validate', function stampViewAs(next) {
  const actor = viewAsActor()
  if (actor && !this.viewAsBy && String(this.byUser) !== String(actor.id)) {
    this.viewAsBy = actor.id
    this.detail = `${this.detail} [done by ${actor.name} using view as]`
  }
  next()
})

auditLogSchema.index({ byUser: 1 })
auditLogSchema.index({ createdAt: -1 })

export const AuditLog = mongoose.model('AuditLog', auditLogSchema)
