import { Router } from 'express'
import { ActionItem } from '../models/ActionItem.js'
import { User } from '../models/User.js'
import { AuditLog } from '../models/AuditLog.js'
import { requireAuth, requireAdmin, requireMaster } from '../middleware/auth.js'

const router = Router()

const USER_FIELDS = 'name company code'
const VALID_PRIORITIES = ['high', 'medium', 'low']
const VALID_STATUSES = ['open', 'done']

const enrichActionItem = a => ({
  id: a._id,
  title: a.title,
  detail: a.detail,
  assigneeId: a.assigneeId?._id?.toString() ?? a.assigneeId?.toString(),
  assigneeName: a.assigneeId?.name ?? null,
  createdBy: a.createdBy?._id?.toString() ?? a.createdBy?.toString(),
  createdByName: a.createdBy?.name ?? null,
  buyerId: a.buyerId?._id?.toString() ?? a.buyerId?.toString() ?? null,
  buyerCompany: a.buyerId?.company ?? null,
  orderId: a.orderId,
  stageName: a.stageName,
  source: a.source,
  priority: a.priority,
  eta: a.eta,
  status: a.status,
  updates: (a.updates || []).map(u => ({
    text: u.text,
    byUser: u.byUser?._id?.toString() ?? u.byUser?.toString(),
    byUserName: u.byUser?.name ?? null,
    at: u.at,
  })),
  closedAt: a.closedAt,
  createdAt: a.createdAt,
  updatedAt: a.updatedAt,
})

const POPULATE = [
  { path: 'assigneeId', select: USER_FIELDS },
  { path: 'createdBy', select: USER_FIELDS },
  { path: 'buyerId', select: USER_FIELDS },
  { path: 'updates.byUser', select: USER_FIELDS },
]

// GET /api/action-items — all items (admin scope; frontend filters "mine")
router.get('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const items = await ActionItem.find().populate(POPULATE).lean()
    // Sort: open before done, then eta asc (nulls last), then priority high->low
    const priorityRank = { high: 0, medium: 1, low: 2 }
    items.sort((a, b) => {
      if ((a.status === 'done') !== (b.status === 'done')) return a.status === 'done' ? 1 : -1
      const aEta = a.eta ? new Date(a.eta).getTime() : Infinity
      const bEta = b.eta ? new Date(b.eta).getTime() : Infinity
      if (aEta !== bEta) return aEta - bEta
      return priorityRank[a.priority] - priorityRank[b.priority]
    })
    res.json(items.map(enrichActionItem))
  } catch (err) {
    console.error('[action-items]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/action-items — create
router.post('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { title, detail, assigneeId, buyerId, orderId, stageName, source, priority, eta } = req.body

    if (!title?.trim()) return res.status(400).json({ error: 'Title is required' })
    if (title.trim().length > 200) return res.status(400).json({ error: 'Title too long (max 200 chars)' })
    if (!assigneeId) return res.status(400).json({ error: 'Assignee is required' })
    if (priority && !VALID_PRIORITIES.includes(priority))
      return res.status(400).json({ error: 'Invalid priority' })

    const assignee = await User.findById(assigneeId, 'role isActive').lean()
    if (!assignee || assignee.role !== 'admin') return res.status(400).json({ error: 'Assignee must be an admin' })
    if (!assignee.isActive) return res.status(400).json({ error: 'Assignee account is inactive' })

    if (buyerId) {
      const buyer = await User.findById(buyerId, 'role').lean()
      if (!buyer || buyer.role !== 'buyer') return res.status(400).json({ error: 'Invalid customer' })
    }

    if (eta && isNaN(new Date(eta).getTime())) return res.status(400).json({ error: 'Invalid ETA date' })

    const created = await ActionItem.create({
      title: title.trim(),
      detail: detail || '',
      assigneeId,
      createdBy: req.user.id,
      buyerId: buyerId || null,
      orderId: orderId || null,
      stageName: stageName || null,
      source: source === 'tna' ? 'tna' : 'custom',
      priority: priority || 'medium',
      eta: eta || null,
    })

    const populated = await ActionItem.findById(created._id).populate(POPULATE).lean()

    await AuditLog.create({
      byUser: req.user.id,
      action: 'Action Item Created',
      detail: `"${title.trim()}" assigned to ${assignee.name || assigneeId}`,
    })

    res.status(201).json(enrichActionItem(populated))
  } catch (err) {
    console.error('[action-items]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/action-items/:id — update fields
router.post('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { title, detail, assigneeId, buyerId, priority, eta, status } = req.body
    const update = {}

    if (title !== undefined) {
      if (!title.trim()) return res.status(400).json({ error: 'Title is required' })
      if (title.trim().length > 200) return res.status(400).json({ error: 'Title too long (max 200 chars)' })
      update.title = title.trim()
    }
    if (detail !== undefined) update.detail = detail
    if (assigneeId !== undefined) {
      const assignee = await User.findById(assigneeId, 'role isActive').lean()
      if (!assignee || assignee.role !== 'admin') return res.status(400).json({ error: 'Assignee must be an admin' })
      if (!assignee.isActive) return res.status(400).json({ error: 'Assignee account is inactive' })
      update.assigneeId = assigneeId
    }
    if (buyerId !== undefined) {
      if (buyerId) {
        const buyer = await User.findById(buyerId, 'role').lean()
        if (!buyer || buyer.role !== 'buyer') return res.status(400).json({ error: 'Invalid customer' })
      }
      update.buyerId = buyerId || null
    }
    if (priority !== undefined) {
      if (!VALID_PRIORITIES.includes(priority)) return res.status(400).json({ error: 'Invalid priority' })
      update.priority = priority
    }
    if (eta !== undefined) {
      if (eta && isNaN(new Date(eta).getTime())) return res.status(400).json({ error: 'Invalid ETA date' })
      update.eta = eta || null
    }
    if (status !== undefined) {
      if (!VALID_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' })
      update.status = status
      update.closedAt = status === 'done' ? new Date() : null
    }

    if (Object.keys(update).length === 0) return res.status(400).json({ error: 'No fields to update' })

    const item = await ActionItem.findByIdAndUpdate(req.params.id, { $set: update }, { new: true })
      .populate(POPULATE).lean()
    if (!item) return res.status(404).json({ error: 'Action item not found' })

    await AuditLog.create({
      byUser: req.user.id,
      action: status === 'done' ? 'Action Item Closed' : status === 'open' ? 'Action Item Reopened' : 'Action Item Updated',
      detail: `"${item.title}"`,
    })

    res.json(enrichActionItem(item))
  } catch (err) {
    console.error('[action-items]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/action-items/:id/updates — append a timestamped progress note
router.post('/:id/updates', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { text } = req.body
    if (!text?.trim()) return res.status(400).json({ error: 'Update text is required' })
    if (text.trim().length > 1000) return res.status(400).json({ error: 'Update too long (max 1000 chars)' })

    const item = await ActionItem.findByIdAndUpdate(
      req.params.id,
      { $push: { updates: { text: text.trim(), byUser: req.user.id, at: new Date() } } },
      { new: true }
    ).populate(POPULATE).lean()
    if (!item) return res.status(404).json({ error: 'Action item not found' })

    await AuditLog.create({
      byUser: req.user.id,
      action: 'Action Item Update Added',
      detail: `"${item.title}": ${text.trim().slice(0, 100)}`,
    })

    res.json(enrichActionItem(item))
  } catch (err) {
    console.error('[action-items]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/action-items/:id/delete
router.post('/:id/delete', requireAuth, requireMaster, async (req, res) => {
  try {
    const item = await ActionItem.findByIdAndDelete(req.params.id).lean()
    if (!item) return res.status(404).json({ error: 'Action item not found' })

    await AuditLog.create({
      byUser: req.user.id,
      action: 'Action Item Deleted',
      detail: `Deleted "${item.title}"`,
    })

    res.json({ ok: true })
  } catch (err) {
    console.error('[action-items]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

export default router
