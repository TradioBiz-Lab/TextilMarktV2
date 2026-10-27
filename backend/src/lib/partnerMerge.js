import { companyKey } from './partners.js'

// Merging fresh source rows into the Partner Directory without duplicates and without losing what people have entered.
// Pure planning: it takes the partners on file and the incoming rows and says what to create, update and deactivate; the
// script (scripts/importManufacturers.mjs) prints the plan (a dry run) and, with --apply, writes it.
//
// The rules for a partner that already exists: a field is only ever FILLED, never replaced by something blank or lower
// quality. Existing contacts and the whole verification block are kept; new contacts, keywords, fabrics, categories and
// brands are added to the existing ones; new notes and source text are appended (and not appended twice). The only things
// that are replaced are placeholders: a type of "unknown", a cluster of "other" when the new one is specific, and a name
// that was only a stand-in ("... (company not identified)").

// Different spellings of one company. Keys are companyKey()s.
const ALIASES = {
  'shiv shakti enterprises likely': 'shiv shakti enterprises',
  'shivshakti enterprises not identified': 'shiv shakti enterprises', // "(company not identified)": companyKey drops the word company
  'shivshakti enterprises': 'shiv shakti enterprises',
  'chinmay ludhiana': 'chinmay enterprises',
  'indira hosiery mills': 'indra hosiery mills',
}

/** The one key a company is known by, whatever spelling a source uses. */
export function canonicalKey(name) {
  const k = companyKey(name)
  return ALIASES[k] || k
}

// Not production units: buying houses, sourcing platforms, seller-services entities, traders. Where one is in the directory it
// is taken out of the active list (isActive false, status off_scope) with an audit entry. Keys are companyKey()s; a partner
// matches on the key itself or on the key followed by more words ("Lal10 Noida").
export const REMOVE_NAMES = [
  'Lal10', 'ASK Apparels & Textiles Sourcing', 'RDPL Digital Value Added Services', 'Bhagwandas Retail Pvt Ltd',
  'T International', 'Wings2Fashion (R S Enterprises)', 'MASS India / Mirthuni Apparel Sourcing',
]
export const REMOVE_REASON = 'removed: not a production unit'
const removeKeys = REMOVE_NAMES.map(companyKey)
export const isRemovedName = name => {
  const k = companyKey(name)
  return removeKeys.some(r => k === r || k.startsWith(`${r} `))
}

const blank = v => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)
const PLACEHOLDER_NAME = /\(company not identified\)|\(likely\)/i
const digits = s => String(s || '').replace(/\D/g, '')

const SCALARS = ['legalName', 'city', 'address', 'pincode', 'website', 'priceIndication', 'moqNote', 'gstin', 'udyam', 'mcaCin']
const LISTS = ['keywords', 'fabrics', 'fabricTypes', 'trimCategories', 'categories', 'brands', 'products']

const sameText = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase()
const union = (have = [], add = []) => {
  const out = [...have]
  for (const x of add) if (x && !out.some(y => sameText(x, y))) out.push(x)
  return out
}
const sameContact = (a, b) =>
  (a.email && b.email && sameText(a.email, b.email)) ||
  (a.phone && b.phone && digits(a.phone) && digits(a.phone) === digits(b.phone)) ||
  (a.name && b.name && sameText(a.name, b.name) && !a.email && !b.email && !a.phone && !b.phone)

/** Appends the lines of `text` that `have` does not already contain, so a note is never repeated and a re-run adds nothing. */
const append = (have, text, sep) => {
  const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean)
  if (!lines.length) return have || ''
  if (!have) return lines.join('\n')
  const fresh = lines.filter(l => !have.includes(l))
  return fresh.length ? `${have}${sep}${fresh.join('\n')}` : have
}

/**
 * Merges one incoming partner body into `current` (a partner as stored, or an earlier merged state). Returns the new state and
 * the field-by-field changes: [{ field, from, to }]. Never touches isActive, status, priority or verification.
 */
export function mergePartner(current, incoming) {
  const next = { ...current }
  const diffs = []
  const set = (field, to) => { diffs.push({ field, from: current[field], to }); next[field] = to }

  // A stand-in name is replaced by the identified one.
  const wanted = incoming.name
  if (wanted && PLACEHOLDER_NAME.test(current.name || '') && !PLACEHOLDER_NAME.test(wanted) && !sameText(current.name, wanted)) set('name', wanted)

  if ((!current.type || current.type === 'unknown') && incoming.type && incoming.type !== 'unknown') set('type', incoming.type)
  if (blank(current.cluster) || (current.cluster === 'other' && incoming.cluster && incoming.cluster !== 'other')) {
    if (incoming.cluster && incoming.cluster !== current.cluster) set('cluster', incoming.cluster)
  }
  for (const f of SCALARS) if (blank(current[f]) && !blank(incoming[f])) set(f, incoming[f])
  if ((current.moqPerStyleColour === null || current.moqPerStyleColour === undefined) && incoming.moqPerStyleColour != null) set('moqPerStyleColour', incoming.moqPerStyleColour)

  for (const f of LISTS) {
    const u = union(current[f], incoming[f])
    if (u.length !== (current[f] || []).length) set(f, u)
  }

  const contacts = [...(current.contacts || [])]
  for (const c of incoming.contacts || []) if (!contacts.some(x => sameContact(x, c))) contacts.push(c)
  if (contacts.length !== (current.contacts || []).length) set('contacts', contacts)

  const notes = append(current.notes, incoming.notes, '\n\n')
  if (notes !== (current.notes || '')) set('notes', notes)
  const source = append(current.source, incoming.source, '; ')
  if (source !== (current.source || '')) set('source', source)
  return { next, diffs }
}

/**
 * Plans the whole run.
 * @param existing partners on file (lean documents)
 * @param incoming rows from the sources, in order: [{ source: 'label', body }]
 * @returns {{ create: object[], update: {partner, patch, diffs, sources}[], deactivate: {partner, reason}[], skipped: {name, reason}[], keep: object[] }}
 */
export function planMerge(existing, incoming) {
  const byKey = new Map()
  for (const p of existing) byKey.set(canonicalKey(p.name), p)
  const states = new Map() // key -> { partner|null, state, diffs, sources }
  const skipped = []

  for (const { source, body } of incoming) {
    if (!body?.name) continue
    if (isRemovedName(body.name)) { skipped.push({ name: body.name, reason: `${REMOVE_REASON} (not imported)` }); continue }
    const key = canonicalKey(body.name)
    let st = states.get(key)
    if (!st) {
      const partner = byKey.get(key) || null
      st = { partner, state: partner ? { ...partner } : null, diffs: [], sources: new Set(), body0: null }
      states.set(key, st)
    }
    st.sources.add(source)
    if (!st.state) { st.state = { ...body, name: body.name }; st.body0 = body; continue }
    const { next, diffs } = mergePartner(st.state, body)
    st.state = next
    st.diffs.push(...diffs)
  }

  const create = []
  const update = []
  for (const st of states.values()) {
    if (!st.partner) { create.push({ ...st.state, _sources: [...st.sources] }); continue }
    // collapse repeated diffs of one field into first-from -> last-to
    const merged = new Map()
    for (const d of st.diffs) merged.set(d.field, merged.has(d.field) ? { field: d.field, from: merged.get(d.field).from, to: d.to } : d)
    const diffs = [...merged.values()].filter(d => JSON.stringify(d.from ?? null) !== JSON.stringify(d.to ?? null))
    if (diffs.length) update.push({ partner: st.partner, patch: Object.fromEntries(diffs.map(d => [d.field, st.state[d.field]])), diffs, sources: [...st.sources] })
    else skipped.push({ name: st.partner.name, reason: 'already up to date' })
  }

  const deactivate = []
  for (const p of existing) {
    if (!isRemovedName(p.name)) continue
    if (p.linkedUserId || p.status === 'live') { skipped.push({ name: p.name, reason: 'is on the platform: not removed' }); continue }
    if (p.isActive === false && p.status === 'off_scope') { skipped.push({ name: p.name, reason: 'already removed' }); continue }
    deactivate.push({ partner: p, reason: REMOVE_REASON })
  }
  return { create, update, deactivate, skipped }
}

