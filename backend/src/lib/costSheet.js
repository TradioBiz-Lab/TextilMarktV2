// Checking and shaping cost sheets: what a request may say, and what each side is shown. The arithmetic
// is lib/costing.js and is never done here.
import { computeCostSheet, MATERIAL_SECTIONS, DEFAULT_PERCENTS } from './costing.js'
import { roundTo } from './bomMath.js'

export const SHEET_LIMITS = { linesPerSection: 60 }

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const num = v => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : NaN)

/** One material line. @returns {{ok: true, line} | {ok: false, error}} */
export function cleanMaterial(raw, label) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: `${label}: is not valid` }
  const name = text(raw.name, 120)
  if (!name) return { ok: false, error: `${label}: name the item` }
  const field = (key, { min = 0, max, fallback = 0, what }) => {
    const v = num(raw[key]) ?? fallback
    if (!Number.isFinite(v) || v < min || v > max) return { error: `${label}: ${what} must be between ${min} and ${max}` }
    return { v }
  }
  const consumption = field('consumption', { max: 1e6, fallback: 1, what: 'quantity per piece' })
  const wastage = field('wastagePct', { max: 100, what: 'wastage' })
  const rate = field('rate', { max: 1e8, what: 'rate' })
  const freight = field('freight', { max: 1e8, what: 'freight' })
  const duty = field('dutyPct', { max: 200, what: 'duty' })
  for (const f of [consumption, wastage, rate, freight, duty]) if (f.error) return { ok: false, error: f.error }
  return {
    ok: true,
    line: {
      name, spec: text(raw.spec, 200), unit: text(raw.unit, 20), consumption: roundTo(consumption.v, 4), wastagePct: roundTo(wastage.v, 2),
      rate: roundTo(rate.v, 4), freight: roundTo(freight.v, 4), dutyPct: roundTo(duty.v, 2), note: text(raw.note, 200),
    },
  }
}

/**
 * The editable part of a sheet from a request body; anything left out keeps the value in `fallback`.
 * `tradioEnabled` decides whether Tradio's fee line can be used at all: for any other factory it is
 * always zero, whatever the browser says.
 * @returns {{ok: true, data: object} | {ok: false, error: string}}
 */
export function cleanSheet(body, fallback = {}, { tradioEnabled = false } = {}) {
  const b = body && typeof body === 'object' ? body : {}
  const data = {}

  const styleName = b.styleName === undefined ? fallback.styleName : text(b.styleName, 120)
  if (!styleName) return { ok: false, error: 'Name the style' }
  data.styleName = styleName
  data.styleCode = b.styleCode === undefined ? fallback.styleCode || '' : text(b.styleCode, 60)
  data.internalNote = b.internalNote === undefined ? fallback.internalNote || '' : text(b.internalNote, 1000)

  const qty = b.qty === undefined ? Number(fallback.qty) || 0 : num(b.qty) ?? 0
  if (!Number.isFinite(qty) || qty < 0 || qty > 1e8) return { ok: false, error: 'The quantity must be a number from 0 up' }
  data.qty = Math.round(qty)

  for (const key of MATERIAL_SECTIONS) {
    const raw = b[key] === undefined ? fallback[key] || [] : b[key]
    if (!Array.isArray(raw) || raw.length > SHEET_LIMITS.linesPerSection) return { ok: false, error: `At most ${SHEET_LIMITS.linesPerSection} lines in each block` }
    data[key] = []
    for (const [i, r] of raw.entries()) {
      const c = cleanMaterial(r, `${LABELS[key]} line ${i + 1}`)
      if (!c.ok) return c
      data[key].push(c.line)
    }
  }

  const labourIn = b.labour === undefined ? fallback.labour || {} : b.labour
  data.labour = {}
  for (const key of ['cuttingThreads', 'making', 'finishingPacking']) {
    const v = labourIn && typeof labourIn === 'object' ? num(labourIn[key]) ?? 0 : 0
    if (!Number.isFinite(v) || v < 0 || v > 1e8) return { ok: false, error: 'Labour costs must be numbers from 0 up' }
    data.labour[key] = roundTo(v, 4)
  }

  const percent = (key, max, what) => {
    const v = b[key] === undefined ? Number(fallback[key] ?? DEFAULT_PERCENTS[key]) : num(b[key]) ?? DEFAULT_PERCENTS[key]
    if (!Number.isFinite(v) || v < 0 || v > max) return { error: `${what} must be between 0 and ${max}` }
    return { v: roundTo(v, 2) }
  }
  for (const [key, max, what] of [['overheadPct', 100, 'Overhead'], ['rejectionPct', 100, 'Rejection'], ['marginPct', 500, 'Margin'], ['tradioPct', 100, 'Tradio fee'], ['discountPct', 100, 'The negotiated discount']]) {
    const p = percent(key, max, what)
    if (p.error) return { ok: false, error: p.error }
    data[key] = p.v
  }
  if (!tradioEnabled) data.tradioPct = 0
  return { ok: true, data }
}

const LABELS = { fabric: 'Fabric', process: 'Process', trims: 'Trims', labelsPackaging: 'Labels and packaging' }

/** The figures for a sheet's inputs, with its quantity. */
export const computeFor = data => computeCostSheet(data)

/** What a version is called: its number and version, e.g. CS-TPR-2627-0003 v2. */
export const labelOf = sheet => `${sheet.chainId} v${sheet.version}`

const commentView = c => ({ id: String(c._id), at: c.at, by: c.byName || '', role: c.byRole, kind: c.kind || 'comment', text: c.text })

const base = (s, extra) => ({
  id: String(s._id), chainId: s.chainId, version: s.version, status: s.status,
  styleName: s.styleName, styleCode: s.styleCode || '', orderId: s.orderId || null, qty: s.qty || 0,
  fabric: s.fabric || [], process: s.process || [], trims: s.trims || [], labelsPackaging: s.labelsPackaging || [],
  labour: { cuttingThreads: s.labour?.cuttingThreads || 0, making: s.labour?.making || 0, finishingPacking: s.labour?.finishingPacking || 0 },
  overheadPct: s.overheadPct, rejectionPct: s.rejectionPct, marginPct: s.marginPct, tradioPct: s.tradioPct || 0, discountPct: s.discountPct || 0,
  computed: s.status === 'draft' || !s.computed ? computeFor(s) : s.computed,
  comments: (s.comments || []).map(commentView),
  sharedAt: s.sharedAt || null, sharedMessage: s.sharedMessage || '',
  approvedAt: s.approvedAt || null, approvedByName: s.approvedByName || '', approvedPrice: s.approvedPrice ?? null,
  createdAt: s.createdAt, updatedAt: s.updatedAt, ...extra,
})

/** A version as its factory sees it: everything, including its own note and the BOM it came from. */
export const factoryView = (s, extra = {}) => base(s, { internalNote: s.internalNote || '', bomId: s.bomId ? String(s.bomId) : null, brandId: String(s.brandId), ...extra })

/** A shared version as the brand sees it: no internal note, no BOM, never a draft. */
export const brandView = (s, extra = {}) => base(s, { mfrId: String(s.mfrId), ...extra })

/** One row of a list. */
export const summaryView = s => ({
  id: String(s._id), chainId: s.chainId, version: s.version, status: s.status, styleName: s.styleName, styleCode: s.styleCode || '',
  qty: s.qty || 0, price: s.computed?.price ?? null, negotiated: s.computed?.negotiated ?? null,
  discountPct: s.discountPct || 0, sharedAt: s.sharedAt || null, approvedAt: s.approvedAt || null,
  commentCount: (s.comments || []).length, updatedAt: s.updatedAt,
})
