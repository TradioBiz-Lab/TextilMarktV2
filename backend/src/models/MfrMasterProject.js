import mongoose from 'mongoose'

// A manufacturer's own grouping of non-Tradio styles — the manufacturer-owned
// mirror of MasterOrder, so the two-level "master order -> styles" flow they
// already know from the Tradio side works for their own business too.
//
// PRIVACY: mfrId is the sole owner and there is NO admin override anywhere.
// This is a deliberate inversion of this app's normal admin-sees-everything
// convention — Tradio provides the tool, it does not gain oversight of a
// manufacturer's other clients. Every route on this model scopes to
// mfrId === req.user.id and 403s for admin and master admin alike.
const mfrMasterProjectSchema = new mongoose.Schema({
  mfrId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  // Free text — Tradio has no relationship with, and no record of, this buyer.
  buyerName: { type: String, default: '', trim: true, maxlength: 200 },
  season:    { type: String, default: '', trim: true, maxlength: 60 },
  notes:     { type: String, default: '', maxlength: 1000 },
  isActive:  { type: Boolean, default: true },
}, { timestamps: true })

mfrMasterProjectSchema.index({ mfrId: 1, isActive: 1, createdAt: -1 })

export const MfrMasterProject = mongoose.model('MfrMasterProject', mfrMasterProjectSchema)
