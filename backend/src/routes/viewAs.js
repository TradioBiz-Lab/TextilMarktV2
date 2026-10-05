// SANDBOX ONLY, TEMPORARY. Lets the master admin browse the portal as any
// customer or manufacturer. Remove this file, its mount in app.js, the
// viewAsFlags() calls in routes/auth.js and the frontend ViewAsPicker when the
// feature is dropped.
//
// Off unless ENABLE_VIEW_AS=true is set in the environment (the sandbox .env
// sets it, production's never does). While active, the session is a normal JWT
// for the target user plus `viewAsBy` (the admin's id), so every existing
// permission check behaves exactly as it does for that user. Starting and
// stopping are written to the audit log under the real admin's name.
import { Router } from 'express'
import jwt from 'jsonwebtoken'
import mongoose from 'mongoose'
import { requireAuth } from '../middleware/auth.js'
import { User, AuditLog } from '../db/index.js'

const router = Router()
export const viewAsEnabled = () => process.env.ENABLE_VIEW_AS === 'true'

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

// GET /api/auth/view-as/options - everyone the master admin may view as
router.get('/options', requireAuth, async (req, res) => {
  if (!(await realAdmin(req.user))) return res.status(403).json({ error: 'Master admin only' })
  const users = await User.find({ role: { $in: ['buyer', 'manufacturer'] }, isActive: true }, 'name company role code').sort({ role: 1, company: 1 }).lean()
  res.json(users.map(u => ({ id: String(u._id), name: u.name, company: u.company, role: u.role })))
})

// POST /api/auth/view-as  { userId }
router.post('/', requireAuth, async (req, res) => {
  const admin = await realAdmin(req.user)
  if (!admin) return res.status(403).json({ error: 'Master admin only' })
  const { userId } = req.body || {}
  if (!mongoose.Types.ObjectId.isValid(userId)) return res.status(400).json({ error: 'userId required' })
  const target = await User.findById(userId)
  if (!target || !target.isActive) return res.status(404).json({ error: 'User not found' })
  if (target.role === 'admin') return res.status(400).json({ error: 'You can only view as a customer or manufacturer' })

  const payload = { ...basePayload(target), viewAsBy: String(admin._id), viewAsByName: admin.name }
  const token = setSession(res, payload)
  AuditLog.create({ byUser: admin._id, action: 'View As Started', detail: `${admin.email} is viewing as ${target.email} (${target.role}, ${target.company})` }).catch(() => {})
  res.json({ user: { ...payload, canViewAs: true }, token })
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
  res.json({ user: { ...payload, canViewAs: true }, token })
})

export default router
