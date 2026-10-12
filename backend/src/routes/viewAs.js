// View as: lets the master admin look at any customer's or manufacturer's account exactly as that
// company sees it.
//
// Standalone product: this is how Tradio staff see a company's world. The session is READ-ONLY
// (requireAuth refuses every write) unless the master admin switches on "act for", which is only
// possible for a manufacturer Tradio has enabled. A company that has turned Tradio's view access
// off cannot be opened at all.
//
// Tradio portal: the sandbox tool it always was. Off unless ENABLE_VIEW_AS=true (production's
// environment never sets it), and the session has full powers as the viewed user.
//
// Either way the session is a normal JWT for the viewed company's primary account plus `viewAsBy`
// (the admin's id), so every existing permission check behaves as it does for that company.
// Starting and stopping are written to the audit log under the real admin's name.
import { Router } from 'express'
import jwt from 'jsonwebtoken'
import mongoose from 'mongoose'
import { requireAuth } from '../middleware/auth.js'
import { User, AuditLog, Organization } from '../db/index.js'
import { isStandalone } from '../lib/platform.js'
import { ensureOrgForUser, partyIdOfUser, roleForOrgType } from '../lib/orgs.js'
import { identityFor, publicUser } from '../lib/session.js'

const router = Router()
export const viewAsEnabled = () => process.env.ENABLE_VIEW_AS === 'true' || isStandalone()

const basePayload = u => ({
  id: u._id.toString(), email: u.email, role: u.role, adminType: u.adminType,
  name: u.name, company: u.company, code: u.code, mustChangePw: false,
})

const setSession = (res, payload) => {
  const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '60m' })
  const isProd = process.env.NODE_ENV === 'production'
  res.cookie('tradio_token', token, { httpOnly: true, secure: isProd, sameSite: isProd ? 'none' : 'lax', maxAge: 60 * 60 * 1000, path: '/' })
  return token
}

/** The real person behind this session: the admin who started a view-as, else the user themself. Must be an active master admin. */
async function realAdmin(reqUser) {
  const id = reqUser.viewAsBy || reqUser.id
  const u = await User.findById(id)
  return u && u.isActive && u.role === 'admin' && u.adminType === 'master' ? u : null
}

/** Merged into the user object the frontend gets from /login and /me. */
export async function viewAsFlags(payload) {
  if (!viewAsEnabled() || !payload) return {}
  if (payload.viewAsBy) {
    const admin = await realAdmin(payload)
    return admin ? { canViewAs: true, viewAsBy: String(admin._id), viewAsByName: admin.name } : {}
  }
  return payload.role === 'admin' && payload.adminType === 'master' ? { canViewAs: true } : {}
}

router.use((_req, res, next) => (viewAsEnabled() ? next() : res.status(404).json({ error: 'Not found' })))

// GET /api/auth/view-as/options - every company the master admin may open, one entry per
// organization (its primary account). `id` is that account's user id, which is what start takes.
router.get('/options', requireAuth, async (req, res) => {
  if (!(await realAdmin(req.user))) return res.status(403).json({ error: 'Master admin only' })

  // Accounts that predate organizations get theirs now, so every company appears here.
  const orphans = await User.find({ role: { $in: ['buyer', 'manufacturer'] }, isActive: true, orgId: null }).lean()
  for (const u of orphans) await ensureOrgForUser(u)

  const orgs = await Organization.find({ isActive: true }).lean()
  const owners = await User.find({ _id: { $in: orgs.map(o => o.ownerUserId) } }, 'name').lean()
  const ownerName = new Map(owners.map(u => [String(u._id), u.name]))
  const options = orgs.map(o => ({
    id: String(o.ownerUserId), name: ownerName.get(String(o.ownerUserId)) || '', company: o.name,
    role: roleForOrgType(o.type), code: o.code,
    orgId: String(o._id), type: o.type,
    tradioEnabled: !!o.tradioEnabled, tradioCanView: o.tradioCanView !== false,
  }))
  options.sort((a, b) => a.role.localeCompare(b.role) || a.company.localeCompare(b.company))
  res.json(options)
})

// POST /api/auth/view-as  { userId, act? }
router.post('/', requireAuth, async (req, res) => {
  const admin = await realAdmin(req.user)
  if (!admin) return res.status(403).json({ error: 'Master admin only' })
  const { userId, act } = req.body || {}
  if (!mongoose.Types.ObjectId.isValid(userId)) return res.status(400).json({ error: 'userId required' })
  let target = await User.findById(userId)
  if (!target || !target.isActive) return res.status(404).json({ error: 'User not found' })
  if (target.role === 'admin') return res.status(400).json({ error: 'You can only view as a customer or manufacturer' })

  // A teammate resolves to their organization's primary account: the session is always the company's.
  const partyId = await partyIdOfUser(target)
  if (partyId !== String(target._id)) {
    target = await User.findById(partyId)
    if (!target || !target.isActive) return res.status(404).json({ error: 'User not found' })
  }
  const org = await ensureOrgForUser(target)
  if (org && !org.isActive) return res.status(404).json({ error: 'User not found' })

  let acting = true   // the Tradio portal's view-as has always had full powers
  if (isStandalone()) {
    if (org?.tradioCanView === false)
      return res.status(403).json({ error: 'This organization has turned off Tradio access', code: 'VIEW_BLOCKED' })
    acting = !!act
    if (acting && !(target.role === 'manufacturer' && org?.tradioEnabled))
      return res.status(403).json({ error: 'Tradio can only act for Tradio-enabled manufacturers', code: 'NOT_TRADIO_ENABLED' })
  }

  const payload = { ...basePayload(target), viewAsBy: String(admin._id), viewAsByName: admin.name, actingFor: acting }
  const token = setSession(res, payload)
  const ident = await identityFor(target)
  AuditLog.create({
    byUser: admin._id,
    action: isStandalone() && acting ? 'Acting For Started' : 'View As Started',
    detail: `${admin.email} is ${isStandalone() && acting ? 'acting for' : 'viewing as'} ${target.email} (${target.role}, ${target.company})`,
  }).catch(() => {})
  res.json({ user: { ...publicUser({ ...payload, ...ident }), canViewAs: true }, token })
})

// POST /api/auth/view-as/exit - back to the admin's own session
router.post('/exit', requireAuth, async (req, res) => {
  if (!req.user.viewAsBy) return res.status(400).json({ error: 'Not viewing as anyone' })
  const admin = await realAdmin(req.user)
  if (!admin) return res.status(403).json({ error: 'Master admin only' })
  const payload = basePayload(admin)
  payload.mustChangePw = admin.mustChangePw
  const token = setSession(res, payload)
  AuditLog.create({ byUser: admin._id, action: 'View As Ended', detail: `${admin.email} stopped viewing as ${req.user.email}` }).catch(() => {})
  res.json({ user: { ...publicUser(payload), canViewAs: true }, token })
})

export default router
