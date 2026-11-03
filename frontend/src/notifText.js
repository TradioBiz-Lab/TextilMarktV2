// A notification as a person reads it: Tradio's internal style IDs (BUY-DRESS-SS26-006) become the style's name and the
// customer's own style number ("Midi Dress, 4002"), and master order IDs become the master order's name. Pure, so it is tested
// on its own; only orders and master orders the viewer already has are named (the rest stay as they were).
const ID = /\b[A-Z0-9]+(?:-[A-Z0-9]+){2,}\b/g

/** "Midi Dress, 4002": the product and the last digits of the customer's style number (or all of it when it has none). */
export function styleLabel(o) {
  const sn = String(o.styleNumber || '').trim()
  const tail = sn.match(/(\d+)\D*$/)?.[1]
  return sn ? `${o.product}, ${tail || sn}` : o.product
}

export function notifText(msg, orders = [], masterOrders = []) {
  const styles = new Map((orders || []).map(o => [o.id, styleLabel(o)]))
  const mos = new Map((masterOrders || []).map(m => [m.id, m.orderName]))
  return String(msg ?? '').replace(ID, id => styles.get(id) || mos.get(id) || id)
}
