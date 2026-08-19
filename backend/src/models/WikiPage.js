import mongoose from 'mongoose'

const wikiPageSchema = new mongoose.Schema({
  title:        { type: String, required: true, trim: true, maxlength: 200 },
  category:     { type: String, required: true, enum: ['tech_pack', 'sop'] },
  // Markdown text — including any images, embedded as base64 data URIs inline
  // (![alt](data:image/jpeg;base64,...)). 8MB covers a heavily-illustrated SOP
  // like a real trims/packing reference with a dozen photos; well under the
  // app's 14MB JSON body limit and MongoDB's 16MB document limit.
  bodyMarkdown: { type: String, required: true, maxlength: 8_000_000 },

  // Same two-tier scoping as Document's wiki fields — company-wide or one buyer
  wikiScope: { type: String, required: true, enum: ['company', 'buyer'] },
  buyerId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  isActive:  { type: Boolean, default: true },
}, { timestamps: true })

wikiPageSchema.index({ buyerId: 1, wikiScope: 1, isActive: 1 })

export const WikiPage = mongoose.model('WikiPage', wikiPageSchema)
