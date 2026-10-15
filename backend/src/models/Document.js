import mongoose from 'mongoose'

const DOC_TYPES = [
  // 'buyer_order' is the old name for the customer's PO: kept so old records load, read and filed as 'PO'.
  'PO', 'buyer_order', 'tech_pack', 'cost_sheet', 'RFQ', 'terms',
  // Tradio's invoice to the customer. Commercial: a factory never sees it (see HIDDEN_FROM_FACTORIES in routes/documents.js).
  'invoice',
  'compliance_cert', 'factory_audit', 'chemical_cert',
  'environmental_cert', 'insurance',
  // Style-level reference documents (creation wizard's Documents step)
  'measurements', 'pattern', 'lab_dip', 'test_report',
  // Manufacturer profile PDF
  'mfr_profile',
  // Production stage evidence documents
  'material_po', 'knitting_grn', 'knitting_qc',
  'dyeing_grn', 'dyeing_qc', 'processing_grn', 'processing_qc',
  'cutting_qc', 'stitching_qc', 'final_qc', 'packing_qc', 'dispatch_docs',
  // Evidence captured from a factory message (photo, voice note, challan) by Zero Entry Capture
  'floor_evidence',
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

  // An earlier version: when a document's file is replaced, the old file is kept as its own record, inactive, pointing at
  // the live document (versionOf). It opens under the same rules as that document. See GET /api/documents/:id/versions.
  versionOf:      { type: mongoose.Schema.Types.ObjectId, ref: 'Document', default: null },
  replacedAt:     { type: Date, default: null },
  replacedByUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  // A requirement the customer sent in without a style, once Tradio files it into one (POST /api/documents/:id/file).
  filedAt:        { type: Date, default: null },
  filedBy:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  // Production stage link (index into assignment.stages array, null for non-stage docs)
  stageIndex: { type: Number, default: null, min: 0 },

  // A file that belongs to a whole master order rather than one style (e.g. the customer's PO
  // attached when the master order is created). Without it that PO had no link to anything.
  masterOrderId: { type: String, ref: 'MasterOrder', default: null },

  // Optional link to a specific materials/PO checklist line within that stage
  // (index into stages[stageIndex].materials array) — used for PO document attachments.
  materialLineIndex: { type: Number, default: null, min: 0 },

  // Free-text notes — used for stage evidence entries that capture context (SOP-driven),
  // including text-only stage evidence (no file/link).
  notes:      { type: String, default: null },

  // Set when this evidence was created from an inbound factory message
  sourceMessageId: { type: mongoose.Schema.Types.ObjectId, ref: 'InboundMessage', default: null },

  // File payload — stored as base64 data URL (inline) OR external link (e.g. Zoho/GDrive share URL)
  // For non-stage docs, exactly one of dataUrl or externalUrl is set.
  // Stage-evidence docs (stageIndex != null) may omit both when notes is present.
  dataUrl:     { type: String, default: null },
  externalUrl: { type: String, default: null },
  fileName:    { type: String, default: null },
  fileSize:    { type: Number, default: null },
  mimeType:    { type: String, default: null },
}, { timestamps: true })

documentSchema.index({ masterOrderId: 1 })
documentSchema.index({ versionOf: 1 }, { partialFilterExpression: { versionOf: { $type: 'objectId' } } })
documentSchema.index({ mfrId: 1, isActive: 1 })
documentSchema.index({ orderId: 1, isActive: 1 })
documentSchema.index({ expiryDate: 1 })          // for expiry-alert queries
documentSchema.index({ uploadedBy: 1 })
documentSchema.index({ createdAt: -1 })           // for list sort (avoids in-memory sort on Atlas)

export const Document = mongoose.model('Document', documentSchema)
