// Purchase order arithmetic. Pure functions: no database, no clock.
//
// Money is worked in whole paise so a long order never drifts by a rupee through floating point, and
// every figure on a PO (line amounts, tax, the grand total) is computed here on the server. A total
// sent by the browser is never trusted or stored.
//
// Per line:   taxable = qty x rate, less the line discount
//             intra state: CGST and SGST are each half the GST rate, on the taxable value
//             inter state: IGST is the whole rate
//             unknown:     one combined GST figure (the split needs both states)
// The grand total is rounded to the nearest rupee, with the difference shown as "round off".
import mongoose from 'mongoose'

export const TAX_MODES = ['intra', 'inter', 'unknown']
export const PO_UNITS_MAX = 20

const toPaise = n => Math.round(Number(n) * 100)
const toRupees = p => p / 100
const roundTo = (n, places) => { const f = 10 ** places; return Math.round(Number(n) * f) / f }

const isoDate = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(new Date(v).getTime()) ? v : null)

/**
 * Validate and normalise one line from a request body.
 * @returns {{ok: true, line: object} | {ok: false, error: string}}
 */
export function cleanLine(raw, position = 1) {
  const at = `Line ${position}`
  if (!raw || typeof raw !== 'object') return { ok: false, error: `${at}: is not valid` }
  const description = typeof raw.description === 'string' ? raw.description.trim() : ''
  if (!description) return { ok: false, error: `${at}: describe the item` }
  if (description.length > 300) return { ok: false, error: `${at}: the description is too long` }

  const qty = Number(raw.qty)
  if (!Number.isFinite(qty) || qty <= 0) return { ok: false, error: `${at}: quantity must be more than zero` }
  if (qty > 1e9) return { ok: false, error: `${at}: quantity is too large` }

  const rate = Number(raw.rate ?? 0)
  if (!Number.isFinite(rate) || rate < 0) return { ok: false, error: `${at}: rate cannot be negative` }
  if (rate > 1e8) return { ok: false, error: `${at}: rate is too large` }

  const discountPct = Number(raw.discountPct ?? 0)
  if (!Number.isFinite(discountPct) || discountPct < 0 || discountPct > 100) return { ok: false, error: `${at}: discount must be between 0 and 100` }

  const taxPct = Number(raw.taxPct ?? 0)
  if (!Number.isFinite(taxPct) || taxPct < 0 || taxPct > 40) return { ok: false, error: `${at}: GST rate must be between 0 and 40` }

  const hsnCode = typeof raw.hsnCode === 'string' ? raw.hsnCode.replace(/\s+/g, '') : ''
  if (hsnCode && !/^\d{4,8}$/.test(hsnCode)) return { ok: false, error: `${at}: HSN code must be 4 to 8 digits` }

  const unit = typeof raw.unit === 'string' && raw.unit.trim() ? raw.unit.trim() : 'pcs'
  if (unit.length > PO_UNITS_MAX) return { ok: false, error: `${at}: the unit is too long` }

  const note = typeof raw.note === 'string' ? raw.note.trim() : ''
  if (note.length > 300) return { ok: false, error: `${at}: the note is too long` }

  let itemId = null
  if (raw.itemId) {
    if (!mongoose.Types.ObjectId.isValid(raw.itemId)) return { ok: false, error: `${at}: the catalog item is not valid` }
    itemId = String(raw.itemId)
  }

  let expectedDate = null
  if (raw.expectedDate) {
    expectedDate = isoDate(raw.expectedDate)
    if (!expectedDate) return { ok: false, error: `${at}: the expected date is not a valid date` }
  }

  // Where the goods are for: a material line on one of the manufacturer's own orders (see poSync.js).
  let materialRef = null
  if (raw.materialRef) {
    const r = raw.materialRef
    const stageIndex = Number(r.stageIndex), materialIndex = Number(r.materialIndex)
    if (typeof r.orderId !== 'string' || !r.orderId || r.orderId.length > 100
      || !Number.isInteger(stageIndex) || stageIndex < 0 || !Number.isInteger(materialIndex) || materialIndex < 0)
      return { ok: false, error: `${at}: the linked material is not valid` }
    materialRef = { orderId: r.orderId, stageIndex, materialIndex, name: typeof r.name === 'string' ? r.name.slice(0, 200) : '' }
  }

  return {
    ok: true,
    line: {
      description, itemId, hsnCode, unit, qty: roundTo(qty, 3), rate: roundTo(rate, 4),
      discountPct: roundTo(discountPct, 2), taxPct: roundTo(taxPct, 2), expectedDate, materialRef, note,
    },
  }
}

/** The money on one line, in paise. */
export function computeLine(l, mode) {
  const gross = Math.round(l.qty * l.rate * 100)
  const discount = Math.round(gross * (l.discountPct || 0) / 100)
  const taxable = gross - discount
  const rate = l.taxPct || 0
  let cgst = 0, sgst = 0, igst = 0, gst = 0
  if (mode === 'intra') { cgst = Math.round(taxable * rate / 200); sgst = cgst }
  else if (mode === 'inter') igst = Math.round(taxable * rate / 100)
  else gst = Math.round(taxable * rate / 100)
  const tax = cgst + sgst + igst + gst
  return { gross, discount, taxable, cgst, sgst, igst, gst, tax, total: taxable + tax }
}

/**
 * Totals for a whole PO, in rupees. `lines` come back with their own computed amounts, `byRate`
 * groups the tax by GST rate (what a tax invoice summary shows).
 */
export function computeTotals(lines, mode = 'unknown') {
  const m = TAX_MODES.includes(mode) ? mode : 'unknown'
  const sum = { gross: 0, discount: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, gst: 0, tax: 0 }
  const byRate = new Map()
  const computed = lines.map(l => {
    const c = computeLine(l, m)
    for (const k of Object.keys(sum)) sum[k] += c[k]
    const key = l.taxPct || 0
    const g = byRate.get(key) || { rate: key, taxable: 0, cgst: 0, sgst: 0, igst: 0, gst: 0 }
    g.taxable += c.taxable; g.cgst += c.cgst; g.sgst += c.sgst; g.igst += c.igst; g.gst += c.gst
    byRate.set(key, g)
    return { amount: toRupees(c.taxable), taxAmount: toRupees(c.tax), lineTotal: toRupees(c.total) }
  })
  const before = sum.taxable + sum.tax
  const grand = Math.round(before / 100) * 100
  return {
    taxMode: m,
    lines: computed,
    totals: {
      subtotal: toRupees(sum.gross), discount: toRupees(sum.discount), taxable: toRupees(sum.taxable),
      cgst: toRupees(sum.cgst), sgst: toRupees(sum.sgst), igst: toRupees(sum.igst), gst: toRupees(sum.gst),
      taxTotal: toRupees(sum.tax), roundOff: toRupees(grand - before), grandTotal: toRupees(grand),
      byRate: [...byRate.values()].sort((a, b) => a.rate - b.rate).map(g => ({
        rate: g.rate, taxable: toRupees(g.taxable), cgst: toRupees(g.cgst), sgst: toRupees(g.sgst), igst: toRupees(g.igst), gst: toRupees(g.gst),
      })),
    },
  }
}

/** Lines ordered below the supplier's minimum order quantity for the catalog item they name. */
export function moqWarnings(lines, itemsById) {
  const out = []
  lines.forEach((l, i) => {
    const item = l.itemId ? itemsById.get(String(l.itemId)) : null
    if (item && item.moq > 0 && l.qty < item.moq)
      out.push({ line: i, code: 'BELOW_MOQ', moq: item.moq, unit: item.unit || l.unit, message: `Line ${i + 1} is below the supplier's minimum order of ${item.moq} ${item.unit || l.unit}` })
  })
  return out
}
