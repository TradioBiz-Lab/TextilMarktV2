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
      items: logs.map(a => ({ id: a._id, by: a.byUser, viewAsBy: a.viewAsBy || null, action: a.action, detail: a.detail, at: a.createdAt })),
    })
  } catch (err) {
    console.error('[audit]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// There is deliberately no POST here: the audit log is written by the server, at the point an
// action happens. A client-writable endpoint let any admin record entries that never occurred.

export default router
