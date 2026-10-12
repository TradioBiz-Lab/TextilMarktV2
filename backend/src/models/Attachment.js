import mongoose from 'mongoose'

export const ATTACHMENT_REFS = ['grn', 'jobwork']
export const ATTACHMENT_KINDS = ['challan', 'goods', 'damage', 'other']

// A photo or file kept as evidence against a record: the supplier's challan, the rolls as they arrived,
// damage. Stored apart from the record so a list of records stays light and so a photo is never mixed
// into the documents other people see. Private to the company that took it.
const attachmentSchema = new mongoose.Schema({
  ownerOrgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
  refType: { type: String, enum: ATTACHMENT_REFS, required: true },
  refId: { type: String, required: true },
  kind: { type: String, enum: ATTACHMENT_KINDS, default: 'other' },
  name: { type: String, default: '', maxlength: 200 },
  caption: { type: String, default: '', maxlength: 300 },
  mimeType: { type: String, required: true },
  size: { type: Number, default: 0 },
  dataUrl: { type: String, required: true },
  uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: { createdAt: true, updatedAt: false } })

attachmentSchema.index({ ownerOrgId: 1, refType: 1, refId: 1, createdAt: 1 })

export const Attachment = mongoose.model('Attachment', attachmentSchema)
