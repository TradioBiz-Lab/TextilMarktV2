// Organizations: the companies on the platform, their teams, who they work with, and the two
// switches that govern Tradio's access to them.
//
//   tradioEnabled  Tradio staff may take actions for this manufacturer. Set by the master admin.
//   tradioCanView  Tradio staff may look at this company at all. Set only by the company's owner:
//                  Tradio can never turn a company's privacy back off.
import { Router } from 'express'
import bcrypt from 'bcryptjs'
import mongoose from 'mongoose'
import rateLimit from 'express-rate-limit'
import { requireAuth, requireAdmin, requireMaster } from '../middleware/auth.js'
import { User, Organization, Partnership, AuditLog } from '../db/index.js'
import { sendEmail, emailUserCreated } from '../lib/email.js'
import { ensureOrgForUser, ensureOrgsByPartyIds, roleForOrgType, isPartyRole } from '../lib/orgs.js'
import { generateTempPassword } from './users.js'
import { userKey } from '../lib/limiterKey.js'
import { cleanProfile, profileSet, profileView } from '../lib/orgProfile.js'

const router = Router()

const limiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 60, keyGenerator: userKey,
  message: { error: 'Too many requests. Please wait.' },
  standardHeaders: true, legacyHeaders: false, validate: false, skip: () => process.env.NODE_ENV === 'test',
})

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const orgView = (o, owner, members = [], partnerIds = []) => ({
  id: String(o._id), name: o.name, type: o.type, code: o.code, isActive: o.isActive !== false,
  tradioEnabled: !!o.tradioEnabled, tradioCanView: o.tradioCanView !== false,
  profile: profileView(o.profile),
  ownerUserId: String(o.ownerUserId), ownerName: owner?.name ?? '', ownerEmail: owner?.email ?? '',
  members: members.map(m => ({ id: String(m._id), name: m.name, email: m.email, isActive: m.isActive, orgRole: m.orgRole || 'owner' })),
  partnerIds: partnerIds.map(String),
})

/** Accounts that predate organizations get theirs, so every company shows up in every list below. */
async function backfill() {
  const orphans = await User.find({ role: { $in: ['buyer', 'manufacturer'] }, orgId: null }).lean()
  for (const u of orphans) await ensureOrgForUser(u)
}

async function loadOrgViews(filter = {}) {
  await backfill()
  const orgs = await Organization.find(filter).sort({ name: 1 }).lean()
  if (orgs.length === 0) return []
  const people = await User.find({ orgId: { $in: orgs.map(o => o._id) } }, 'name email isActive orgId orgRole').lean()
  const byOrg = new Map()
  for (const p of people) byOrg.set(String(p.orgId), [...(byOrg.get(String(p.orgId)) || []), p])
  const links = await Partnership.find({ status: 'active', $or: [{ brandOrgId: { $in: orgs.map(o => o._id) } }, { mfrOrgId: { $in: orgs.map(o => o._id) } }] }).lean()
  const partners = new Map()
  const add = (k, v) => partners.set(String(k), [...(partners.get(String(k)) || []), v])
  for (const l of links) { add(l.brandOrgId, l.mfrOrgId); add(l.mfrOrgId, l.brandOrgId) }
  return orgs.map(o => {
    const team = byOrg.get(String(o._id)) || []
    const owner = team.find(p => String(p._id) === String(o.ownerUserId))
    return orgView(o, owner, team, partners.get(String(o._id)) || [])
  })
}

// GET /api/orgs - every company, with its team and partners (admins: this is the view-only product)
router.get('/', requireAuth, requireAdmin, async (_req, res) => {
  try { res.json(await loadOrgViews()) } catch (err) { console.error('[orgs]', err); res.status(500).json({ error: 'Server error' }) }
})

// POST /api/orgs - create a company together with its owner account (master admin).
// { type: 'manufacturer'|'brand', company, code, tradioEnabled?, owner: { name, email, phone? } }
router.post('/', requireAuth, requireMaster, limiter, async (req, res) => {
  try {
    const { type, company, code, tradioEnabled, owner } = req.body || {}
    if (!['manufacturer', 'brand'].includes(type)) return res.status(400).json({ error: 'Type must be manufacturer or brand' })
    if (typeof company !== 'string' || !company.trim() || company.length > 200) return res.status(400).json({ error: 'Company name is required (max 200 characters)' })
    const normalizedCode = String(code || '').trim().toUpperCase()
    if (normalizedCode.length < 3 || normalizedCode.length > 5) return res.status(400).json({ error: 'Company code must be 3-5 characters' })
    if (!owner || typeof owner.name !== 'string' || !owner.name.trim() || typeof owner.email !== 'string' || !EMAIL_RE.test(owner.email.trim()))
      return res.status(400).json({ error: "The owner's name and a valid email are required" })

    const role = roleForOrgType(type)
    if (await Organization.exists({ code: normalizedCode }) || await User.exists({ code: normalizedCode, role: { $in: ['buyer', 'manufacturer'] } }))
      return res.status(409).json({ error: `Company code "${normalizedCode}" is already in use` })
    if (await User.exists({ email: owner.email.toLowerCase().trim() })) return res.status(409).json({ error: 'Email already in use' })

    const tempPw = generateTempPassword()
    const user = await User.create({
      email: owner.email, passwordHash: await bcrypt.hash(tempPw, 10), role, adminType: null,
      company: company.trim(), name: owner.name.trim(), phone: owner.phone || null, code: normalizedCode,
      isActive: true, mustChangePw: true,
    })
    let org
    try { org = await ensureOrgForUser(user) } catch (err) {
      await User.deleteOne({ _id: user._id })   // lost a simultaneous creation of the same code: the organization's unique index decides
      if (err?.code === 11000) return res.status(409).json({ error: `Company code "${normalizedCode}" is already in use` })
      throw err
    }
    if (type === 'manufacturer' && tradioEnabled === true) await Organization.updateOne({ _id: org._id }, { $set: { tradioEnabled: true } })

    sendEmail(emailUserCreated({ name: user.name, email: user.email, password: tempPw, role, company: company.trim() }))
    await AuditLog.create({ byUser: req.user.id, action: 'Organization Created', detail: `${type} ${company.trim()} (${normalizedCode}) created with owner ${user.email} by ${req.user.name}` })

    const [view] = await loadOrgViews({ _id: org._id })
    res.status(201).json(view)
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'That code or email is already in use' })
    console.error('[orgs]', err); res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/orgs/:id - rename, enable Tradio for a manufacturer, or deactivate (master admin).
// Deliberately cannot touch tradioCanView: that is the company's own choice.
router.post('/:id', requireAuth, requireMaster, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ error: 'Organization not found' })
    const org = await Organization.findById(req.params.id)
    if (!org) return res.status(404).json({ error: 'Organization not found' })
    const { name, tradioEnabled, isActive, profile } = req.body || {}
    const changes = []
    let profileChange = null
    if (profile !== undefined) {
      const cleaned = cleanProfile(profile)
      if (!cleaned.ok) return res.status(400).json({ error: cleaned.error })
      profileChange = cleaned.profile; changes.push('business details')
    }
    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim() || name.length > 200) return res.status(400).json({ error: 'Company name is required (max 200 characters)' })
      org.name = name.trim(); changes.push(`name -> ${org.name}`)
    }
    if (tradioEnabled !== undefined) {
      if (typeof tradioEnabled !== 'boolean') return res.status(400).json({ error: 'tradioEnabled must be true or false' })
      if (tradioEnabled && org.type !== 'manufacturer') return res.status(400).json({ error: 'Tradio can only be enabled for manufacturers' })
      org.tradioEnabled = tradioEnabled; changes.push(`Tradio ${tradioEnabled ? 'enabled' : 'disabled'}`)
    }
    if (isActive !== undefined) {
      if (typeof isActive !== 'boolean') return res.status(400).json({ error: 'isActive must be true or false' })
      org.isActive = isActive; changes.push(isActive ? 'activated' : 'deactivated')
    }
    if (changes.length === 0) return res.status(400).json({ error: 'Nothing to change' })
    await org.save()
    if (profileChange) await Organization.updateOne({ _id: org._id }, { $set: profileSet(profileChange) })
    await AuditLog.create({ byUser: req.user.id, action: 'Organization Updated', detail: `${org.name} (${org.code}): ${changes.join(', ')} by ${req.user.name}` })
    const [view] = await loadOrgViews({ _id: org._id })
    res.json(view)
  } catch (err) { console.error('[orgs]', err); res.status(500).json({ error: 'Server error' }) }
})

// POST /api/orgs/:id/members - add a teammate to a company (master admin). They sign in as
// themself and act as the company; the company code and name are the company's.
router.post('/:id/members', requireAuth, requireMaster, limiter, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ error: 'Organization not found' })
    const org = await Organization.findById(req.params.id).lean()
    if (!org) return res.status(404).json({ error: 'Organization not found' })
    const { name, email, phone } = req.body || {}
    if (typeof name !== 'string' || !name.trim() || name.length > 200) return res.status(400).json({ error: 'Name is required' })
    if (typeof email !== 'string' || !EMAIL_RE.test(email.trim()) || email.length > 254) return res.status(400).json({ error: 'A valid email is required' })
    if (await User.exists({ email: email.toLowerCase().trim() })) return res.status(409).json({ error: 'Email already in use' })

    const tempPw = generateTempPassword()
    const role = roleForOrgType(org.type)
    const user = await User.create({
      email, passwordHash: await bcrypt.hash(tempPw, 10), role, adminType: null,
      company: org.name, name: name.trim(), phone: phone || null, code: org.code,
      orgId: org._id, orgRole: 'member', isActive: true, mustChangePw: true,
    })
    sendEmail(emailUserCreated({ name: user.name, email: user.email, password: tempPw, role, company: org.name }))
    await AuditLog.create({ byUser: req.user.id, action: 'Team Member Added', detail: `${user.email} added to ${org.name} (${org.code}) by ${req.user.name}` })
    const [view] = await loadOrgViews({ _id: org._id })
    res.status(201).json(view)
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'Email already in use' })
    console.error('[orgs]', err); res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/orgs/:id/partners { partnerOrgId } - connect a brand and a manufacturer (master admin)
router.post('/:id/partners', requireAuth, requireMaster, async (req, res) => {
  try {
    const { partnerOrgId } = req.body || {}
    if (!mongoose.Types.ObjectId.isValid(req.params.id) || !mongoose.Types.ObjectId.isValid(partnerOrgId)) return res.status(404).json({ error: 'Organization not found' })
    const [a, b] = await Promise.all([Organization.findById(req.params.id).lean(), Organization.findById(partnerOrgId).lean()])
    if (!a || !b) return res.status(404).json({ error: 'Organization not found' })
    if (a.type === b.type) return res.status(400).json({ error: 'A brand can only be connected with a manufacturer' })
    const [brand, mfr] = a.type === 'brand' ? [a, b] : [b, a]
    await Partnership.findOneAndUpdate(
      { brandOrgId: brand._id, mfrOrgId: mfr._id },
      { $setOnInsert: { source: 'admin', createdBy: req.user.actorId || req.user.id }, $set: { status: 'active' } },
      { upsert: true },
    )
    await AuditLog.create({ byUser: req.user.id, action: 'Partnership Created', detail: `${brand.name} and ${mfr.name} connected by ${req.user.name}` })
    res.json({ ok: true })
  } catch (err) { console.error('[orgs]', err); res.status(500).json({ error: 'Server error' }) }
})

// POST /api/orgs/:id/partners/:partnerOrgId/revoke - disconnect a brand and a manufacturer (master admin).
// Existing orders are untouched; no new orders can be created between them.
router.post('/:id/partners/:partnerOrgId/revoke', requireAuth, requireMaster, async (req, res) => {
  try {
    const { id, partnerOrgId } = req.params
    if (!mongoose.Types.ObjectId.isValid(id) || !mongoose.Types.ObjectId.isValid(partnerOrgId)) return res.status(404).json({ error: 'Partnership not found' })
    const r = await Partnership.updateOne(
      { $or: [{ brandOrgId: id, mfrOrgId: partnerOrgId }, { brandOrgId: partnerOrgId, mfrOrgId: id }], status: 'active' },
      { $set: { status: 'revoked' } },
    )
    if (r.matchedCount === 0) return res.status(404).json({ error: 'Partnership not found' })
    await AuditLog.create({ byUser: req.user.id, action: 'Partnership Revoked', detail: `${id} and ${partnerOrgId} disconnected by ${req.user.name}` })
    res.json({ ok: true })
  } catch (err) { console.error('[orgs]', err); res.status(500).json({ error: 'Server error' }) }
})

// GET /api/orgs/me - the signed-in company, its team and its two Tradio switches
router.get('/me', requireAuth, async (req, res) => {
  try {
    if (!isPartyRole(req.user.role)) return res.status(403).json({ error: 'Companies only' })
    const org = (await ensureOrgsByPartyIds([req.user.id])).get(String(req.user.id))
    if (!org) return res.status(404).json({ error: 'Organization not found' })
    const [view] = await loadOrgViews({ _id: org._id })
    res.json(view)
  } catch (err) { console.error('[orgs]', err); res.status(500).json({ error: 'Server error' }) }
})

// POST /api/orgs/me/profile - the company's business details (GSTIN, address, state), the header of
// its purchase orders. The owner keeps them; Tradio can also set them up (POST /api/orgs/:id).
router.post('/me/profile', requireAuth, limiter, async (req, res) => {
  try {
    if (!isPartyRole(req.user.role) || req.user.viewAsBy) return res.status(403).json({ error: 'Only the company owner can change this' })
    if (req.user.orgRole !== 'owner') return res.status(403).json({ error: 'Only the company owner can change this' })
    const cleaned = cleanProfile(req.body)
    if (!cleaned.ok) return res.status(400).json({ error: cleaned.error })
    const org = await Organization.findByIdAndUpdate(req.user.orgId, { $set: profileSet(cleaned.profile) }, { new: true }).lean()
    if (!org) return res.status(404).json({ error: 'Organization not found' })
    await AuditLog.create({ byUser: req.user.id, action: 'Business Details Updated', detail: `${org.name} (${org.code}): ${Object.keys(cleaned.profile).join(', ')} updated by ${req.user.name}` })
    const [view] = await loadOrgViews({ _id: org._id })
    res.json(view)
  } catch (err) { console.error('[orgs]', err); res.status(500).json({ error: 'Server error' }) }
})

// POST /api/orgs/me/privacy { tradioCanView } - the company's owner decides whether Tradio staff may
// look at the company at all. Tradio cannot change it, and a teammate who is not the owner cannot.
router.post('/me/privacy', requireAuth, async (req, res) => {
  try {
    if (!isPartyRole(req.user.role) || req.user.viewAsBy) return res.status(403).json({ error: 'Only the company owner can change this' })
    if (req.user.orgRole !== 'owner') return res.status(403).json({ error: 'Only the company owner can change this' })
    const { tradioCanView } = req.body || {}
    if (typeof tradioCanView !== 'boolean') return res.status(400).json({ error: 'tradioCanView must be true or false' })
    const org = await Organization.findByIdAndUpdate(req.user.orgId, { $set: { tradioCanView } }, { new: true }).lean()
    if (!org) return res.status(404).json({ error: 'Organization not found' })
    await AuditLog.create({ byUser: req.user.id, action: 'Tradio Access Changed', detail: `${org.name} (${org.code}): Tradio staff ${tradioCanView ? 'may' : 'may no longer'} view this company, set by ${req.user.name}` })
    const [view] = await loadOrgViews({ _id: org._id })
    res.json(view)
  } catch (err) { console.error('[orgs]', err); res.status(500).json({ error: 'Server error' }) }
})

export default router
