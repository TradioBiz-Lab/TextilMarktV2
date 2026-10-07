import mongoose from 'mongoose'

// The permanent record of a style (or an empty master order) that was dropped.
// A drop removes the live document so it leaves every list and report, but
// first copies the whole thing here with who did it, when and why, so it can
// always be looked up and, if it was a mistake, rebuilt. Nothing in the app
// ever updates or deletes these.
const droppedRecordSchema = new mongoose.Schema({
  kind:     { type: String, enum: ['style', 'master_order'], required: true },
  refId:    { type: String, required: true },          // the dropped order's or master order's own _id
  label:    { type: String, required: true },          // what a person would call it, e.g. "Slim Fit Jeans (JNS-01)"
  masterOrderId: { type: String, default: null },      // the master order a style was dropped from
  buyerId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  buyerCompany: { type: String, default: '' },
  // The full document as it was, stages, assignments, colourways, photo and all.
  snapshot: { type: mongoose.Schema.Types.Mixed, required: true },
  // Documents attached to a dropped style are left where they are (they stay in
  // the Documents tab); this lists which ones there were.
  documentIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Document' }],
  reason:   { type: String, default: '', maxlength: 500 },
  droppedBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  droppedByName: { type: String, default: '' },
  droppedAt:     { type: Date, default: Date.now },
}, { timestamps: true })

droppedRecordSchema.index({ droppedAt: -1 })
droppedRecordSchema.index({ masterOrderId: 1, droppedAt: -1 })
droppedRecordSchema.index({ refId: 1 })

export const DroppedRecord = mongoose.model('DroppedRecord', droppedRecordSchema)
