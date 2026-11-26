import mongoose from 'mongoose'

// A customer's SOP: the one document that says how its orders are made (process checklist, trims, testing, packing).
// One per customer; saving again replaces it. The file opens inside the app for Tradio, the factories making that
// customer's styles and the coordinators at those factories, never for the customer. `text` is the same document as
// plain words, which is what Kriyaa answers from.
const customerSopSchema = new mongoose.Schema({
  buyerId:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name:           { type: String, required: true, trim: true, maxlength: 200 },
  fileName:       { type: String, default: '', maxlength: 300 },
  dataUrl:        { type: String, required: true },   // the PDF itself
  text:           { type: String, default: '' },      // the document in words; '' when it could not be read
  uploadedBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  uploadedByName: { type: String, default: '' },
}, { timestamps: true })

customerSopSchema.index({ buyerId: 1 }, { unique: true })

export const CustomerSop = mongoose.model('CustomerSop', customerSopSchema)
