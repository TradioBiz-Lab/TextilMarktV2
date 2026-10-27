import mongoose from 'mongoose'

// The Partner Directory: Tradio's internal sourcing CRM of garment manufacturers, fabric suppliers and trims
// suppliers (collection `manufacturers`, shown as "Partners" in the UI). This is strategically sensitive data and
// is admin-only end to end (routes/manufacturers.js). It is NOT the same thing as a manufacturer-role User: a
// directory record only points at one through `linkedUserId`, and linking changes nothing about what that user sees.
export const PARTNER_TYPES = ['garment_manufacturer', 'fabric_supplier', 'trims_supplier', 'dyer_processor', 'trader', 'buying_house', 'unknown']
export const PARTNER_CLUSTERS = ['ludhiana', 'ncr', 'jaipur', 'kolkata', 'tiruppur', 'other']
// Noida and Delhi were once two clusters; they are one NCR now. The old values are still understood on input.
export const LEGACY_CLUSTERS = { noida_ncr: 'ncr', delhi_ncr: 'ncr' }
// One pipeline. `live` is its last stage: Tradio has orders with this manufacturer now (it needs a platform account, and only a
// live manufacturer can be given a style: lib/liveManufacturers.js).
export const PARTNER_STATUSES = ['new', 'contacted', 'qualified', 'pilot', 'live', 'rejected', 'off_scope']
export const PARTNER_PRIORITIES = ['A', 'B', 'C', 'D']
// What a partner makes for. A factory can sit in several (an activewear unit that also does fusion wear).
export const PARTNER_CATEGORIES = ['athleisure', 'indian', 'western', 'fusion', 'home_textiles']

// One spelling for a name: single spaces, no edges. The unique index below then only has case left to fold.
const collapse = v => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : v)

const contactSchema = new mongoose.Schema({
  name:     { type: String, trim: true, default: '' },
  role:     { type: String, trim: true, default: '' },
  phone:    { type: String, trim: true, default: '' },
  email:    { type: String, trim: true, default: '' },
  whatsapp: { type: String, trim: true, default: '' },
}, { _id: false })

const count = { type: Number, min: 0, default: 0 } // 0 = unknown

const manufacturerSchema = new mongoose.Schema({
  name:      { type: String, required: true, trim: true, set: collapse, maxlength: 200 },
  legalName: { type: String, trim: true, default: '', maxlength: 200 },
  type:      { type: String, required: true, enum: PARTNER_TYPES },

  categories: { type: [{ type: String, enum: PARTNER_CATEGORIES }], default: [] },

  cluster: { type: String, enum: PARTNER_CLUSTERS, default: undefined },
  city:    { type: String, trim: true, default: '', maxlength: 120 },
  address: { type: String, trim: true, default: '', maxlength: 500 },
  pincode: { type: String, trim: true, default: '', maxlength: 12 },

  // Garment units only. Product and fabric tokens are snake_case (sports_bra, poly_spandex) so filters line up.
  products: { type: [String], default: [] },
  machines: {
    flatlock: count, coverstitch: count, overlock: count, singleNeedle: count,
  },
  // The MOQ figure is a claim until verification.gstVerified or verification.sampleApproved is set; the UI says so.
  moqPerStyleColour: { type: Number, min: 0, default: null },
  moqNote:           { type: String, trim: true, default: '', maxlength: 500 },

  fabricTypes:    { type: [String], default: [] }, // fabric suppliers
  trimCategories: { type: [String], default: [] }, // trims suppliers
  fabrics:        { type: [String], default: [] }, // fabric experience of a garment unit

  priceIndication: { type: String, trim: true, default: '', maxlength: 300 },
  leadTimeDays:    { type: Number, min: 0, default: null },

  contacts: { type: [contactSchema], default: [] },

  website: { type: String, trim: true, default: '', maxlength: 300 },
  gstin:   { type: String, trim: true, uppercase: true, default: '', maxlength: 15 },
  udyam:   { type: String, trim: true, uppercase: true, default: '', maxlength: 30 },
  mcaCin:  { type: String, trim: true, uppercase: true, default: '', maxlength: 25 },

  verification: {
    score:             { type: Number, min: 0, max: 100, default: null }, // null = not assessed yet
    gstVerified:       { type: Boolean, default: false },
    udyamVerified:     { type: Boolean, default: false },
    referencesChecked: { type: Boolean, default: false },
    videoWalkthrough:  { type: Boolean, default: false },
    sampleApproved:    { type: Boolean, default: false },
    siteVisited:       { type: Boolean, default: false },
    lastCheckedAt:     { type: Date, default: null },
  },

  status:   { type: String, enum: PARTNER_STATUSES, default: 'new' },
  priority: { type: String, enum: PARTNER_PRIORITIES, default: 'C' },

  source:   { type: String, trim: true, default: '', maxlength: 500 }, // where the lead came from, with the capture date
  keywords: { type: [String], default: [] },
  // The brands this manufacturer works with, as typed (Tradio's own customers, Cocoblu ...). Kept for scoring later.
  brands:   { type: [String], default: [] },
  notes:    { type: String, trim: true, default: '', maxlength: 5000 },
  isActive: { type: Boolean, default: true },
  // Derived from `status === 'live'` by the hooks below, so lists can put live partners first. Never set it directly.
  isLive: { type: Boolean, default: false },

  // Tiles (generated drawings, not factory photos). A link, or an upload kept inline under a small cap like the product
  // photos, with a small copy for the grid. Both uploads are `select: false` so list reads never carry image bytes.
  imageUrl:        { type: String, trim: true, default: '', maxlength: 2000 },
  imageData:       { type: String, default: '', select: false },
  thumbData:       { type: String, default: '', select: false }, // ~360px copy for the card grid, fetched in one batch
  imageUploadedAt: { type: Date, default: null },
  logoUrl:         { type: String, trim: true, default: '', maxlength: 2000 },

  // Set when this partner is also a manufacturer-role user on the platform (scripts/syncPlatformManufacturers.mjs).
  linkedUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true })

// One partner per name, whatever its capitalisation.
// isLive always follows status, however the status is written (save, updateOne, findOneAndUpdate).
manufacturerSchema.pre('validate', function syncLive(next) { this.isLive = this.status === 'live'; next() })
manufacturerSchema.pre(['updateOne', 'updateMany', 'findOneAndUpdate'], function syncLiveOnUpdate(next) {
  const u = this.getUpdate() || {}
  const status = u.$set && u.$set.status !== undefined ? u.$set.status : u.status
  if (status !== undefined) { u.$set = { ...(u.$set || {}), isLive: status === 'live' }; this.setUpdate(u) }
  next()
})

manufacturerSchema.index({ name: 1 }, { unique: true, name: 'name_ci_unique', collation: { locale: 'en', strength: 2 } })
manufacturerSchema.index(
  { name: 'text', city: 'text', products: 'text', fabrics: 'text', fabricTypes: 'text', trimCategories: 'text', keywords: 'text', notes: 'text' },
  { name: 'partner_text', weights: { name: 10, keywords: 8, products: 6, fabricTypes: 5, trimCategories: 5, fabrics: 4, city: 4, notes: 1 } },
)
manufacturerSchema.index({ type: 1, cluster: 1, status: 1 })
manufacturerSchema.index({ categories: 1 })
manufacturerSchema.index({ linkedUserId: 1 }, { sparse: true })

export const Manufacturer = mongoose.model('Manufacturer', manufacturerSchema)
