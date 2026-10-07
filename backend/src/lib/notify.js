// Cross-user notifications are created here, on the server, at the moment the thing they
// describe is saved. The browser used to create them, which failed with a 403 for every
// non-admin (so buyers never heard about manufacturer updates) and was rate limited for
// admins. Notifying is best-effort: it never fails or delays the action that triggered it.
import { Notification, User } from '../db/index.js'

const idOf = v => (v == null ? null : String(v._id ?? v))

/** Create one notification per recipient, skipping duplicates and the person who acted. */
export async function notify(recipients, { type = 'status', msg, orderId = null }, { exceptUserId = null } = {}) {
  try {
    if (!msg) return
    const skip = exceptUserId ? String(exceptUserId) : null
    const ids = [...new Set((recipients || []).map(idOf).filter(Boolean))].filter(id => id !== skip)
    if (ids.length === 0) return
    await Notification.insertMany(ids.map(toUser => ({
      toUser, type, msg: String(msg).slice(0, 500), orderId, isRead: false,
    })))
  } catch (err) {
    console.error('[notify]', err)
  }
}

/** Ids of every active admin; empty on failure so callers can carry on. */
export async function adminIds() {
  try {
    return (await User.find({ role: 'admin', isActive: true }, '_id').lean()).map(u => u._id)
  } catch (err) {
    console.error('[notify]', err)
    return []
  }
}

/**
 * Tell an order's buyer about something, and (when a manufacturer is the one acting)
 * every admin too, so progress is visible without opening each order. The actor is never
 * notified about their own action.
 */
export async function notifyOrderChange(order, actor, { type = 'status', msg, orderId }) {
  const recipients = [order?.buyerId]
  if (actor?.role === 'manufacturer') recipients.push(...await adminIds())
  await notify(recipients, { type, msg, orderId }, { exceptUserId: actor?.id })
}
