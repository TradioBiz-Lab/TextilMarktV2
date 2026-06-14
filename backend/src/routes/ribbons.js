import { Router } from 'express'
import { Ribbon } from '../models/Ribbon.js'
import { AuditLog } from '../models/AuditLog.js'
import { requireAuth, requireAdmin } from '../middleware/auth.js'

const router = Router()

const VALID_AUDIENCES = ['all', 'buyer', 'manufacturer']
const VALID_TYPES = ['urgent', 'warning', 'info']

const enrichRibbon = r => ({
  id: r._id, message: r.message, type: r.type, audience: r.audience,
  targetUserIds: (r.targetUserIds || []).map(id => id.toString()),
  isActive: r.isActive, expiresAt: r.expiresAt, createdBy: r.createdBy,
  createdAt: r.createdAt, updatedAt: r.updatedAt,
})

// GET /api/ribbons — active ribbons for the current user's role
router.get('/', requireAuth, async (req, res) => {
  try {
    const now = new Date()
    const ribbons = await Ribbon.find({
      isActive: true,
      $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
      audience: { $in: ['all', req.user.role] },
    }).sort({ createdAt: -1 }).lean()

    // Filter by targetUserIds: if set, only show to those specific users (audience role already filtered by DB query above)
    const filtered = ribbons.filter(r =>
      !r.targetUserIds || r.targetUserIds.length === 0 || r.targetUserIds.some(id => id.toString() === req.user.id)
    )

    res.set('Cache-Control', 'no-store').json(filtered.map(enrichRibbon))
  } catch (err) {
    console.error('[ribbons]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// GET /api/ribbons/all — all ribbons (admin only, for management)
router.get('/all', requireAuth, requireAdmin, async (req, res) => {
  try {
    const ribbons = await Ribbon.find().sort({ createdAt: -1 }).lean()
    res.json(ribbons.map(enrichRibbon))
  } catch (err) {
    console.error('[ribbons]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/ribbons — create a ribbon (admin only)
router.post('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { message, type, audience, expiresAt, targetUserIds } = req.body
    if (!message?.trim()) return res.status(400).json({ error: 'Message is required' })
    if (!audience || !VALID_AUDIENCES.includes(audience))
      return res.status(400).json({ error: 'Audience must be one of: all, buyer, manufacturer' })
    if (type && !VALID_TYPES.includes(type))
      return res.status(400).json({ error: 'Type must be one of: urgent, warning, info' })

    // Deactivate any existing active ribbon for same audience (only if not user-targeted)
    if (!targetUserIds || targetUserIds.length === 0) {
      await Ribbon.updateMany(
        { audience, isActive: true, $or: [{ targetUserIds: { $exists: false } }, { targetUserIds: { $size: 0 } }] },
        { $set: { isActive: false } }
      )
    }

    const ribbon = await Ribbon.create({
      message: message.trim(),
      type: type || 'info',
      audience,
      targetUserIds: targetUserIds || [],
      expiresAt: expiresAt || null,
      createdBy: req.user.id,
    })

    await AuditLog.create({
      byUser: req.user.id,
      action: 'Ribbon Published',
      detail: `${type || 'info'} ribbon for ${audience}: "${message.trim()}"`,
    })

    res.status(201).json(enrichRibbon(ribbon.toObject()))
  } catch (err) {
    console.error('[ribbons]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// PATCH /api/ribbons/:id — update a ribbon (admin only)
router.patch('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { message, type, audience, isActive, expiresAt } = req.body
    const update = {}
    if (message !== undefined) {
      if (typeof message !== 'string' || !message.trim()) return res.status(400).json({ error: 'Message is required' })
      if (message.trim().length > 160) return res.status(400).json({ error: 'Message too long (max 160 chars)' })
      update.message = message.trim()
    }
    if (type !== undefined) {
      if (!VALID_TYPES.includes(type)) return res.status(400).json({ error: 'Invalid type' })
      update.type = type
    }
    if (audience !== undefined) {
      if (!VALID_AUDIENCES.includes(audience)) return res.status(400).json({ error: 'Invalid audience' })
      update.audience = audience
    }
    if (isActive !== undefined) update.isActive = isActive
    if (expiresAt !== undefined) update.expiresAt = expiresAt || null

    const ribbon = await Ribbon.findByIdAndUpdate(req.params.id, { $set: update }, { new: true }).lean()
    if (!ribbon) return res.status(404).json({ error: 'Ribbon not found' })

    await AuditLog.create({
      byUser: req.user.id,
      action: isActive === false ? 'Ribbon Removed' : 'Ribbon Updated',
      detail: `Ribbon ${ribbon._id}: "${ribbon.message}"`,
    })

    res.json(enrichRibbon(ribbon))
  } catch (err) {
    console.error('[ribbons]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// DELETE /api/ribbons/:id — delete a ribbon (admin only)
router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const ribbon = await Ribbon.findByIdAndDelete(req.params.id).lean()
    if (!ribbon) return res.status(404).json({ error: 'Ribbon not found' })

    await AuditLog.create({
      byUser: req.user.id,
      action: 'Ribbon Deleted',
      detail: `Deleted ribbon: "${ribbon.message}"`,
    })

    res.json({ ok: true })
  } catch (err) {
    console.error('[ribbons]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

export default router
