import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { sendEmail, emailSignupInquiry } from '../lib/email.js'

// Strict rate limit: 5 sign-up submissions per IP per hour to prevent spam
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Too many sign-up requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
})

const router = Router()

// POST /api/signup — public endpoint, no auth required
router.post('/', signupLimiter, async (req, res) => {
  try {
    const { name, email, company, phone, role, message } = req.body

    if (!name || typeof name !== 'string' || !name.trim())
      return res.status(400).json({ error: 'Name is required' })
    if (!email || typeof email !== 'string' || !email.trim())
      return res.status(400).json({ error: 'Email is required' })
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
      return res.status(400).json({ error: 'Invalid email address' })

    // Sanitize lengths
    if (name.trim().length > 120)
      return res.status(400).json({ error: 'Name too long' })
    if (email.trim().length > 200)
      return res.status(400).json({ error: 'Email too long' })
    if (company && company.length > 200)
      return res.status(400).json({ error: 'Company name too long' })
    if (phone && phone.length > 30)
      return res.status(400).json({ error: 'Phone number too long' })
    if (message && message.length > 2000)
      return res.status(400).json({ error: 'Message too long (max 2000 characters)' })

    await sendEmail(emailSignupInquiry({
      name: name.trim(),
      email: email.trim().toLowerCase(),
      company: company?.trim() || '',
      phone: phone?.trim() || '',
      role: role?.trim() || '',
      message: message?.trim() || '',
    }))

    res.json({ ok: true })
  } catch (err) {
    console.error('[signup]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

export default router
