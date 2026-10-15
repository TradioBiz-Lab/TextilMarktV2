import { Router } from 'express'
import mongoose from 'mongoose'
import { Order } from '../models/Order.js'
import { User } from '../models/User.js'
import { AuditLog } from '../models/AuditLog.js'
import { PlanTemplate } from '../models/PlanTemplate.js'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import { planSteps, templateStepsFrom } from '../lib/planCopy.js'

// A customer's saved production plan (models/PlanTemplate.js). Tradio saves it from a style's plan and starts new
// plans from it (POST /api/orders/:id/assignments/:mfrId/stages/start-plan with from: 'template').
const router = Router()

const out = t => (t ? {
  exists: true, stepCount: t.steps.length, sourceOrderId: t.sourceOrderId, updatedAt: t.updatedAt, savedByName: t.savedByName || '',
  steps: t.steps.map(s => ({ name: s.name, kind: s.kind, startOffset: s.startOffset, endOffset: s.endOffset, owner: s.owner, description: s.description })),
} : { exists: false, stepCount: 0, steps: [] })

// GET /api/plan-templates/:buyerId - the customer's template, or { exists: false }.
router.get('/:buyerId', requireAuth, requireAdmin, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.buyerId)) return res.status(400).json({ error: 'Invalid customer ID' })
    res.json(out(await PlanTemplate.findOne({ buyerId: req.params.buyerId }).lean()))
  } catch (err) {
    console.error('[plan-templates]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/plan-templates/:buyerId - save one of the customer's style plans as its template (replaces the old one).
// Body { fromOrderId, fromMfrId }.
router.post('/:buyerId', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { buyerId } = req.params
    const { fromOrderId, fromMfrId } = req.body || {}
    if (!mongoose.Types.ObjectId.isValid(buyerId)) return res.status(400).json({ error: 'Invalid customer ID' })
    if (typeof fromOrderId !== 'string' || !mongoose.Types.ObjectId.isValid(String(fromMfrId))) return res.status(400).json({ error: 'Choose the plan to save' })
    const buyer = await User.findById(buyerId, 'role company').lean()
    if (!buyer || buyer.role !== 'buyer') return res.status(404).json({ error: 'Customer not found' })
    const order = await Order.findById(fromOrderId).lean()
    if (!order || String(order.buyerId) !== String(buyerId)) return res.status(400).json({ error: "That style is not this customer's" })
    const asgn = (order.assignments || []).find(a => a.mfrId?.toString() === String(fromMfrId))
    if (!asgn || !planSteps(asgn.stages).length) return res.status(400).json({ error: 'That plan has no steps to save' })

    const steps = await templateStepsFrom(order, asgn)
    const saved = await PlanTemplate.findOneAndUpdate(
      { buyerId },
      { $set: { steps, sourceOrderId: order._id, savedBy: req.user.id, savedByName: req.user.name || '' } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean()
    await AuditLog.create({ byUser: req.user.id, action: 'Plan Template Saved', detail: `${buyer.company}: ${steps.length} steps from ${order._id} by ${req.user.name}` })
    res.json(out(saved))
  } catch (err) {
    console.error('[plan-templates]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

export default router
