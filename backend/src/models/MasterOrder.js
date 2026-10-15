import mongoose from 'mongoose'

const masterOrderSchema = new mongoose.Schema({
  // Human-readable ID: MO-<BuyerCode>-<Season>-<NNN>
  _id:       { type: String },
  buyerId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  orderName: { type: String, required: true, trim: true, maxlength: 200 },
  // The customer's own season code (lib/seasons.js checks it).
  season:    { type: String },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  // The customer's own purchase order for this buy, when it should ship, and anything else worth keeping with it.
  poNumber:  { type: String, default: '', trim: true, maxlength: 60 },
  poDate:    { type: Date, default: null },
  shipBy:    { type: Date, default: null },
  notes:     { type: String, default: '', maxlength: 2000 },
}, { timestamps: true })

masterOrderSchema.index({ buyerId: 1, createdAt: -1 })

export const MasterOrder = mongoose.model('MasterOrder', masterOrderSchema)
