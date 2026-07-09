import { Router } from 'express'
import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import rateLimit from 'express-rate-limit'
import { User } from '../db/index.js'
import { requireAuth, requireAdmin, requireMaster } from '../middleware/auth.js'
import { sendEmail, emailUserCreated, emailPasswordReset } from '../lib/email.js'

// User creation is admin-only and low-volume; still cap to prevent bulk-create abuse
const createUserLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 30,
  keyGenerator: req => req.user?.id || req.ip,
  message: { error: 'Too many user creation requests. Please wait.' },
  standardHeaders: true, legacyHeaders: false, validate: false,
})

// Enforce minimum password complexity: 8+ chars, uppercase, lowercase, digit, special char
function isStrongPassword(pw) {
  return pw.length >= 8 && /[A-Z]/.test(pw) && /[a-z]/.test(pw) && /[0-9]/.test(pw) && /[^A-Za-z0-9]/.test(pw)
}

const router = Router()

const mapUser = u => ({
  id: u._id.toString(), email: u.email, role: u.role, adminType: u.adminType,
  company: u.company, name: u.name, phone: u.phone, code: u.code,
  isActive: u.isActive, createdAt: u.createdAt, mustChangePw: u.mustChangePw,
})

// GET /api/users
router.get('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const users = await User.find().sort({ createdAt: 1 }).lean()
    res.json(users.map(mapUser))
  } catch (err) {
    console.error('[users]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/users
router.post('/', requireAuth, requireMaster, createUserLimiter, async (req, res) => {
  try {
    const { email, password, role, adminType, company, name, phone, code } = req.body
    if (!email || !password || !role || !company || !name) {
      return res.status(400).json({ error: 'Missing required fields' })
    }
    if (typeof email !== 'string' || typeof password !== 'string' || typeof name !== 'string' || typeof company !== 'string') {
      return res.status(400).json({ error: 'Invalid input types' })
    }
    if (email.length > 254 || name.length > 200 || company.length > 200 || password.length > 128) {
      return res.status(400).json({ error: 'Input too long' })
    }
    if (!isStrongPassword(password)) {
      return res.status(400).json({ error: 'Password must be at least 8 characters and include uppercase, lowercase, a number, and a special character' })
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return res.status(400).json({ error: 'Invalid email address' })
    }
    if (!['admin', 'buyer', 'manufacturer'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' })
    }

    const exists = await User.findOne({ email: email.toLowerCase().trim() })
    if (exists) return res.status(409).json({ error: 'Email already in use' })

    // Company code must be unique across all users (AC from US-USR-01)
    if (role !== 'admin' && !code?.trim()) {
      return res.status(400).json({ error: 'Company code is required for buyers and manufacturers' })
    }
    const normalizedCode = role === 'admin' ? 'TRD' : code.trim().toUpperCase().slice(0, 5)
    if (role !== 'admin') {
      if (normalizedCode.length < 3 || normalizedCode.length > 5) {
        return res.status(400).json({ error: 'Company code must be 3–5 characters' })
      }
      const codeExists = await User.findOne({ code: normalizedCode })
      if (codeExists) return res.status(409).json({ error: `Company code "${normalizedCode}" is already in use` })
    }

    const user = await User.create({
      email,
      passwordHash: await bcrypt.hash(password, 10),
      role,
      adminType: adminType || null,
      company,
      name,
      phone: phone || null,
      code: normalizedCode,
      isActive: true,
      mustChangePw: true,
    })

    // BRD US-USR-01: "Login credentials sent to user via email on creation"
    sendEmail(emailUserCreated({ name, email, password, role, company }))

    res.status(201).json(mapUser(user.toObject()))
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'Email already in use' })
    console.error('[users]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// PATCH /api/users/:id (edit user details — master admin only)
router.post('/:id', requireAuth, requireMaster, async (req, res) => {
  try {
    const { name, email, phone } = req.body
    const user = await User.findById(req.params.id)
    if (!user) return res.status(404).json({ error: 'User not found' })

    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'Name is required' })
      if (name.length > 200) return res.status(400).json({ error: 'Name too long' })
      user.name = name.trim()
    }
    if (email !== undefined) {
      if (typeof email !== 'string' || !email.trim()) return res.status(400).json({ error: 'Email is required' })
      if (email.length > 254) return res.status(400).json({ error: 'Email too long' })
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return res.status(400).json({ error: 'Invalid email address' })
      const normalized = email.toLowerCase().trim()
      if (normalized !== user.email) {
        const exists = await User.findOne({ email: normalized })
        if (exists) return res.status(409).json({ error: 'Email already in use' })
        user.email = normalized
      }
    }
    if (phone !== undefined) {
      if (phone !== null && phone !== '' && typeof phone !== 'string') return res.status(400).json({ error: 'Invalid phone' })
      user.phone = phone || null
    }

    await user.save()
    res.json(mapUser(user.toObject()))
  } catch (err) {
    console.error('[users]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// PATCH /api/users/:id/toggle
router.post('/:id/toggle', requireAuth, requireMaster, async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
    if (!user) return res.status(404).json({ error: 'User not found' })
    if (user.adminType === 'master') return res.status(403).json({ error: 'Cannot deactivate master admin' })

    user.isActive = !user.isActive
    await user.save()
    res.json(mapUser(user.toObject()))
  } catch (err) {
    console.error('[users]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// PATCH /api/users/:id/reset-password
router.post('/:id/reset-password', requireAuth, requireMaster, async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
    if (!user) return res.status(404).json({ error: 'User not found' })

    // Generate a cryptographically secure temporary password
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
    const specials = '!@#$%&*'
    const bytes = crypto.randomBytes(12)
    let tempPw = ''
    for (let i = 0; i < 10; i++) tempPw += chars[bytes[i] % chars.length]
    tempPw += specials[bytes[10] % specials.length]
    // Ensure at least one uppercase, one lowercase, one digit
    tempPw = 'T' + tempPw.slice(1, 9) + 'a1' + tempPw.slice(11)

    user.passwordHash = await bcrypt.hash(tempPw, 10)
    user.mustChangePw = true
    await user.save()

    // BRD US-USR-01: "Sends a password reset email to the user instantly"
    sendEmail(emailPasswordReset({ name: user.name, email: user.email, tempPassword: tempPw }))

    // Do NOT return tempPassword in response — delivered via email only
    res.json({ ok: true })
  } catch (err) {
    console.error('[users]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

export default router
