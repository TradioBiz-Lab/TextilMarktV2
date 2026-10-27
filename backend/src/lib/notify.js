// Cross-user notifications are created here, on the server, at the moment the thing they
// describe is saved. The browser used to create them, which failed with a 403 for every
// non-admin (so buyers never heard about manufacturer updates) and was rate limited for
// admins. Notifying is best-effort: it never fails or delays the action that triggered it.
import { Notification, User } from '../db/index.js'
import { isStandalone } from './platform.js'

const idOf = v => (v == null ? null : String(v._id ?? v))

/** Create one notification per recipient, skipping duplicates and the person who acted. */
export async function notify(recipients, { type = 'status', msg, orderId = null, link = null }, { exceptUserId = null } = {}) {
  try {
    if (!msg) return
    const skip = exceptUserId ? String(exceptUserId) : null
    const ids = [...new Set((recipients || []).map(idOf).filter(Boolean))].filter(id => id !== skip)
    if (ids.length === 0) return
    await Notification.insertMany(ids.map(toUser => ({
      toUser, type, msg: String(msg).slice(0, 500), orderId, link, isRead: false,
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
 * Tell the right people about a change to an order. The actor is never notified about their own action.
 *
 * Tradio portal: the buyer, and every admin too when a manufacturer is the one acting, so progress is
 * visible without opening each order.
 *
 * Standalone: the brand and the manufacturers on the order tell each other (a brand's change goes to
 * the order's manufacturers, a manufacturer's to the brand; never to another manufacturer on the same
 * order, who may be a competitor). Tradio staff hear only about manufacturers they may act for.
 */
export async function notifyOrderChange(order, actor, { type = 'status', msg, orderId }) {
  const recipients = []
  if (!isStandalone()) {
    recipients.push(order?.buyerId)
    if (actor?.role === 'manufacturer') recipients.push(...await adminIds())
  } else {
    if (actor?.role !== 'buyer') recipients.push(order?.buyerId)
    if (actor?.role === 'buyer' || actor?.role === 'admin') recipients.push(...(order?.assignments || []).map(a => a.mfrId))
    if (actor?.role === 'manufacturer' && actor.tradioEnabled && actor.tradioCanView !== false) recipients.push(...await adminIds())
  }
  await notify(recipients, { type, msg, orderId }, { exceptUserId: actor?.id })
}

/** Ids of every active master admin (Tradio's decision makers); empty on failure. */
export async function masterAdminIds() {
  try {
    return (await User.find({ role: 'admin', adminType: 'master', isActive: true }, '_id').lean()).map(u => u._id)
  } catch (err) {
    console.error('[notify]', err)
    return []
  }
}

/**
 * Tell the people on one split: its factory and every active master admin, never the actor. Used for what a
 * customer or a factory says on a step (a note, an approval), which would otherwise reach nobody. A factory only
 * ever hears about its own split. Tradio portal only: standalone has its own rules in notifyOrderChange.
 */
export async function notifySplit(mfrId, actor, { type = 'status', msg, orderId }) {
  if (isStandalone()) return
  await notify([mfrId, ...await masterAdminIds()], { type, msg, orderId }, { exceptUserId: actor?.id })
}
