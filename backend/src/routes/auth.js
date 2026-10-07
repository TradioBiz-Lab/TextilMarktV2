import { Router } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import rateLimit from 'express-rate-limit'
import { User, AuditLog } from '../db/index.js'
import { requireAuth } from '../middleware/auth.js'
import { viewAsFlags } from './viewAs.js'  // sandbox-only, see viewAs.js

const router = Router()

// Bypassed only under NODE_ENV=test — a suite logging in as several roles
// would otherwise exhaust the 5-attempt window mid-run.
const skipInTest = () => process.env.NODE_ENV === 'test'

// Server-side brute-force protection: 5 attempts per email per 15 min window
// Keyed by IP AND email: keyed by email alone, anyone could lock a known user (the master admin
// included) out of their account by sending five bad attempts every 15 minutes. A second, looser
// ceiling per email still caps guessing spread across many IPs.
const emailOf = req => String(req.body?.email ?? '').toLowerCase().trim().slice(0, 254)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => `${req.ip}|${emailOf(req)}`,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  skip: skipInTest,
})
const loginEmailCeiling = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  keyGenerator: (req) => `email|${emailOf(req)}`,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  skip: skipInTest,
})

// Compared against when the email is unknown, so a missing account costs the same bcrypt time as a
// wrong password and the response timing does not reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10)

// Sessions refresh themselves through /me, so cap the total life of one login.
const MAX_SESSION_SECONDS = 12 * 60 * 60

const changePasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => req.user?.id || req.ip,
  message: { error: 'Too many password change attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  skip: skipInTest,
})

router.post('/login', loginLimiter, loginEmailCeiling, async (req, res) => {
  try {
    const { email, password } = req.body
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' })
    if (typeof email !== 'string' || typeof password !== 'string') return res.status(400).json({ error: 'Invalid input' })
    if (email.length > 254 || password.length > 128) return res.status(400).json({ error: 'Input too long' })

    const user = await User.findOne({ email: email.toLowerCase().trim() })
    if (!user) {
      await bcrypt.compare(password, DUMMY_HASH)
      // Capped: the email is attacker-controlled text and lands in the audit log.
      AuditLog.create({ byUser: null, action: 'Login Failed', detail: `Unknown email: ${email.toLowerCase().trim().slice(0, 100)}` }).catch(err => console.error('[auth] Audit log failed:', err))
      return res.status(401).json({ error: 'Invalid email or password' })
    }

    const valid = await bcrypt.compare(password, user.passwordHash)
    // An inactive account gets the same answer as a wrong password, after the same work, so the
    // response does not reveal that the account exists or that it was deactivated.
    if (valid && !user.isActive) {
      AuditLog.create({ byUser: user._id, action: 'Login Failed', detail: `Inactive account: ${user.email}` }).catch(err => console.error('[auth] Audit log failed:', err))
      return res.status(401).json({ error: 'Invalid email or password' })
    }
    if (!valid) {
      AuditLog.create({ byUser: user._id, action: 'Login Failed', detail: `Bad password for: ${user.email}` }).catch(err => console.error('[auth] Audit log failed:', err))
      return res.status(401).json({ error: 'Invalid email or password' })
    }

    const payload = {
      id: user._id.toString(), email: user.email, role: user.role,
      adminType: user.adminType, name: user.name, company: user.company,
      code: user.code, mustChangePw: user.mustChangePw,
    }
    // oiat: when this login began. /me keeps it across refreshes so a session cannot slide forever.
    const token = jwt.sign({ ...payload, oiat: Math.floor(Date.now() / 1000) }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '60m' })

    // Set httpOnly cookie (secure + sameSite=none for cross-origin Vercel→Render in production)
    const isProd = process.env.NODE_ENV === 'production'
    res.cookie('tradio_token', token, {
      httpOnly: true,
      secure: isProd,
      sameSite: isProd ? 'none' : 'lax',
      maxAge: 60 * 60 * 1000,
      path: '/',
    })

    AuditLog.create({ byUser: user._id, action: 'Login', detail: `Successful login: ${user.email}` }).catch(err => console.error('[auth] Audit log failed:', err))
    // Token is delivered via httpOnly cookie AND in the response body. The cookie is
    // primary, but iOS WebKit (Chrome/Safari on iPhone) can silently drop cross-site
    // SameSite=None cookies, so the frontend also stores this token and sends it as
    // an Authorization header — requireAuth already accepts either. Always included
    // (not just in non-prod) since prod is exactly where the cookie can fail.
    res.json({ user: { ...payload, ...(await viewAsFlags(payload)) }, token })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

router.post('/change-password', requireAuth, changePasswordLimiter, async (req, res) => {
  if (req.user.viewAsBy) return res.status(403).json({ error: 'Not available while viewing as another user' })
  try {
    const { currentPassword, newPassword } = req.body
    if (!currentPassword || typeof currentPassword !== 'string') return res.status(400).json({ error: 'Current password is required' })
    if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' })
    if (newPassword.length > 128) return res.status(400).json({ error: 'Password too long' })
    if (!/[A-Z]/.test(newPassword) || !/[a-z]/.test(newPassword) || !/[0-9]/.test(newPassword) || !/[^A-Za-z0-9]/.test(newPassword)) {
      return res.status(400).json({ error: 'Password must include uppercase, lowercase, a number, and a special character' })
    }

    const user = await User.findById(req.user.id)
    if (!user) return res.status(404).json({ error: 'User not found' })

    if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
      return res.status(400).json({ error: 'Current password incorrect' })
    }

    user.passwordHash = await bcrypt.hash(newPassword, 10)
    user.mustChangePw = false
    user.passwordChangedAt = new Date()
    await user.save()
    // Clear the auth cookie so all tabs must re-authenticate with the new password
    const isProd = process.env.NODE_ENV === 'production'
    res.clearCookie('tradio_token', { httpOnly: true, sameSite: isProd ? 'none' : 'lax', secure: isProd })
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// GET /api/auth/me — restore session and refresh the httpOnly cookie
router.get('/me', requireAuth, async (req, res) => {
  const startedAt = req.user.oiat ?? req.user.iat
  if (startedAt && Math.floor(Date.now() / 1000) - startedAt > MAX_SESSION_SECONDS) {
    res.clearCookie('tradio_token', { httpOnly: true, sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax', secure: process.env.NODE_ENV === 'production' })
    return res.status(401).json({ error: 'Session expired — please log in again' })
  }
  const payload = {
    id: req.user.id, email: req.user.email, role: req.user.role,
    adminType: req.user.adminType, name: req.user.name, company: req.user.company,
    code: req.user.code, mustChangePw: req.user.mustChangePw,
    // Keep a view-as session a view-as session when the cookie is refreshed.
    ...(req.user.viewAsBy ? { viewAsBy: req.user.viewAsBy, viewAsByName: req.user.viewAsByName } : {}),
    ...(startedAt ? { oiat: startedAt } : {}),
  }
  const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '60m' })
  const isProd = process.env.NODE_ENV === 'production'
  res.cookie('tradio_token', token, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    maxAge: 60 * 60 * 1000,
    path: '/',
  })
  // Same Authorization-header fallback as /login — see comment there.
  res.json({ user: { ...req.user, ...(await viewAsFlags(req.user)) }, token })
})

// POST /api/auth/logout — clear the httpOnly cookie
router.post('/logout', (_req, res) => {
  res.clearCookie('tradio_token', { httpOnly: true, sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax', secure: process.env.NODE_ENV === 'production' })
  res.json({ ok: true })
})

export default router
