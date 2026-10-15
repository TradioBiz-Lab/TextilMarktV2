import mongoose from 'mongoose'

const userSchema = new mongoose.Schema({
  email:        { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  role:         { type: String, required: true, enum: ['admin', 'buyer', 'manufacturer'] },
  adminType:    { type: String, enum: ['master', 'user'], default: null },
  company:      { type: String, required: true, trim: true },
  name:         { type: String, required: true, trim: true },
  phone:        { type: String, default: null },
  // Zero Entry Capture: a manufacturer is identified on inbound messages by WhatsApp number.
  whatsappNumber:   { type: String, default: null, trim: true },
  language:         { type: String, default: 'hi' },
  code:         { type: String, required: true, maxlength: 5, uppercase: true },
  isActive:     { type: Boolean, default: true },
  // A customer's own seasons (for example H1, H2); empty means the standard SS/FW list (lib/seasons.js).
  seasons:      { type: [String], default: undefined },
  mustChangePw:      { type: Boolean, default: false },
  passwordChangedAt: { type: Date, default: null },
  // Buyers and manufacturers belong to an organization (see Organization). An 'owner' is the
  // organization's primary account; a 'member' is a teammate who acts as that organization.
  // Admins belong to none. Filled in on first sight for accounts that predate organizations.
  orgId:        { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', default: null },
  orgRole:      { type: String, enum: ['owner', 'member'], default: null },
}, { timestamps: true })

// Ensure admin users cannot have buyer/manufacturer roles and vice versa
userSchema.index({ role: 1, isActive: 1 })
// A company code is shared by every member of an organization, so it is no longer unique per user:
// Organization.code is where uniqueness is enforced. (The old unique index is dropped at startup,
// see lib/migrate.js.)
userSchema.index({ code: 1 })
userSchema.index({ orgId: 1 })

export const User = mongoose.model('User', userSchema)
