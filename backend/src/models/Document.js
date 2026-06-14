import mongoose from 'mongoose'

const DOC_TYPES = [
  'PO', 'buyer_order', 'tech_pack', 'cost_sheet', 'RFQ', 'terms',
  'compliance_cert', 'factory_audit', 'chemical_cert',
  'environmental_cert', 'insurance',
  // Manufacturer profile PDF
  'mfr_profile',
  // Production stage evidence documents
  'material_po', 'knitting_grn', 'knitting_qc',
  'dyeing_grn', 'dyeing_qc', 'processing_grn', 'processing_qc',
  'cutting_qc', 'stitching_qc', 'final_qc', 'packing_qc', 'dispatch_docs',
]

const documentSchema = new mongoose.Schema({
  type:       { type: String, required: true, enum: DOC_TYPES },
  name:       { type: String, required: true, trim: true },

  // A document belongs to a manufacturer OR an order (or both)
  mfrId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User',  default: null },
  orderId:    { type: String,                          ref: 'Order', default: null },

  issueDate:  { type: Date, default: Date.now },
  expiryDate: { type: Date, default: null },

  uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  issuer:     { type: String, default: null },
  version:    { type: Number, default: 1 },
  isActive:   { type: Boolean, default: true },

  // Production stage link (index into assignment.stages array, null for non-stage docs)
  stageIndex: { type: Number, default: null, min: 0 },

  // Free-text notes — used for stage evidence entries that capture context (SOP-driven),
  // including text-only stage evidence (no file/link).
  notes:      { type: String, default: null },

  // File payload — stored as base64 data URL (inline) OR external link (e.g. Zoho/GDrive share URL)
  // For non-stage docs, exactly one of dataUrl or externalUrl is set.
  // Stage-evidence docs (stageIndex != null) may omit both when notes is present.
  dataUrl:     { type: String, default: null },
  externalUrl: { type: String, default: null },
  fileName:    { type: String, default: null },
  fileSize:    { type: Number, default: null },
  mimeType:    { type: String, default: null },
}, { timestamps: true })

documentSchema.index({ mfrId: 1, isActive: 1 })
documentSchema.index({ orderId: 1, isActive: 1 })
documentSchema.index({ expiryDate: 1 })          // for expiry-alert queries
documentSchema.index({ uploadedBy: 1 })
documentSchema.index({ createdAt: -1 })           // for list sort (avoids in-memory sort on Atlas)

export const Document = mongoose.model('Document', documentSchema)
