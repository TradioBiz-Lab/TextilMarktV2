// Seeds the Partner Directory from the two research spreadsheets. Idempotent on name (case-insensitive): a partner
// that is already in the directory is skipped, never updated, so re-running changes nothing.
//
//   Athleisure_LowMOQ_Manufacturer_Plan.xlsx, sheet "Leads"      -> imported first
//   Cocoblu_Vendor_Contacts_Clean.xlsx, sheet "Vendors (deduped)" -> imported second; a name already in the Leads file is skipped
//
//   node --env-file=.env.sandbox scripts/importManufacturers.mjs            dry run: report only
//   node --env-file=.env.sandbox scripts/importManufacturers.mjs --apply    write, then write reports/partners_needing_images.md
//   options: --leads=<xlsx> --vendors=<xlsx>   (defaults: ../Tradio Market Research/ next to this repo)
//
// exceljs is a devDependency: this is a one-off tool, not part of the deployed server.
import path from 'node:path'
import ExcelJS from 'exceljs'
import { Manufacturer } from '../src/models/Manufacturer.js'
import { runPartnerImport } from '../src/lib/partnerImport.js'
import { nameKey, companyKey } from '../src/lib/partners.js'
import { leadToPartner, vendorToPartner } from '../src/lib/partnerSeed.js'
import { connectGuarded, disconnect, apply, flag, repoDir, fail, today } from './partners-shared.mjs'
import { writeImageReport } from './partnersImageReport.mjs'

const researchDir = path.resolve(repoDir, '..', 'Tradio Market Research')
const leadsFile = flag('leads') || path.join(researchDir, 'Athleisure_LowMOQ_Manufacturer_Plan.xlsx')
const vendorsFile = flag('vendors') || path.join(researchDir, 'Cocoblu_Vendor_Contacts_Clean.xlsx')

const cellText = v => {
  if (v === undefined || v === null) return ''
  if (typeof v !== 'object') return String(v)
  if (v.richText) return v.richText.map(r => r.text).join('')
  return String(v.text ?? v.result ?? v.hyperlink ?? '')
}

/** The rows of a sheet as { header: text } objects: the header row is the one with a "Company" cell, and the data
 * ends where the "#" column stops being a number (the Leads sheet has a computed summary below its data). */
async function readSheet(file, sheetName) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(file).catch(err => fail(`Could not read ${file}: ${err.message}`))
  const ws = wb.getWorksheet(sheetName)
  if (!ws) fail(`${path.basename(file)} has no sheet named "${sheetName}" (it has: ${wb.worksheets.map(w => w.name).join(', ')})`)
  let headers = null
  const rows = []
  ws.eachRow((row, n) => {
    const cells = Array.from({ length: ws.columnCount }, (_, i) => cellText(row.getCell(i + 1).value).trim())
    if (!headers) { if (cells.some(c => c.trim() === 'Company')) headers = cells.map(c => c.trim()); return }
    if (!/^\d+$/.test(cells[0].trim())) return
    rows.push(Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ''])))
  })
  if (!headers) fail(`${path.basename(file)} / ${sheetName}: no header row with a "Company" column`)
  return rows
}

const importedOn = today()
const leads = (await readSheet(leadsFile, 'Leads')).map(r => leadToPartner(r, { importedOn })).filter(Boolean)
const vendorsAll = (await readSheet(vendorsFile, 'Vendors (deduped)')).map(r => vendorToPartner(r, { importedOn })).filter(Boolean)
const inLeads = new Set(leads.map(p => nameKey(p.name)))
const vendors = vendorsAll.filter(p => !inLeads.has(nameKey(p.name)))
const alsoInLeads = vendorsAll.filter(p => inLeads.has(nameKey(p.name)))
console.log(`[partners] read ${leads.length} leads and ${vendorsAll.length} vendors; ${alsoInLeads.length} vendor rows already in the Leads file: ${alsoInLeads.map(p => p.name).join(', ') || 'none'}`)

await connectGuarded()
if (apply) await Manufacturer.init()

// A row that is only another spelling of a partner already on file (or earlier in these files) is skipped, so a merged
// company is not brought back: "Sportking group (Sobhagia)" after it was merged into "Sportking (Sobhagia)".
const onFile = new Map((await Manufacturer.find({}, 'name').lean()).map(p => [companyKey(p.name), p.name]))
for (const p of leads) if (!onFile.has(companyKey(p.name))) onFile.set(companyKey(p.name), p.name)

let problems = 0
for (const [label, allRows] of [['Leads', leads], ['Vendors', vendors]]) {
  const rows = allRows.filter(p => {
    const other = onFile.get(companyKey(p.name))
    // The exact same name is the importer's own dedupe; only a different spelling is reported here.
    if (other && nameKey(other) !== nameKey(p.name)) { console.log(`  skipped "${p.name}" (same company as "${other}")`); return false }
    return true
  })
  const r = await runPartnerImport({ rows, dryRun: !apply, defaultType: 'unknown', userId: null })
  const n = apply ? r.created : r.wouldCreate
  console.log(`[partners] ${label}: ${n} ${apply ? 'created' : 'would be created'}, ${r.skipped.length} already in the directory, ${r.errors.length} rejected`)
  for (const s of r.skipped) console.log(`  skipped "${s.name}" (${s.reason === 'duplicate_existing' ? 'already in the directory' : `duplicate of row ${s.firstRow}`})`)
  for (const e of r.errors) { problems++; console.log(`  REJECTED row ${e.row} "${e.name}": ${e.errors.join('; ')}`) }
}

if (apply) {
  const { file, count } = await writeImageReport()
  console.log(`[partners] ${count} partner${count === 1 ? '' : 's'} need an image: see ${file}`)
} else {
  console.log('[partners] dry run only. Re-run with --apply to write.')
}
await disconnect()
if (problems) process.exitCode = 1
