import mongoose from 'mongoose'

// One garment measured against the style's measurement sheet: who measured it, at which stage and in which size, and for
// every point of the sheet the required value, what was measured, the difference and whether it is inside tolerance.
// The workbook made from it is a Document (resultDocumentId). Never deleted. The customer sees it once released.
const pointSchema = new mongoose.Schema({
  name: { type: String, required: true },
  spec: { type: mongoose.Schema.Types.Mixed, default: null },   // a number, or text such as "6 X 1"
  tol: { type: Number, default: null },
  measured: { type: Number, default: null },
  diff: { type: Number, default: null },
  ok: { type: Boolean, default: null },   // null: not judged (nothing measured, a text spec, or no tolerance on the sheet)
}, { _id: false })

const measurementSessionSchema = new mongoose.Schema({
  orderId: { type: String, ref: 'Order', required: true },
  mfrId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  byName: { type: String, default: '' },
  byRole: { type: String, default: '' },
  stage: { type: String, enum: ['fit', 'pp', 'final'], required: true },
  size: { type: String, required: true },
  sourceDocumentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Document', required: true },
  sourceTab: { type: String, required: true },
  method: { type: String, enum: ['voice', 'typed'], default: 'typed' },
  transcript: { type: String, default: '' },
  points: { type: [pointSchema], default: [] },
  measuredCount: { type: Number, default: 0 },
  outOfTolerance: { type: Number, default: 0 },
  resultDocumentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Document', default: null },
  releasedAt: { type: Date, default: null },
  releasedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  at: { type: Date, default: Date.now },
}, { timestamps: true })
measurementSessionSchema.index({ orderId: 1, at: -1 })
measurementSessionSchema.index({ by: 1, at: -1 })

export const MeasurementSession = mongoose.model('MeasurementSession', measurementSessionSchema)
