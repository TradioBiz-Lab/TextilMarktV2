// Who may change what, in one place.
//
// Tradio portal (PLATFORM_MODE unset): Tradio staff coordinate everything, exactly as before, and
// nothing in this file restricts them.
//
// Standalone product: the brand and the manufacturer transact with each other directly. Tradio
// staff are viewers who can act only for manufacturers Tradio has enabled, and a company that has
// switched Tradio's view access off is invisible to staff entirely. The server is the only gate;
// the frontend's capability map mirrors these rules for display.
import { Order, MasterOrder, Organization, Partnership } from '../db/index.js'
import { isStandalone } from './platform.js'
import { ensureOrgsByPartyIds, privatePartyIds } from './orgs.js'

const idOf = v => String(v?._id ?? v)

export const NOT_ENABLED = {
  error: 'Tradio can only make changes for Tradio-enabled manufacturers',
  code: 'NOT_TRADIO_ENABLED',
}

/**
 * May Tradio staff make changes on behalf of these manufacturers (party ids)? Every one must be an
 * active organization with Tradio enabled and Tradio's view access left on. An empty list is never
 * allowed: with no manufacturer involved there is nobody Tradio could be acting for.
 */
export async function staffMayActForMfrs(mfrPartyIds) {
  const ids = [...new Set((mfrPartyIds || []).map(idOf))]
  if (ids.length === 0) return false
  const orgs = await ensureOrgsByPartyIds(ids)
  return ids.every(id => {
    const o = orgs.get(id)
    return !!o && o.isActive !== false && o.tradioEnabled === true && o.tradioCanView !== false
  })
}

const mfrIdsOf = order => (order?.assignments || []).map(a => a.mfrId)

/**
 * Add to every order route that writes. In the standalone product it stops a Tradio admin session
 * (not a view-as session, which is a company's own session) from touching an order unless every
 * manufacturer on it is one Tradio may act for. Everyone else passes straight through: their own
 * checks live in the routes. In the Tradio portal it does nothing.
 */
export async function orderWriteGuard(req, res, next) {
  try {
    if (!isStandalone() || req.user?.role !== 'admin') return next()
    const order = await Order.findById(req.params.orderId ?? req.params.id, 'assignments.mfrId').lean()
    if (!order) return next()   // the route answers 404
    if (await staffMayActForMfrs(mfrIdsOf(order))) return next()
    return res.status(403).json(NOT_ENABLED)
  } catch (err) { next(err) }
}

/**
 * Editing or deleting an order. Tradio portal: admin only, as always. Standalone: the company that
 * created the order (a brand or a manufacturer), or Tradio staff for manufacturers they may act
 * for. A company that merely appears on an order, including its own buyer when a manufacturer
 * created it, cannot reshape it: they work it through their own side (progress, approvals, plan).
 */
export async function requireOrderOwner(req, res, next) {
  try {
    if (req.user?.role === 'admin') return orderWriteGuard(req, res, next)
    if (!isStandalone()) return res.status(403).json({ error: 'Admin only' })
    const order = await Order.findById(req.params.orderId ?? req.params.id, 'createdBy createdByRole').lean()
    if (!order) return next()   // the route answers 404
    if (order.createdBy && order.createdByRole === req.user.role && idOf(order.createdBy) === String(req.user.id)) return next()
    return res.status(403).json({ error: 'Only the company that created this order can change it', code: 'NOT_ORDER_OWNER' })
  } catch (err) { next(err) }
}

/**
 * Editing a manufacturer split's plan: its dates, its steps, its owners. Tradio portal: admin only.
 * Standalone: the split's own manufacturer (it owns its schedule; with no coordinator in the middle,
 * nobody else could report a delay), or Tradio staff for manufacturers they may act for. A brand
 * proposes the plan when it creates the order and approves the steps assigned to it; it does not
 * run the factory's calendar.
 */
export async function requirePlanEditor(req, res, next) {
  try {
    if (req.user?.role === 'admin') return orderWriteGuard(req, res, next)
    if (isStandalone() && req.user?.role === 'manufacturer' && String(req.user.id) === String(req.params.mfrId)) return next()
    return res.status(403).json({ error: 'Admin only' })
  } catch (err) { next(err) }
}

/**
 * May Tradio staff manage master orders for this brand? A master order involves only the brand until
 * orders sit under it, so staff may act only when the brand has an active partnership with at least
 * one manufacturer Tradio may act for (a Tradio-managed account).
 */
export async function adminMayManageBuyer(buyerPartyId) {
  const orgs = await ensureOrgsByPartyIds([buyerPartyId])
  const brand = orgs.get(String(buyerPartyId))
  if (!brand) return false
  const links = await Partnership.find({ brandOrgId: brand._id, status: 'active' }, 'mfrOrgId').lean()
  if (links.length === 0) return false
  return !!(await Organization.exists({
    _id: { $in: links.map(l => l.mfrOrgId) }, isActive: true, tradioEnabled: true, tradioCanView: { $ne: false },
  }))
}

/** May Tradio staff change this master order? With orders under it, only if they may act for every manufacturer on them. */
export async function adminMayManageMasterOrder(mo) {
  const children = await Order.find({ masterOrderId: mo._id }, 'assignments.mfrId').lean()
  if (children.length) return staffMayActForMfrs(children.flatMap(mfrIdsOf))
  return adminMayManageBuyer(mo.buyerId)
}

/**
 * Editing or deleting a master order. Tradio portal: admin only. Standalone: the company that
 * created it, or Tradio staff where adminMayManageMasterOrder allows.
 */
export async function requireMasterOrderOwner(req, res, next) {
  try {
    if (!isStandalone()) return req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin only' })
    const mo = await MasterOrder.findById(req.params.id, 'buyerId createdBy createdByRole').lean()
    if (!mo) return next()   // the route answers 404
    if (req.user.role === 'admin') return (await adminMayManageMasterOrder(mo)) ? next() : res.status(403).json(NOT_ENABLED)
    if (mo.createdBy && mo.createdByRole === req.user.role && idOf(mo.createdBy) === String(req.user.id)) return next()
    return res.status(403).json({ error: 'Only the company that created this master order can change it', code: 'NOT_ORDER_OWNER' })
  } catch (err) { next(err) }
}

/**
 * Adding a manufacturer to an order. Tradio portal: admin only. Standalone: the brand that created
 * the order (it picks whom to assign among its connections; the route checks that), or Tradio
 * staff (the route checks the manufacturer being added, which this cannot know yet).
 */
export async function requireAssigner(req, res, next) {
  try {
    if (req.user?.role === 'admin') return next()
    if (!isStandalone() || req.user?.role !== 'buyer') return res.status(403).json({ error: 'Admin only' })
    const order = await Order.findById(req.params.orderId, 'createdBy createdByRole').lean()
    if (!order) return next()   // the route answers 404
    if (order.createdByRole === 'buyer' && idOf(order.createdBy) === String(req.user.id)) return next()
    return res.status(403).json({ error: 'Only the company that created this order can assign manufacturers to it', code: 'NOT_ORDER_OWNER' })
  } catch (err) { next(err) }
}

/** True when this caller may write plan fields on the split owned by `mfrId` (for in-route checks). */
export const mayEditPlanFor = (user, mfrId) =>
  user?.role === 'admin' || (isStandalone() && user?.role === 'manufacturer' && String(user.id) === String(mfrId))

/**
 * May this caller add, change or remove the material lines and checklist items on a step of the split
 * owned by `mfrId`? Admins (orderWriteGuard has already vetted them), the step's named owner, and, in
 * the standalone product, the split's own manufacturer on any of its steps: with no coordinator in the
 * middle, nobody else could keep the step's purchasing and checklist current. Buyers never (the routes
 * also deny them explicitly).
 */
export const mayRunStep = (user, mfrId, stage) => {
  if (!user || user.role === 'buyer') return false
  if (user.role === 'admin') return true
  if (stage?.responsibleId && idOf(stage.responsibleId) === String(user.id)) return true
  return mayEditPlanFor(user, mfrId)
}

/**
 * Who may create orders at all. Tradio portal: admin only. Standalone: also brands and
 * manufacturers; the route then applies the rules for the caller's role (lib/orderCreate.js).
 */
export function canCreateOrders(req, res, next) {
  const role = req.user?.role
  if (role === 'admin' || (isStandalone() && (role === 'buyer' || role === 'manufacturer'))) return next()
  return res.status(403).json({ error: 'Admin only' })
}

/**
 * Mongo filter that keeps Tradio staff out of companies that switched Tradio's view access off.
 * Empty in the Tradio portal and when nobody has. Apply to every query an admin session uses to
 * list or read orders: a list returns only the orders Tradio may see, and an order involving a
 * private company on either side (brand or any manufacturer) is hidden whole.
 */
export async function adminOrderVisibility() {
  if (!isStandalone()) return {}
  const priv = await privatePartyIds()
  if (priv.length === 0) return {}
  return { buyerId: { $nin: priv }, 'assignments.mfrId': { $nin: priv } }
}

/** Ids of orders and master orders Tradio staff may not see (those involving a private company). */
export async function privateScopeIds() {
  if (!isStandalone()) return { priv: [], orderIds: [], masterOrderIds: [] }
  const priv = await privatePartyIds()
  if (priv.length === 0) return { priv: [], orderIds: [], masterOrderIds: [] }
  const orderIds = await Order.distinct('_id', { $or: [{ buyerId: { $in: priv } }, { 'assignments.mfrId': { $in: priv } }] })
  const masterOrderIds = [...new Set([
    ...(await MasterOrder.distinct('_id', { buyerId: { $in: priv } })),
    ...(await Order.distinct('masterOrderId', { _id: { $in: orderIds }, masterOrderId: { $ne: null } })),
  ])]
  return { priv, orderIds, masterOrderIds }
}

/** Party ids of every manufacturer Tradio staff may act for (active, enabled, view access on). */
export async function enabledMfrPartyIds() {
  const orgs = await Organization.find({ type: 'manufacturer', isActive: true, tradioEnabled: true, tradioCanView: { $ne: false } }, 'ownerUserId').lean()
  return orgs.map(o => String(o.ownerUserId))
}

/**
 * May Tradio staff change this document? The manufacturers it involves (its own, plus those on its
 * order) must all be ones Tradio may act for; a document on a master order follows that master order.
 * A document tied to nothing at all is not Tradio's to change in the standalone product.
 */
export async function adminMayWriteDoc(doc) {
  if (!isStandalone()) return true
  const mfrs = []
  if (doc.mfrId) mfrs.push(doc.mfrId)
  if (doc.orderId) mfrs.push(...mfrIdsOf(await Order.findById(doc.orderId, 'assignments.mfrId').lean()))
  if (mfrs.length) return staffMayActForMfrs(mfrs)
  if (doc.masterOrderId) {
    const mo = await MasterOrder.findById(doc.masterOrderId, 'buyerId').lean()
    return mo ? adminMayManageMasterOrder(mo) : false
  }
  return false
}

/** May this admin session read this document (a company that switched Tradio's view access off is hidden)? */
export async function adminMayViewDoc(doc) {
  if (!isStandalone()) return true
  const priv = new Set(await privatePartyIds())
  if (priv.size === 0) return true
  if (doc.mfrId && priv.has(idOf(doc.mfrId))) return false
  if (doc.uploadedBy && priv.has(idOf(doc.uploadedBy))) return false
  if (doc.orderId) {
    const o = await Order.findById(doc.orderId, 'buyerId assignments.mfrId').lean()
    if (o && !(await adminMayViewOrder(o))) return false
  }
  if (doc.masterOrderId) {
    const mo = await MasterOrder.findById(doc.masterOrderId, 'buyerId').lean()
    if (mo && priv.has(idOf(mo.buyerId))) return false
  }
  return true
}

/** Mongo filter for document queries an admin session runs: hides everything tied to a private company. */
export async function adminDocVisibility() {
  const { priv, orderIds, masterOrderIds } = await privateScopeIds()
  if (priv.length === 0) return {}
  return { mfrId: { $nin: priv }, uploadedBy: { $nin: priv }, orderId: { $nin: orderIds }, masterOrderId: { $nin: masterOrderIds } }
}

/** Can this admin session read this order at all (privacy opt-out)? */
export async function adminMayViewOrder(order) {
  if (!isStandalone()) return true
  const priv = new Set(await privatePartyIds())
  if (priv.size === 0) return true
  return !priv.has(idOf(order.buyerId)) && !mfrIdsOf(order).some(m => priv.has(idOf(m)))
}
