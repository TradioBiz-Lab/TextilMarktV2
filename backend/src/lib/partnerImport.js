import Papa from 'papaparse'
import { Manufacturer } from '../models/Manufacturer.js'
import {
  cleanPartnerInput, nameKey, splitCell, splitPhone,
  normalizeType, normalizeCluster, normalizeStatus, normalizePriority, normalizeCategory,
} from './partners.js'

// Bulk loading for the Partner Directory: the CSV upload (parse, suggest a column mapping, map rows) and the one
// import runner that both the API (POST /api/manufacturers/import) and the seed scripts use, so a row is cleaned,
// de-duplicated (case-insensitive on name, against the directory and within the file) and reported the same way.

export const MAX_IMPORT_ROWS = 1000
export const MAX_CSV_CHARS = 2_000_000

// The fields a CSV column can fill. `aliases` are matched against the header with case, spacing and punctuation
// folded away. The contact* fields build one contact per ';'-separated entry, in step with each other.
export const PARTNER_CSV_FIELDS = [
  { key: 'name', label: 'Name', aliases: ['name', 'company', 'companyname', 'partner', 'partnername', 'vendor', 'vendorname', 'manufacturer', 'firm', 'supplier'] },
  { key: 'legalName', label: 'Legal name', aliases: ['legalname', 'registeredname'] },
  { key: 'type', label: 'Type', aliases: ['type', 'category', 'partnertype', 'kind'] },
  { key: 'categories', label: 'Categories', aliases: ['categories', 'segment', 'segments', 'market', 'markets', 'productcategory', 'productcategories'] },
  { key: 'cluster', label: 'Cluster', aliases: ['cluster', 'region', 'hub'] },
  { key: 'city', label: 'City', aliases: ['city', 'town', 'location'] },
  { key: 'address', label: 'Address', aliases: ['address'] },
  { key: 'pincode', label: 'Pincode', aliases: ['pincode', 'pin', 'zip', 'zipcode', 'postalcode'] },
  { key: 'products', label: 'Specialised products (added as keywords)', aliases: ['products', 'product', 'capability', 'capabilities', 'whattheymake', 'whatthedo'] },
  { key: 'fabrics', label: 'Fabrics (experience)', aliases: ['fabrics', 'fabric', 'fabricexperience'] },
  { key: 'fabricTypes', label: 'Fabric types (supplier)', aliases: ['fabrictypes', 'fabrictype'] },
  { key: 'trimCategories', label: 'Trim categories', aliases: ['trimcategories', 'trimcategory', 'trims'] },
  { key: 'machines.flatlock', label: 'Flatlock machines', aliases: ['flatlock', 'flatlockmachines'] },
  { key: 'machines.coverstitch', label: 'Coverstitch machines', aliases: ['coverstitch', 'coverstitchmachines'] },
  { key: 'machines.overlock', label: 'Overlock machines', aliases: ['overlock', 'overlockmachines'] },
  { key: 'machines.singleNeedle', label: 'Single needle machines', aliases: ['singleneedle', 'singleneedlemachines'] },
  { key: 'moqPerStyleColour', label: 'MOQ (pieces)', aliases: ['moq', 'moqclaim', 'moqpcs', 'minimumorder', 'minimumorderquantity'] },
  { key: 'moqNote', label: 'MOQ note', aliases: ['moqnote', 'moqnotes'] },
  { key: 'priceIndication', label: 'Price indication', aliases: ['price', 'priceindication', 'pricing'] },
  { key: 'leadTimeDays', label: 'Lead time (days)', aliases: ['leadtime', 'leadtimedays'] },
  { key: 'contactName', label: 'Contact name', aliases: ['contact', 'contactname', 'contactperson', 'contacts', 'contactnames'] },
  { key: 'contactRole', label: 'Contact role', aliases: ['role', 'designation', 'contactrole'] },
  { key: 'contactPhone', label: 'Contact phone', aliases: ['phone', 'phones', 'mobile', 'phonenumber', 'contactphone', 'telephone', 'tel'] },
  { key: 'contactEmail', label: 'Contact email', aliases: ['email', 'emails', 'emailid', 'contactemail', 'mail'] },
  { key: 'contactWhatsapp', label: 'Contact WhatsApp', aliases: ['whatsapp', 'whatsappnumber'] },
  { key: 'website', label: 'Website', aliases: ['website', 'web', 'url', 'site'] },
  { key: 'gstin', label: 'GSTIN', aliases: ['gstin', 'gst', 'gstno', 'gstnumber'] },
  { key: 'udyam', label: 'Udyam', aliases: ['udyam', 'udyamnumber', 'udyamno'] },
  { key: 'mcaCin', label: 'CIN', aliases: ['cin', 'mcacin'] },
  { key: 'status', label: 'Status', aliases: ['status', 'stage'] },
  { key: 'priority', label: 'Priority', aliases: ['priority'] },
  { key: 'source', label: 'Source', aliases: ['source', 'leadsource'] },
  { key: 'keywords', label: 'Keywords', aliases: ['keywords', 'tags'] },
  { key: 'notes', label: 'Notes', aliases: ['notes', 'note', 'remarks', 'comments', 'confidence', 'nextaction'] },
]
const FIELD_KEYS = new Set(PARTNER_CSV_FIELDS.map(f => f.key))
const LIST_FIELDS = new Set(['products', 'fabrics', 'fabricTypes', 'trimCategories', 'keywords', 'categories'])

const fold = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
const cellText = v => (v === undefined || v === null ? '' : String(v).trim())

/** Parses CSV text: { headers, rows } (rows are objects keyed by header) or { error }. */
export function parsePartnerCsv(text) {
  if (typeof text !== 'string' || !text.trim()) return { error: 'The file is empty' }
  if (text.length > MAX_CSV_CHARS) return { error: 'The file is too large (max 2 MB)' }
  const parsed = Papa.parse(text.replace(/^﻿/, ''), {
    header: true, skipEmptyLines: 'greedy', transformHeader: h => String(h ?? '').trim(),
  })
  const headers = (parsed.meta.fields || []).filter(Boolean)
  const fatal = parsed.errors.find(e => e.type === 'Quotes')
  if (headers.length === 0) return { error: 'No header row found' }
  if (fatal) return { error: `The file could not be read: ${fatal.message}` }
  if (parsed.data.length === 0) return { error: 'The file has a header row but no data rows' }
  if (parsed.data.length > MAX_IMPORT_ROWS) return { error: `Too many rows (max ${MAX_IMPORT_ROWS} per file)` }
  const rows = parsed.data.map(r => Object.fromEntries(headers.map(h => [h, cellText(r[h])])))
  return { headers, rows }
}

/** The best guess for which field each header fills: { [header]: fieldKey | null }. A field is claimed once. */
export function suggestPartnerMapping(headers) {
  const claimed = new Set()
  const out = {}
  const score = (h, f) => {
    let best = 0
    for (const a of f.aliases) {
      if (h === a) return 100 + a.length
      if (a.length >= 4 && h.startsWith(a)) best = Math.max(best, a.length)
    }
    return best
  }
  // Exact matches first across all headers, then prefix matches, so "Contact" cannot take "Contact email"'s place.
  const ranked = headers.flatMap(h => PARTNER_CSV_FIELDS.map(f => ({ h, f, s: score(fold(h), f) }))).filter(x => x.s > 0).sort((a, b) => b.s - a.s)
  for (const h of headers) out[h] = null
  for (const { h, f } of ranked) {
    if (out[h] || claimed.has(f.key)) continue
    out[h] = f.key
    claimed.add(f.key)
  }
  return out
}

/** Parallel lists of names, roles, phones, emails and WhatsApp numbers (one entry per person) -> contact entries. */
export function zipContacts({ name = [], role = [], phone = [], email = [], whatsapp = [] }) {
  const n = Math.max(name.length, role.length, phone.length, email.length, whatsapp.length)
  return Array.from({ length: n }, (_, i) => ({ name: name[i] || '', role: role[i] || '', phone: phone[i] || '', email: email[i] || '', whatsapp: whatsapp[i] || '' }))
}

/** One CSV record plus a { header: fieldKey } mapping -> a partner body (still to be cleaned by cleanPartnerInput). */
export function mapPartnerRecord(record, mapping) {
  const out = {}
  const contact = { name: [], role: [], phone: [], email: [], whatsapp: [] }
  const notes = []
  for (const [header, field] of Object.entries(mapping || {})) {
    if (!field || !FIELD_KEYS.has(field)) continue
    const raw = cellText(record?.[header])
    if (!raw) continue
    // Specialised products are kept as keywords (generic garments are the category's job), so this column feeds them.
    if (LIST_FIELDS.has(field)) { const to = field === 'products' ? 'keywords' : field; out[to] = [...(out[to] || []), ...splitCell(raw)] }
    else if (field.startsWith('contact')) {
      const part = field.slice(7).toLowerCase()
      if (part === 'phone') for (const piece of splitCell(raw, ';,')) { const p = splitPhone(piece); contact.phone.push(p.phone); contact.whatsapp.push(p.whatsapp) }
      else contact[part].push(...splitCell(raw, part === 'name' || part === 'role' ? ';' : ';,'))
    } else if (field.startsWith('machines.')) out.machines = { ...(out.machines || {}), [field.slice(9)]: raw }
    else if (field === 'notes') notes.push({ header, raw })
    else if (out[field] === undefined) out[field] = raw
  }
  if (notes.length) out.notes = notes.length === 1 ? notes[0].raw : notes.map(n => `${n.header}: ${n.raw}`).join('\n')
  const contacts = zipContacts(contact)
  if (contacts.length) out.contacts = contacts
  // Forgiving spellings of the enum columns; whatever cannot be read is left as typed, so the row reports it.
  if (out.type !== undefined) out.type = normalizeType(out.type) ?? out.type
  if (out.cluster !== undefined) out.cluster = normalizeCluster(out.cluster, out.city) ?? undefined
  else if (out.city) { const c = normalizeCluster('', out.city); if (c) out.cluster = c }
  // A category word that is not one of the five stays as typed, so the row reports it.
  if (out.categories) out.categories = out.categories.map(c => normalizeCategory(c) ?? c)
  if (out.status !== undefined) out.status = normalizeStatus(out.status) ?? out.status
  if (out.priority !== undefined) out.priority = normalizePriority(out.priority) ?? out.priority
  if (out.moqPerStyleColour !== undefined) {
    // "100 pcs/style" -> 100, with the words kept in the note; anything else is a note only.
    const m = /\d[\d,]*/.exec(String(out.moqPerStyleColour))
    if (!/^\s*\d+\s*$/.test(String(out.moqPerStyleColour))) out.moqNote = out.moqNote || String(out.moqPerStyleColour)
    if (m) out.moqPerStyleColour = Number(m[0].replace(/,/g, '')); else delete out.moqPerStyleColour
  }
  return out
}

/**
 * Cleans, de-duplicates and (unless `dryRun`) writes partners. `rows` are CSV records when a `mapping` is given,
 * otherwise partner bodies already in the API's shape. Names are compared case-insensitively against the directory
 * and against earlier rows of the same file; the first row of a name wins, the rest are reported as skipped.
 * @returns {{ dryRun, total, created, wouldCreate, skipped: {row,name,reason,firstRow?}[], errors: {row,name,errors}[], createdIds: string[] }}
 */
export async function runPartnerImport({ rows, mapping = null, dryRun = false, defaultType = 'unknown', userId = null }) {
  const firstRow = mapping ? 2 : 1 // a CSV's first data row is line 2
  const existing = new Set((await Manufacturer.find({}, 'name').lean()).map(p => nameKey(p.name)))
  const seen = new Map()
  const skipped = []
  const errors = []
  const accepted = []
  rows.forEach((raw, i) => {
    const row = firstRow + i
    const body = mapping ? mapPartnerRecord(raw, mapping) : raw
    const label = typeof body?.name === 'string' ? body.name.trim() : ''
    const cleaned = cleanPartnerInput(body, { defaultType })
    if (cleaned.errors) { errors.push({ row, name: label, errors: cleaned.errors }); return }
    const key = nameKey(cleaned.data.name)
    if (existing.has(key)) { skipped.push({ row, name: cleaned.data.name, reason: 'duplicate_existing' }); return }
    if (seen.has(key)) { skipped.push({ row, name: cleaned.data.name, reason: 'duplicate_in_file', firstRow: seen.get(key) }); return }
    seen.set(key, row)
    accepted.push({ row, data: cleaned.data })
  })
  const createdIds = []
  if (!dryRun) {
    for (const { row, data } of accepted) {
      try {
        const doc = await Manufacturer.create({ ...data, createdBy: userId, updatedBy: userId })
        createdIds.push(String(doc._id))
      } catch (err) {
        if (err.code === 11000) skipped.push({ row, name: data.name, reason: 'duplicate_existing' })
        else errors.push({ row, name: data.name, errors: [err.message] })
      }
    }
  }
  return {
    dryRun: !!dryRun, total: rows.length,
    created: createdIds.length, wouldCreate: accepted.length,
    skipped, errors, createdIds,
  }
}
