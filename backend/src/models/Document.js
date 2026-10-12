import mongoose from 'mongoose'

const DOC_TYPES = [
  'PO', 'buyer_order', 'tech_pack', 'cost_sheet', 'RFQ', 'terms',
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
  // The PDF of a purchase order a factory sent to a supplier. Never shown to brands (see PO_HIDDEN_FROM_BRANDS).
  'supplier_po',
  // The PDF of a goods received note: also the factory's own, never shown to brands.
  'goods_receipt',
  // The delivery challan of goods sent to a job worker: the factory's own, never shown to brands.
  'job_challan',
]

// What a factory buys is its own business: in the standalone product a brand never receives these,
// whatever order they hang off.
export const PO_HIDDEN_FROM_BRANDS = ['supplier_po', 'material_po', 'goods_receipt', 'job_challan']

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

  // The purchase order this document is the PDF of (type 'supplier_po').
  poId: { type: String, default: null },
  // The goods received note this document is the PDF of (type 'goods_receipt').
  grnId: { type: String, default: null },
  // The job work challan this document is the PDF of (type 'job_challan').
  jobworkId: { type: String, default: null },

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
documentSchema.index({ mfrId: 1, isActive: 1 })
documentSchema.index({ orderId: 1, isActive: 1 })
documentSchema.index({ expiryDate: 1 })          // for expiry-alert queries
documentSchema.index({ uploadedBy: 1 })
documentSchema.index({ createdAt: -1 })           // for list sort (avoids in-memory sort on Atlas)

export const Document = mongoose.model('Document', documentSchema)
