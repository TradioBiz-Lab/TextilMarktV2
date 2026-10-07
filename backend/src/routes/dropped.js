import { Router } from 'express'
import mongoose from 'mongoose'
import { DroppedRecord } from '../models/DroppedRecord.js'
import { requireAuth, requireAdmin } from '../middleware/auth.js'

const router = Router()

const summary = r => ({
  id: String(r._id), kind: r.kind, refId: r.refId, label: r.label,
  masterOrderId: r.masterOrderId, buyerCompany: r.buyerCompany || null,
  reason: r.reason || '', documentCount: (r.documentIds || []).length,
  droppedBy: r.droppedBy ? String(r.droppedBy) : null, droppedByName: r.droppedByName || null,
  droppedAt: r.droppedAt,
})

// GET /api/dropped - what has been dropped, newest first (admin only). The
// snapshot itself is large (stages, photo), so the list leaves it out and
// GET /api/dropped/:id returns the whole record.
router.get('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const filter = {}
    if (typeof req.query.kind === 'string' && ['style', 'master_order'].includes(req.query.kind)) filter.kind = req.query.kind
    if (typeof req.query.masterOrderId === 'string' && req.query.masterOrderId) filter.masterOrderId = req.query.masterOrderId
    const rows = await DroppedRecord.find(filter).select('-snapshot').sort({ droppedAt: -1 }).limit(500).lean()
    res.json(rows.map(summary))
  } catch (err) {
    console.error('[dropped]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

router.get('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ error: 'Record not found' })
    const r = await DroppedRecord.findById(req.params.id).lean()
    if (!r) return res.status(404).json({ error: 'Record not found' })
    res.json({ ...summary(r), documentIds: (r.documentIds || []).map(String), snapshot: r.snapshot })
  } catch (err) {
    console.error('[dropped]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

export default router
