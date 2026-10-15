import { Router } from 'express'
import mongoose from 'mongoose'
import { MasterOrder } from '../models/MasterOrder.js'
import { DroppedRecord } from '../models/DroppedRecord.js'
import { parseDropReason } from '../lib/dropRecord.js'
import { Order }        from '../models/Order.js'
import { User }        from '../models/User.js'
import { AuditLog }    from '../models/AuditLog.js'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import { parseMasterOrderDetails, masterOrderDetailsOut } from '../lib/masterOrderDetails.js'
import { nextMasterOrderId } from '../lib/ids.js'
import { seasonError } from '../lib/seasons.js'

const router = Router()

// A factory never sees the customer's purchase order (documents.js keeps the PO file from it too), so the PO number and
// date and the notes stay with Tradio and the customer. The ship-by date is the factory's deadline as well, so it stays.
const detailsFor = (mo, viewer) => {
  const d = masterOrderDetailsOut(mo)
  return viewer?.role === 'manufacturer' ? { ...d, poNumber: '', poDate: null, notes: '' } : d
}

const enrich = (mo, viewer) => ({
  id: mo._id,
  buyerId: mo.buyerId?._id?.toString?.() ?? mo.buyerId?.toString?.() ?? mo.buyerId,
  buyerCompany: mo.buyerId?.company ?? null,
  buyerCode: mo.buyerId?.code ?? null,
  buyerName: mo.buyerId?.name ?? null,
  orderName: mo.orderName,
  season: mo.season,
  createdBy: mo.createdBy?._id?.toString?.() ?? mo.createdBy?.toString?.(),
  createdByName: mo.createdBy?.name ?? null,
  createdAt: mo.createdAt,
  ...detailsFor(mo, viewer),
})

// GET /api/master-orders - list (admin sees all, buyer sees theirs, a manufacturer sees
// only the master orders that their own assigned orders belong to, read-only)
router.get('/', requireAuth, async (req, res) => {
  try {
    let filter = {}
    if (req.user.role === 'buyer') filter = { buyerId: req.user.id }
    else if (req.user.role === 'manufacturer') {
      const ids = await Order.distinct('masterOrderId', { 'assignments.mfrId': req.user.id, masterOrderId: { $ne: null } })
      filter = { _id: { $in: ids } }
    }
    const mos = await MasterOrder.find(filter)
      .populate('buyerId', 'name company code')
      .populate('createdBy', 'name')
      .sort({ createdAt: -1 })
      .lean()
    res.json(mos.map(mo => enrich(mo, req.user)))
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/master-orders — create (admin only)
router.post('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { buyerId, orderName, season } = req.body
    let { id } = req.body
    if (!id || !buyerId || !orderName)
      return res.status(400).json({ error: 'Missing required fields (id, buyerId, orderName)' })
    if (typeof id !== 'string' || id.length > 100)
      return res.status(400).json({ error: 'Invalid ID' })
    if (typeof orderName !== 'string' || orderName.length > 200)
      return res.status(400).json({ error: 'Order name too long' })
    if (!mongoose.Types.ObjectId.isValid(buyerId))
      return res.status(400).json({ error: 'Invalid buyer ID' })

    const buyer = await User.findById(buyerId, 'role isActive company code').lean()
    if (!buyer || buyer.role !== 'buyer')
      return res.status(400).json({ error: 'Buyer not found' })
    if (!buyer.isActive)
      return res.status(400).json({ error: 'Buyer account is inactive' })
    const badSeason = await seasonError(buyerId, season)
    if (badSeason) return res.status(400).json({ error: badSeason })
    const details = parseMasterOrderDetails(req.body)
    if (details.error) return res.status(400).json({ error: details.error })
    const doc = { buyerId, orderName: orderName.trim(), season: season || null, createdBy: req.user.id, ...details.set }
    let mo
    if (id === 'auto') {
      // The server numbers it (the app's form and Kriyaa both create this way). Two creators racing for the same
      // number are caught by the unique id, and the later one takes the next number.
      for (let attempt = 1; !mo; attempt++) {
        id = await nextMasterOrderId(buyer.code, season)
        try { mo = await MasterOrder.create({ _id: id, ...doc }) }
        catch (err) { if (err.code !== 11000 || attempt >= 4) throw err }
      }
    } else {
      // Check for duplicate ID
      const existing = await MasterOrder.findById(id).lean()
      if (existing)
        return res.status(400).json({ error: 'A master order with this ID already exists' })
      mo = await MasterOrder.create({ _id: id, ...doc })
    }

    await AuditLog.create({
      byUser: req.user.id,
      action: 'Master Order Created',
      detail: `${id} - ${orderName.trim()} for buyer ${buyer.company}`,
    })

    // Re-fetch with populated fields
    const populated = await MasterOrder.findById(mo._id)
      .populate('buyerId', 'name company code')
      .populate('createdBy', 'name')
      .lean()

    res.status(201).json(enrich(populated, req.user))
  } catch (err) {
    if (err.code === 11000)
      return res.status(400).json({ error: 'Duplicate master order ID' })
    console.error('Master order create error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/master-orders/:id - edit the name, season, PO number and date, ship-by date or notes (admin only). Only the
// fields sent are changed; the id, buyer and creator never change. The styles under
// it keep their own season, since each style carries its own.
router.post('/:id', requireAuth, requireAdmin, async (req, res) => {
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
      else {
        const badSeason = await seasonError(mo.buyerId, body.season, mo.season)
        if (badSeason) return res.status(400).json({ error: badSeason })
        set.season = body.season
      }
    }
    const details = parseMasterOrderDetails(body)
    if (details.error) return res.status(400).json({ error: details.error })
    Object.assign(set, details.set)
    if (Object.keys(set).length === 0) return res.status(400).json({ error: 'Nothing to change' })
    // Only real changes are written and logged: a field sent with the value it already has is dropped.
    const norm = v => (v instanceof Date ? v.getTime() : v == null || v === '' ? null : v)
    for (const k of Object.keys(set)) if (norm(set[k]) === norm(mo[k])) delete set[k]
    const populate = () => MasterOrder.findById(mo._id).populate('buyerId', 'name company code').populate('createdBy', 'name').lean()
    if (Object.keys(set).length === 0) return res.json(enrich(await populate(), req.user))

    await MasterOrder.updateOne({ _id: mo._id }, { $set: set })

    const changes = Object.keys(set).map(k => `${k}: ${JSON.stringify(mo[k] ?? null)} -> ${JSON.stringify(set[k])}`).join('; ')
    await AuditLog.create({
      byUser: req.user.id,
      action: 'Master Order Edited',
      detail: `${mo._id}: ${changes} by ${req.user.name}`,
    })

    res.json(enrich(await populate(), req.user))
  } catch (err) {
    console.error('Master order edit error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/master-orders/:id/delete — delete (admin only). Refuses if any order
// still references this master order, to avoid orphaning real orders.
router.post('/:id/delete', requireAuth, requireAdmin, async (req, res) => {
  try {
    const mo = await MasterOrder.findById(req.params.id).lean()
    if (!mo) return res.status(404).json({ error: 'Master order not found' })

    const childCount = await Order.countDocuments({ masterOrderId: mo._id })
    if (childCount > 0)
      return res.status(400).json({ error: `Cannot delete - ${childCount} order(s) still reference this master order. Delete those first.` })

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

// GET /api/master-orders/:id/dropped - the styles dropped from this master order, newest first, so its page keeps
// them on record. Tradio staff and the master order's own customer only: a factory never sees other splits.
// The snapshot is large (stages, photo), so only what the page shows is read from it.
router.get('/:id/dropped', requireAuth, async (req, res) => {
  try {
    const mo = await MasterOrder.findById(req.params.id).select('buyerId').lean()
    if (!mo) return res.status(404).json({ error: 'Master order not found' })
    const ownCustomer = req.user.role === 'buyer' && String(mo.buyerId) === String(req.user.id)
    if (req.user.role !== 'admin' && !ownCustomer) return res.status(403).json({ error: 'Access denied' })
    const rows = await DroppedRecord.find({ kind: 'style', masterOrderId: mo._id })
      .select('refId label reason droppedByName droppedAt snapshot.product snapshot.styleNumber snapshot.totalQty snapshot.imageUrl snapshot.phase')
      .sort({ droppedAt: -1 }).limit(500).lean()
    res.json(rows.map(r => ({
      id: String(r._id), refId: r.refId, label: r.label, reason: r.reason || '',
      droppedByName: r.droppedByName || null, droppedAt: r.droppedAt,
      style: {
        product: r.snapshot?.product || null, styleNumber: r.snapshot?.styleNumber || '',
        totalQty: r.snapshot?.totalQty ?? null, phase: r.snapshot?.phase || 'production',
        imageUrl: typeof r.snapshot?.imageUrl === 'string' && /^https?:\/\//.test(r.snapshot.imageUrl) ? r.snapshot.imageUrl : null,
      },
    })))
  } catch (err) {
    console.error('[master-orders dropped]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

export default router
