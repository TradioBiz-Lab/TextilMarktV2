// Bill of materials arithmetic. Pure functions: no database, no clock.
//
// Worked the way a factory's own fabric plan is worked (the 5117/5118 polar fleece sheet): the pieces of
// a colour are split over the sizes by the size ratio and rounded to whole pieces; each size's material
// is its pieces times that size's consumption, rounded to one decimal; the colour's buffer is the line's
// wastage percent of that total, rounded to one decimal; and the order quantity is the two added and
// rounded to the unit (up for things bought by the piece, nearest for cloth, as the sheet does).
// A line that does not depend on colour (labels, zips) is worked once over the whole order.
// These are the quantities a factory buys against, so they are computed here, never trusted from the browser.

/**
 * Excel's ROUND: half away from zero, on the number as it prints (15 significant digits), so a float
 * such as 303.45000000000005 rounds the way the spreadsheet rounds 303.45.
 */
export function roundTo(value, digits = 0) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  const clean = Number(n.toPrecision(15))
  const f = 10 ** digits
  const scaled = Number((Math.abs(clean) * f).toPrecision(15))
  return (Math.sign(clean) * Math.round(scaled)) / f
}

const ceilClean = n => Math.ceil(Number(Number(n).toPrecision(15)))
const sum = (list, pick = x => x) => list.reduce((s, x) => s + pick(x), 0)

// Things a factory buys in whole units: an order for 10,800.4 zips means 10,801.
const COUNT_UNITS = new Set([
  'pcs', 'pc', 'piece', 'pieces', 'nos', 'no', 'number', 'pair', 'pairs', 'set', 'sets', 'dozen', 'doz',
  'cone', 'cones', 'roll', 'rolls', 'box', 'boxes', 'carton', 'cartons', 'ctn', 'bag', 'bags', 'reel', 'reels',
  'spool', 'spools', 'tin', 'tins', 'bundle', 'bundles',
])
export const isCountUnit = unit => COUNT_UNITS.has(String(unit ?? '').trim().toLowerCase())

/** Pieces per size for a quantity: each size's share by the ratio, rounded to whole pieces. */
export function splitBySize(qty, ratio) {
  const total = sum(ratio)
  if (!(total > 0)) return ratio.map(() => 0)
  return ratio.map(r => roundTo((Number(qty) * r) / total, 0))
}

/** Consumption per piece for each size: the size's own figure when given, otherwise the line's base figure. */
export function consumptionBySize(line, sizeCount) {
  const base = Number(line?.consumption) || 0
  return Array.from({ length: sizeCount }, (_, i) => {
    const v = line?.perSize?.[i]
    return v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? base : Number(v)
  })
}

/** The average consumption per piece across the size mix, which is what a cost sheet uses. */
export function weightedConsumption(planInput, line) {
  const plan = normalisePlan(planInput)
  const cons = consumptionBySize(line, plan.sizes.length)
  const total = sum(plan.ratio)
  if (!(total > 0)) return roundTo(Number(line?.consumption) || 0, 4)
  return roundTo(sum(plan.ratio.map((r, i) => r * cons[i])) / total, 4)
}

/** The plan with its colours always present: an order with none entered is one colour of the whole quantity. */
export function normalisePlan(plan) {
  const sizes = plan?.sizes?.length ? plan.sizes : ['ONE']
  const ratio = sizes.map((_, i) => Number(plan?.ratio?.[i]) || (plan?.ratio?.length ? 0 : 1))
  let colours = (plan?.colours || []).map(c => ({ name: c.name, qty: Number(c.qty) || 0 }))
  if (colours.length === 0 && Number(plan?.totalQty) > 0) colours = [{ name: 'All', qty: Number(plan.totalQty) }]
  return { sizes, ratio, colours }
}

/** One run of pieces (a colour, or the whole order) worked through the sizes. */
function run(qty, ratio, cons, wastagePct, count) {
  const sizePcs = splitBySize(qty, ratio)
  const net = roundTo(sum(sizePcs.map((p, i) => roundTo(p * cons[i], 1))), 6)
  const buffer = roundTo((net * wastagePct) / 100, 1)
  const orderQty = count ? ceilClean(net + buffer) : roundTo(net + buffer, 0)
  return { sizePcs, sizeTotal: sum(sizePcs), net, buffer, orderQty }
}

/**
 * What one BOM line needs. `line`: { unit, consumption, perSize?, wastagePct?, perColour? }.
 * @returns {{ net, buffer, orderQty, perColour: Array<{ colour, qty, sizePcs, sizeTotal, net, buffer, orderQty }> }}
 *   For a line that does not depend on colour, perColour is empty and sizePcs/sizeTotal sit on the result.
 */
export function computeLine(planInput, line) {
  const plan = normalisePlan(planInput)
  const cons = consumptionBySize(line, plan.sizes.length)
  const wastage = Math.max(0, Number(line?.wastagePct) || 0)
  const count = isCountUnit(line?.unit)
  if (line?.perColour === true && plan.colours.length) {
    const perColour = plan.colours.map(c => ({ colour: c.name, qty: c.qty, ...run(c.qty, plan.ratio, cons, wastage, count) }))
    return {
      net: roundTo(sum(perColour, c => c.net), 6),
      buffer: roundTo(sum(perColour, c => c.buffer), 6),
      orderQty: roundTo(sum(perColour, c => c.orderQty), 6),
      perColour,
    }
  }
  const whole = run(sum(plan.colours, c => c.qty), plan.ratio, cons, wastage, count)
  return { net: whole.net, buffer: whole.buffer, orderQty: whole.orderQty, sizePcs: whole.sizePcs, sizeTotal: whole.sizeTotal, perColour: [] }
}

/**
 * Every line worked, plus the things worth telling the person: sizes that add up to a different number of
 * pieces than the colour (the ratio does not divide evenly), and colours that do not add up to the order.
 */
export function computeBom(planInput, lines, { totalQty = null } = {}) {
  const plan = normalisePlan(planInput)
  const worked = (lines || []).map(line => ({ ...line, computed: computeLine(plan, line) }))
  const warnings = []
  const colourTotal = sum(plan.colours, c => c.qty)
  if (totalQty && colourTotal && colourTotal !== totalQty) warnings.push({ code: 'colour_total', message: `The colours add up to ${colourTotal} pieces, not the ${totalQty} on the order` })
  const seen = new Set()
  for (const l of worked) {
    for (const c of l.computed.perColour) {
      if (c.sizeTotal !== c.qty && !seen.has(c.colour)) {
        seen.add(c.colour)
        warnings.push({ code: 'size_rounding', message: `${c.colour}: the size split adds up to ${c.sizeTotal} pieces, not ${c.qty}, because the ratio does not divide evenly` })
      }
    }
  }
  return { plan, lines: worked, warnings }
}
