import { Router } from 'express'
import mongoose from 'mongoose'
import rateLimit from 'express-rate-limit'
import { Notification, User } from '../db/index.js'
import { requireAuth } from '../middleware/auth.js'

// 60 notifications per user per hour — prevents in-app notification spam
const createNotifLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 60,
  keyGenerator: req => req.user?.id || req.ip,
  message: { error: 'Too many notification requests. Please wait.' },
  standardHeaders: true, legacyHeaders: false, validate: false,
})

const router = Router()

const mapNotif = n => ({
  id: n._id.toString(), to: n.toUser?.toString(), type: n.type, msg: n.msg,
  orderId: n.orderId?.toString() || null, read: n.isRead, at: n.createdAt,
})

// GET /api/notifications
router.get('/', requireAuth, async (req, res) => {
  try {
    const notifs = await Notification.find({ toUser: req.user.id }).sort({ createdAt: -1 }).limit(200).lean()
    res.json(notifs.map(mapNotif))
  } catch (err) {
    console.error('[notifications]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/notifications
router.post('/', requireAuth, createNotifLimiter, async (req, res) => {
  try {
    const { toUser, type, msg, orderId } = req.body
    if (!toUser || !msg) return res.status(400).json({ error: 'toUser and msg are required' })
    if (!mongoose.Types.ObjectId.isValid(toUser)) return res.status(400).json({ error: 'Invalid user ID' })
    if (typeof msg !== 'string' || msg.length > 500) return res.status(400).json({ error: 'Message must be a string under 500 characters' })

    // Only admins can create notifications for other users
    if (req.user.role !== 'admin' && String(toUser) !== String(req.user.id)) {
      return res.status(403).json({ error: 'You can only create notifications for yourself' })
    }

    const targetUser = await User.findById(toUser, '_id').lean()
    if (!targetUser) return res.status(400).json({ error: 'Target user not found' })

    const notif = await Notification.create({
      toUser, type: type || 'status', msg, orderId: orderId || null, isRead: false,
    })
    res.status(201).json(mapNotif(notif.toObject()))
  } catch (err) {
    console.error('[notifications]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// PATCH /api/notifications/:id/read — mark a single notification as read
router.patch('/:id/read', requireAuth, async (req, res) => {
  try {
    const notif = await Notification.findOneAndUpdate(
      { _id: req.params.id, toUser: req.user.id },
      { $set: { isRead: true } },
      { new: true }
    )
    if (!notif) return res.status(404).json({ error: 'Notification not found' })
    res.json(mapNotif(notif.toObject()))
  } catch (err) {
    console.error('[notifications]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// PATCH /api/notifications/mark-all-read
router.patch('/mark-all-read', requireAuth, async (req, res) => {
  try {
    await Notification.updateMany({ toUser: req.user.id, isRead: false }, { $set: { isRead: true } })
    res.json({ ok: true })
  } catch (err) {
    console.error('[notifications]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

export default router
