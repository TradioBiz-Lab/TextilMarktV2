import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { InboundMessage, Order } from '../db/index.js'

const router = Router()

// GET /api/floor/feed - recent message activity for the viewer's orders, plus a
// cheap `version` the app polls to know when to refetch orders and evidence. Customers see only
// their own orders, factories only the orders assigned to them, admins see all.
router.get('/feed', requireAuth, async (req, res) => {
  const orderFilter = req.user.role === 'buyer' ? { buyerId: req.user.id }
    : req.user.role === 'manufacturer' ? { 'assignments.mfrId': req.user.id } : {}
  const orderIds = (await Order.find(orderFilter, '_id').lean()).map(o => o._id)
  const msgs = await InboundMessage.find({ orderId: { $in: orderIds }, state: { $in: ['auto_applied', 'applied', 'needs_review'] } })
    .select('-dataUrl').sort({ updatedAt: -1 }).limit(60).lean()
  const items = msgs.map(m => ({
    id: String(m._id), type: m.type, orderId: m.orderId, stage: m.stageApplied,
    issue: m.hasDefect, state: m.state, at: m.createdAt,
    description: m.parsed?.description || m.rawText?.slice(0, 140) || '',
    hasMedia: m.type !== 'text',
  }))
  res.json({ version: msgs[0] ? `${msgs[0]._id}:${new Date(msgs[0].updatedAt).getTime()}:${items.length}` : 'none', items })
})

export default router
