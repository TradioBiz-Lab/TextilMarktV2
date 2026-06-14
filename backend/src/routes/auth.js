import { Router } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import rateLimit from 'express-rate-limit'
import { User, AuditLog } from '../db/index.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()

// Server-side brute-force protection: 5 attempts per email per 15 min window
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => req.body?.email?.toLowerCase?.()?.trim?.() || req.ip,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
})

const changePasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => req.user?.id || req.ip,
  message: { error: 'Too many password change attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
})

router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' })
    if (typeof email !== 'string' || typeof password !== 'string') return res.status(400).json({ error: 'Invalid input' })
    if (email.length > 254 || password.length > 128) return res.status(400).json({ error: 'Input too long' })

    const user = await User.findOne({ email: email.toLowerCase().trim() })
    if (!user) {
      AuditLog.create({ byUser: null, action: 'Login Failed', detail: `Unknown email: ${email.toLowerCase().trim()}` }).catch(err => console.error('[auth] Audit log failed:', err))
      return res.status(401).json({ error: 'Invalid email or password' })
    }
    if (!user.isActive) {
      AuditLog.create({ byUser: user._id, action: 'Login Failed', detail: `Inactive account: ${user.email}` }).catch(err => console.error('[auth] Audit log failed:', err))
      return res.status(403).json({ error: 'Account inactive. Contact your administrator.' })
    }

    const valid = await bcrypt.compare(password, user.passwordHash)
    if (!valid) {
      AuditLog.create({ byUser: user._id, action: 'Login Failed', detail: `Bad password for: ${user.email}` }).catch(err => console.error('[auth] Audit log failed:', err))
      return res.status(401).json({ error: 'Invalid email or password' })
    }

    const payload = {
      id: user._id.toString(), email: user.email, role: user.role,
      adminType: user.adminType, name: user.name, company: user.company,
      code: user.code, mustChangePw: user.mustChangePw,
    }
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '60m' })

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
    // Token is delivered via httpOnly cookie. In non-production, also include it in the body
    // so that the test suite (which uses Authorization headers) can still function.
    const body = { user: payload }
    if (!isProd) body.token = token
    res.json(body)
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

router.post('/change-password', requireAuth, changePasswordLimiter, async (req, res) => {
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
router.get('/me', requireAuth, (req, res) => {
  const payload = {
    id: req.user.id, email: req.user.email, role: req.user.role,
    adminType: req.user.adminType, name: req.user.name, company: req.user.company,
    code: req.user.code, mustChangePw: req.user.mustChangePw,
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
  // Token in cookie only; expose in body only for non-production (test suite needs it)
  const meBody = { user: req.user }
  if (!isProd) meBody.token = token
  res.json(meBody)
})

// POST /api/auth/logout — clear the httpOnly cookie
router.post('/logout', (_req, res) => {
  res.clearCookie('tradio_token', { httpOnly: true, sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax', secure: process.env.NODE_ENV === 'production' })
  res.json({ ok: true })
})

export default router
