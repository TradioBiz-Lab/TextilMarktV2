import { Order, User } from '../db/index.js'

// Shared scoping rule for both WikiPage and Document's wiki_* subset — company-wide
// items are visible to any authenticated user, buyer-scoped items to that buyer, admins,
// and any manufacturer currently assigned to at least one of that buyer's orders.
export function canAccessWikiScope(user, { wikiScope, buyerId }, assignedBuyerIds = []) {
  if (user.role === 'admin') return true
  if (wikiScope === 'company') return true
  if (wikiScope === 'buyer') {
    if (user.role === 'buyer') return !!buyerId && String(buyerId) === String(user.id)
    if (user.role === 'manufacturer') return !!buyerId && assignedBuyerIds.includes(String(buyerId))
  }
  return false
}

// Buyer ids of every buyer this manufacturer currently has at least one order-assignment
// with — used to resolve the manufacturer branch of canAccessWikiScope for list queries.
export async function resolveAssignedBuyerIds(mfrUserId) {
  const orders = await Order.find({ 'assignments.mfrId': mfrUserId }, { buyerId: 1 }).lean()
  return [...new Set(orders.map(o => o.buyerId?.toString()).filter(Boolean))]
}

// Write-side validation shared by WikiPage's create/edit routes and Document's
// assertDocAccess: wikiScope must be 'company'|'buyer', 'buyer' requires a buyerId
// that resolves to a real buyer user, 'company' forbids buyerId. Throws { status } on failure.
export async function validateWikiScopeShape(wikiScope, buyerId) {
  if (!['company', 'buyer'].includes(wikiScope))
    throw Object.assign(new Error('wikiScope must be "company" or "buyer"'), { status: 400 })
  if (wikiScope === 'buyer') {
    if (!buyerId) throw Object.assign(new Error('wikiScope "buyer" requires buyerId'), { status: 400 })
    const buyerUser = await User.findById(buyerId, { role: 1 }).lean()
    if (!buyerUser || buyerUser.role !== 'buyer')
      throw Object.assign(new Error('buyerId must reference a valid buyer'), { status: 400 })
  } else if (buyerId) {
    throw Object.assign(new Error('wikiScope "company" must not include buyerId'), { status: 400 })
  }
}
