import { PARTNER_TYPES, PARTNER_CLUSTERS, PARTNER_STATUSES, PARTNER_PRIORITIES, PARTNER_CATEGORIES } from '../models/Manufacturer.js'

// Validation, normalisation and query parsing for the Partner Directory (models/Manufacturer.js,
// routes/manufacturers.js). Everything that reaches a partner document or a Mongo filter goes through here, so
// request bodies and Kriyaa tool input are rebuilt from an allowlist and never spread straight into a query.

const MAX_TAGS = 40
const MAX_TAG_LEN = 60
const MAX_CONTACTS = 20
const MAX_IMAGE_BYTES = 600 * 1024 // an uploaded tile; the browser resizes to about 640px, so this is generous

export const PARTNER_SORTS = ['relevance', 'score', 'priority', 'updated', 'name']

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
  if (PARTNER_CLUSTERS.includes(t)) return t
  const pick = s => {
    if (/ludhiana/.test(s)) return 'ludhiana'
    if (/tirupp?ur/.test(s)) return 'tiruppur'
    if (/noida/.test(s)) return 'noida_ncr'
    if (/delhi|gurugram|gurgaon|faridabad|ghaziabad|sonipat|sonepat|panipat/.test(s)) return 'delhi_ncr'
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
  if (/^(active|live)$/.test(t)) return 'onboarded'
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
    if (blank(body.cluster)) data.cluster = undefined
    else if (!PARTNER_CLUSTERS.includes(body.cluster)) fail('Invalid cluster')
    else data.cluster = body.cluster
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
  if (has('isLive')) {
    if (typeof body.isLive !== 'boolean') fail('isLive must be true or false'); else data.isLive = body.isLive
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
    const list = csvOf(q[key])
    if (list.length > allowed.length || !list.every(x => allowed.includes(x))) return { error: `Invalid ${key}` }
    f[key] = [...new Set(list)]
  }
  if (!blank(q.category)) {
    const list = csvOf(q.category).map(c => normalizeCategory(c))
    if (list.length === 0 || list.length > PARTNER_CATEGORIES.length || list.some(c => !c)) return { error: 'Invalid category' }
    f.category = [...new Set(list)]
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
  if (f.product) and.push({ products: { $in: f.product } })
  if (f.fabric) and.push({ $or: [{ fabrics: { $in: f.fabric } }, { fabricTypes: { $in: f.fabric } }] })
  if (f.minScore !== undefined) and.push({ 'verification.score': { $gte: f.minScore } })
  if (f.maxScore !== undefined) and.push({ 'verification.score': { $lte: f.maxScore } })
  // "Verified" is one idea everywhere: GST checked or a sample approved. It is also what lifts the MOQ "self-reported" tag.
  if (f.verifiedOnly) and.push({ $or: [{ 'verification.gstVerified': true }, { 'verification.sampleApproved': true }] })
  if (f.onPlatform) and.push({ linkedUserId: { $type: 'objectId' } })
  if (f.live) and.push({ isLive: true })
  return and.length ? { $and: and } : {}
}

const SEARCH_FIELDS = ['name', 'legalName', 'city', 'products', 'fabrics', 'fabricTypes', 'trimCategories', 'keywords']

/** The regex fallback for partial words: every word must appear in some searchable field. */
export function partnerRegexFilter(tokens) {
  return { $and: tokens.map(t => ({ $or: SEARCH_FIELDS.map(k => ({ [k]: { $regex: escapeRe(t), $options: 'i' } })) })) }
}

// Live manufacturers (the ones with orders at Tradio now) always come first; the chosen sort orders each group.
const SORTS = {
  score:    { isLive: -1, 'verification.score': -1, name: 1 },
  priority: { isLive: -1, priority: 1, 'verification.score': -1, name: 1 },
  updated:  { isLive: -1, updatedAt: -1 },
  name:     { isLive: -1, name: 1 },
}

/**
 * Runs a list query. A search goes to the text index first (ranked, stemmed: "legging" finds "leggings"); when that
 * finds nothing, to a regex over the same fields so partial words ("ludh", "sports br") still work.
 * @returns {{ items: object[], total: number, mode: 'text'|'regex'|'filter' }}
 */
export async function findPartners(Manufacturer, f) {
  const base = partnerMongoFilter(f)
  const tokens = searchTokens(f.search)
  const page = q => q.skip(f.skip).limit(f.limit).lean()
  const sorted = (sort, q) => q.sort(sort)

  if (tokens.length) {
    const textFilter = { $and: [base, { $text: { $search: tokens.join(' ') } }] }
    const total = await Manufacturer.countDocuments(textFilter)
    if (total > 0) {
      const sort = !f.sort || f.sort === 'relevance' ? { _ts: { $meta: 'textScore' }, name: 1 } : SORTS[f.sort]
      const items = await page(sorted(sort, Manufacturer.find(textFilter, { _ts: { $meta: 'textScore' } })))
      return { items: items.map(({ _ts, ...rest }) => rest), total, mode: 'text' }
    }
    const regexFilter = { $and: [base, partnerRegexFilter(tokens)] }
    const rtotal = await Manufacturer.countDocuments(regexFilter)
    const items = await page(sorted(!f.sort || f.sort === 'relevance' ? SORTS.score : SORTS[f.sort], Manufacturer.find(regexFilter)))
    return { items, total: rtotal, mode: 'regex' }
  }
  const total = await Manufacturer.countDocuments(base)
  const items = await page(sorted(SORTS[f.sort] || SORTS.score, Manufacturer.find(base)).collation({ locale: 'en', strength: 2 }))
  return { items, total, mode: 'filter' }
}

// ── Response shape ─────────────────────────────────────────────────────────────────────────────────────────────

/** A partner as the API returns it. Uploaded image bytes never ride along: the page fetches them (GET /:id/image). */
export function toPartner(p) {
  return {
    id: String(p._id),
    name: p.name, legalName: p.legalName || '', type: p.type,
    categories: p.categories || [],
    cluster: p.cluster || null, city: p.city || '', address: p.address || '', pincode: p.pincode || '',
    products: p.products || [],
    machines: { flatlock: 0, coverstitch: 0, overlock: 0, singleNeedle: 0, ...(p.machines || {}) },
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
    linkedUserId: p.linkedUserId ? String(p.linkedUserId) : null, onPlatform: !!p.linkedUserId,
    createdBy: p.createdBy ? String(p.createdBy) : null, updatedBy: p.updatedBy ? String(p.updatedBy) : null,
    createdAt: p.createdAt, updatedAt: p.updatedAt,
  }
}
