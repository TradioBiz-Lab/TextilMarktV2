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
  // What the customer pays for this buy and on what terms (lib/masterOrderDetails.js). Price, currency and payment
  // terms are never sent to a factory; the Incoterm and ship-to are, since the factory ships the goods.
  currency:     { type: String, default: '', trim: true, maxlength: 3 },
  price:        { type: Number, default: null, min: 0 },
  paymentTerms: { type: String, default: '', trim: true, maxlength: 200 },
  incoterm:     { type: String, default: '', trim: true, maxlength: 3 },
  shipTo:       { type: String, default: '', trim: true, maxlength: 500 },
}, { timestamps: true })

masterOrderSchema.index({ buyerId: 1, createdAt: -1 })

export const MasterOrder = mongoose.model('MasterOrder', masterOrderSchema)
