import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { InboundMessage, Order } from '../db/index.js'

const router = Router()

// GET /api/floor/feed - latest floor activity for the viewer's orders, plus a
// cheap `version` the dashboard polls to know when to refetch. Buyers see only
// their own orders; admins see all; manufacturers get nothing here.
router.get('/feed', requireAuth, async (req, res) => {
  if (req.user.role === 'manufacturer') return res.status(403).json({ error: 'Forbidden' })
  const orderFilter = req.user.role === 'buyer' ? { buyerId: req.user.id } : {}
  const orderIds = (await Order.find(orderFilter, '_id').lean()).map(o => o._id)
  const msgs = await InboundMessage.find({ orderId: { $in: orderIds }, state: { $in: ['auto_applied', 'applied', 'needs_review'] }, 'changes.0': { $exists: true } })
    .select('-dataUrl').sort({ createdAt: -1 }).limit(60).lean()
  const items = msgs.map(m => ({
    id: String(m._id), type: m.type, orderId: m.orderId, stage: m.stageApplied,
    issue: m.hasDefect, state: m.state, at: m.createdAt,
    description: m.parsed?.description || m.rawText?.slice(0, 140) || '',
    hasMedia: m.type !== 'text',
  }))
  res.json({ version: items[0]?.id ? `${items[0].id}:${items[0].state}:${items.length}` : 'none', items })
})

export default router
