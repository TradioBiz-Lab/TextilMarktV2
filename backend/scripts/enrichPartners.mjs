// Loads partner profiles read from brochures, certificates and web research into the Partner Directory.
// The input is a JSON array of records (see the field list in toBody below), one per company.
//
//   - A company not on file is created (status new, priority C).
//   - A company already on file is only filled in: an empty field gets a value, tag lists and contacts are added to,
//     and a dated block is appended to the notes. Nothing already typed in is replaced or removed, and status,
//     priority, verification and isActive are never touched. Archived partners are left alone.
// Certifications have no field of their own: they go into the keywords (so the search finds "gots") and the notes.
// Idempotent: a second run finds nothing to do.
//
//   node --env-file=.env.sandbox scripts/enrichPartners.mjs --file=/path/records.json            dry run
//   node --env-file=.env.sandbox scripts/enrichPartners.mjs --file=/path/records.json --apply    write
import fs from 'node:fs'
import { Manufacturer } from '../src/models/Manufacturer.js'
import { AuditLog } from '../src/models/AuditLog.js'
import { cleanPartnerInput, nameKey, companyKey, normTag } from '../src/lib/partners.js'
import { connectGuarded, disconnect, apply, flag, fail } from './partners-shared.mjs'

const file = flag('file')
if (!file) fail('Pass --file=<records.json>')
const records = JSON.parse(fs.readFileSync(file, 'utf8'))
const STAMP = flag('date') || '28 Nov 2026'

const str = v => (typeof v === 'string' ? v.replace(/—|–/g, '-').trim() : '')
const list = v => (Array.isArray(v) ? v.map(str).filter(Boolean) : [])
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 3).trimEnd()}...` : s)
const num = v => (Number.isInteger(v) && v > 0 ? v : null)

const CERT_TAGS = [
  [/gots|global organic textile/i, 'gots'], [/oeko/i, 'oeko-tex'], [/sedex|smeta/i, 'sedex'], [/bsci|amfori/i, 'bsci'],
  [/\bwrap\b/i, 'wrap'], [/\bgrs\b|global recycle/i, 'grs'], [/\bocs\b|organic content/i, 'ocs'], [/\biso\s*9001/i, 'iso 9001'],
  [/\biso\s*14001/i, 'iso 14001'], [/sa\s*8000/i, 'sa8000'], [/fair\s*trade/i, 'fairtrade'], [/\bbci\b|better cotton/i, 'bci'],
  [/higg/i, 'higg'], [/c-?tpat/i, 'c-tpat'], [/\brcs\b|recycled claim/i, 'rcs'], [/accord|rsc\b/i, 'accord'], [/leed/i, 'leed'],
]
const certTags = certs => [...new Set(certs.flatMap(c => CERT_TAGS.filter(([re]) => re.test(c)).map(([, t]) => t)))]

const CLUSTER = [[/tirup+ur/i, 'tiruppur'], [/ludhiana/i, 'ludhiana'], [/jaipur/i, 'jaipur'], [/kolkata|howrah/i, 'kolkata'],
  [/noida|delhi|gurugram|gurgaon|faridabad|ghaziabad|manesar/i, 'ncr']]
const clusterOf = r => {
  if (r.country && !/india/i.test(r.country)) return 'other'
  if (!str(r.city) && !str(r.address)) return undefined // nothing known about where it is
  return CLUSTER.find(([re]) => re.test(`${r.city} ${r.address}`))?.[1] || 'other'
}

/** The dated notes block for a record. Its first line is the marker that makes a re-run a no-op. */
function notesBlock(r) {
  const web = r.kind === 'web'
  const head = web ? `Web research, ${STAMP} (public pages, not verified by Tradio):`
    : r.kind === 'po' ? `From Tradio's purchase orders, read ${STAMP}:`
    : `From the profile on file (WorkDrive, Sourcing Team/Vendors), read ${STAMP}:`
  const lines = [head, str(r.summary)]
  const add = (label, v) => { if (str(v)) lines.push(`${label}: ${str(v)}`) }
  if (r.country && !/india/i.test(r.country)) add('Country', r.country)
  add('Established', r.established)
  add('Capacity', r.capacity)
  add('Workforce', r.workforce)
  add('Certifications', list(r.certifications).join(', '))
  add('Certificate details', r.certDetails)
  add('Came through', r.viaAgent)
  add('Note', r.extraNote)
  if (list(r.sourceFiles).length) add('Files', list(r.sourceFiles).join('; '))
  if (list(r.sourceUrls).length) add('Sources', list(r.sourceUrls).slice(0, 5).join(' '))
  return { head, text: lines.filter(Boolean).join('\n') }
}

/** A record as a partner body (before validation). */
function toBody(r) {
  const certs = list(r.certifications)
  const abroad = r.country && !/india/i.test(r.country)
  const city = str(r.city)
  const contacts = (Array.isArray(r.contacts) ? r.contacts : []).map(c => ({
    name: clip(str(c.name), 120), role: clip(str(c.role), 120), phone: clip(str(c.phone), 40),
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str(c.email)) ? str(c.email) : '', whatsapp: clip(str(c.whatsapp), 40),
  })).filter(c => Object.values(c).some(Boolean)).slice(0, 8)
  const website = str(r.website).split(/[\s,;]+/)[0] || ''
  const tags = (v, snake) => [...new Set(list(v).map(t => normTag(t, snake)).filter(t => t && t.length <= 60))].slice(0, 30)
  const keywords = [...new Set([...tags(r.keywords, false), ...certTags(certs),
    ...(abroad ? [normTag(r.country, false)] : []), ...(str(r.viaAgent) ? [`via ${normTag(r.viaAgent, false)}`.slice(0, 60)] : [])])].slice(0, 40)
  const m = r.machines || {}
  return {
    name: str(r.name), legalName: clip(str(r.legalName), 200), type: str(r.type) || 'unknown',
    categories: list(r.categories), cluster: clusterOf(r),
    city: clip(abroad && city && !new RegExp(r.country, 'i').test(city) ? `${city}, ${r.country}` : city || (abroad ? r.country : ''), 120),
    address: clip(str(r.address), 500), pincode: /^[A-Za-z0-9 -]{0,12}$/.test(str(r.pincode)) ? str(r.pincode) : '',
    products: tags(r.products, true), fabrics: tags(r.fabrics, true), fabricTypes: tags(r.fabricTypes, true), trimCategories: tags(r.trimCategories, true),
    machineCount: num(r.machineCount),
    machines: { flatlock: num(m.flatlock) || 0, coverstitch: num(m.coverstitch) || 0, overlock: num(m.overlock) || 0, singleNeedle: num(m.singleNeedle) || 0 },
    moqPerStyleColour: num(r.moqPerStyleColour), moqNote: clip(str(r.moqNote), 500),
    leadTimeDays: num(r.leadTimeDays), priceIndication: clip(str(r.priceIndication), 300),
    contacts, website: website.length <= 300 ? website : '',
    gstin: /^[0-9A-Z]{15}$/.test(str(r.gstin).toUpperCase()) ? str(r.gstin).toUpperCase() : '',
    udyam: /^[0-9A-Z-]{1,30}$/i.test(str(r.udyam)) ? str(r.udyam).toUpperCase() : '',
    mcaCin: /^[0-9A-Z]{1,25}$/i.test(str(r.mcaCin)) ? str(r.mcaCin).toUpperCase() : '',
    brands: [...new Set(list(r.brands).map(b => clip(b, 60)))].slice(0, 30), keywords,
  }
}

const digits = s => String(s || '').replace(/\D/g, '').slice(-10)
const sameContact = (a, b) => (a.email && b.email && a.email.toLowerCase() === b.email.toLowerCase())
  || (digits(a.phone) && digits(a.phone) === digits(b.phone)) || (!a.email && !a.phone && nameKey(a.name) === nameKey(b.name) && nameKey(a.role) === nameKey(b.role))
const TAG_FIELDS = ['categories', 'products', 'fabrics', 'fabricTypes', 'trimCategories', 'keywords', 'brands']
const FILL_TEXT = ['legalName', 'city', 'address', 'pincode', 'moqNote', 'priceIndication', 'website', 'gstin', 'udyam', 'mcaCin']
const FILL_NUM = ['machineCount', 'moqPerStyleColour', 'leadTimeDays']

/** What to set on an existing partner: only gaps are filled. */
function fillFor(p, body, block) {
  const set = {}
  for (const k of FILL_TEXT) if (!str(p[k]) && body[k]) set[k] = body[k]
  // A pincode found for another town than the one on file would only mislead (a company with two addresses).
  const town = v => str(v).toLowerCase().split(/[\s(,/]+/)[0]
  if (set.pincode && str(p.city) && town(p.city) !== town(body.city)) delete set.pincode
  for (const k of FILL_NUM) if ((p[k] === null || p[k] === undefined) && body[k] !== null) set[k] = body[k]
  if ((p.type === 'unknown' || !p.type) && body.type !== 'unknown') set.type = body.type
  if (!p.cluster && body.cluster) set.cluster = body.cluster
  for (const k of TAG_FIELDS) {
    const have = p[k] || []
    const add = body[k].filter(t => !have.some(h => h.toLowerCase() === t.toLowerCase()))
    if (add.length) set[k] = [...have, ...add].slice(0, 40)
  }
  const machines = {}
  for (const k of Object.keys(body.machines)) if (!(p.machines?.[k] > 0) && body.machines[k] > 0) machines[k] = body.machines[k]
  if (Object.keys(machines).length) set.machines = machines
  const haveC = p.contacts || []
  const addC = body.contacts.filter(c => !haveC.some(h => sameContact(c, h)))
  if (addC.length) set.contacts = [...haveC.map(({ name, role, phone, email, whatsapp }) => ({ name, role, phone, email, whatsapp })), ...addC].slice(0, 20)
  if (block.text.length > block.head.length + 1 && !(p.notes || '').includes(block.head)) {
    set.notes = clip(`${p.notes ? `${p.notes.trim()}\n\n` : ''}${block.text}`, 5000)
  }
  return set
}

await connectGuarded()
const existing = await Manufacturer.find({}).lean()
const byKey = new Map()
for (const p of existing) { byKey.set(nameKey(p.name), p); if (!byKey.has(`c:${companyKey(p.name)}`)) byKey.set(`c:${companyKey(p.name)}`, p) }

let created = 0; let updated = 0; let same = 0; let skipped = 0
for (const r of records) {
  const body = toBody(r)
  if (!body.name) { console.log('[partners] SKIP a record with no name'); skipped++; continue }
  const block = notesBlock(r)
  const p = byKey.get(nameKey(r.matchName || body.name)) || byKey.get(`c:${companyKey(r.matchName || body.name)}`)
  if (r.matchName && !p) { console.log(`[partners] SKIP "${body.name}": expected on file as "${r.matchName}" but it is not there`); skipped++; continue }
  if (p) {
    if (p.isActive === false) { console.log(`[partners] SKIP "${p.name}": archived`); skipped++; continue }
    const set = fillFor(p, body, block)
    if (!Object.keys(set).length) { same++; continue }
    const cleaned = cleanPartnerInput(set, { partial: true })
    if (cleaned.errors) { console.log(`[partners] SKIP "${p.name}": ${cleaned.errors.join('. ')}`); skipped++; continue }
    updated++
    console.log(`[partners] ${apply ? 'update' : 'would update'} "${p.name}": ${Object.keys(set).join(', ')}`)
    if (apply) {
      const $set = { ...cleaned.data }
      if ($set.machines) { for (const [k, v] of Object.entries($set.machines)) $set[`machines.${k}`] = v; delete $set.machines }
      await Manufacturer.updateOne({ _id: p._id }, { $set })
    }
    // Keep the copy in hand current, so a second record for the same partner builds on this one.
    Object.assign(p, { ...cleaned.data, machines: { ...(p.machines || {}), ...(cleaned.data.machines || {}) } })
  } else {
    const src = r.kind === 'web' ? `Web research, ${STAMP}` : `Manufacturer profile on file (WorkDrive, Sourcing Team/Vendors), added ${STAMP}`
    const full = { ...body, notes: clip(block.text, 5000), source: src, status: 'new', priority: 'C' }
    const cleaned = cleanPartnerInput(full)
    if (cleaned.errors) { console.log(`[partners] SKIP "${body.name}": ${cleaned.errors.join('. ')}`); skipped++; continue }
    created++
    console.log(`[partners] ${apply ? 'create' : 'would create'} "${body.name}" | ${body.type} | ${body.city || 'no city'} | ${body.cluster}${body.gstin ? ` | GSTIN ${body.gstin}` : ''}`)
    if (apply) { const doc = await Manufacturer.create(cleaned.data); byKey.set(nameKey(doc.name), doc.toObject()) }
    else byKey.set(nameKey(body.name), { ...full, isActive: true })
  }
}
if (apply && (created || updated)) {
  await AuditLog.create({ byUser: null, action: 'Partner Updated', detail: `Partner profiles loaded from the WorkDrive manufacturer profiles and web research: ${created} added, ${updated} filled in (script, on Ankit's instruction)` })
}
console.log(`[partners] ${records.length} records: ${created} ${apply ? 'created' : 'to create'}, ${updated} ${apply ? 'updated' : 'to update'}, ${same} already right, ${skipped} skipped.`)
if (!apply && (created || updated)) console.log('[partners] dry run only. Re-run with --apply to write.')
await disconnect()
