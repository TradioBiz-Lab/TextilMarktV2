// Purchase order sums, worked live while a PO is typed. The same rules as backend/src/lib/poMath.js,
// held to the same cases (backend/tests/fixtures/poMath.cases.json, run by both test suites), so the
// figure on screen is the figure the server will save. The server recomputes everything on save and
// ignores what the browser sends: this exists only so nobody has to wait to see a total.
//
// Money is worked in whole paise (no floating point drift); results come back in rupees.

const toRupees = p => p / 100

/** The money on one line, in paise. */
export function computeLine(l, mode) {
  const qty = Number(l.qty) || 0, rate = Number(l.rate) || 0
  const gross = Math.round(qty * rate * 100)
  const discount = Math.round(gross * (Number(l.discountPct) || 0) / 100)
  const taxable = gross - discount
  const pct = Number(l.taxPct) || 0
  let cgst = 0, sgst = 0, igst = 0, gst = 0
  if (mode === 'intra') { cgst = Math.round(taxable * pct / 200); sgst = cgst }
  else if (mode === 'inter') igst = Math.round(taxable * pct / 100)
  else gst = Math.round(taxable * pct / 100)
  const tax = cgst + sgst + igst + gst
  return { gross, discount, taxable, cgst, sgst, igst, gst, tax, total: taxable + tax }
}

/** Totals for a whole PO in rupees: each line's amounts, the sums, tax by rate, round off, grand total. */
export function computeTotals(lines, mode = 'unknown') {
  const m = ['intra', 'inter', 'unknown'].includes(mode) ? mode : 'unknown'
  const sum = { gross: 0, discount: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, gst: 0, tax: 0 }
  const byRate = new Map()
  const computed = (lines || []).map(l => {
    const c = computeLine(l, m)
    for (const k of Object.keys(sum)) sum[k] += c[k]
    const key = Number(l.taxPct) || 0
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

/** Lines ordered below the supplier's minimum order quantity for their catalog item: [{ line, moq, unit, message }]. */
export function moqWarnings(lines, items) {
  const byId = new Map((items || []).map(i => [String(i.id), i]))
  const out = []
  ;(lines || []).forEach((l, i) => {
    const item = l.itemId ? byId.get(String(l.itemId)) : null
    if (item && item.moq > 0 && Number(l.qty) < item.moq)
      out.push({ line: i, moq: item.moq, unit: item.unit || l.unit, message: `Line ${i + 1} is below the supplier's minimum order of ${item.moq} ${item.unit || l.unit}` })
  })
  return out
}
