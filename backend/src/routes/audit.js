import { Router } from 'express'
import { AuditLog } from '../db/index.js'
import { requireAuth, requireAdmin } from '../middleware/auth.js'

const router = Router()

// GET /api/audit  (admin only)
// Supports ?limit=N&skip=N for pagination (default: most recent 200)
router.get('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 200, 500)
    const skip  = Math.max(parseInt(req.query.skip)  || 0,   0)
    const [logs, total] = await Promise.all([
      AuditLog.find().sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      AuditLog.countDocuments(),
    ])
    res.json({
      total, limit, skip,
      items: logs.map(a => ({ id: a._id, by: a.byUser, action: a.action, detail: a.detail, at: a.createdAt })),
    })
  } catch (err) {
    console.error('[audit]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/audit (admin only)
router.post('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { action, detail } = req.body
    if (!action || typeof action !== 'string' || action.trim().length === 0)
      return res.status(400).json({ error: 'Action is required' })
    if (action.length > 100) return res.status(400).json({ error: 'Action too long (max 100 chars)' })
    if (detail && typeof detail !== 'string') return res.status(400).json({ error: 'Invalid detail' })
    if (detail && detail.length > 1000) return res.status(400).json({ error: 'Detail too long (max 1000 chars)' })
    const entry = await AuditLog.create({ byUser: req.user.id, action: action.trim(), detail: detail?.trim() || '' })
    res.status(201).json({ id: entry._id })
  } catch (err) {
    console.error('[audit]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

export default router
