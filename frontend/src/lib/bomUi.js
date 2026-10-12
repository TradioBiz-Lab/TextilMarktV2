// The bill of materials editor's state: what a person types (strings, so "1." can be half-typed) turned
// into the payload the server takes and the numbers the live preview (bomCalc.js) works with.
import { computeBom } from './bomCalc.js'

export const SECTIONS = [
  { id: 'fabric', label: 'Fabric', hint: 'Cloth: main fabric, mesh, rib', unit: 'm', perColour: true },
  { id: 'process', label: 'Process', hint: 'Prints, embroidery, laser cutting, washes', unit: 'pcs', perColour: false },
  { id: 'trims', label: 'Trims', hint: 'Zips, elastic, drawcords, toggles, buttons', unit: 'pcs', perColour: false },
  { id: 'labels_packaging', label: 'Labels and packaging', hint: 'Main label, care label, tags, polybag, carton', unit: 'pcs', perColour: false },
  { id: 'other', label: 'Other', hint: 'Anything else you buy for this style', unit: 'pcs', perColour: false },
]
export const sectionLabel = id => SECTIONS.find(s => s.id === id)?.label || id

let keySeq = 0
export const newKey = () => `k${++keySeq}`

const str = v => (v === null || v === undefined ? '' : String(v))
export const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
/** Keeps only what a decimal number can contain, so a half-typed value never turns into NaN. */
export const decimal = v => String(v ?? '').replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1')

export function blankLine(section) {
  const s = SECTIONS.find(x => x.id === section) || SECTIONS[4]
  return {
    key: newKey(), lineId: null, section: s.id, item: '', spec: '', unit: s.unit, consumption: '', perSize: [], wastagePct: '',
    perColour: s.perColour, supplierId: '', itemId: '', rate: '', note: '', source: 'manual', confidence: null, needsReview: false, evidence: '', confirmed: false,
  }
}

const lineToForm = l => ({
  key: newKey(), lineId: l.lineId, section: l.section, item: l.item, spec: l.spec || '', unit: l.unit || '',
  consumption: l.consumption ? str(l.consumption) : '', perSize: (l.perSize || []).map(v => (v === null || v === undefined ? '' : str(v))),
  wastagePct: l.wastagePct ? str(l.wastagePct) : '', perColour: !!l.perColour, supplierId: l.supplierId || '', itemId: l.itemId || '',
  rate: l.rate ? str(l.rate) : '', note: l.note || '', source: l.source || 'manual', confidence: l.confidence ?? null,
  needsReview: !!l.needsReview, evidence: l.evidence || '', confirmed: false,
})

/**
 * A server BOM as editable state. A colour with its own pieces for each size has `sizes` (strings); one without
 * has null. When any colour has them every colour does here, so the editor never shows half a grid: the others
 * are split by the ratio, keeping their total.
 */
export function toDraft(bom) {
  const sizes = bom.plan.sizes.map((name, i) => ({ name, ratio: str(bom.plan.ratio[i] ?? 1) }))
  const colours = bom.plan.colours.map(c => ({ key: newKey(), name: c.name, qty: str(c.qty), sizes: c.sizes?.length ? c.sizes.map(str) : null }))
  return {
    plan: { totalQty: str(bom.plan.totalQty || ''), sizes, colours: colours.some(c => c.sizes) ? toGrid(colours, bom.plan.ratio) : colours },
    lines: bom.lines.map(lineToForm),
  }
}

const sum = list => list.reduce((a, b) => a + b, 0)

/** A quantity split over the sizes by the ratio so it adds up exactly (the largest leftovers take the odd pieces). */
export function splitExactly(qty, ratio) {
  const total = sum(ratio.map(num))
  const n = Math.max(0, Math.round(num(qty)))
  if (!(total > 0) || n === 0) return ratio.map(() => 0)
  const exact = ratio.map(r => (n * num(r)) / total)
  const out = exact.map(Math.floor)
  let left = n - sum(out)
  const byLeftover = exact.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1])
  for (const [, i] of byLeftover) { if (left <= 0) break; out[i] += 1; left -= 1 }
  return out
}

/** Has the order been given as pieces for each size and colour? */
export const gridOn = colours => colours.some(c => c.sizes)

/** Colours as a size and colour grid, each starting as its total split by the ratio (a colour already a grid is kept). */
export const toGrid = (colours, ratio) => colours.map(c => {
  if (c.sizes) return { ...c, qty: String(sum(c.sizes.map(num))) }
  const pieces = splitExactly(c.qty, ratio)
  return { ...c, sizes: pieces.map(String), qty: String(sum(pieces)) }
})

/** Back to one ratio for every colour: each keeps its total. */
export const fromGrid = colours => colours.map(c => ({ ...c, sizes: null, qty: c.sizes ? String(sum(c.sizes.map(num))) : c.qty }))

/** One cell of the grid changed: the colour's total follows. */
export const setGridCell = (colours, key, index, value) => colours.map(c => {
  if (c.key !== key || !c.sizes) return c
  const sizes = c.sizes.map((v, i) => (i === index ? value : v))
  return { ...c, sizes, qty: String(sum(sizes.map(num))) }
})

/** The grid follows the size list when a size is added (a new empty column) or removed. */
export const addGridSize = colours => colours.map(c => (c.sizes ? { ...c, sizes: [...c.sizes, ''] } : c))
export const removeGridSize = (colours, index) => colours.map(c => {
  if (!c.sizes) return c
  const sizes = c.sizes.filter((_, i) => i !== index)
  return { ...c, sizes, qty: String(sum(sizes.map(num))) }
})

/** The plan and lines as numbers, for the live preview. */
export function numeric(draft) {
  const plan = {
    sizes: draft.plan.sizes.map(s => s.name.trim() || ' '), ratio: draft.plan.sizes.map(s => num(s.ratio)),
    colours: draft.plan.colours.filter(c => c.name.trim()).map(c => (c.sizes ? { name: c.name.trim(), qty: sum(c.sizes.map(num)), sizes: c.sizes.map(num) } : { name: c.name.trim(), qty: num(c.qty) })),
  }
  const lines = draft.lines.map(l => ({
    ...l, consumption: num(l.consumption), wastagePct: num(l.wastagePct), rate: num(l.rate),
    perSize: draft.plan.sizes.map((_, i) => (l.perSize[i] === '' || l.perSize[i] === undefined ? null : num(l.perSize[i]))),
  }))
  return { plan, lines }
}

/** The editor's live figures: every line worked, and anything worth warning about. */
export function preview(draft, totalQty) {
  const { plan, lines } = numeric(draft)
  return computeBom(plan, lines, { totalQty: totalQty || num(draft.plan.totalQty) || null })
}

/** The body the server's save route takes. */
export function payloadFrom(draft, updatedAt, { confirmAll = false } = {}) {
  return {
    ...(updatedAt ? { updatedAt } : {}),
    ...(confirmAll ? { confirmAll: true } : {}),
    plan: {
      totalQty: num(draft.plan.totalQty),
      sizes: draft.plan.sizes.map(s => s.name.trim()),
      sizeRatio: draft.plan.sizes.map(s => num(s.ratio)),
      colours: draft.plan.colours.filter(c => c.name.trim()).map(c => (c.sizes ? { name: c.name.trim(), qty: sum(c.sizes.map(num)), sizes: c.sizes.map(num) } : { name: c.name.trim(), qty: num(c.qty) })),
    },
    lines: draft.lines.filter(l => l.item.trim()).map(l => ({
      ...(l.lineId ? { lineId: l.lineId } : {}), section: l.section, item: l.item.trim(), spec: l.spec.trim(), unit: l.unit.trim(),
      consumption: num(l.consumption), wastagePct: num(l.wastagePct), rate: num(l.rate), perColour: !!l.perColour,
      perSize: draft.plan.sizes.map((_, i) => (l.perSize[i] === '' || l.perSize[i] === undefined ? null : num(l.perSize[i]))),
      supplierId: l.supplierId || null, itemId: l.itemId || null, note: l.note.trim(), ...(l.confirmed ? { confirmed: true } : {}),
    })),
  }
}

export const reviewCount = lines => lines.filter(l => l.needsReview && !l.confirmed).length

/** Has the person changed anything since this was loaded? A comparison of what would be sent. */
export const isDirty = (draft, saved) => JSON.stringify(payloadFrom(draft)) !== JSON.stringify(payloadFrom(saved))

/** Keep the per-size boxes as many as there are sizes after the size list changes. */
export const alignPerSize = (lines, sizeCount) => lines.map(l => ({ ...l, perSize: Array.from({ length: sizeCount }, (_, i) => l.perSize[i] ?? '') }))

/** Give the colours an even share of the order quantity, the first taking any remainder. */
export function shareEvenly(colours, totalQty) {
  const n = colours.length
  if (!n) return colours
  const each = Math.floor(totalQty / n)
  return colours.map((c, i) => ({ ...c, qty: String(each + (i === 0 ? totalQty - each * n : 0)) }))
}

// ── Excel import of lines ─────────────────────────────────────────────────────────────────────────────
// The columns of the template a factory fills in (see components/SpreadsheetImport.jsx and lib/excelIO.js). The
// section is written in words, as a person would, and mapped back to the section id.
const SECTION_WORDS = SECTIONS.map(s => s.label)
export const BOM_COLUMNS = [
  { key: 'section', header: 'Section', required: true, type: 'enum', options: SECTION_WORDS, aliases: ['group', 'category', 'type'] },
  { key: 'item', header: 'Item', required: true, aliases: ['material', 'name', 'description'] },
  { key: 'spec', header: 'Detail', aliases: ['spec', 'specification', 'details'] },
  { key: 'unit', header: 'Unit', aliases: ['uom'] },
  { key: 'consumption', header: 'Per piece', type: 'number', aliases: ['consumption', 'qty per piece', 'quantity per piece', 'consumption per piece'] },
  { key: 'wastagePct', header: 'Wastage %', type: 'number', aliases: ['wastage', 'wastage percent', 'buffer', 'buffer %'] },
  { key: 'supplier', header: 'Supplier', aliases: ['vendor'] },
  { key: 'rate', header: 'Rate', type: 'number', aliases: ['price', 'unit rate', 'rate per unit'] },
  { key: 'perColour', header: 'Per colour', type: 'enum', options: ['Yes', 'No'], aliases: ['by colour', 'colour wise', 'order per colour'] },
]
export const BOM_EXAMPLE = { section: 'Fabric', item: 'Polar fleece 300 GSM', spec: '150 cm width', unit: 'kg', consumption: 0.72, wastagePct: 7, supplier: 'Coimbatore Knit Fabrics', rate: 410, perColour: 'Yes' }

// ── Excel import of the size and colour grid ─────────────────────────────────────────────────────────
// The sheet is a colour in each row and a column for each of the plan's sizes, as buyers send an order.
export const gridColumns = sizeNames => [
  { key: 'colour', header: 'Colour', required: true, aliases: ['color', 'colourway', 'colorway', 'shade'] },
  ...sizeNames.map((name, i) => ({ key: `size${i}`, header: name, type: 'number' })),
]
export const gridExample = (sizeNames, ratio) => ({ colour: 'Black', ...Object.fromEntries(sizeNames.map((_, i) => [`size${i}`, 100 * (num(ratio[i]) || 1)])) })

/** Whether every size has its own name, so the sheet's columns can be told apart. */
export const sizeNamesUsable = names => names.every(n => n.trim()) && new Set(names.map(n => n.trim().toLowerCase())).size === names.length

/**
 * The colours of a filled-in grid sheet, as editor state. A row with no colour, a colour named twice or a
 * negative number of pieces is left out and says why; a blank cell is no pieces.
 * @returns {{ colours: object[], skipped: Array<{ row, name, error }> }}
 */
export function coloursFromRows(rows, sizeCount) {
  const colours = []
  const skipped = []
  const seen = new Set()
  for (const r of rows || []) {
    const name = String(r.colour || '').trim().slice(0, 60)
    const pieces = Array.from({ length: sizeCount }, (_, i) => (r[`size${i}`] === null || r[`size${i}`] === undefined ? 0 : Number(r[`size${i}`])))
    if (!name) { skipped.push({ row: r._row, name: '', error: 'No colour' }); continue }
    if (seen.has(name.toLowerCase())) { skipped.push({ row: r._row, name, error: 'This colour is already in the file' }); continue }
    if (pieces.some(v => !Number.isFinite(v) || v < 0)) { skipped.push({ row: r._row, name, error: 'Pieces cannot be negative' }); continue }
    seen.add(name.toLowerCase())
    const whole = pieces.map(Math.round)
    colours.push({ key: newKey(), name, qty: String(sum(whole)), sizes: whole.map(String) })
  }
  return { colours, skipped }
}

const normName = v => String(v || '').trim().toLowerCase().replace(/\s+/g, ' ')

/**
 * The supplier a typed name means: the exact name (ignoring case and spacing), else the one supplier whose name
 * holds it or is held by it ("YKK" for "YKK India (Mumbai depot)"). Two or more candidates is no match, so a
 * line is never tied to a guess between suppliers.
 */
export function matchSupplier(name, suppliers) {
  const n = normName(name)
  if (!n) return null
  const book = (suppliers || []).map(s => ({ id: s.id, n: normName(s.name) }))
  const exact = book.find(s => s.n === n)
  if (exact) return exact.id
  if (n.length < 3) return null
  const near = book.filter(s => s.n.includes(n) || (s.n.length >= 3 && n.includes(s.n)))
  return near.length === 1 ? near[0].id : null
}

/**
 * Draft lines from the rows of a filled-in template. A supplier is matched to the factory's own book by name;
 * one that is not there leaves the line without a supplier for the person to set, and is counted in `unmatched`.
 * @returns {{ lines: object[], skipped: Array<{ row, name, error }>, unmatched: number }}
 */
export function linesFromRows(rows, suppliers, sizeCount) {
  const bySection = new Map(SECTIONS.map(s => [s.label.toLowerCase(), s.id]))
  const lines = []
  const skipped = []
  let unmatched = 0
  for (const r of rows || []) {
    const section = bySection.get(String(r.section || '').trim().toLowerCase())
    const item = String(r.item || '').trim()
    if (!section || !item) { skipped.push({ row: r._row, name: item, error: !item ? 'No item' : 'No section' }); continue }
    const line = blankLine(section)
    line.item = item.slice(0, 200)
    line.spec = String(r.spec || '').trim().slice(0, 300)
    if (r.unit) line.unit = String(r.unit).trim().slice(0, 20)
    line.consumption = r.consumption ? String(r.consumption) : ''
    line.wastagePct = r.wastagePct ? String(r.wastagePct) : ''
    line.rate = r.rate ? String(r.rate) : ''
    if (r.perColour) line.perColour = r.perColour === 'Yes'
    line.supplierId = matchSupplier(r.supplier, suppliers) || ''
    if (normName(r.supplier) && !line.supplierId) unmatched += 1
    line.perSize = Array.from({ length: sizeCount }, () => '')
    lines.push(line)
  }
  return { lines, skipped, unmatched }
}
