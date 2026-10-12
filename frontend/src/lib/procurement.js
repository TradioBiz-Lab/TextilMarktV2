// Labels, formatting and small rules shared by the supplier and purchase order screens.

export const SUPPLIER_TYPES = [
  { id: 'fabric_supplier', label: 'Fabric supplier' },
  { id: 'dyer', label: 'Dyer or processor' },
  { id: 'trims_supplier', label: 'Trims supplier' },
  { id: 'other', label: 'Other' },
]
export const supplierTypeLabel = id => SUPPLIER_TYPES.find(t => t.id === id)?.label || 'Other'

export const ITEM_CATEGORIES = [
  { id: 'fabric', label: 'Fabric' },
  { id: 'trim', label: 'Trim' },
  { id: 'other', label: 'Other' },
]

// A PO's life, with the tone each status is drawn in. 'sending' is the few seconds an email is going out.
export const PO_STATUS = {
  draft: { label: 'Draft', tone: 'neutral' },
  sending: { label: 'Sending', tone: 'info' },
  sent: { label: 'Sent', tone: 'info' },
  acknowledged: { label: 'Confirmed', tone: 'info' },
  partially_received: { label: 'Part received', tone: 'warn' },
  closed: { label: 'Received', tone: 'good' },
  cancelled: { label: 'Cancelled', tone: 'bad' },
}
export const poStatusLabel = s => PO_STATUS[s]?.label || s

/** Statuses a PO is still waiting on goods in. */
export const OPEN_STATUSES = ['sent', 'acknowledged', 'partially_received']

const inr = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const inrWhole = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })
const plain = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 3 })

/** ₹1,23,456.50 */
export const rupees = n => `₹${inr.format(Number(n) || 0)}`
/** ₹1,23,457: whole rupees, for lists where paise are noise */
export const rupeesWhole = n => `₹${inrWhole.format(Math.round(Number(n) || 0))}`
/** 1,500 or 12.5 */
export const fmtQty = n => plain.format(Number(n) || 0)

/** 12 Oct 2026 from an ISO date string or Date; a dash when there is none. */
export function fmtDay(value) {
  if (!value) return '-'
  const d = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00`) : new Date(value)
  if (Number.isNaN(d.getTime())) return '-'
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

/**
 * The material lines on a factory's own orders that still need buying, grouped by order, for starting a
 * PO "from material lines". A line needs buying while what is on order is less than what is required
 * and it has not been received. `remaining` is what is still to order, never below zero.
 *
 * @returns {Array<{ orderId, product, buyerCompany, lines: Array<{ ref, name, unit, required, ordered, remaining, supplier, stage }> }>}
 */
export function materialsToBuy(orders, partyId) {
  const out = []
  for (const o of orders || []) {
    const asgn = (o.assignments || []).find(a => String(a.mid) === String(partyId))
    if (!asgn) continue
    const lines = []
    ;(asgn.stages || []).forEach((s, si) => (s.materials || []).forEach((m, mi) => {
      const remaining = Math.max(0, (m.requiredQty || 0) - (m.orderedQty || 0))
      if (m.status === 'received' || remaining <= 0) return
      lines.push({
        ref: { orderId: o.id, stageIndex: si, materialIndex: mi, name: m.name },
        name: m.name, unit: m.unit || '', required: m.requiredQty || 0, ordered: m.orderedQty || 0, remaining,
        supplier: m.supplier || '', supplierId: m.supplierId || null, stage: s.name,
      })
    }))
    if (lines.length) out.push({ orderId: o.id, product: o.product, buyerCompany: o.buyerCompany, lines })
  }
  return out
}

/**
 * Carry a PO's lines across a change of supplier (or the moment a supplier's catalog loads). A line tied
 * to an item the new supplier does not stock keeps its words and numbers but loses the tie, because the
 * server refuses an item from another catalog. A line with no item and no rate yet is matched by name
 * to the catalog (its active items) so the rate, HSN and GST fill in. Lines are plain objects with
 * description, itemId, hsnCode, rate and taxPct; `untouchedTax` is the GST the builder starts every line with.
 */
export function reconcileLines(lines, catalog, untouchedTax = '5') {
  const byId = new Map((catalog || []).map(i => [i.id, i]))
  const byName = new Map((catalog || []).filter(i => i.isActive !== false).map(i => [String(i.name || '').trim().toLowerCase(), i]))
  return (lines || []).map(line => {
    let l = line
    if (l.itemId && !byId.has(l.itemId)) l = { ...l, itemId: null }
    if (l.itemId || String(l.rate ?? '').trim() !== '') return l
    const item = byName.get(String(l.description || '').trim().toLowerCase())
    if (!item) return l
    return {
      ...l, itemId: item.id, hsnCode: l.hsnCode || item.hsnCode || '',
      rate: item.defaultRate ? String(item.defaultRate) : '',
      taxPct: l.taxPct === untouchedTax ? String(item.taxPct ?? untouchedTax) : l.taxPct,
    }
  })
}

/**
 * The supplier to start a PO with when its lines come from material lines: the one they were planned with,
 * if every line that names a supplier names the same one. Null when they disagree or none names any.
 */
export function supplierForLines(lines) {
  const ids = [...new Set((lines || []).map(l => l.supplierId).filter(Boolean).map(String))]
  return ids.length === 1 ? ids[0] : null
}

/** A stage's purchasing in one glance: how many material lines are bought on POs, and how many have arrived. */
export function stagePoSummary(stage) {
  const mats = (stage?.materials || []).filter(m => m.poId)
  if (!mats.length) return null
  return { lines: mats.length, received: mats.filter(m => m.status === 'received').length, pos: [...new Set(mats.map(m => m.poId))] }
}
