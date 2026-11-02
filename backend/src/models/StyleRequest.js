import mongoose from 'mongoose'

// A customer's request to add styles, waiting for a master admin to approve or decline it. Nothing exists as a style until
// it is approved, and the master admin chooses the master order the styles go under then (the customer never picks one).
// Three kinds:
//   import  a sheet of NPD/Replen styles (routes/styleImports.js). The sheet itself is kept here and read again at
//           approval, so what is approved is what the sheet says then, checked the same way as when it was sent.
//   replen  reorders of styles that are in production: `items`, one per style (POST /api/style-requests, or the Order replen
//           button on one style). Older requests carry a single style in sourceOrderId / quantity / note instead.
//   npd     new styles from the guided New Product Development form: `items`, one per style.
// Files sent with an item (measurement sheets, tech packs, patterns) are Documents with no style yet and styleRequestId set;
// approval moves them onto the style made from that item.
// Decided requests keep their record (who, when, why); the sheet bytes are dropped once it is decided.
const styleRequestSchema = new mongoose.Schema({
  kind:        { type: String, enum: ['import', 'replen', 'npd'], required: true },
  // 'processing' is only while an approval is running, so a double click cannot create the styles twice.
  status:      { type: String, enum: ['pending', 'processing', 'approved', 'declined', 'cancelled'], default: 'pending' },
  buyerId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },       // the customer the styles belong to
  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  masterOrderId: { type: String, default: null },                                          // set by the customer's sheet import of old, or by the master admin at approval
  items:       { type: [mongoose.Schema.Types.Mixed], default: [] },

  // import
  filename:    { type: String, default: '', maxlength: 200 },
  data:        { type: Buffer, select: false },
  uploadId:    { type: String, default: null },
  skipInvalid: { type: Boolean, default: false },
  summary:     { type: mongoose.Schema.Types.Mixed, default: null },                         // { total, ok, errors, exists } when it was sent

  // replen
  sourceOrderId: { type: String, default: null },
  product:     { type: String, default: '' },
  styleNumber: { type: String, default: '' },
  quantity:    { type: Number, default: null },
  note:        { type: String, default: '', maxlength: 500 },

  // the decision
  decidedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  decidedAt:   { type: Date, default: null },
  decisionNote: { type: String, default: '', maxlength: 300 },
  createdOrderIds: [{ type: String }],
  failedCount: { type: Number, default: 0 },
}, { timestamps: true })

styleRequestSchema.index({ status: 1, createdAt: -1 })
styleRequestSchema.index({ requestedBy: 1, createdAt: -1 })

export const StyleRequest = mongoose.model('StyleRequest', styleRequestSchema)
