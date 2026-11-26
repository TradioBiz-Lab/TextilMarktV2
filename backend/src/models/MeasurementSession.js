import mongoose from 'mongoose'

// One garment measured against the style's measurement sheet: who measured it, at which stage and in which size, and for
// every point of the sheet the required value, what was measured, the difference and whether it is inside tolerance.
// The workbook made from it is a Document (resultDocumentId). The customer sees it once released.
// A session is a 'draft' while he is still measuring: it is saved as he goes, there is one per style, factory, stage and
// size, anyone who may record there can pick it up on any device, and it has no workbook yet. Finishing makes it 'final'.
// A final session is never deleted; a draft he discards is.
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
  status: { type: String, enum: ['draft', 'final'], default: 'final' },
  stage: { type: String, enum: ['fit', 'pp', 'inline', 'final'], required: true },
  size: { type: String, required: true },
  sourceDocumentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Document', required: true },
  sourceTab: { type: String, required: true },
  method: { type: String, enum: ['voice', 'photo', 'typed'], default: 'typed' },   // how the values first got in: spoken, a photo of his paper, or typed
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
measurementSessionSchema.index({ orderId: 1, mfrId: 1, stage: 1, size: 1 }, { unique: true, partialFilterExpression: { status: 'draft' } })

export const MeasurementSession = mongoose.model('MeasurementSession', measurementSessionSchema)
