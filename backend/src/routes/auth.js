import { Router } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import rateLimit from 'express-rate-limit'
import crypto from 'node:crypto'
import { sendEmail, emailConfigured, emailPasswordResetLink } from '../lib/email.js'
import { User, AuditLog } from '../db/index.js'
import { requireAuth } from '../middleware/auth.js'
import { viewAsFlags } from './viewAs.js'
import { identityFor, publicUser } from '../lib/session.js'

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
  keyGenerator: (req) => req.user?.actorId || req.user?.id || req.ip,
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

    // A buyer or manufacturer signs in as a person but acts as their organization (see
    // lib/session.js). A deactivated organization gets the same answer as a wrong password.
    const ident = await identityFor(user)
    if (ident.orgId && !ident.orgActive) {
      AuditLog.create({ byUser: user._id, action: 'Login Failed', detail: `Inactive organization: ${user.email}` }).catch(err => console.error('[auth] Audit log failed:', err))
      return res.status(401).json({ error: 'Invalid email or password' })
    }

    // The token names the person. requireAuth resolves it to the party on every request.
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
    res.json({ user: { ...publicUser({ ...payload, ...ident }), ...(await viewAsFlags(payload)) }, token })
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

    // The person's own account, never the organization's primary account a teammate acts as.
    const user = await User.findById(req.user.actorId || req.user.id)
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
    return res.status(401).json({ error: 'Session expired - please log in again' })
  }
  const payload = {
    // The person, not the party: re-signing the party's id would turn a teammate into the owner on
    // their first refresh.
    id: req.user.actorId || req.user.id, email: req.user.email, role: req.user.role,
    adminType: req.user.adminType, name: req.user.name, company: req.user.company,
    code: req.user.code, mustChangePw: req.user.mustChangePw,
    // Keep a view-as session a view-as session when the cookie is refreshed.
    ...(req.user.viewAsBy ? { viewAsBy: req.user.viewAsBy, viewAsByName: req.user.viewAsByName, actingFor: !!req.user.actingFor } : {}),
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
  res.json({ user: { ...req.user, ...publicUser(req.user), ...(await viewAsFlags(req.user)) }, token })
})

// POST /api/auth/logout — clear the httpOnly cookie
// ── Forgotten password ────────────────────────────────────────────────────────
// Anyone may ask; the answer is the same whether or not the email has an account, so it reveals nothing. An active account
// gets a link with a one-time token (only its hash is stored) that expires in 30 minutes. When email is not set up on this
// server the answer says so, and the person asks Tradio to reset it instead.
const RESET_TOKEN_MINUTES = 30
const hashToken = t => crypto.createHash('sha256').update(String(t)).digest('hex')
const forgotLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 5,
  keyGenerator: req => `${req.ip}|${emailOf(req)}`,
  message: { error: 'Too many requests. Please try again in an hour.' },
  standardHeaders: true, legacyHeaders: false, validate: false, skip: skipInTest,
})
const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  keyGenerator: req => req.ip,
  message: { error: 'Too many attempts. Please try again in 15 minutes.' },
  standardHeaders: true, legacyHeaders: false, validate: false, skip: skipInTest,
})

router.post('/forgot-password', forgotLimiter, async (req, res) => {
  try {
    const email = emailOf(req)
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter your email address' })
    const enabled = emailConfigured()
    const user = enabled ? await User.findOne({ email, isActive: true }) : null
    if (user) {
      const token = crypto.randomBytes(32).toString('base64url')
      user.resetTokenHash = hashToken(token)
      user.resetTokenExpires = new Date(Date.now() + RESET_TOKEN_MINUTES * 60 * 1000)
      await user.save()
      // Not awaited: how long the send takes must not tell an outsider that the account exists.
      sendEmail(emailPasswordResetLink({ name: user.name, email: user.email, token }))
      AuditLog.create({ byUser: user._id, action: 'Password Reset Requested', detail: `Reset link emailed to ${user.email}` }).catch(err => console.error('[auth] Audit log failed:', err))
    }
    res.json({ ok: true, emailEnabled: enabled })
  } catch (err) {
    console.error('[auth]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

router.post('/reset-password', resetLimiter, async (req, res) => {
  try {
    const { token, password } = req.body || {}
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) return res.status(400).json({ error: 'This reset link is not valid. Ask for a new one.' })
    if (typeof password !== 'string' || password.length < 8 || password.length > 128 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9]/.test(password))
      return res.status(400).json({ error: 'Password must be at least 8 characters and include uppercase, lowercase, a number, and a special character' })
    const user = await User.findOne({ resetTokenHash: hashToken(token), resetTokenExpires: { $gt: new Date() }, isActive: true })
    if (!user) return res.status(400).json({ error: 'This reset link has expired or was already used. Ask for a new one.' })
    user.passwordHash = await bcrypt.hash(password, 10)
    user.mustChangePw = false
    user.passwordChangedAt = new Date()   // signs out every session that was open under the old password
    user.resetTokenHash = null
    user.resetTokenExpires = null
    await user.save()
    await AuditLog.create({ byUser: user._id, action: 'Password Reset', detail: `Password reset through the emailed link: ${user.email}` })
    res.json({ ok: true })
  } catch (err) {
    console.error('[auth]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

router.post('/logout', (_req, res) => {
  res.clearCookie('tradio_token', { httpOnly: true, sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax', secure: process.env.NODE_ENV === 'production' })
  res.json({ ok: true })
})

export default router
