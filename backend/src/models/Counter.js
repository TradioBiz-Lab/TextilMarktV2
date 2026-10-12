import mongoose from 'mongoose'

// One row per numbering series (an order prefix, a master-order buyer, a PO series). The sequence
// is advanced with a single atomic update, so concurrent creators can never be handed the same
// number, and it stays correct if the server ever runs more than one process.
const counterSchema = new mongoose.Schema({
  _id: { type: String },
  seq: { type: Number, required: true, default: 0 },
}, { versionKey: false })

export const Counter = mongoose.model('Counter', counterSchema)
