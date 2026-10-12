import mongoose from 'mongoose'

export const ORG_TYPES = ['manufacturer', 'brand']

// A company on the platform: one factory or one brand, with any number of people on its team.
// Tradio staff are admin users and belong to no organization.
const organizationSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 200 },
  type: { type: String, required: true, enum: ORG_TYPES },
  // The company code used inside order IDs. Users carry a copy so existing code that reads
  // `user.code` keeps working; this is where it is unique.
  code: { type: String, required: true, uppercase: true, trim: true, maxlength: 5 },
  // The organization's primary account. Orders, assignments and stage owners reference this user
  // id (they predate organizations), so it doubles as the "party" id for all of them.
  ownerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  // Tradio staff may take actions on behalf of this organization. Manufacturers only. Off until
  // Tradio turns it on, because it grants write access to the factory's work.
  tradioEnabled: { type: Boolean, default: false },
  // Whether Tradio staff may look at this organization's data at all. Only the organization's own
  // owner changes it (the "we never see your data" promise for factories Tradio does not buy from).
  tradioCanView: { type: Boolean, default: true },
  isActive: { type: Boolean, default: true },
  // Business details that appear on the documents the company issues (a purchase order's header:
  // who is buying, where to deliver, which GSTIN). All optional; a company fills them in once.
  profile: {
    legalName: { type: String, default: '', trim: true, maxlength: 200 },
    gstin:     { type: String, default: '', uppercase: true, trim: true, maxlength: 15 },
    pan:       { type: String, default: '', uppercase: true, trim: true, maxlength: 10 },
    address:   { type: String, default: '', trim: true, maxlength: 300 },
    city:      { type: String, default: '', trim: true, maxlength: 80 },
    pincode:   { type: String, default: '', trim: true, maxlength: 6 },
    // GST state code ('27'), taken from the GSTIN when there is one. Decides CGST and SGST versus IGST.
    stateCode: { type: String, default: '', trim: true, maxlength: 2 },
    phone:     { type: String, default: '', trim: true, maxlength: 40 },
    email:     { type: String, default: '', trim: true, lowercase: true, maxlength: 254 },
  },
}, { timestamps: true })

organizationSchema.index({ code: 1 }, { unique: true })
organizationSchema.index({ ownerUserId: 1 }, { unique: true })
organizationSchema.index({ type: 1, isActive: 1 })

export const Organization = mongoose.model('Organization', organizationSchema)
