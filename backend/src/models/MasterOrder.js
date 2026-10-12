import mongoose from 'mongoose'

export const SEASONS = ['SS26', 'FW26', 'SS27', 'FW27', 'SS28']

const masterOrderSchema = new mongoose.Schema({
  // Human-readable ID: MO-<BuyerCode>-<Season>-<NNN>
  _id:       { type: String },
  buyerId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  orderName: { type: String, required: true, trim: true, maxlength: 200 },
  season:    { type: String, enum: SEASONS },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  // Role of the creating company's session (see Order.createdByRole). Null on master orders that
  // predate it, which count as Tradio's.
  createdByRole: { type: String, enum: ['admin', 'buyer', 'manufacturer'], default: null },
}, { timestamps: true })

masterOrderSchema.index({ buyerId: 1, createdAt: -1 })

export const MasterOrder = mongoose.model('MasterOrder', masterOrderSchema)
