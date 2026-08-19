import { Router } from 'express'
import mongoose from 'mongoose'
import { InventoryMovement, User } from '../db/index.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()

// GET /api/inventory — on-hand stock, computed as sum(in) - sum(out) grouped
// by mfrId + materialName + unit. This is the read side of the Finance-module
// data seam (InventoryMovement) — no valuation, just quantity on hand.
//
// Manufacturer: their own movements, BOTH scopeTypes (tradio_order AND
// mfr_project) — a manufacturer's own stock ledger has to span all their
// work to be useful to them, per the model's own design comment.
// Admin/master: every manufacturer's on-hand stock, but tradio_order rows
// ONLY — mfr_project movements are a manufacturer's private business and
// stay invisible to Tradio, same privacy boundary as everywhere else this
// feature touches mfr_project data. No admin override, full stop.
// Buyer: no legitimate reason to see procurement internals — 403.
router.get('/inventory', requireAuth, async (req, res) => {
  try {
    if (req.user.role === 'buyer') return res.status(403).json({ error: 'Forbidden' })

    // req.user.id is a string (JWT payload); cast to a real ObjectId for an
    // exact match against the ref field rather than relying on implicit
    // string coercion working for every driver version.
    const match = req.user.role === 'manufacturer'
      ? { mfrId: new mongoose.Types.ObjectId(req.user.id) }
      : { scopeType: 'tradio_order' }

    const rows = await InventoryMovement.aggregate([
      { $match: match },
      {
        $group: {
          _id: { mfrId: '$mfrId', materialName: '$materialName', unit: '$unit' },
          onHand: { $sum: { $cond: [{ $eq: ['$direction', 'in'] }, '$qty', { $multiply: ['$qty', -1] }] } },
          lastMovementAt: { $max: '$occurredAt' },
        },
      },
      { $sort: { '_id.materialName': 1 } },
    ])

    let mfrNames = {}
    if (req.user.role === 'admin') {
      const mfrIds = [...new Set(rows.map(r => r._id.mfrId.toString()))]
      const users = await User.find({ _id: { $in: mfrIds } }, 'company name').lean()
      mfrNames = Object.fromEntries(users.map(u => [u._id.toString(), u.company || u.name || u._id.toString()]))
    }

    res.json(rows.map(r => ({
      mfrId: r._id.mfrId.toString(),
      mfrCompany: mfrNames[r._id.mfrId.toString()] || null,
      materialName: r._id.materialName,
      unit: r._id.unit || '',
      onHand: r.onHand,
      lastMovementAt: r.lastMovementAt,
    })))
  } catch (err) {
    console.error('[inventory]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

export default router
