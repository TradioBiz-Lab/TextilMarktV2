// Cost sheet arithmetic: what one piece costs and what it is priced at. Pure functions, no database.
//
// It is the approved Fitleasure core costing sheet, line for line (all figures per piece, in rupees):
//   each material line  = quantity per piece x rate (plus freight and duty for imported goods, plus wastage)
//   materials           = fabric + process + trims + labels and packaging
//   labour              = cutting and threads + making + finishing and packing
//   base                = materials + labour
//   overhead            = base x overhead %
//   rejection           = (base + overhead) x rejection %
//   margin              = (base + overhead + rejection) x margin %
//   tradio fee          = base x tradio %            (0 unless the factory is managed by Tradio)
//   price               = base + overhead + rejection + margin + tradio fee
//   negotiated price    = price less the negotiated discount %
// The summary rows come only from the subtotals above them. Rows are held to four decimals and the two
// prices to the paisa; nothing in between is rounded, as in the spreadsheet. The browser has a copy of
// this file for live editing and both run the same cases, but the server's figures are the ones stored
// and shared: a total sent by the browser is never trusted.
import { roundTo } from './bomMath.js'

export const MATERIAL_SECTIONS = ['fabric', 'process', 'trims', 'labelsPackaging']
export const DEFAULT_PERCENTS = { overheadPct: 5, rejectionPct: 3, marginPct: 20, tradioPct: 10, discountPct: 0 }

const n = v => (Number.isFinite(Number(v)) ? Number(v) : 0)
const pct = v => n(v) / 100

/** What one material line costs per piece. Freight is per unit of the material, duty is on rate plus freight. */
export function lineAmount(l) {
  const landedRate = (n(l?.rate) + n(l?.freight)) * (1 + pct(l?.dutyPct))
  return n(l?.consumption) * landedRate * (1 + pct(l?.wastagePct))
}

/**
 * Work a whole sheet.
 * @param {{ fabric, process, trims, labelsPackaging, labour: {cuttingThreads, making, finishingPacking}, overheadPct, rejectionPct, marginPct, tradioPct, discountPct, qty? }} sheet
 * @returns {object} every summary row, the amount of each material line by section, and (with a quantity) the order
 *   value, which is the price as shown times the quantity
 */
export function computeCostSheet(sheet) {
  const sections = {}
  const totals = {}
  for (const key of MATERIAL_SECTIONS) {
    const amounts = (sheet?.[key] || []).map(lineAmount)
    sections[key] = amounts.map(a => roundTo(a, 4))
    totals[key] = amounts.reduce((s, a) => s + a, 0)
  }
  const labour = sheet?.labour || {}
  const cuttingThreads = n(labour.cuttingThreads)
  const making = n(labour.making)
  const finishingPacking = n(labour.finishingPacking)

  const materials = totals.fabric + totals.process + totals.trims + totals.labelsPackaging
  const labourTotal = cuttingThreads + making + finishingPacking
  const base = materials + labourTotal
  const overhead = base * pct(sheet?.overheadPct)
  const rejection = (base + overhead) * pct(sheet?.rejectionPct)
  const margin = (base + overhead + rejection) * pct(sheet?.marginPct)
  const tradio = base * pct(sheet?.tradioPct)
  const price = base + overhead + rejection + margin + tradio
  const negotiated = price * (1 - pct(sheet?.discountPct))

  const out = {
    fabric: roundTo(totals.fabric, 4), process: roundTo(totals.process, 4), trims: roundTo(totals.trims, 4),
    labelsPackaging: roundTo(totals.labelsPackaging, 4), materials: roundTo(materials, 4),
    cuttingThreads: roundTo(cuttingThreads, 4), making: roundTo(making, 4), finishingPacking: roundTo(finishingPacking, 4),
    labour: roundTo(labourTotal, 4), base: roundTo(base, 4),
    overhead: roundTo(overhead, 4), rejection: roundTo(rejection, 4), margin: roundTo(margin, 4), tradio: roundTo(tradio, 4),
    price: roundTo(price, 2), negotiated: roundTo(negotiated, 2),
    lines: sections,
  }
  const qty = n(sheet?.qty)
  if (qty > 0) {
    out.qty = qty
    out.orderValue = roundTo(out.price * qty, 2)
    out.negotiatedValue = roundTo(out.negotiated * qty, 2)
  }
  return out
}

/**
 * Material lines for a cost sheet from a bill of materials: each BOM line's average consumption across the
 * size mix, its wastage and its rate, under the section it belongs to. Lines the BOM calls "other" are
 * left out (they are not part of the factory's costing blocks); the person adds those by hand.
 * @param {(line) => number} consumptionOf  the BOM's weighted consumption for a line (lib/bomMath.js)
 */
export function linesFromBom(bomLines, consumptionOf) {
  const out = { fabric: [], process: [], trims: [], labelsPackaging: [] }
  const into = { fabric: 'fabric', process: 'process', trims: 'trims', labels_packaging: 'labelsPackaging' }
  for (const l of bomLines || []) {
    const key = into[l.section]
    if (!key) continue
    out[key].push({
      name: l.item, spec: l.spec || '', unit: l.unit || '', consumption: consumptionOf(l),
      wastagePct: n(l.wastagePct), rate: n(l.rate), freight: 0, dutyPct: 0, note: '',
    })
  }
  return out
}
