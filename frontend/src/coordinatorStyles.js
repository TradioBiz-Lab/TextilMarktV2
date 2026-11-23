// What an Ops & QC coordinator sees at a factory: the clients with work there, then one client's products. Pure.
// `orders` are the styles the server sent him (only those at his factories, with only those factories' splits).
import { phaseOf } from './constants.js'

const splitAt = (order, factoryId) => (order?.assignments || []).find(a => String(a.mid) === String(factoryId)) || null

/** The styles with a split at this factory. */
export const stylesAtFactory = (orders, factoryId) => (orders || []).filter(o => splitAt(o, factoryId))

/** 'delivered' once this factory's split is, else the style's phase: 'development', 'replen' or 'production'. */
export function productState(order, factoryId) {
  const split = splitAt(order, factoryId)
  if (split?.status === 'Delivered') return 'delivered'
  return phaseOf(order)
}

/**
 * The clients with styles at this factory, those with live work first, then by name:
 * [{ id, name, count (all their styles here), live (not yet delivered) }].
 */
export function clientsAtFactory(orders, factoryId) {
  const m = new Map()
  for (const o of stylesAtFactory(orders, factoryId)) {
    const id = String(o.buyerId)
    const c = m.get(id) || { id, name: o.buyerCompany || o.buyerName || 'Client', count: 0, live: 0 }
    c.count += 1
    if (productState(o, factoryId) !== 'delivered') c.live += 1
    m.set(id, c)
  }
  return [...m.values()].sort((a, b) => (b.live > 0) - (a.live > 0) || a.name.localeCompare(b.name))
}

/**
 * One client's products at a factory, under the master order each belongs to:
 * { groups: [{ key, title, products }], delivered: [products] }. Styles with no master order sit under key 'none'
 * (title null: the screen names it "Other styles"), last. Delivered products are apart, to fold away.
 */
export function productsOfClient(orders, masterOrders, factoryId, clientId) {
  const moName = new Map((masterOrders || []).map(mo => [String(mo.id), mo.orderName || String(mo.id)]))
  const groups = new Map()
  const delivered = []
  const mine = stylesAtFactory(orders, factoryId).filter(o => String(o.buyerId) === String(clientId))
  for (const o of mine) {
    const state = productState(o, factoryId)
    const card = { id: o.id, order: o, product: o.product || o.id, styleNumber: o.styleNumber || '', state, qty: splitAt(o, factoryId)?.qty ?? null }
    if (state === 'delivered') { delivered.push(card); continue }
    const key = o.masterOrderId ? String(o.masterOrderId) : 'none'
    if (!groups.has(key)) groups.set(key, { key, title: key === 'none' ? null : (moName.get(key) || key), products: [] })
    groups.get(key).products.push(card)
  }
  const byName = (a, b) => a.product.localeCompare(b.product)
  const list = [...groups.values()].sort((a, b) => (a.key === 'none') - (b.key === 'none') || String(a.title).localeCompare(String(b.title)))
  for (const g of list) g.products.sort(byName)
  return { groups: list, delivered: delivered.sort(byName) }
}

const newest = docs => [...docs].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))[0] || null

/** The tech pack to open for a style: its newest one, or null. */
export const techPackOf = (docs, orderId) => newest((docs || []).filter(d => d.type === 'tech_pack' && String(d.orderId) === String(orderId) && d.isActive !== false))

/** The measurement sheet to open for a style: the Locked Measurement when there is one, else the newest sheet. */
export function measurementOf(docs, orderId) {
  const sheets = (docs || []).filter(d => d.type === 'measurements' && String(d.orderId) === String(orderId) && d.isActive !== false)
  return sheets.find(d => d.locked) || newest(sheets)
}

/** Where a master order found by the search opens for a coordinator: one of his factories making it, and its client. */
export function masterOrderTarget(orders, masterOrderId, preferFactoryId = null) {
  const styles = (orders || []).filter(o => String(o.masterOrderId) === String(masterOrderId))
  if (!styles.length) return null
  const factoryIds = [...new Set(styles.flatMap(o => (o.assignments || []).map(a => String(a.mid))))]
  const factoryId = preferFactoryId && factoryIds.includes(String(preferFactoryId)) ? String(preferFactoryId) : factoryIds[0]
  return factoryId ? { factoryId, clientId: String(styles[0].buyerId) } : null
}
