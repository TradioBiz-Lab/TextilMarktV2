// Links in emails and messages open a screen: "#order=ZAR-TSHRT-FW26-001", "#view=orders". The app
// has no URL router (navigation is state, see App.jsx), so after sign-in it reads the hash once and
// opens the matching screen. The hash is whatever the link said, so nothing in it is trusted: only
// listed screens, and order ids of the shape the server uses, are accepted. The server still decides
// whether the signed-in user may see the order.
const ORDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const PO_ID = /^PO-[A-Z0-9]{1,5}-\d{4}-\d{4,}$/
// Screens a link may name. Later modules add theirs here (cost sheets, inspections). A screen the signed-in
// user does not have (purchasing, for a brand) simply is not found: the app shows its "page not found".
const LINKABLE_VIEWS = new Set(['dashboard', 'orders', 'documents', 'reports', 'action_items', 'kriyaa', 'company', 'suppliers', 'purchase_orders'])

/** @returns {{view: 'order_detail', orderId: string} | {view: 'po_detail', poId: string} | {view: string} | null} */
export function parseDeepLink(hash) {
  const raw = String(hash || '').replace(/^#/, '').trim()
  if (!raw || raw.length > 300) return null
  let params
  try { params = new URLSearchParams(raw) } catch { return null }
  const order = params.get('order')
  if (order) return ORDER_ID.test(order) ? { view: 'order_detail', orderId: order } : null
  const po = params.get('po')
  if (po) return PO_ID.test(po) ? { view: 'po_detail', poId: po } : null
  const view = params.get('view')
  return view && LINKABLE_VIEWS.has(view) ? { view } : null
}
