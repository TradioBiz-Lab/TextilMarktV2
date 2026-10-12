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

/** A server BOM as editable state. */
export function toDraft(bom) {
  const sizes = bom.plan.sizes.map((name, i) => ({ name, ratio: str(bom.plan.ratio[i] ?? 1) }))
  return {
    plan: { totalQty: str(bom.plan.totalQty || ''), sizes, colours: bom.plan.colours.map(c => ({ key: newKey(), name: c.name, qty: str(c.qty) })) },
    lines: bom.lines.map(lineToForm),
  }
}

/** The plan and lines as numbers, for the live preview. */
export function numeric(draft) {
  const plan = {
    sizes: draft.plan.sizes.map(s => s.name.trim() || ' '), ratio: draft.plan.sizes.map(s => num(s.ratio)),
    colours: draft.plan.colours.filter(c => c.name.trim()).map(c => ({ name: c.name.trim(), qty: num(c.qty) })),
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
      colours: draft.plan.colours.filter(c => c.name.trim()).map(c => ({ name: c.name.trim(), qty: num(c.qty) })),
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
