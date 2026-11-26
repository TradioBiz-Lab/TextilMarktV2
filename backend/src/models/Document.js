import mongoose from 'mongoose'

const DOC_TYPES = [
  // 'buyer_order' is the old name for the customer's PO: kept so old records load, read and filed as 'PO'.
  'PO', 'buyer_order', 'tech_pack', 'cost_sheet', 'RFQ', 'terms',
  // Tradio's invoice to the customer. Commercial: a factory never sees it (see HIDDEN_FROM_FACTORIES in routes/documents.js).
  'invoice',
  'compliance_cert', 'factory_audit', 'chemical_cert',
  'environmental_cert', 'insurance',
  // Style-level reference documents (creation wizard's Documents step)
  // 'bom' is the bill of materials (fabric, trims, labels, packing): what goes into the style, with no prices on it.
  'measurements', 'bom', 'pattern', 'lab_dip', 'test_report',
  // Manufacturer profile PDF
  'mfr_profile',
  // Production stage evidence documents
  'material_po', 'knitting_grn', 'knitting_qc',
  'dyeing_grn', 'dyeing_qc', 'processing_grn', 'processing_qc',
  'cutting_qc', 'stitching_qc', 'final_qc', 'packing_qc', 'dispatch_docs',
  // Evidence captured from a factory message (photo, voice note, challan) by Zero Entry Capture
  'floor_evidence',
  // A coordinator's photo of one item of the bill of materials, as seen at a factory (bomItemId; Order.bom.items[].evidence).
  'bom_evidence',
]

// Where a measurement sheet stands in the fit process. Every measurement upload carries one; the one a master admin locks
// is the style's Locked Measurement.
// 'final_qc' is a garment measured at final inspection (routes/measurements.js).
export const MEASUREMENT_LABELS = ['customer_submission', 'fit_approval', 'pp_approval', 'final_qc']
export const MEASUREMENT_LABEL_NAMES = { customer_submission: 'Customer Submission', fit_approval: 'Fit Approval', pp_approval: 'PP Approval', final_qc: 'Final QC' }

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

  // Measurement sheets only (type 'measurements'): which stage of the fit process this sheet is. Required on every new
  // upload; null on sheets filed before labels existed.
  measurementLabel: { type: String, enum: MEASUREMENT_LABELS, default: null },
  // The style's Locked Measurement: the one sheet everyone works to. Only a master admin sets or clears it, and while it is
  // set the sheet can be neither replaced nor deleted. A style has at most one.
  locked:    { type: Boolean, default: false },
  lockedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  lockedAt:  { type: Date, default: null },
  // A file a customer sent with a style request (routes/styleRequests.js): no style yet; approval moves it onto the style.
  styleRequestId: { type: mongoose.Schema.Types.ObjectId, ref: 'StyleRequest', default: null },

  // A coordinator's update from the factory floor (models/FieldUpdate.js): its photos and voice note point back to it.
  // `internal` keeps the file from the customer until an admin releases the update; `tradioOnly` (the voice recording)
  // keeps it from the factory as well, for good.
  fieldUpdateId: { type: mongoose.Schema.Types.ObjectId, ref: 'FieldUpdate', default: null },
  internal:      { type: Boolean, default: false },
  // Set on a measurement workbook the quality module made (models/MeasurementSession.js): the session it records.
  measurementSessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'MeasurementSession', default: null },
  // The bill of materials item a 'bom_evidence' photo shows (Order.bom.items[].id).
  bomItemId:     { type: String, default: null },
  tradioOnly:    { type: Boolean, default: false },
  // Set when the file's bytes are kept outside the database (lib/fileStore.js); dataUrl is then empty.
  storage: {
    driver: { type: String, default: null },
    bucket: { type: String, default: null },
    key:    { type: String, default: null },
  },

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
documentSchema.index({ fieldUpdateId: 1 }, { partialFilterExpression: { fieldUpdateId: { $type: 'objectId' } } })
documentSchema.index({ versionOf: 1 }, { partialFilterExpression: { versionOf: { $type: 'objectId' } } })
documentSchema.index({ mfrId: 1, isActive: 1 })
documentSchema.index({ orderId: 1, isActive: 1 })
documentSchema.index({ expiryDate: 1 })          // for expiry-alert queries
documentSchema.index({ uploadedBy: 1 })
documentSchema.index({ createdAt: -1 })           // for list sort (avoids in-memory sort on Atlas)

export const Document = mongoose.model('Document', documentSchema)
