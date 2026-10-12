// Who is creating an order, and what that allows.
//
// Tradio portal: only Tradio staff create orders, and the body is used as sent.
//
// Standalone product, by role:
//   brand         creates for itself, and may assign only manufacturers it is connected with.
//   manufacturer  creates for a brand it is connected with, always assigned to itself alone. It
//                 reports on and runs its own split, so an order it created without itself on it
//                 would be invisible to it.
//   Tradio staff  create only when every manufacturer on the order is one Tradio may act for.
//
// A brand or manufacturer never chooses the order's ID (the server numbers it, see counters.js), and
// nobody can set who created it: createdBy and createdByRole come from the session.
import mongoose from 'mongoose'
import { isStandalone } from './platform.js'
import { staffMayActForMfrs, NOT_ENABLED } from './authz.js'
import { unpartneredMfrs, ensurePartnership } from './orgs.js'

const fail = (status, error, code) => ({ ok: false, status, error, ...(code ? { code } : {}) })
const idStr = v => String(v?._id ?? v)

/** The brand and manufacturers (party ids) on an order. */
export const partiesOf = order => ({
  buyerId: idStr(order.buyerId),
  mfrIds: (order.assignments || []).map(a => idStr(a.mfrId)),
})

/**
 * @returns {Promise<{ok: true, input: object, link: boolean} | {ok: false, status: number, error: string, code?: string}>}
 *   `input` is what validateAndCreateOrder receives; `link` asks afterCreate to record the
 *   partnership (Tradio put the two together).
 */
export async function applyCreationRules(user, body) {
  const raw = body && typeof body === 'object' ? body : {}
  // Provenance and internal switches are the server's to set, never the client's.
  // eslint-disable-next-line no-unused-vars
  const { createdBy, createdByRole, allowedResponsibleIds, deferPlan, ...b } = raw
  const asgns = Array.isArray(b.assignments) ? b.assignments : []
  const mids = asgns.map(a => a?.mid).filter(Boolean)
  if (mids.some(m => !mongoose.Types.ObjectId.isValid(m))) return fail(400, 'Invalid manufacturer ID')

  if (user.role === 'admin') {
    if (isStandalone() && !(await staffMayActForMfrs(mids)))
      return fail(403, `${NOT_ENABLED.error}. Assign a Tradio-enabled manufacturer`, NOT_ENABLED.code)
    return { ok: true, input: { ...b, createdBy: user.id, createdByRole: 'admin' }, link: true }
  }

  // Brands and manufacturers only get this far in standalone mode (canCreateOrders).
  const planGiven = Array.isArray(b.stageNames) && b.stageNames.length > 0

  if (user.role === 'buyer') {
    if (b.buyerId && String(b.buyerId) !== String(user.id)) return fail(403, 'You can only create orders for your own company')
    if (mids.length && (await unpartneredMfrs(user.id, mids)).length)
      return fail(403, 'You can only assign manufacturers you are connected with', 'NOT_CONNECTED')
    return {
      ok: true, link: false,
      input: {
        ...b, id: 'auto', buyerId: String(user.id), createdBy: user.id, createdByRole: 'buyer',
        allowedResponsibleIds: new Set([String(user.id), ...mids.map(String)]),
        deferPlan: !planGiven,
      },
    }
  }

  if (user.role === 'manufacturer') {
    if (!b.buyerId) return fail(400, 'Choose the customer this order is for')
    if (!mongoose.Types.ObjectId.isValid(b.buyerId)) return fail(400, 'Invalid buyer ID')
    if ((await unpartneredMfrs(b.buyerId, [user.id])).length)
      return fail(403, 'You are not connected with that customer', 'NOT_CONNECTED')
    if (asgns.length > 1 || mids.some(m => String(m) !== String(user.id)))
      return fail(400, 'A manufacturer creates orders for itself; it cannot assign other manufacturers')
    return {
      ok: true, link: false,
      input: {
        ...b, id: 'auto', assignments: [{ mid: String(user.id), qty: b.totalQty }],
        createdBy: user.id, createdByRole: 'manufacturer',
        allowedResponsibleIds: new Set([String(b.buyerId), String(user.id)]),
        deferPlan: !planGiven,
      },
    }
  }

  return fail(403, 'Admin only')
}

/** After an order is created: Tradio putting a brand and a manufacturer together makes them partners. */
export async function afterCreate(user, order, { link }) {
  if (!link) return
  try {
    const { buyerId, mfrIds } = partiesOf(order)
    for (const m of mfrIds) await ensurePartnership(buyerId, m, { source: 'order', createdBy: user.actorId || user.id })
  } catch (err) {
    console.error('[orders] could not record the partnership', err)   // the order is already created
  }
}
