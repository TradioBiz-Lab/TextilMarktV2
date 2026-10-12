// The cost sheet editor's state: what a person types (strings, so "1." can be half-typed) turned into the
// payload the server takes and the figures the live preview (costCalc.js) works with, plus the labels.
import { computeCostSheet, lineAmount, MATERIAL_SECTIONS } from './costCalc.js'

export { MATERIAL_SECTIONS }

export const BLOCKS = [
  { key: 'fabric', label: 'Fabric', hint: 'Cloth for one piece: quantity times its rate', unit: 'm' },
  { key: 'process', label: 'Process', hint: 'Branding, elastics, transfers, prints', unit: 'pcs' },
  { key: 'trims', label: 'Trims', hint: 'Zips, cords, stoppers, reflective strips', unit: 'pcs' },
  { key: 'labelsPackaging', label: 'Labels, tags and packaging', hint: 'Labels, polybag, carton, transport', unit: 'pcs' },
]

// What a version is called, and the tone it is drawn in. A brand reads "shared" as its own to-do.
export const COST_STATUS = {
  draft: { label: 'Draft', tone: 'neutral' },
  shared: { label: 'Shared', tone: 'info' },
  commented: { label: 'Comments', tone: 'warn' },
  approved: { label: 'Approved', tone: 'good' },
  superseded: { label: 'Replaced', tone: 'neutral' },
}
export function costStatus(status, { brand = false } = {}) {
  if (brand && status === 'shared') return { label: 'Needs your review', tone: 'info' }
  if (brand && status === 'commented') return { label: 'You commented', tone: 'warn' }
  return COST_STATUS[status] || { label: status, tone: 'neutral' }
}

/** Sheets a brand has yet to answer: shared, nothing said or approved yet. */
export const awaitingReview = rows => rows.filter(r => r.status === 'shared')

let keySeq = 0
const newKey = () => `c${++keySeq}`
const str = v => (v === null || v === undefined ? '' : String(v))
export const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
export const decimal = v => String(v ?? '').replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1')

export function blankMaterial(block) {
  const b = BLOCKS.find(x => x.key === block) || BLOCKS[0]
  return { key: newKey(), name: '', spec: '', unit: b.unit, consumption: block === 'fabric' ? '' : '1', wastagePct: '', rate: '', freight: '', dutyPct: '', note: '' }
}

const materialToForm = m => ({
  key: newKey(), name: m.name, spec: m.spec || '', unit: m.unit || '', consumption: str(m.consumption), wastagePct: m.wastagePct ? str(m.wastagePct) : '',
  rate: m.rate ? str(m.rate) : '', freight: m.freight ? str(m.freight) : '', dutyPct: m.dutyPct ? str(m.dutyPct) : '', note: m.note || '',
})

/** A server sheet as editable state. */
export function toForm(sheet) {
  const form = {
    styleName: sheet.styleName, styleCode: sheet.styleCode || '', qty: sheet.qty ? str(sheet.qty) : '', internalNote: sheet.internalNote || '',
    labour: { cuttingThreads: str(sheet.labour?.cuttingThreads || ''), making: str(sheet.labour?.making || ''), finishingPacking: str(sheet.labour?.finishingPacking || '') },
    overheadPct: str(sheet.overheadPct), rejectionPct: str(sheet.rejectionPct), marginPct: str(sheet.marginPct), tradioPct: str(sheet.tradioPct || 0), discountPct: sheet.discountPct ? str(sheet.discountPct) : '',
  }
  for (const k of MATERIAL_SECTIONS) form[k] = (sheet[k] || []).map(materialToForm)
  return form
}

const material = m => ({
  name: m.name, spec: m.spec, unit: m.unit, consumption: num(m.consumption), wastagePct: num(m.wastagePct), rate: num(m.rate),
  freight: num(m.freight), dutyPct: num(m.dutyPct), note: m.note,
})

/** The sheet as numbers: for the live preview and for the server. Lines with no name are left out. */
export function toNumbers(form) {
  const out = {
    styleName: form.styleName.trim(), styleCode: form.styleCode.trim(), qty: num(form.qty), internalNote: form.internalNote,
    labour: { cuttingThreads: num(form.labour.cuttingThreads), making: num(form.labour.making), finishingPacking: num(form.labour.finishingPacking) },
    overheadPct: num(form.overheadPct), rejectionPct: num(form.rejectionPct), marginPct: num(form.marginPct), tradioPct: num(form.tradioPct), discountPct: num(form.discountPct),
  }
  for (const k of MATERIAL_SECTIONS) out[k] = form[k].filter(m => m.name.trim()).map(m => material({ ...m, name: m.name.trim(), spec: m.spec.trim(), unit: m.unit.trim(), note: m.note.trim() }))
  return out
}

/** What one line of the form costs per piece, as it stands (a nameless line still shows what it would). */
export const lineAmountOf = l => lineAmount(material(l))

/** The editor's live figures. */
export const figures = form => computeCostSheet(toNumbers(form))

/** The body the server's save route takes. */
export const payloadFrom = (form, updatedAt) => ({ ...(updatedAt ? { updatedAt } : {}), ...toNumbers(form) })

export const isDirty = (form, saved) => JSON.stringify(toNumbers(form)) !== JSON.stringify(toNumbers(saved))
