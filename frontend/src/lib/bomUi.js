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
