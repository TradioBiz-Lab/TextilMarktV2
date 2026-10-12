import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { InboundMessage, Order, ActionItem, Supplier, SupplierItem, PurchaseOrder, Bom, CostSheet, InventoryItem, StockLedger, Grn, StockIssue } from '../db/index.js'
import { adminOrderVisibility } from '../lib/authz.js'
import { isStandalone } from '../lib/platform.js'

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
    : req.user.role === 'manufacturer' ? { 'assignments.mfrId': req.user.id } : await adminOrderVisibility()
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
  res.json({ version: `${messageVersion}|orders:${orders.length}:${newestOrder}`, itemsVersion, items, versions: await featureVersions(req.user) })
})

// A cheap version per feature store, so a screen open on one phone notices a change made on another
// (the screen refetches when its number moves; see LiveRefresh). Computed from the caller's OWN
// company's rows only, so the numbers can never reveal that another company's data changed. A factory
// gets its suppliers, purchase orders, bills of materials, cost sheets, stock and goods received notes; a brand gets the cost sheets
// shared with it (never a draft); Tradio staff get none.
async function featureVersions(user) {
  if (!isStandalone() || !user.orgId) return undefined
  const stamp = async (Model, filter, field = 'updatedAt') => {
    const [n, newest] = await Promise.all([Model.countDocuments(filter), Model.findOne(filter, field).sort({ [field]: -1 }).lean()])
    return { n, at: newest?.[field] ? new Date(newest[field]).getTime() : 0 }
  }
  if (user.role === 'buyer') {
    const sheets = await stamp(CostSheet, { brandOrgId: user.orgId, sharedAt: { $ne: null } })
    return { 'cost-sheets': `${sheets.n}:${sheets.at}` }
  }
  if (user.role !== 'manufacturer') return undefined
  const own = { ownerOrgId: user.orgId }
  const [sup, item, po, bom, sheets, stock, moves, grn, issue] = await Promise.all([
    stamp(Supplier, own), stamp(SupplierItem, own), stamp(PurchaseOrder, own), stamp(Bom, own), stamp(CostSheet, own),
    stamp(InventoryItem, own), stamp(StockLedger, own, 'createdAt'), stamp(Grn, own), stamp(StockIssue, own),
  ])
  return {
    suppliers: `${sup.n}:${sup.at}:${item.n}:${item.at}`,
    'purchase-orders': `${po.n}:${po.at}`,
    boms: `${bom.n}:${bom.at}`,
    'cost-sheets': `${sheets.n}:${sheets.at}`,
    inventory: `${stock.n}:${stock.at}:${moves.n}:${moves.at}:${issue.n}:${issue.at}`,
    grns: `${grn.n}:${grn.at}`,
  }
}

export default router
