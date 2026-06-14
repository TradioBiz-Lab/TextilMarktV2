import { Router } from 'express'
import mongoose from 'mongoose'
import { MasterOrder } from '../models/MasterOrder.js'
import { User }        from '../models/User.js'
import { AuditLog }    from '../models/AuditLog.js'
import { requireAuth, requireAdmin } from '../middleware/auth.js'

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
  createdAt: mo.createdAt,
})

// GET /api/master-orders — list all (admin sees all, buyer sees theirs, manufacturer blocked)
router.get('/', requireAuth, async (req, res) => {
  try {
    if (req.user.role === 'manufacturer') return res.status(403).json({ error: 'Forbidden' })
    const filter = req.user.role === 'buyer' ? { buyerId: req.user.id } : {}
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

// POST /api/master-orders — create (admin only)
router.post('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id, buyerId, orderName, season } = req.body
    if (!id || !buyerId || !orderName)
      return res.status(400).json({ error: 'Missing required fields (id, buyerId, orderName)' })
    if (typeof id !== 'string' || id.length > 100)
      return res.status(400).json({ error: 'Invalid ID' })
    if (typeof orderName !== 'string' || orderName.length > 200)
      return res.status(400).json({ error: 'Order name too long' })
    if (!mongoose.Types.ObjectId.isValid(buyerId))
      return res.status(400).json({ error: 'Invalid buyer ID' })

    const buyer = await User.findById(buyerId, 'role isActive company').lean()
    if (!buyer || buyer.role !== 'buyer')
      return res.status(400).json({ error: 'Buyer not found' })
    if (!buyer.isActive)
      return res.status(400).json({ error: 'Buyer account is inactive' })

    // Check for duplicate ID
    const existing = await MasterOrder.findById(id).lean()
    if (existing)
      return res.status(400).json({ error: 'A master order with this ID already exists' })

    const mo = await MasterOrder.create({
      _id: id,
      buyerId,
      orderName: orderName.trim(),
      season: season || null,
      createdBy: req.user.id,
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

export default router
