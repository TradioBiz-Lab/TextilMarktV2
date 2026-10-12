import mongoose from 'mongoose'

// The measurement spec of a style as read from its tech pack: each point to measure, its tolerance and the
// target for every size. It is kept so extraction runs once and QC (inspections, PP samples) measures
// against the same numbers. It belongs to the order, not to one company: the brand and the factory on the
// order can both read it, and the factory that extracted it can correct it.
const pointSchema = new mongoose.Schema({
  code: { type: String, default: '', maxlength: 10 },
  name: { type: String, required: true, maxlength: 200 },
  // Tolerance in cm either side. Most points are symmetric; tolMinus is only set when it is not.
  tolPlus: { type: Number, default: null, min: 0 },
  tolMinus: { type: Number, default: null, min: 0 },
  // The target for each size, parallel to sizes; null where the pack gives none.
  values: { type: [mongoose.Schema.Types.Mixed], default: [] },
  confidence: { type: Number, min: 0, max: 1, default: null },
  needsReview: { type: Boolean, default: false },
}, { _id: false })

const specSheetSchema = new mongoose.Schema({
  orderId: { type: String, required: true },
  ownerOrgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
  mfrId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  sourceDocumentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Document', default: null },
  header: {
    type: new mongoose.Schema({
      brand: String, styleNo: String, description: String, category: String, gender: String,
      fabricComposition: String, gsm: String, sizeRange: String, collection: String, designer: String, season: String,
    }, { _id: false }),
    default: () => ({}),
  },
  sizes: { type: [String], default: [] },
  points: { type: [pointSchema], default: [] },
  extractedAt: { type: Date, default: null },
  model: { type: String, default: '' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true })

specSheetSchema.index({ orderId: 1, ownerOrgId: 1 }, { unique: true })

export const SpecSheet = mongoose.model('SpecSheet', specSheetSchema)
