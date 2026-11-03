// The search in the top bar: one box for a customer, a master order, a style (by name, Tradio ID or the customer's style ID,
// including just its last digits), ranked so the likely target comes first. Pure, so it is tested on its own; it searches
// only what the signed-in user already has (the server sends each role its own orders and master orders).
import { PHASE_LABEL, phaseOf } from './constants.js'

const low = s => String(s ?? '').toLowerCase().trim()
const compact = s => low(s).replace(/[^a-z0-9]/g, '')
const digitsAtEnd = s => (String(s ?? '').match(/(\d+)\D*$/) || [])[1] || ''

/** How well one query word matches one text: 0 (not at all) up to 100 (the whole text). */
function wordScore(token, text, { styleId = false } = {}) {
  const t = compact(token), v = compact(text)
  if (!t || !v) return 0
  if (v === t) return 100
  // A style ID by its last digits: "4002" finds FYLSS26WD-4002; so does "002".
  if (styleId && /^\d{2,}$/.test(t)) {
    const tail = digitsAtEnd(text)
    if (tail === t) return 95
    if (tail.endsWith(t)) return 85
  }
  if (v.startsWith(t)) return 70
  if (low(text).split(/[^a-z0-9]+/i).some(w => compact(w).startsWith(t))) return 60
  return v.includes(t) ? 40 : 0
}

/**
 * Every query word has to match some field of an item; the item scores the sum of each word's best field score times that
 * field's weight. Weights make the right kind win: a customer's name ranks its master orders above its many styles.
 */
function scoreItem(tokens, fields) {
  let total = 0
  for (const token of tokens) {
    let best = 0
    for (const f of fields) best = Math.max(best, wordScore(token, f.text, f) * f.weight)
    if (!best) return 0
    total += best
  }
  return total
}

/** The searchable items: styles and master orders, each with the fields it can be found by. */
export function buildSearchIndex({ orders = [], masterOrders = [] } = {}) {
  const moById = Object.fromEntries((masterOrders || []).map(m => [m.id, m]))
  const styles = (orders || []).map(o => {
    const mo = moById[o.masterOrderId]
    return {
      kind: 'style', id: o.id, order: o,
      title: o.product || o.id,
      sub: [o.styleNumber, o.buyerCompany, mo?.orderName].filter(Boolean).join(' · '),
      badge: PHASE_LABEL[phaseOf(o)] || '',
      fields: [
        { text: o.styleNumber, weight: 1.2, styleId: true },
        { text: o.id, weight: 1, styleId: true },
        { text: o.product, weight: 1 },
        { text: o.brand, weight: 0.6 },
        { text: mo?.orderName, weight: 0.6 },
        { text: o.masterOrderId, weight: 0.6 },
        { text: o.buyerCompany, weight: 0.5 },
        { text: o.category, weight: 0.4 },
      ],
    }
  })
  const mos = (masterOrders || []).map(m => {
    const n = (orders || []).filter(o => o.masterOrderId === m.id).length
    return {
      kind: 'master_order', id: m.id,
      title: m.orderName || m.id,
      sub: [m.buyerCompany, m.season, `${n} style${n === 1 ? '' : 's'}`, m.id].filter(Boolean).join(' · '),
      badge: 'Master order',
      fields: [
        { text: m.orderName, weight: 1.1 },
        { text: m.id, weight: 1 },
        { text: m.buyerCompany, weight: 1 },
        { text: m.poNumber, weight: 0.8 },
        { text: m.season, weight: 0.4 },
      ],
    }
  })
  return [...mos, ...styles]
}

/** The best matches for `query`, best first. */
export function searchItems(index, query, limit = 8) {
  // A word that is only symbols ("&", "-") matches nothing, so it is dropped rather than failing the whole search.
  const tokens = String(query ?? '').trim().split(/\s+/).filter(t => compact(t))
  if (!tokens.length) return []
  return index
    .map(item => ({ item, score: scoreItem(tokens, item.fields) }))
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score || (a.item.kind === 'master_order' ? -1 : 1) - (b.item.kind === 'master_order' ? -1 : 1) || a.item.title.localeCompare(b.item.title))
    .slice(0, limit)
    .map(r => r.item)
}
