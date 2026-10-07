import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { InboundMessage, Order, ActionItem } from '../db/index.js'

const router = Router()

// GET /api/floor/feed - recent message activity for the viewer's orders, plus a
// cheap `version` the app polls to know when to refetch orders and evidence. Customers see only
// their own orders, factories only the orders assigned to them, admins see all.
//
// `version` changes when a factory message lands OR when any of the viewer's
// orders is written (a stage update, a date revision, a new or deleted order),
// by anyone. Without the order part, a dashboard left open never learned about
// another user's edits. Order has timestamps, so the newest updatedAt plus the
// count (which catches a deletion) is enough; `itemsVersion` does the same for
// the admin task list, which the other roles don't have.
router.get('/feed', requireAuth, async (req, res) => {
  const orderFilter = req.user.role === 'buyer' ? { buyerId: req.user.id }
    : req.user.role === 'manufacturer' ? { 'assignments.mfrId': req.user.id } : {}
  const orders = await Order.find(orderFilter, '_id updatedAt').lean()
  const orderIds = orders.map(o => o._id)
  const newestOrder = orders.reduce((m, o) => Math.max(m, o.updatedAt ? new Date(o.updatedAt).getTime() : 0), 0)
  const msgs = await InboundMessage.find({ orderId: { $in: orderIds }, state: { $in: ['auto_applied', 'applied', 'needs_review'] } })
    .select('-dataUrl').sort({ updatedAt: -1 }).limit(60).lean()
  const items = msgs.map(m => ({
    id: String(m._id), type: m.type, orderId: m.orderId, stage: m.stageApplied,
    issue: m.hasDefect, state: m.state, at: m.createdAt,
    description: m.parsed?.description || m.rawText?.slice(0, 140) || '',
    hasMedia: m.type !== 'text',
  }))
  const messageVersion = msgs[0] ? `${msgs[0]._id}:${new Date(msgs[0].updatedAt).getTime()}:${items.length}` : 'none'
  let itemsVersion = null
  if (req.user.role === 'admin') {
    const newestItem = await ActionItem.findOne({}, 'updatedAt').sort({ updatedAt: -1 }).lean()
    itemsVersion = `${newestItem ? new Date(newestItem.updatedAt).getTime() : 0}:${await ActionItem.estimatedDocumentCount()}`
  }
  res.json({ version: `${messageVersion}|orders:${orders.length}:${newestOrder}`, itemsVersion, items })
})

export default router
