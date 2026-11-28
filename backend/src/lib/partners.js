import { PARTNER_TYPES, PARTNER_CLUSTERS, PARTNER_STATUSES, PARTNER_PRIORITIES, PARTNER_CATEGORIES, LEGACY_CLUSTERS } from '../models/Manufacturer.js'
import { parseMapsLocation } from './geo.js'

// Validation, normalisation and query parsing for the Partner Directory (models/Manufacturer.js,
// routes/manufacturers.js). Everything that reaches a partner document or a Mongo filter goes through here, so
// request bodies and Kriyaa tool input are rebuilt from an allowlist and never spread straight into a query.

const MAX_TAGS = 40
const MAX_TAG_LEN = 60
const MAX_CONTACTS = 20
const MAX_IMAGE_BYTES = 600 * 1024 // an uploaded tile; the browser resizes to about 640px, so this is generous

export const PARTNER_SORTS = ['relevance', 'score', 'priority', 'updated', 'name', 'machines']

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v)
const blank = v => v === undefined || v === null || (typeof v === 'string' && !v.trim())

/** A name as one comparable key: case and spacing folded. */
export const nameKey = name => String(name || '').replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * One key for "the same company under another spelling": "Sportking (Sobhagia)" and "Sportking group (Sobhagia)" both
 * give "sportking sobhagia". Company-form words (pvt, ltd, group, international ...) and punctuation are dropped. The
 * seed importer uses it to skip a row that is only another spelling of a partner already on file.
 */
export const companyKey = name => nameKey(name).replace(/[()&.,'`]/g, ' ').replace(/\b(pvt|private|ltd|limited|llp|group|india|international|the|co|company)\b/g, ' ').replace(/\s+/g, ' ').trim()

/** A tag as stored. `snake` for product, fabric and category tokens (sports_bra), plain lower case for keywords. */
export function normTag(raw, snake) {
  const t = String(raw ?? '').trim().toLowerCase()
  return snake ? t.replace(/[\s\-/]+/g, '_').replace(/[^a-z0-9_]/g, '').replace(/^_+|_+$/g, '') : t.replace(/\s+/g, ' ')
}

/** Splits one spreadsheet cell into pieces on any of `seps` (a regex character class body). */
export function splitCell(raw, seps = ';,|') {
  if (blank(raw)) return []
  return String(raw).split(new RegExp(`[${seps}]`)).map(s => s.trim()).filter(Boolean)
}

/** "+91 98680 88882 (WhatsApp)" -> the number, flagged as a WhatsApp number. */
export function splitPhone(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return { phone: '', whatsapp: '' }
  const isWa = /whats\s*app/i.test(text)
  const number = text.replace(/\(?\s*whats\s*app\s*\)?/ig, '').replace(/\s+/g, ' ').trim()
  return isWa ? { phone: number, whatsapp: number } : { phone: number, whatsapp: '' }
}

// ── Enum normalisers: forgiving about spelling, used by CSV mapping and the seed importer ──────────────────────

export function normalizeType(text) {
  const t = String(text ?? '').trim().toLowerCase()
  if (!t) return null
  if (PARTNER_TYPES.includes(t)) return t
  if (/fabric|textile mill|yarn/.test(t)) return 'fabric_supplier'
  if (/trim|accessor|button|zip|label/.test(t)) return 'trims_supplier'
  if (/dyer|dyeing|processor|processing|printing/.test(t)) return 'dyer_processor'
  if (/trader|trading/.test(t)) return 'trader'
  if (/buying|sourcing|agent/.test(t)) return 'buying_house'
  if (/manufactur|garment|factory|exporter|apparel/.test(t)) return 'garment_manufacturer'
  if (/unknown|unclear/.test(t)) return 'unknown'
  return null
}

/** The cluster for a cluster label, or for a city when the label is empty. null when neither says anything. */
export function normalizeCluster(text, city = '') {
  const t = String(text ?? '').trim().toLowerCase()
  if (LEGACY_CLUSTERS[t]) return LEGACY_CLUSTERS[t]
  if (PARTNER_CLUSTERS.includes(t)) return t
  const pick = s => {
    if (/ludhiana/.test(s)) return 'ludhiana'
    if (/tirupp?ur/.test(s)) return 'tiruppur'
    if (/jaipur/.test(s)) return 'jaipur'
    if (/kolkata|calcutta/.test(s)) return 'kolkata'
    if (/noida|delhi|\bncr\b|gurugram|gurgaon|faridabad|ghaziabad|sonipat|sonepat|panipat/.test(s)) return 'ncr'
    return null
  }
  if (t && !/^(tbd|n\/?a|not found|not listed|unknown|-)$/.test(t)) return pick(t) || 'other'
  const c = String(city ?? '').trim().toLowerCase()
  if (!c || /^(tbd|n\/?a|not found|not listed|unknown|-)$/.test(c)) return null
  return pick(c) || 'other'
}

export function normalizeStatus(text) {
  const t = String(text ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (!t) return null
  if (PARTNER_STATUSES.includes(t)) return t
  if (/^(existing_contact|in_touch)$/.test(t)) return 'contacted'
  if (t === 'live') return 'live'
  // "Onboarded" and "active" used to be a status of their own; being on the platform now shows as Live, which needs a
  // platform account a spreadsheet row cannot have, so these read as the stage before it.
  if (/^(active|onboarded)$/.test(t)) return 'pilot'
  if (/^(excluded|excluded_for_now|dropped|not_interested)$/.test(t)) return 'rejected'
  if (/^off_?scope$/.test(t)) return 'off_scope'
  return null
}

export function normalizePriority(text) {
  const t = String(text ?? '').trim().toUpperCase()
  return PARTNER_PRIORITIES.includes(t) ? t : null
}

/** "Activewear", "Indo-western", "Home textiles" ... -> a category value, or null when it is none of the five. */
export function normalizeCategory(text) {
  const t = String(text ?? '').trim().toLowerCase().replace(/[\s\-/&]+/g, '_').replace(/^_+|_+$/g, '')
  if (!t) return null
  if (PARTNER_CATEGORIES.includes(t)) return t
  if (/^(athleisure|activewear|active_wear|sportswear|sports_wear|athletic|gymwear|gym_wear)$/.test(t)) return 'athleisure'
  if (/^(indian|indianwear|indian_wear|ethnic|ethnic_wear|ethnicwear|traditional)$/.test(t)) return 'indian'
  if (/^(western|westernwear|western_wear)$/.test(t)) return 'western'
  if (/^(fusion|fusion_wear|indo_western|indowestern|indo_western_wear)$/.test(t)) return 'fusion'
  if (/^(home|home_textile|home_textiles|hometextile|hometextiles|home_furnishing|home_furnishings|home_linen)$/.test(t)) return 'home_textiles'
  return null
}

// ── Input cleaning ─────────────────────────────────────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const verificationFlags = ['gstVerified', 'udyamVerified', 'referencesChecked', 'videoWalkthrough', 'sampleApproved', 'siteVisited']

/** A web link as stored: http(s) only, scheme added when missing. null when it is not a usable link. */
export function cleanLink(raw, { max = 300 } = {}) {
  const t = String(raw ?? '').trim()
  if (!t || t.length > max || /\s/.test(t)) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return /^https?:\/\/[^/]+\.[^/]+/i.test(t) ? t : null
  return /^[^/]+\.[^/]+/.test(t) ? `https://${t}` : null
}

/**
 * Rebuilds a partner from a request body: only known fields, each checked. `partial` is an update (absent fields are
 * left alone, and an empty value clears one); otherwise name and type are required (type falls back to `defaultType`).
 * Returns { data } or { errors }. `data.machines` and `data.verification` hold only the keys that were sent.
 * createdBy, updatedBy, linkedUserId, lastCheckedAt and the uploaded image are never taken from a body.
 */
export function cleanPartnerInput(body, { partial = false, defaultType = null } = {}) {
  if (!isObj(body)) return { errors: ['Invalid partner'] }
  const errors = []
  const data = {}
  const has = k => body[k] !== undefined
  const fail = msg => { errors.push(msg) }

  const text = (key, max, label = key) => {
    if (!has(key)) return
    const v = body[key]
    if (blank(v)) { data[key] = ''; return }
    if (typeof v !== 'string' && typeof v !== 'number') return fail(`${label} must be text`)
    const t = String(v).trim()
    if (t.length > max) return fail(`${label} is too long (max ${max} characters)`)
    data[key] = t
  }
  const whole = (src, key, label, max) => {
    const v = src[key]
    if (blank(v)) return null
    const n = typeof v === 'string' && /^\s*-?\d+\s*$/.test(v) ? Number(v) : v
    if (!Number.isInteger(n) || n < 0 || n > max) { fail(`${label} must be a whole number from 0 to ${max}`); return undefined }
    return n
  }
  const tagList = (key, snake) => {
    if (!has(key)) return
    let v = body[key]
    if (blank(v)) v = []
    if (typeof v === 'string') v = splitCell(v)
    if (!Array.isArray(v)) return fail(`${key} must be a list`)
    const out = []
    for (const raw of v) {
      if (typeof raw !== 'string') return fail(`${key} must be a list of text`)
      const t = normTag(raw, snake)
      if (!t) continue
      if (t.length > MAX_TAG_LEN) return fail(`A ${key} entry is too long (max ${MAX_TAG_LEN} characters)`)
      if (!out.includes(t)) out.push(t)
    }
    if (out.length > MAX_TAGS) return fail(`Too many ${key} (max ${MAX_TAGS})`)
    data[key] = out
  }

  // Identity
  if (has('name') || !partial) {
    const name = typeof body.name === 'string' ? body.name.replace(/\s+/g, ' ').trim() : ''
    if (!name) fail('Name is required')
    else if (name.length > 200) fail('Name is too long (max 200 characters)')
    else data.name = name
  }
  text('legalName', 200, 'Legal name')
  if (has('type') || !partial) {
    const raw = blank(body.type) ? defaultType : body.type
    if (!PARTNER_TYPES.includes(raw)) fail(raw ? 'Invalid type' : 'Type is required')
    else data.type = raw
  }

  // Location
  if (has('cluster')) {
    const cluster = LEGACY_CLUSTERS[body.cluster] || body.cluster
    if (blank(body.cluster)) data.cluster = undefined
    else if (!PARTNER_CLUSTERS.includes(cluster)) fail('Invalid cluster')
    else data.cluster = cluster
  }
  text('city', 120, 'City')
  text('address', 500, 'Address')
  if (has('pincode')) {
    const p = blank(body.pincode) ? '' : String(body.pincode).trim()
    if (!/^[A-Za-z0-9 -]{0,12}$/.test(p)) fail('Pincode is not valid')
    else data.pincode = p
  }

  // Capabilities
  tagList('products', true)
  tagList('fabrics', true)
  tagList('fabricTypes', true)
  tagList('trimCategories', true)
  tagList('keywords', false)
  if (has('brands')) {
    let v = body.brands
    if (blank(v)) v = []
    if (typeof v === 'string') v = splitCell(v)
    if (!Array.isArray(v)) fail('Brands must be a list')
    else {
      const out = []
      for (const raw of v) {
        if (typeof raw !== 'string') { fail('Brands must be a list of text'); break }
        const t = raw.replace(/\s+/g, ' ').trim()
        if (!t) continue
        if (t.length > MAX_TAG_LEN) { fail(`A brand name is too long (max ${MAX_TAG_LEN} characters)`); break }
        if (!out.some(b => b.toLowerCase() === t.toLowerCase())) out.push(t)
      }
      if (out.length > MAX_TAGS) fail(`Too many brands (max ${MAX_TAGS})`)
      else data.brands = out
    }
  }
  if (has('categories')) {
    let v = body.categories
    if (blank(v)) v = []
    if (typeof v === 'string') v = splitCell(v)
    if (!Array.isArray(v)) fail('Categories must be a list')
    else {
      const out = []
      for (const raw of v) {
        const c = typeof raw === 'string' ? normalizeCategory(raw) : null
        if (!c) { fail(`Unknown category "${String(raw).slice(0, 40)}" (use athleisure, indian, western, fusion or home_textiles)`); break }
        if (!out.includes(c)) out.push(c)
      }
      data.categories = out
    }
  }
  if (has('machines')) {
    if (!isObj(body.machines)) fail('Machines must be an object')
    else {
      data.machines = {}
      for (const k of ['flatlock', 'coverstitch', 'overlock', 'singleNeedle']) {
        if (body.machines[k] === undefined) continue
        const n = whole(body.machines, k, `Machine count (${k})`, 9999)
        if (n !== undefined) data.machines[k] = n ?? 0
      }
    }
  }
  if (has('machineCount')) {
    const n = whole(body, 'machineCount', 'Total machines', 99_999)
    if (n !== undefined) data.machineCount = n
  }
  if (has('moqPerStyleColour')) {
    const n = whole(body, 'moqPerStyleColour', 'MOQ', 1_000_000)
    if (n !== undefined) data.moqPerStyleColour = n
  }
  text('moqNote', 500, 'MOQ note')
  text('priceIndication', 300, 'Price indication')
  if (has('leadTimeDays')) {
    const n = whole(body, 'leadTimeDays', 'Lead time', 3650)
    if (n !== undefined) data.leadTimeDays = n
  }

  // Contacts
  if (has('contacts')) {
    if (blank(body.contacts)) data.contacts = []
    else if (!Array.isArray(body.contacts)) fail('Contacts must be a list')
    else if (body.contacts.length > MAX_CONTACTS) fail(`Too many contacts (max ${MAX_CONTACTS})`)
    else {
      const out = []
      for (const [i, c] of body.contacts.entries()) {
        if (!isObj(c)) { fail(`Contact ${i + 1} is not valid`); continue }
        const one = {}
        for (const [k, max] of [['name', 120], ['role', 120], ['phone', 40], ['email', 254], ['whatsapp', 40]]) {
          const v = blank(c[k]) ? '' : c[k]
          if (typeof v !== 'string' && typeof v !== 'number') { fail(`Contact ${i + 1}: ${k} must be text`); continue }
          const t = String(v).trim()
          if (t.length > max) fail(`Contact ${i + 1}: ${k} is too long`)
          else one[k] = t
        }
        if (one.email && !EMAIL_RE.test(one.email)) fail(`Contact ${i + 1}: email is not valid`)
        if (Object.values(one).some(Boolean)) out.push({ name: '', role: '', phone: '', email: '', whatsapp: '', ...one })
      }
      data.contacts = out
    }
  }

  // Registrations and links
  if (has('website')) {
    if (blank(body.website)) data.website = ''
    else {
      const w = cleanLink(body.website)
      if (!w) fail('Website must be a web address'); else data.website = w
    }
  }
  for (const [key, label, re, max] of [['gstin', 'GSTIN', /^[0-9A-Z]{15}$/, 15], ['udyam', 'Udyam number', /^[0-9A-Z-]{1,30}$/, 30], ['mcaCin', 'CIN', /^[0-9A-Z]{1,25}$/, 25]]) {
    if (!has(key)) continue
    const v = blank(body[key]) ? '' : String(body[key]).replace(/\s+/g, '').toUpperCase()
    if (v && (v.length > max || !re.test(v))) fail(key === 'gstin' ? 'GSTIN must be 15 letters and digits' : `${label} is not valid`)
    else data[key] = v
  }
  for (const key of ['imageUrl', 'logoUrl']) {
    if (!has(key)) continue
    if (blank(body[key])) { data[key] = ''; continue }
    const l = cleanLink(body[key], { max: 2000 })
    if (!l) fail(`${key === 'imageUrl' ? 'Image' : 'Logo'} must be an http or https link (upload a picture from the partner page instead)`)
    else data[key] = l
  }

  // Verification: the server stamps lastCheckedAt, a client cannot
  if (has('verification')) {
    if (!isObj(body.verification)) fail('Verification must be an object')
    else {
      data.verification = {}
      const v = body.verification
      if (v.score !== undefined) {
        if (blank(v.score)) data.verification.score = null
        else {
          const n = typeof v.score === 'string' && /^\s*\d+\s*$/.test(v.score) ? Number(v.score) : v.score
          if (!Number.isInteger(n) || n < 0 || n > 100) fail('Score must be a whole number from 0 to 100')
          else data.verification.score = n
        }
      }
      for (const f of verificationFlags) {
        if (v[f] === undefined) continue
        if (typeof v[f] !== 'boolean') fail(`${f} must be true or false`)
        else data.verification[f] = v[f]
      }
    }
  }

  // Where the unit is: a Google Maps link or "lat, lng". Empty clears it.
  if (has('mapsLocation')) {
    const loc = parseMapsLocation(blank(body.mapsLocation) ? '' : body.mapsLocation)
    if (loc?.error) fail(loc.error); else data.geo = loc
  }

  // Pipeline
  if (has('status')) {
    if (!PARTNER_STATUSES.includes(body.status)) fail('Invalid status'); else data.status = body.status
  }
  if (has('priority')) {
    if (!PARTNER_PRIORITIES.includes(body.priority)) fail('Invalid priority'); else data.priority = body.priority
  }
  text('source', 500, 'Source')
  text('notes', 5000, 'Notes')
  if (has('isActive')) {
    if (typeof body.isActive !== 'boolean') fail('isActive must be true or false'); else data.isActive = body.isActive
  }


  return errors.length ? { errors } : { data }
}

/** An uploaded tile: { image } (a JPEG, PNG or WebP data URL under the cap) or { error }. */
export function cleanPartnerImage(value, { maxBytes = MAX_IMAGE_BYTES } = {}) {
  const m = /^data:(image\/jpeg|image\/png|image\/webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(value ?? ''))
  if (!m) return { error: 'Image must be a JPEG, PNG or WebP picture' }
  if (m[2].length * 0.75 > maxBytes) return { error: `Image too large - keep it under ${Math.round(maxBytes / 1024)}KB` }
  return { image: value }
}

// ── Query parsing ──────────────────────────────────────────────────────────────────────────────────────────────

const csvOf = v => (Array.isArray(v) ? v : String(v ?? '').split(',')).map(s => String(s).trim()).filter(Boolean)
const truthy = v => v === true || v === 1 || /^(1|true|yes)$/i.test(String(v ?? ''))

/**
 * The filters a list request (or a Kriyaa tool call) may carry, validated: { filters } or { error }. Unknown keys are
 * ignored; enum lists are checked against the model's values. `filters` holds only normalised values, so it is safe
 * to turn back into a query string (partnerQueryString) or a Mongo filter (partnerMongoFilter).
 */
export function parsePartnerQuery(raw = {}) {
  const q = isObj(raw) ? raw : {}
  const f = {}
  if (!blank(q.search)) {
    if (typeof q.search !== 'string' || q.search.length > 100) return { error: 'Invalid search' }
    f.search = q.search.trim()
  }
  for (const [key, allowed] of [['type', PARTNER_TYPES], ['cluster', PARTNER_CLUSTERS], ['status', PARTNER_STATUSES], ['priority', PARTNER_PRIORITIES]]) {
    if (blank(q[key])) continue
    const list = csvOf(q[key]).map(x => (key === 'cluster' ? LEGACY_CLUSTERS[x] || x : x))
    if (list.length > allowed.length || !list.every(x => allowed.includes(x))) return { error: `Invalid ${key}` }
    f[key] = [...new Set(list)]
  }
  if (!blank(q.category)) {
    const list = csvOf(q.category).map(c => normalizeCategory(c))
    if (list.length === 0 || list.length > PARTNER_CATEGORIES.length || list.some(c => !c)) return { error: 'Invalid category' }
    f.category = [...new Set(list)]
  }
  if (!blank(q.brand)) {
    const list = (Array.isArray(q.brand) ? q.brand : String(q.brand).split(',')).map(x => String(x).replace(/\s+/g, ' ').trim()).filter(Boolean)
    if (list.length === 0 || list.length > 10 || list.some(x => x.length > MAX_TAG_LEN)) return { error: 'Invalid brand' }
    f.brand = [...new Set(list)]
  }
  for (const key of ['product', 'fabric']) {
    if (blank(q[key])) continue
    const list = csvOf(q[key]).map(x => normTag(x, true)).filter(Boolean)
    if (list.length === 0 || list.length > 10 || list.some(x => x.length > MAX_TAG_LEN)) return { error: `Invalid ${key}` }
    f[key] = [...new Set(list)]
  }
  for (const key of ['minScore', 'maxScore']) {
    if (blank(q[key])) continue
    const n = Number(q[key])
    if (!Number.isFinite(n) || n < 0 || n > 100) return { error: `Invalid ${key}` }
    f[key] = n
  }
  if (!blank(q.minMachines)) {
    const n = Number(q.minMachines)
    if (!Number.isInteger(n) || n < 0 || n > 99_999) return { error: 'Invalid minMachines' }
    f.minMachines = n
  }
  for (const key of ['verifiedOnly', 'onPlatform', 'live', 'includeInactive']) if (truthy(q[key])) f[key] = true
  if (!blank(q.sort)) {
    if (!PARTNER_SORTS.includes(q.sort)) return { error: 'Invalid sort' }
    f.sort = q.sort
  }
  const limit = blank(q.limit) ? 120 : Number(q.limit)
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) return { error: 'Invalid limit' }
  f.limit = limit
  const skip = blank(q.skip) ? 0 : Number(q.skip)
  if (!Number.isInteger(skip) || skip < 0 || skip > 100_000) return { error: 'Invalid skip' }
  f.skip = skip
  return { filters: f }
}

/** The validated filters as a query string. Only ever built from parsePartnerQuery's output. */
export function partnerQueryString(filters) {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(filters)) {
    if (v === undefined || v === false) continue
    p.set(k, Array.isArray(v) ? v.join(',') : String(v))
  }
  return p.toString()
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Words of a search box, with anything that could act as a regex or a text-search operator taken out. */
export function searchTokens(search) {
  // Quotes make a phrase and a leading minus negates a word in a text search; neither is offered to the admin.
  return String(search || '').toLowerCase().replace(/["\\]/g, ' ').split(/[\s,;]+/).map(t => t.trim().replace(/^-+/, '')).filter(Boolean).slice(0, 8)
}

/** The Mongo filter for everything except the search box. */
export function partnerMongoFilter(f) {
  const and = []
  if (!f.includeInactive) and.push({ isActive: { $ne: false } })
  for (const k of ['type', 'cluster', 'status', 'priority']) if (f[k]) and.push({ [k]: { $in: f[k] } })
  if (f.category) and.push({ categories: { $in: f.category } }) // any of the chosen categories
  // a brand matches whatever its capitalisation, and exactly (so "Cocoblu" does not match "Cocoblu Kids")
  if (f.brand) and.push({ brands: { $in: f.brand.map(b => new RegExp(`^${escapeRe(b)}$`, 'i')) } })
  if (f.product) and.push({ products: { $in: f.product } })
  if (f.fabric) and.push({ $or: [{ fabrics: { $in: f.fabric } }, { fabricTypes: { $in: f.fabric } }] })
  if (f.minScore !== undefined) and.push({ 'verification.score': { $gte: f.minScore } })
  if (f.maxScore !== undefined) and.push({ 'verification.score': { $lte: f.maxScore } })
  if (f.minMachines) and.push({ machineCount: { $gte: f.minMachines } })
  // "Verified" is one idea everywhere: GST checked or a sample approved. It is also what lifts the MOQ "self-reported" tag.
  if (f.verifiedOnly) and.push({ $or: [{ 'verification.gstVerified': true }, { 'verification.sampleApproved': true }] })
  if (f.onPlatform) and.push({ linkedUserId: { $type: 'objectId' } })
  if (f.live) and.push({ status: 'live' })
  return and.length ? { $and: and } : {}
}

// ── Search ─────────────────────────────────────────────────────────────────────────────────────────────────────
// The directory is a few hundred records, so a search reads the partners the filters leave and ranks them here. That
// buys what an index could not: every word must be found (in any field), part of a word is enough, "tirupur" finds
// "Tiruppur", "oekotex" finds "oeko-tex", "sports bra" finds sports_bra, and the address, notes, contacts and
// registration numbers are searched too. A name match outranks a keyword, which outranks a word buried in the notes.

// Words people (and Kriyaa) put around what they are looking for. Dropped unless they are all there is.
const FILLER = new Set(['a', 'an', 'the', 'in', 'of', 'for', 'and', 'or', 'with', 'who', 'which', 'that', 'do', 'does', 'make', 'makes', 'making',
  'factory', 'factories', 'manufacturer', 'manufacturers', 'maker', 'makers', 'supplier', 'suppliers', 'vendor', 'vendors', 'partner', 'partners', 'near', 'from', 'at', 'certified'])

/** One search word as a pattern: letters may be doubled, a space, hyphen or underscore may sit between them, and a plural s is optional. */
export function tokenPattern(token) {
  let t = String(token).toLowerCase().replace(/[\s_-]+/g, '')
  if (t.length > 3 && /[^s]s$/.test(t)) t = t.slice(0, -1) // leggings -> legging
  const letters = [...t.replace(/(.)\1+/g, '$1')].map(c => `${escapeRe(c)}+`)
  return new RegExp(letters.join('[\\s_-]?'), 'i')
}

// [weight, what to read]. The best field a word is found in is what it scores.
const SEARCH_FIELDS = [
  [10, p => [p.name]], [8, p => [p.legalName]],
  [7, p => [...(p.keywords || []), ...(p.products || [])]],
  [6, p => [...(p.brands || []), ...(p.categories || []), p.city, p.cluster]],
  [5, p => [...(p.fabrics || []), ...(p.fabricTypes || []), ...(p.trimCategories || []), String(p.type || '').replace(/_/g, ' ')]],
  [4, p => [p.gstin, p.udyam, p.mcaCin, p.pincode, ...(p.contacts || []).flatMap(c => [c.name, c.phone, c.email])]],
  [3, p => [p.address, p.website]],
  [1, p => [p.notes, p.source, p.moqNote, p.priceIndication]],
]

/** How well a partner answers the words: { hits: words found, score }. A word at the start of the name counts most. */
export function scorePartner(p, patterns) {
  let hits = 0; let score = 0
  for (const re of patterns) {
    let best = 0
    for (const [w, read] of SEARCH_FIELDS) {
      if (read(p).some(v => v && re.test(String(v)))) { best = w; break }
    }
    if (best === 10 && new RegExp(`(^|[\\s(])${re.source}`, 'i').test(p.name)) best = 12
    if (best) { hits++; score += best }
  }
  return { hits, score }
}

// Live manufacturers (the ones with orders at Tradio now) always come first; the chosen sort orders each group.
const SORTS = {
  score:    { isLive: -1, 'verification.score': -1, name: 1 },
  priority: { isLive: -1, priority: 1, 'verification.score': -1, name: 1 },
  updated:  { isLive: -1, updatedAt: -1 },
  name:     { isLive: -1, name: 1 },
  machines: { isLive: -1, machineCount: -1, 'verification.score': -1, name: 1 }, // not recorded sorts after any number
}

const at = (o, path) => path.split('.').reduce((v, k) => (v === undefined || v === null ? v : v[k]), o)
/** The same order a Mongo sort would give, for rows already in hand (a missing value sorts as the lowest). */
function compareBy(spec) {
  const keys = Object.entries(spec)
  return (a, b) => {
    for (const [k, dir] of keys) {
      let x = at(a, k); let y = at(b, k)
      if (typeof x === 'string' && typeof y === 'string') { const c = x.localeCompare(y, 'en', { sensitivity: 'base' }); if (c) return c * dir; continue }
      if (x instanceof Date) x = x.getTime(); if (y instanceof Date) y = y.getTime()
      if (typeof x === 'boolean') x = x ? 1 : 0; if (typeof y === 'boolean') y = y ? 1 : 0
      const nx = x === undefined || x === null; const ny = y === undefined || y === null
      if (nx && ny) continue
      if (nx) return dir; if (ny) return -dir
      if (x !== y) return (x < y ? -1 : 1) * dir
    }
    return 0
  }
}

/**
 * One page of a list, with the rejected partners always after everyone else whatever the sort. They are two groups read one
 * after the other (the others first, then the rejected), so paging crosses from one into the next without a schema field.
 * `find(extra)` builds the sorted query for the filter plus `extra`; `total` is both groups together.
 */
async function pageSunkLast(Manufacturer, filter, f, find) {
  const open = { $and: [filter, { status: { $ne: 'rejected' } }] }
  const rejected = { $and: [filter, { status: 'rejected' }] }
  const [nOpen, nRejected] = await Promise.all([Manufacturer.countDocuments(open), Manufacturer.countDocuments(rejected)])
  let items = []
  if (f.skip < nOpen) items = await find(open).skip(f.skip).limit(f.limit).lean()
  const room = f.limit - items.length
  if (room > 0 && nRejected > 0) items = items.concat(await find(rejected).skip(Math.max(0, f.skip - nOpen)).limit(room).lean())
  return { items, total: nOpen + nRejected }
}

const SEARCH_POOL = 5000 // far above the directory's size; a guard, not a page size

/**
 * Runs a list query. With search words, the partners the filters leave are ranked here (see the note above): those with
 * every word, best match first (mode 'all'); when none has every word, those with some of them, most words first (mode
 * 'any'), so a long question still gets its nearest answers. Rejected partners come last in every case.
 * @returns {{ items: object[], total: number, mode: 'all'|'any'|'filter' }}
 */
export async function findPartners(Manufacturer, f) {
  const base = partnerMongoFilter(f)
  let tokens = searchTokens(f.search)
  const meaningful = tokens.filter(t => !FILLER.has(t))
  if (meaningful.length) tokens = meaningful

  if (tokens.length) {
    const patterns = tokens.map(tokenPattern)
    const rows = await Manufacturer.find(base).limit(SEARCH_POOL).lean()
    const scored = rows.map(p => ({ p, ...scorePartner(p, patterns) })).filter(r => r.hits > 0)
    const all = scored.filter(r => r.hits === patterns.length)
    const pool = all.length ? all : scored
    const byRelevance = !f.sort || f.sort === 'relevance'
    const tie = compareBy(byRelevance ? SORTS.score : SORTS[f.sort])
    const sunk = r => (r.p.status === 'rejected' ? 1 : 0)
    pool.sort((a, b) => sunk(a) - sunk(b)
      || (all.length ? 0 : b.hits - a.hits)
      || (byRelevance ? b.score - a.score : 0)
      || tie(a.p, b.p))
    return { items: pool.slice(f.skip, f.skip + f.limit).map(r => r.p), total: pool.length, mode: all.length || !pool.length ? 'all' : 'any' }
  }
  const hit = await pageSunkLast(Manufacturer, base, f, extra => Manufacturer.find(extra).sort(SORTS[f.sort] || SORTS.score).collation({ locale: 'en', strength: 2 }))
  return { ...hit, mode: 'filter' }
}

// ── Response shape ─────────────────────────────────────────────────────────────────────────────────────────────

/** A partner as the API returns it. Uploaded image bytes never ride along: the page fetches them (GET /:id/image). */
export function toPartner(p) {
  return {
    id: String(p._id),
    name: p.name, legalName: p.legalName || '', type: p.type,
    categories: p.categories || [],
    brands: p.brands || [],
    cluster: p.cluster || null, city: p.city || '', address: p.address || '', pincode: p.pincode || '',
    products: p.products || [],
    machines: { flatlock: 0, coverstitch: 0, overlock: 0, singleNeedle: 0, ...(p.machines || {}) },
    machineCount: p.machineCount ?? null,
    moqPerStyleColour: p.moqPerStyleColour ?? null, moqNote: p.moqNote || '',
    fabricTypes: p.fabricTypes || [], trimCategories: p.trimCategories || [], fabrics: p.fabrics || [],
    priceIndication: p.priceIndication || '', leadTimeDays: p.leadTimeDays ?? null,
    contacts: p.contacts || [],
    website: p.website || '', gstin: p.gstin || '', udyam: p.udyam || '', mcaCin: p.mcaCin || '',
    verification: {
      score: p.verification?.score ?? null,
      gstVerified: !!p.verification?.gstVerified, udyamVerified: !!p.verification?.udyamVerified,
      referencesChecked: !!p.verification?.referencesChecked, videoWalkthrough: !!p.verification?.videoWalkthrough,
      sampleApproved: !!p.verification?.sampleApproved, siteVisited: !!p.verification?.siteVisited,
      lastCheckedAt: p.verification?.lastCheckedAt || null,
    },
    status: p.status || 'new', priority: p.priority || 'C',
    source: p.source || '', keywords: p.keywords || [], notes: p.notes || '', isActive: p.isActive !== false, isLive: !!p.isLive,
    imageUrl: p.imageUrl || '', hasUpload: !!p.imageUploadedAt, logoUrl: p.logoUrl || '',
    geo: p.geo && p.geo.lat != null && p.geo.lng != null ? { lat: p.geo.lat, lng: p.geo.lng, mapsUrl: p.geo.mapsUrl || '' } : null,
    linkedUserId: p.linkedUserId ? String(p.linkedUserId) : null, onPlatform: !!p.linkedUserId,
    createdBy: p.createdBy ? String(p.createdBy) : null, updatedBy: p.updatedBy ? String(p.updatedBy) : null,
    createdAt: p.createdAt, updatedAt: p.updatedAt,
  }
}
