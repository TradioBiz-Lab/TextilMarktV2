// One-off: file a folder of measurement (spec) sheets on the NPD / Replen styles they belong to. A sheet is matched to a style
// by the style code in its file name (WD-4002, WSK-4001, WB-4005, WS-2605; WDR is read as WD), against the style number on file.
// Each is added as a Measurements document, never locked (a master admin locks one in the app, if ever). The label comes from the
// workbook's own tabs, and the latest stage wins: a PP tab (PP, RPP) means PP Approval, else a fit tab (FIT, NPD) means Fit
// Approval, else Customer Submission. --label=<one of them> sets it for every sheet instead. A style that already has the same
// file is not given a second copy; if that copy has no label yet, it gets this one. Safe to run twice.
//
//   node --env-file=.env.sandbox scripts/uploadMeasurementSheets.mjs --dir="/path/to/folder" --by=email@tradiobiz.com            dry run
//   node --env-file=.env.sandbox scripts/uploadMeasurementSheets.mjs --dir="/path/to/folder" --by=email@tradiobiz.com --apply    file them
//   --label=auto (default) | customer_submission | fit_approval | pp_approval
//
// Production needs CONFIRM_DB=<its exact name> as well (see partners-shared.mjs), and nobody should do that without asking.
import fs from 'node:fs'
import path from 'node:path'
import mongoose from 'mongoose'
import JSZip from 'jszip'
import { Document, MEASUREMENT_LABELS, MEASUREMENT_LABEL_NAMES } from '../src/models/Document.js'
import { AuditLog } from '../src/models/AuditLog.js'
import { connectGuarded, disconnect, apply, flag } from './partners-shared.mjs'

const dir = flag('dir'), by = flag('by'), forced = flag('label') || 'auto'
if (!dir || !by) { console.error('[sheets] --dir and --by are required.'); process.exit(1) }
if (forced !== 'auto' && !MEASUREMENT_LABELS.includes(forced)) { console.error(`[sheets] --label must be auto or one of: ${MEASUREMENT_LABELS.join(', ')}`); process.exit(1) }

/** The label a workbook's tabs point to (the latest stage wins), with the tab names it was read from. */
async function labelOf(bytes) {
  if (forced !== 'auto') return { label: forced, why: 'set by --label' }
  const wb = await (await JSZip.loadAsync(bytes)).file('xl/workbook.xml')?.async('string') || ''
  const tabs = [...wb.matchAll(/<sheet\s[^>]*name="([^"]+)"/g)].map(m => m[1].trim())
  const why = `tabs ${tabs.join(', ')}`
  if (tabs.some(t => /^R?PP\b/i.test(t))) return { label: 'pp_approval', why }
  if (tabs.some(t => /^(FIT|NPD)\b/i.test(t))) return { label: 'fit_approval', why }
  return { label: 'customer_submission', why: `${why} (no stage tab)` }
}
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const keyOf = s => { const m = /(WDR|WSK|WB|WD|WS)-?(\d{4})/i.exec(String(s || '')); return m ? `${m[1].toUpperCase() === 'WDR' ? 'WD' : m[1].toUpperCase()}-${m[2]}` : null }

const files = fs.readdirSync(dir).filter(f => /\.xlsx$/i.test(f) && !f.startsWith('.')).sort()
await connectGuarded()
const user = await mongoose.connection.collection('users').findOne({ email: by.toLowerCase(), role: 'admin' }, { projection: { name: 1 } })
if (!user) { console.error(`[sheets] no admin with the email ${by}`); await disconnect(); process.exit(1) }
const styles = await mongoose.connection.collection('orders').find({ phase: { $in: ['development', 'replen'] } }, { projection: { product: 1, styleNumber: 1 } }).toArray()

const plan = [], used = new Set()
for (const f of files) {
  const key = keyOf(f)
  const hits = styles.filter(s => keyOf(s.styleNumber) === key)
  if (!key || hits.length !== 1) { console.log(`[sheets] ${f}: ${!key ? 'no style code in the name' : hits.length ? `matches ${hits.length} styles (${hits.map(h => h._id).join(', ')})` : `no NPD/Replen style with ${key}`}, left alone`); continue }
  const s = hits[0]
  used.add(s._id)
  const bytes = fs.readFileSync(path.join(dir, f))
  if (bytes.length > 10 * 1024 * 1024) { console.log(`[sheets] ${f}: over 10MB, left alone`); continue }
  const there = await Document.findOne({ orderId: s._id, type: 'measurements', isActive: true, fileName: f }, { measurementLabel: 1 }).lean()
  const { label, why } = await labelOf(bytes)
  const relabel = there && !there.measurementLabel
  const verb = there ? (relabel ? (apply ? 'label the copy already filed on' : 'would label the copy already filed on') : 'already filed, labelled, on') : (apply ? 'file' : 'would file')
  console.log(`[sheets] ${verb} ${f}  ->  ${s._id} ${s.styleNumber} (${s.product}), ${Math.round(bytes.length / 1024)}KB: ${MEASUREMENT_LABEL_NAMES[label]} (${why})`)
  if (!there || relabel) plan.push({ f, s, bytes, label, existingId: there?._id || null })
}
for (const s of styles.filter(x => !used.has(x._id))) console.log(`[sheets] no sheet for ${s._id} ${s.styleNumber} (${s.product})`)

if (apply && plan.length) {
  for (const { f, s, bytes, label, existingId } of plan) {
    if (existingId) { await Document.updateOne({ _id: existingId, measurementLabel: null }, { $set: { measurementLabel: label } }); continue }
    await Document.create({
      type: 'measurements', name: `Measurements, ${s._id}`, orderId: s._id, mfrId: null, issueDate: new Date(), uploadedBy: user._id,
      version: 1, isActive: true, measurementLabel: label,
      dataUrl: `data:${XLSX};base64,${bytes.toString('base64')}`, fileName: f, fileSize: bytes.length, mimeType: XLSX,
    })
  }
  await AuditLog.create({ byUser: user._id, action: 'Document Uploaded', detail: `Measurement sheets from the sourcing folder filed on the replen styles, none locked (script, on Ankit's instruction): ${plan.map(p => `${p.s._id} ${MEASUREMENT_LABEL_NAMES[p.label]}${p.existingId ? ' (label added to the copy already there)' : ''}`).join(', ')}` })
}
console.log(`[sheets] ${files.length} sheet${files.length === 1 ? '' : 's'}: ${plan.filter(p => !p.existingId).length} ${apply ? 'filed' : 'to file'}, ${plan.filter(p => p.existingId).length} ${apply ? 'labelled' : 'to label'}. Nothing is locked.`)
if (!apply && plan.length) console.log('[sheets] dry run only. Re-run with --apply to write.')
await disconnect()
