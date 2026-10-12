import { Router } from 'express'
import mongoose from 'mongoose'
import { MasterOrder, SEASONS } from '../models/MasterOrder.js'
import { DroppedRecord } from '../models/DroppedRecord.js'
import { parseDropReason } from '../lib/dropRecord.js'
import { Order }        from '../models/Order.js'
import { User }        from '../models/User.js'
import { AuditLog }    from '../models/AuditLog.js'
import { requireAuth } from '../middleware/auth.js'
import { isStandalone } from '../lib/platform.js'
import { canCreateOrders, requireMasterOrderOwner, adminMayManageBuyer, NOT_ENABLED } from '../lib/authz.js'
import { allocateMasterOrderId } from '../lib/counters.js'
import { unpartneredMfrs, privatePartyIds } from '../lib/orgs.js'

const router = Router()

const enrich = (mo) => ({
  id: mo._id,
  buyerId: mo.buyerId?._id?.toString?.() ?? mo.buyerId?.toString?.() ?? mo.buyerId,
  buyerCompany: mo.buyerId?.company ?? null,
  buyerCode: mo.buyerId?.code ?? null,
  buyerName: mo.buyerId?.name ?? null,
  orderName: mo.orderName,
  season: mo.season,
  createdBy: mo.createdBy?._id?.toString?.() ?? mo.createdBy?.toString?.(),
  createdByName: mo.createdBy?.name ?? null,
  createdByRole: mo.createdByRole || null,
  createdAt: mo.createdAt,
})

// GET /api/master-orders - list (admin sees all, buyer sees theirs, a manufacturer sees the master
// orders its own assigned orders belong to plus the ones it created itself, read-only)
router.get('/', requireAuth, async (req, res) => {
  try {
    let filter = {}
    if (req.user.role === 'buyer') filter = { buyerId: req.user.id }
    else if (req.user.role === 'manufacturer') {
      const ids = await Order.distinct('masterOrderId', { 'assignments.mfrId': req.user.id, masterOrderId: { $ne: null } })
      // A master order a manufacturer just created has no orders under it yet, so it would otherwise vanish.
      filter = { $or: [{ _id: { $in: ids } }, { createdBy: req.user.id, createdByRole: 'manufacturer' }] }
    } else if (isStandalone()) {
      // Tradio staff do not see brands that switched Tradio's view access off.
      const priv = await privatePartyIds()
      if (priv.length) filter = { buyerId: { $nin: priv } }
    }
    const mos = await MasterOrder.find(filter)
      .populate('buyerId', 'name company code')
      .populate('createdBy', 'name')
      .sort({ createdAt: -1 })
      .lean()
    res.json(mos.map(enrich))
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/master-orders - create. Tradio portal: admin only, with an ID the caller chose. Standalone:
// a brand for itself, a manufacturer for a brand it is connected with, or Tradio staff where they
// may act; the server numbers it (a brand or manufacturer never picks an ID).
router.post('/', requireAuth, canCreateOrders, async (req, res) => {
  try {
    const { orderName, season } = req.body || {}
    let { id, buyerId } = req.body || {}
    if (req.user.role === 'buyer') {
      if (buyerId && String(buyerId) !== String(req.user.id))
        return res.status(403).json({ error: 'You can only create master orders for your own company' })
      buyerId = String(req.user.id)
    }
    if (req.user.role !== 'admin') id = 'auto'

    if (!id || !buyerId || !orderName)
      return res.status(400).json({ error: 'Missing required fields (id, buyerId, orderName)' })
    if (typeof id !== 'string' || id.length > 100)
      return res.status(400).json({ error: 'Invalid ID' })
    if (typeof orderName !== 'string' || orderName.length > 200)
      return res.status(400).json({ error: 'Order name too long' })
    if (!mongoose.Types.ObjectId.isValid(buyerId))
      return res.status(400).json({ error: 'Invalid buyer ID' })
    if (season && !SEASONS.includes(season))
      return res.status(400).json({ error: `Invalid season. Must be one of: ${SEASONS.join(', ')}` })

    const buyer = await User.findById(buyerId, 'role isActive company code').lean()
    if (!buyer || buyer.role !== 'buyer')
      return res.status(400).json({ error: 'Buyer not found' })
    if (!buyer.isActive)
      return res.status(400).json({ error: 'Buyer account is inactive' })

    if (req.user.role === 'manufacturer' && (await unpartneredMfrs(buyerId, [req.user.id])).length)
      return res.status(403).json({ error: 'You are not connected with that customer', code: 'NOT_CONNECTED' })
    if (req.user.role === 'admin' && isStandalone() && !(await adminMayManageBuyer(buyerId)))
      return res.status(403).json(NOT_ENABLED)

    const auto = id === 'auto'
    if (auto) id = await allocateMasterOrderId({ buyerCode: buyer.code, season })
    // Check for duplicate ID. A numbered ID can still collide with one typed in by hand: take the next.
    for (let attempt = 0; await MasterOrder.exists({ _id: id }); attempt++) {
      if (!auto || attempt >= 5) return res.status(400).json({ error: 'A master order with this ID already exists' })
      id = await allocateMasterOrderId({ buyerCode: buyer.code, season })
    }

    const mo = await MasterOrder.create({
      _id: id,
      buyerId,
      orderName: orderName.trim(),
      season: season || null,
      createdBy: req.user.id,
      createdByRole: req.user.role,
    })

    await AuditLog.create({
      byUser: req.user.id,
      action: 'Master Order Created',
      detail: `${id} — ${orderName.trim()} for buyer ${buyer.company}`,
    })

    // Re-fetch with populated fields
    const populated = await MasterOrder.findById(mo._id)
      .populate('buyerId', 'name company code')
      .populate('createdBy', 'name')
      .lean()

    res.status(201).json(enrich(populated))
  } catch (err) {
    if (err.code === 11000)
      return res.status(400).json({ error: 'Duplicate master order ID' })
    console.error('Master order create error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/master-orders/:id - edit the name and/or season (admin; in standalone the creating
// company). Only the fields sent are changed; the id, buyer and creator never change. The styles
// under it keep their own season, since each style carries its own.
router.post('/:id', requireAuth, requireMasterOrderOwner, async (req, res) => {
  try {
    const mo = await MasterOrder.findById(req.params.id).lean()
    if (!mo) return res.status(404).json({ error: 'Master order not found' })

    const body = req.body || {}
    const set = {}
    if (Object.prototype.hasOwnProperty.call(body, 'orderName')) {
      if (typeof body.orderName !== 'string' || !body.orderName.trim())
        return res.status(400).json({ error: 'Order name cannot be blank' })
      if (body.orderName.trim().length > 200) return res.status(400).json({ error: 'Order name too long' })
      set.orderName = body.orderName.trim()
    }
    if (Object.prototype.hasOwnProperty.call(body, 'season')) {
      if (body.season === '' || body.season === null) set.season = null
      else if (!SEASONS.includes(body.season)) return res.status(400).json({ error: `Invalid season. Must be one of: ${SEASONS.join(', ')}` })
      else set.season = body.season
    }
    if (Object.keys(set).length === 0) return res.status(400).json({ error: 'Nothing to change' })

    await MasterOrder.updateOne({ _id: mo._id }, { $set: set })

    const changes = Object.keys(set).map(k => `${k}: ${JSON.stringify(mo[k] ?? null)} -> ${JSON.stringify(set[k])}`).join('; ')
    await AuditLog.create({
      byUser: req.user.id,
      action: 'Master Order Edited',
      detail: `${mo._id}: ${changes} by ${req.user.name}`,
    })

    const populated = await MasterOrder.findById(mo._id).populate('buyerId', 'name company code').populate('createdBy', 'name').lean()
    res.json(enrich(populated))
  } catch (err) {
    console.error('Master order edit error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/master-orders/:id/delete - delete (admin; in standalone the creating company). Refuses
// if any order still references this master order, to avoid orphaning real orders.
router.post('/:id/delete', requireAuth, requireMasterOrderOwner, async (req, res) => {
  try {
    const mo = await MasterOrder.findById(req.params.id).lean()
    if (!mo) return res.status(404).json({ error: 'Master order not found' })

    const childCount = await Order.countDocuments({ masterOrderId: mo._id })
    if (childCount > 0)
      return res.status(400).json({ error: `Cannot delete — ${childCount} order(s) still reference this master order. Delete those first.` })

    const { reason, error: reasonErr } = parseDropReason(req.body?.reason)
    if (reasonErr) return res.status(400).json({ error: reasonErr })

    // Record first, then delete: if the record can't be written, nothing is removed.
    const buyer = await User.findById(mo.buyerId, 'company').lean()
    const record = await DroppedRecord.create({
      kind: 'master_order', refId: String(mo._id), label: mo.orderName,
      masterOrderId: String(mo._id), buyerId: mo.buyerId || null, buyerCompany: buyer?.company || '',
      snapshot: mo, reason, droppedBy: req.user.id, droppedByName: req.user.name,
    })

    await MasterOrder.findByIdAndDelete(mo._id)

    await AuditLog.create({
      byUser: req.user.id,
      action: 'Master Order Deleted',
      detail: `${mo._id} - ${mo.orderName} deleted by ${req.user.name}${reason ? ` | ${reason.slice(0, 200)}` : ''} [record ${record._id}]`,
    })

    res.json({ ok: true, recordId: String(record._id) })
  } catch (err) {
    console.error('Master order delete error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

export default router
