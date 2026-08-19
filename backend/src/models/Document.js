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
  // Wiki — link-only reference categories (externalUrl required, no dataUrl).
  // Tech Pack/SOP content lives in the separate WikiPage model instead.
  'wiki_inspection_form', 'wiki_fit_comments', 'wiki_photos',
  // Order/Project Setup Wizard — Documents step (see the wizard plan). fit_comments
  // here is distinct from wiki_fit_comments above: this one is order/project-scoped
  // reference material uploaded during setup, not a company/buyer-wide Wiki entry.
  // 'pattern' is link-only (externalUrl required) — see PATTERN_LINK_ONLY_TYPES below.
  'measurement_sheet', 'pattern', 'fit_comments', 'sop',
]

// Cutting/sewing pattern files (can be DXF) have no reliable mime signature and
// browsers send application/octet-stream (or nothing) for .dxf — rather than
// weaken the base64 mime-sniffing check every other inline upload goes through
// (see ALLOWED_MIME in routes/documents.js), this type is link-only.
export const PATTERN_LINK_ONLY_TYPES = ['pattern']

const documentSchema = new mongoose.Schema({
  type:       { type: String, required: true, enum: DOC_TYPES },
  name:       { type: String, required: true, trim: true },

  // A document belongs to a manufacturer OR an order (or both)
  mfrId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User',  default: null },
  orderId:    { type: String,                          ref: 'Order', default: null },

  // Order/Project Setup Wizard scoping — a document uploaded in the wizard's
  // Documents step belongs to the master order/project, before any line-item
  // Order/MfrProject exists yet to hang orderId/mfrProjectId off of. All optional,
  // additive, default null — legacy docs (and every doc uploaded outside the
  // wizard) are simply unscoped by these, same "enrich at read time" precedent
  // as every other field in this file.
  masterOrderId:      { type: String,                          ref: 'MasterOrder',       default: null },
  mfrMasterProjectId: { type: mongoose.Schema.Types.ObjectId,  ref: 'MfrMasterProject',  default: null },
  mfrProjectId:        { type: mongoose.Schema.Types.ObjectId,  ref: 'MfrProject',        default: null },

  issueDate:  { type: Date, default: Date.now },
  expiryDate: { type: Date, default: null },

  uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  issuer:     { type: String, default: null },
  version:    { type: Number, default: 1 },
  isActive:   { type: Boolean, default: true },

  // Production stage link (index into assignment.stages array, null for non-stage docs)
  stageIndex: { type: Number, default: null, min: 0 },

  // Optional link to a specific materials/PO checklist line within that stage
  // (index into stages[stageIndex].materials array) — used for PO document attachments.
  materialLineIndex: { type: Number, default: null, min: 0 },

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

  // Wiki scoping — set only for wiki_* types (see DOC_TYPES above). Company-wide
  // items are visible to every authenticated user; buyer-scoped items to that
  // buyer, admins, and any manufacturer currently assigned to one of their orders.
  wikiScope: { type: String, enum: ['company', 'buyer'], default: null },
  buyerId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true })

documentSchema.index({ mfrId: 1, isActive: 1 })
documentSchema.index({ orderId: 1, isActive: 1 })
documentSchema.index({ masterOrderId: 1, isActive: 1 })
documentSchema.index({ mfrMasterProjectId: 1, isActive: 1 })
documentSchema.index({ mfrProjectId: 1, isActive: 1 })
documentSchema.index({ expiryDate: 1 })          // for expiry-alert queries
documentSchema.index({ uploadedBy: 1 })
documentSchema.index({ createdAt: -1 })           // for list sort (avoids in-memory sort on Atlas)
documentSchema.index({ buyerId: 1, wikiScope: 1, isActive: 1 })

export const Document = mongoose.model('Document', documentSchema)
