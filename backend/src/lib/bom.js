// Checking and shaping bills of materials: what a request may say, what a new BOM starts as, and what
// goes back to the browser. The quantity maths is in bomMath.js; this file never does any of it itself.
import mongoose from 'mongoose'
import { BOM_SECTIONS } from '../models/Bom.js'
import { computeBom, roundTo } from './bomMath.js'

export const BOM_LIMITS = { sizes: 12, colours: 30, lines: 200 }
export const DEFAULT_SIZES = ['S', 'M', 'L', 'XL', 'XXL']
export const DEFAULT_RATIO = [1, 2, 3, 2, 1]
const DEFAULT_UNIT = { fabric: 'm', process: 'pcs', trims: 'pcs', labels_packaging: 'pcs', other: 'pcs' }

export const newLineId = () => String(new mongoose.Types.ObjectId())

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const finite = v => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : NaN)

/**
 * The quantity plan: sizes with their ratio, the colours with their pieces (each may give its pieces for every
 * size instead, a size and colour grid, and then its total is the sum), and the order total.
 * Anything left out falls back to `fallback` (the plan already on the BOM) or the defaults.
 * @returns {{ok: true, plan: {sizes, sizeRatio, colours, totalQty}} | {ok: false, error: string}}
 */
export function cleanPlan(raw, fallback = null) {
  const src = raw && typeof raw === 'object' ? raw : {}

  let sizes = fallback?.sizes?.length ? [...fallback.sizes] : [...DEFAULT_SIZES]
  if (src.sizes !== undefined) {
    if (!Array.isArray(src.sizes) || src.sizes.length < 1 || src.sizes.length > BOM_LIMITS.sizes) return { ok: false, error: `Give between 1 and ${BOM_LIMITS.sizes} sizes` }
    sizes = src.sizes.map(s => text(String(s ?? ''), 12))
    if (sizes.some(s => !s)) return { ok: false, error: 'A size has no name' }
    if (new Set(sizes.map(s => s.toLowerCase())).size !== sizes.length) return { ok: false, error: 'Two sizes have the same name' }
  }

  let sizeRatio = fallback?.sizeRatio?.length === sizes.length ? [...fallback.sizeRatio] : (sizes.length === DEFAULT_SIZES.length ? [...DEFAULT_RATIO] : sizes.map(() => 1))
  const ratioIn = src.sizeRatio ?? src.ratio
  if (ratioIn !== undefined) {
    if (!Array.isArray(ratioIn) || ratioIn.length !== sizes.length) return { ok: false, error: 'The size ratio needs one number for each size' }
    sizeRatio = ratioIn.map(Number)
    if (sizeRatio.some(r => !Number.isFinite(r) || r < 0 || r > 1000)) return { ok: false, error: 'The size ratio must be numbers from 0 up' }
  }
  if (!(sizeRatio.reduce((a, b) => a + b, 0) > 0)) return { ok: false, error: 'The size ratio cannot all be zero' }

  // A grid kept from before the sizes changed no longer lines up with them, so it falls back to the colour's total.
  let colours = (fallback?.colours || []).map(c => (c.sizes?.length === sizes.length ? { name: c.name, qty: c.qty, sizes: Array.from(c.sizes, Number) } : { name: c.name, qty: c.qty }))
  if (src.colours !== undefined) {
    if (!Array.isArray(src.colours) || src.colours.length > BOM_LIMITS.colours) return { ok: false, error: `At most ${BOM_LIMITS.colours} colours` }
    colours = []
    for (const c of src.colours) {
      const name = text(c?.name, 60)
      if (!name) return { ok: false, error: 'A colour has no name' }
      let qty = Number(c?.qty ?? 0)
      let grid = null
      if (c?.sizes !== undefined && c?.sizes !== null) {
        if (!Array.isArray(c.sizes) || c.sizes.length !== sizes.length) return { ok: false, error: `${name}: give the pieces for each of the ${sizes.length} sizes` }
        grid = c.sizes.map(v => (v === '' || v === null ? 0 : Number(v)))
        if (grid.some(v => !Number.isFinite(v) || v < 0 || v > 1e8)) return { ok: false, error: `${name}: the pieces of a size must be numbers from 0 up` }
        grid = grid.map(Math.round)
        qty = grid.reduce((a, b) => a + b, 0)
      }
      if (!Number.isFinite(qty) || qty < 0 || qty > 1e8) return { ok: false, error: `${name}: pieces must be a number from 0 up` }
      colours.push(grid ? { name, qty, sizes: grid } : { name, qty: Math.round(qty) })
    }
    if (new Set(colours.map(c => c.name.toLowerCase())).size !== colours.length) return { ok: false, error: 'Two colours have the same name' }
  }

  let totalQty = Number(fallback?.totalQty) || 0
  if (src.totalQty !== undefined) {
    totalQty = Number(src.totalQty)
    if (!Number.isFinite(totalQty) || totalQty < 0 || totalQty > 1e8) return { ok: false, error: 'The order quantity must be a number from 0 up' }
    totalQty = Math.round(totalQty)
  }
  return { ok: true, plan: { sizes, sizeRatio, colours, totalQty } }
}

/**
 * One line of a request. `previous` is the stored line with the same id, if any: a line from the AI
 * stops needing review once a person changes anything about it.
 * @returns {{ok: true, line: object} | {ok: false, error: string}}
 */
export function cleanBomLine(raw, position, sizeCount, previous = null) {
  const at = `Line ${position}`
  if (!raw || typeof raw !== 'object') return { ok: false, error: `${at}: is not valid` }
  const section = BOM_SECTIONS.includes(raw.section) ? raw.section : null
  if (!section) return { ok: false, error: `${at}: choose a section` }
  const item = text(raw.item, 200)
  if (!item) return { ok: false, error: `${at}: name the item` }
  const spec = text(raw.spec, 300)
  const unit = text(raw.unit, 20) || DEFAULT_UNIT[section]
  const note = text(raw.note, 300)

  const consumption = finite(raw.consumption) ?? 0
  if (!Number.isFinite(consumption) || consumption < 0 || consumption > 1e6) return { ok: false, error: `${at}: consumption must be a number from 0 up` }
  const wastagePct = finite(raw.wastagePct) ?? 0
  if (!Number.isFinite(wastagePct) || wastagePct < 0 || wastagePct > 100) return { ok: false, error: `${at}: wastage must be between 0 and 100` }
  const rate = finite(raw.rate) ?? 0
  if (!Number.isFinite(rate) || rate < 0 || rate > 1e8) return { ok: false, error: `${at}: rate must be a number from 0 up` }

  let perSize = []
  if (Array.isArray(raw.perSize)) {
    if (raw.perSize.length > BOM_LIMITS.sizes) return { ok: false, error: `${at}: too many sizes` }
    perSize = raw.perSize.map(v => finite(v))
    if (perSize.some(v => Number.isNaN(v) || (v !== null && (v < 0 || v > 1e6)))) return { ok: false, error: `${at}: a size's consumption must be a number from 0 up` }
  }
  perSize = Array.from({ length: sizeCount }, (_, i) => perSize[i] ?? null)
  if (perSize.every(v => v === null)) perSize = []

  const ids = {}
  for (const key of ['supplierId', 'itemId']) {
    const v = raw[key]
    if (v === null || v === undefined || v === '') ids[key] = null
    else if (!mongoose.Types.ObjectId.isValid(v)) return { ok: false, error: `${at}: the ${key === 'supplierId' ? 'supplier' : 'catalog item'} is not valid` }
    else ids[key] = String(v)
  }

  const line = {
    lineId: previous?.lineId || (typeof raw.lineId === 'string' && /^[a-f0-9]{24}$/.test(raw.lineId) ? raw.lineId : newLineId()),
    section, item, spec, unit,
    consumption: roundTo(consumption, 4), perSize: perSize.map(v => (v === null ? null : roundTo(v, 4))),
    wastagePct: roundTo(wastagePct, 2), perColour: typeof raw.perColour === 'boolean' ? raw.perColour : section === 'fabric',
    supplierId: ids.supplierId, itemId: ids.itemId, rate: roundTo(rate, 4), note,
    source: previous?.source || (raw.source === 'import' ? 'import' : 'manual'),
    confidence: previous?.confidence ?? null, needsReview: false, evidence: previous?.evidence || '',
  }
  // An AI line stays flagged until a person touches it.
  if (previous?.needsReview) {
    const same = ['section', 'item', 'spec', 'unit', 'consumption', 'wastagePct', 'rate', 'perColour'].every(k => String(previous[k]) === String(line[k]))
      && JSON.stringify(previous.perSize || []) === JSON.stringify(line.perSize)
      && String(previous.supplierId || '') === String(line.supplierId || '') && String(previous.itemId || '') === String(line.itemId || '')
    line.needsReview = same
    // "Looks right": the person checked this line as it is. Like confirm-all this is their say, not the browser's guess.
    if (raw.confirmed === true) line.needsReview = false
  }
  return { ok: true, line }
}

/**
 * What a new BOM starts as, from the order and the factory's split of it: the standard sizes and ratio, the
 * order's colourways sharing the quantity (the first takes the remainder), and the split's quantity.
 */
export function seedPlan(order, asgn) {
  const totalQty = Number(asgn?.qty) || 0
  const names = (order?.colourways || []).map(c => c.name).filter(Boolean)
  let colours
  if (names.length) {
    const each = Math.floor(totalQty / names.length)
    colours = names.map((name, i) => ({ name, qty: each + (i === 0 ? totalQty - each * names.length : 0) }))
  } else colours = totalQty ? [{ name: 'All', qty: totalQty }] : []
  return { sizes: [...DEFAULT_SIZES], sizeRatio: [...DEFAULT_RATIO], colours, totalQty }
}

/** A stored BOM as the browser sees it, every line worked (bomMath.js). */
export function bomView(bom, { supplierNames = new Map() } = {}) {
  const plan = { sizes: bom.sizes || [], ratio: bom.sizeRatio || [], colours: bom.colours || [] }
  const worked = computeBom(plan, bom.lines || [], { totalQty: bom.totalQty || null })
  return {
    id: String(bom._id), orderId: bom.orderId, version: bom.version, status: bom.status,
    plan: { sizes: worked.plan.sizes, ratio: worked.plan.ratio, colours: worked.plan.colours, totalQty: bom.totalQty || 0 },
    lines: worked.lines.map(l => ({
      lineId: l.lineId, section: l.section, item: l.item, spec: l.spec || '', unit: l.unit || '',
      consumption: l.consumption || 0, perSize: l.perSize || [], wastagePct: l.wastagePct || 0, perColour: !!l.perColour,
      supplierId: l.supplierId ? String(l.supplierId) : null, supplierName: l.supplierId ? supplierNames.get(String(l.supplierId)) || '' : '',
      itemId: l.itemId ? String(l.itemId) : null, rate: l.rate || 0, note: l.note || '',
      source: l.source || 'manual', confidence: l.confidence ?? null, needsReview: !!l.needsReview, evidence: l.evidence || '',
      computed: l.computed,
    })),
    warnings: worked.warnings,
    techPackDocumentId: bom.techPackDocumentId ? String(bom.techPackDocumentId) : null,
    extraction: bom.extraction ? { at: bom.extraction.at, model: bom.extraction.model, confidence: bom.extraction.confidence, notes: bom.extraction.notes || [] } : null,
    frozenAt: bom.frozenAt || null, createdAt: bom.createdAt, updatedAt: bom.updatedAt,
  }
}

export const bomSummary = bom => ({
  id: String(bom._id), orderId: bom.orderId, version: bom.version, status: bom.status,
  lineCount: (bom.lines || []).length, frozenAt: bom.frozenAt || null, updatedAt: bom.updatedAt,
})
