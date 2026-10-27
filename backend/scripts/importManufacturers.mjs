// Loads the research spreadsheets into the Partner Directory: creates the partners that are new, MERGES into the ones already
// on file (fills what is blank, adds contacts and keywords, appends notes; never replaces what a person entered, never touches
// verification) and takes out of the active list the entries that are not production units. Idempotent: a second run plans nothing.
//
//   Athleisure_LowMOQ_Manufacturer_Plan.xlsx, sheet "Leads"
//   Cocoblu_Vendor_Contacts_Clean.xlsx, sheet "Vendors (deduped)"
//   Amazon_Mined_Manufacturers.xlsx, sheet "Manufacturers (deduped)"
//
//   node --env-file=.env.sandbox scripts/importManufacturers.mjs            dry run: print the plan, write nothing
//   node --env-file=.env.sandbox scripts/importManufacturers.mjs --apply    write it, audit it, add the new partners to the images report
//   options: --leads=<xlsx> --vendors=<xlsx> --amazon=<xlsx>   (defaults: ../Tradio Market Research/ next to this repo)
//            --report=<md>                                       (the images report to append to; default reports/partners_needing_images.md)
//
// exceljs is a devDependency: this is a one-off tool, not part of the deployed server.
import fs from 'node:fs'
import path from 'node:path'
import ExcelJS from 'exceljs'
import { Manufacturer } from '../src/models/Manufacturer.js'
import { AuditLog } from '../src/models/AuditLog.js'
import { cleanPartnerInput } from '../src/lib/partners.js'
import { planMerge, REMOVE_REASON } from '../src/lib/partnerMerge.js'
import { leadToPartner, vendorToPartner, amazonToPartner } from '../src/lib/partnerSeed.js'
import { appendToImageReport, imageReportMarkdown } from '../src/lib/partnerImagePrompts.js'
import { connectGuarded, disconnect, apply, flag, repoDir, fail, today, brandPrimary } from './partners-shared.mjs'

const researchDir = path.resolve(repoDir, '..', 'Tradio Market Research')
const leadsFile = flag('leads') || path.join(researchDir, 'Athleisure_LowMOQ_Manufacturer_Plan.xlsx')
const vendorsFile = flag('vendors') || path.join(researchDir, 'Cocoblu_Vendor_Contacts_Clean.xlsx')
const amazonFile = flag('amazon') || path.join(researchDir, 'Amazon_Mined_Manufacturers.xlsx')
const reportFile = flag('report') || path.join(repoDir, 'reports', 'partners_needing_images.md')

const cellText = v => {
  if (v === undefined || v === null) return ''
  if (typeof v !== 'object') return String(v)
  if (v.richText) return v.richText.map(r => r.text).join('')
  return String(v.text ?? v.result ?? v.hyperlink ?? '')
}

/** The rows of a sheet as { header: text } objects. The header row is the one with `anchor` among its cells; the data ends
 * where the "#" column stops being a number (these sheets have a computed summary below their data). */
async function readSheet(file, sheetName, anchor) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(file).catch(err => fail(`Could not read ${file}: ${err.message}`))
  const ws = wb.getWorksheet(sheetName)
  if (!ws) fail(`${path.basename(file)} has no sheet named "${sheetName}" (it has: ${wb.worksheets.map(w => w.name).join(', ')})`)
  let headers = null
  const rows = []
  ws.eachRow(row => {
    const cells = Array.from({ length: ws.columnCount }, (_, i) => cellText(row.getCell(i + 1).value).trim())
    if (!headers) { if (cells.some(c => c === anchor)) headers = cells; return }
    if (!/^\d+$/.test(cells[0])) return
    rows.push(Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ''])))
  })
  if (!headers) fail(`${path.basename(file)} / ${sheetName}: no header row with a "${anchor}" column`)
  return rows
}

// The date the research files were captured, not today's: it goes into the source text, and a source line that changed with the
// day would be appended again on every run.
const importedOn = '2026-10-27'
const sources = [
  { label: 'Leads', rows: await readSheet(leadsFile, 'Leads', 'Company'), map: r => leadToPartner(r, { importedOn }) },
  { label: 'Vendors', rows: await readSheet(vendorsFile, 'Vendors (deduped)', 'Company'), map: r => vendorToPartner(r, { importedOn }) },
  { label: 'Amazon', rows: await readSheet(amazonFile, 'Manufacturers (deduped)', 'Manufacturer (canonical)'), map: r => amazonToPartner(r) },
]

// Clean every row the same way the API would (tags, contacts, enums); a row that fails is reported, not imported.
const incoming = []
const rejected = []
for (const s of sources) {
  for (const [i, raw] of s.rows.entries()) {
    const body = s.map(raw)
    if (!body) continue
    const cleaned = cleanPartnerInput(body)
    if (cleaned.errors) { rejected.push({ source: s.label, row: i + 5, name: body.name, errors: cleaned.errors }); continue }
    incoming.push({ source: s.label, body: cleaned.data })
  }
}
console.log(`[partners] read ${sources.map(s => `${s.rows.length} ${s.label}`).join(', ')} rows (${incoming.length} usable, ${rejected.length} rejected)`)

await connectGuarded()
if (apply) await Manufacturer.init()
const existing = await Manufacturer.find({}).lean()
const plan = planMerge(existing, incoming)

// ── The plan, printed ────────────────────────────────────────────────────────────────────────────────────────────
const short = v => {
  if (Array.isArray(v)) return v.length ? `[${v.map(x => (typeof x === 'object' ? (x.name || x.email || x.phone || '?') : x)).join(', ')}]` : '[]'
  const t = v === undefined || v === null || v === '' ? '(blank)' : String(v).replace(/\s+/g, ' ')
  return t.length > 90 ? `${t.slice(0, 87)}...` : t
}
const added = (from = [], to = []) => to.filter(x => !from.some(y => JSON.stringify(y) === JSON.stringify(x)))
const showDiff = d => (Array.isArray(d.to)
  ? `${d.field}: +${short(added(d.from, d.to).map(x => x))}`
  : d.field === 'notes' || d.field === 'source' ? `${d.field}: appended ${short(String(d.to).slice(String(d.from || '').length).trim())}`
  : `${d.field}: ${short(d.from)} -> ${short(d.to)}`)

console.log(`\n=== TO CREATE (${plan.create.length})`)
for (const b of plan.create) console.log(`  + ${b.name} | ${b.type} | ${b.city || 'no city'} | cluster ${b.cluster || 'none'} | categories ${(b.categories || []).join(',') || 'none'} | brands ${(b.brands || []).join(', ') || 'none'} | from ${b._sources.join('+')}`)
console.log(`\n=== TO UPDATE (${plan.update.length})`)
for (const u of plan.update) {
  console.log(`  ~ ${u.partner.name} (from ${u.sources.join('+')})`)
  for (const d of u.diffs) console.log(`      ${showDiff(d)}`)
}
console.log(`\n=== TO DEACTIVATE (${plan.deactivate.length})  [isActive false, status off_scope, audit "${REMOVE_REASON}"]`)
for (const d of plan.deactivate) console.log(`  - ${d.partner.name} (${d.partner.status}${d.partner.isActive === false ? ', already inactive' : ''})`)
const interesting = plan.skipped.filter(s => s.reason !== 'already up to date')
console.log(`\n=== SKIPPED (${plan.skipped.length}): ${plan.skipped.length - interesting.length} already up to date${interesting.length ? '; others:' : ''}`)
for (const s of interesting) console.log(`  . ${s.name}: ${s.reason}`)
if (rejected.length) {
  console.log(`\n=== REJECTED ROWS (${rejected.length})`)
  for (const r of rejected) console.log(`  ! ${r.source} row ${r.row} "${r.name}": ${r.errors.join('; ')}`)
}
console.log(`\n[partners] plan: ${plan.create.length} to create, ${plan.update.length} to update, ${plan.deactivate.length} to deactivate, ${plan.skipped.length} skipped.`)

if (!apply) {
  console.log('[partners] dry run only: nothing was written. Re-run with --apply to write.')
  await disconnect()
  process.exit(rejected.length ? 1 : 0)
}

// ── Write ────────────────────────────────────────────────────────────────────────────────────────────────────────
const createdNames = []
for (const { _sources, ...body } of plan.create) {
  try { await Manufacturer.create({ ...body, createdBy: null, updatedBy: null }); createdNames.push(body.name) } catch (err) { console.log(`[partners] FAILED to create "${body.name}": ${err.message}`) }
}
let updated = 0
for (const u of plan.update) {
  await Manufacturer.updateOne({ _id: u.partner._id }, { $set: u.patch })
  await AuditLog.create({ byUser: null, action: 'Partner Updated', detail: `${u.partner.name}: merged from ${u.sources.join(', ')} (${u.diffs.map(d => d.field).join(', ')}) (script, on Ankit's instruction)`.slice(0, 1000) })
  updated++
}
let deactivated = 0
for (const d of plan.deactivate) {
  await Manufacturer.updateOne({ _id: d.partner._id }, { $set: { isActive: false, status: 'off_scope' } })
  await AuditLog.create({ byUser: null, action: 'Partner Updated', detail: `${d.partner.name}: ${d.reason} (isActive false, status off_scope) (script, on Ankit's instruction)` })
  deactivated++
}
if (createdNames.length) await AuditLog.create({ byUser: null, action: 'Partners Imported', detail: `${createdNames.length} partner${createdNames.length === 1 ? '' : 's'} created from the Amazon listing mining, Leads and Vendors sheets (script, on Ankit's instruction)` })

// New partners go on the images report, in the same prompt style.
if (createdNames.length) {
  const fresh = await Manufacturer.find({ name: { $in: createdNames }, isActive: { $ne: false } }, 'name type city cluster categories products keywords notes').sort({ name: 1 }).lean()
  const primary = brandPrimary()
  fs.mkdirSync(path.dirname(reportFile), { recursive: true })
  const have = fs.existsSync(reportFile) ? fs.readFileSync(reportFile, 'utf8') : imageReportMarkdown([], { primary, generatedOn: today() })
  const out = appendToImageReport(have, fresh, { primary })
  fs.writeFileSync(reportFile, out.md)
  console.log(`[partners] ${out.added.length} new partner${out.added.length === 1 ? '' : 's'} appended to ${reportFile}`)
}

console.log(`\n[partners] DONE: ${createdNames.length} created, ${updated} updated, ${deactivated} deactivated.`)
console.log(`[partners] new partners: ${createdNames.join(', ') || 'none'}`)
await disconnect()
