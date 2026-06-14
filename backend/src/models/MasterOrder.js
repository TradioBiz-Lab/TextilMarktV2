import mongoose from 'mongoose'

const SEASONS = ['SS26', 'FW26', 'SS27', 'FW27', 'SS28']

const masterOrderSchema = new mongoose.Schema({
  // Human-readable ID: MO-<BuyerCode>-<Season>-<NNN>
  _id:       { type: String },
  buyerId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  orderName: { type: String, required: true, trim: true, maxlength: 200 },
  season:    { type: String, enum: SEASONS },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true })

masterOrderSchema.index({ buyerId: 1, createdAt: -1 })

export const MasterOrder = mongoose.model('MasterOrder', masterOrderSchema)
