import { T } from './constants.js'

// Constants and pure helpers for the Partner Directory (pages/admin/PartnersPage.jsx, PartnerDetailPage.jsx). The
// value lists mirror backend/src/models/Manufacturer.js; the server is the real gate for every one of them.

export const PARTNER_TYPES = [
  { v: 'garment_manufacturer', label: 'Garment manufacturer' },
  { v: 'fabric_supplier', label: 'Fabric supplier' },
  { v: 'trims_supplier', label: 'Trims supplier' },
  { v: 'dyer_processor', label: 'Dyer / processor' },
  { v: 'trader', label: 'Trader' },
  { v: 'buying_house', label: 'Buying house' },
  { v: 'unknown', label: 'Type unknown' },
]
export const TYPE_LABEL = Object.fromEntries(PARTNER_TYPES.map(t => [t.v, t.label]))

// The tab bar of the list page. `addType` is what "Add partner" presets while that tab is open.
export const TYPE_TABS = [
  { id: 'all', label: 'All', types: [], addType: 'garment_manufacturer' },
  { id: 'garment', label: 'Garment', types: ['garment_manufacturer'], addType: 'garment_manufacturer', noun: 'garment manufacturer' },
  { id: 'fabric', label: 'Fabric', types: ['fabric_supplier'], addType: 'fabric_supplier', noun: 'fabric supplier' },
  { id: 'trims', label: 'Trims', types: ['trims_supplier'], addType: 'trims_supplier', noun: 'trims supplier' },
  { id: 'other', label: 'Other', types: ['dyer_processor', 'trader', 'buying_house', 'unknown'], addType: 'trader', noun: 'partner' },
]

// What a partner makes for. A factory can be in several of these.
export const CATEGORIES = [
  { v: 'athleisure', label: 'Athleisure' },
  { v: 'indian', label: 'Indian' },
  { v: 'western', label: 'Western' },
  { v: 'fusion', label: 'Fusion' },
  { v: 'home_textiles', label: 'Home textiles' },
]
export const CATEGORY_LABEL = Object.fromEntries(CATEGORIES.map(c => [c.v, c.label]))

export const CLUSTERS = [
  { v: 'ludhiana', label: 'Ludhiana' },
  { v: 'ncr', label: 'NCR' },
  { v: 'jaipur', label: 'Jaipur' },
  { v: 'kolkata', label: 'Kolkata' },
  { v: 'tiruppur', label: 'Tiruppur' },
  { v: 'other', label: 'Other' },
]
export const CLUSTER_LABEL = Object.fromEntries(CLUSTERS.map(c => [c.v, c.label]))

export const STATUSES = [
  { v: 'new', label: 'New', bg: '#f1f5f9', fg: '#475569' },
  { v: 'contacted', label: 'Contacted', bg: '#dbeafe', fg: '#1d4ed8' },
  { v: 'qualified', label: 'Qualified', bg: '#ede9fe', fg: '#6d28d9' },
  { v: 'pilot', label: 'Pilot', bg: '#fef9c3', fg: '#92400e' },
  { v: 'live', label: 'Live', bg: '#dcfce7', fg: '#15803d' }, // has orders with Tradio now; needs a platform account
  { v: 'rejected', label: 'Rejected', bg: '#fee2e2', fg: '#b91c1c' },
  { v: 'off_scope', label: 'Off scope', bg: '#f1f5f9', fg: '#64748b' },
]
export const STATUS_BY = Object.fromEntries(STATUSES.map(s => [s.v, s]))

/** Live needs a manufacturer account on the platform; a partner without one cannot be set to it. */
export const canBeLive = p => !!p?.onPlatform

export const SORTS = [
  { v: 'score', label: 'Verification score' },
  { v: 'updated', label: 'Recently updated' },
  { v: 'name', label: 'Name A to Z' },
]
const RELEVANCE = { v: 'relevance', label: 'Best match' }
/** The sort options for the current search: "Best match" only means something while a search is typed. */
export const sortsFor = searching => (searching ? [RELEVANCE, ...SORTS] : SORTS)

// The checks that make a partner trustworthy, in the order they are usually done.
export const VERIFICATION_CHECKS = [
  { key: 'gstVerified', label: 'GST verified', hint: 'GSTIN checked on the GST portal' },
  { key: 'udyamVerified', label: 'Udyam verified', hint: 'Udyam registration checked' },
  { key: 'referencesChecked', label: 'References checked', hint: 'Spoke to a current client' },
  { key: 'videoWalkthrough', label: 'Video walkthrough', hint: 'Shown the floor on a video call' },
  { key: 'sampleApproved', label: 'Sample approved', hint: 'A sample from them passed our check' },
  { key: 'siteVisited', label: 'Site visited', hint: 'Someone from Tradio has been on site' },
]

// Generic garments (tees, joggers, dresses) are what the category already says. Only SPECIALISED products are named, as
// keywords; these are offered as suggestions next to the keywords already in the directory.
export const SPECIALISED_SUGGESTIONS = ['sports bras', 'leggings', 'thermals', 'socks', 'innerwear', 'tracksuits', 'kidswear']
// Fabrics Tradio sources most, offered the same way.
export const COMMON_FABRICS = ['poly_spandex', 'cotton_lycra', 'nylon_spandex', 'cotton', 'bamboo_blend', 'jersey', 'fleece']

/** "sports_bra" -> "Sports bra". */
export const labelOf = token => {
  const t = String(token ?? '').replace(/_/g, ' ').trim()
  return t ? t[0].toUpperCase() + t.slice(1) : ''
}

/** The tag as the server stores it: lower case, spaces and hyphens as underscores (mirrors normTag in the backend). */
export const snakeOf = raw => String(raw ?? '').trim().toLowerCase().replace(/[\s\-/]+/g, '_').replace(/[^a-z0-9_]/g, '').replace(/^_+|_+$/g, '')

export const initialsOf = name => {
  const words = String(name ?? '').replace(/[()]/g, ' ').split(/\s+/).filter(w => /[A-Za-z0-9]/.test(w))
  const take = words.slice(0, 2).map(w => w.match(/[A-Za-z0-9]/)[0].toUpperCase())
  return take.join('') || '?'
}

/** Colour of the verification badge: green from 70, amber 50 to 69, grey below that or when not assessed. */
export function scoreTone(score) {
  if (score === null || score === undefined) return { bg: '#f1f5f9', fg: '#64748b', label: 'Unscored', level: 'unknown' }
  if (score >= 70) return { bg: T.successBg, fg: T.successDeep, label: String(score), level: 'high' }
  if (score >= 50) return { bg: '#fef3c7', fg: '#92400e', label: String(score), level: 'mid' }
  return { bg: '#f1f5f9', fg: '#475569', label: String(score), level: 'low' }
}

/** A MOQ is a partner's own claim until GST is verified or a sample is approved. */
export const moqVerified = p => !!(p?.verification?.gstVerified || p?.verification?.sampleApproved)

/** Which parts of a partner apply to its type (the form and the detail page show only these). */
export function fieldsFor(type) {
  return {
    garment: type === 'garment_manufacturer',
    fabricTypes: type === 'fabric_supplier',
    trimCategories: type === 'trims_supplier',
  }
}

// ── The list page's query ──────────────────────────────────────────────────────────────────────────────────────

export const PAGE_SIZE = 120

export const emptyQuery = () => ({
  search: '', tab: 'all', category: [], brand: [], cluster: [], fabric: [], status: [],
  minScore: '', maxScore: '', verifiedOnly: false, live: false, includeInactive: false, sort: 'score', limit: PAGE_SIZE,
})

/** The query as the API's parameters: empty filters left out, lists joined with commas. */
export function queryToParams(q) {
  const p = {}
  const tab = TYPE_TABS.find(t => t.id === q.tab)
  if (tab?.types.length) p.type = tab.types.join(',')
  if (q.search?.trim()) p.search = q.search.trim()
  for (const k of ['category', 'brand', 'cluster', 'fabric', 'status']) if (q[k]?.length) p[k] = q[k].join(',')
  for (const k of ['minScore', 'maxScore']) if (q[k] !== '' && q[k] !== null && q[k] !== undefined) p[k] = q[k]
  for (const k of ['verifiedOnly', 'live', 'includeInactive']) if (q[k]) p[k] = 1
  p.sort = q.sort === 'relevance' && !p.search ? 'score' : q.sort
  p.limit = q.limit || PAGE_SIZE
  return p
}

/** How many filters (not counting the search words and the tab) are narrowing the list. */
export function activeFilterCount(q) {
  let n = 0
  for (const k of ['category', 'brand', 'cluster', 'fabric', 'status']) n += q[k]?.length || 0
  if (q.minScore !== '' || q.maxScore !== '') n++
  for (const k of ['verifiedOnly', 'live', 'includeInactive']) if (q[k]) n++
  return n
}

/** The filters in words, for Kriyaa's question. */
export function describeQuery(q) {
  const bits = []
  const tab = TYPE_TABS.find(t => t.id === q.tab)
  if (tab && tab.id !== 'all') bits.push(tab.label.toLowerCase())
  if (q.category.length) bits.push(`for ${q.category.map(c => CATEGORY_LABEL[c] || c).join(' or ').toLowerCase()}`)
  if (q.brand.length) bits.push(`working with ${q.brand.join(' or ')}`)
  if (q.cluster.length) bits.push(`in ${q.cluster.map(c => CLUSTER_LABEL[c] || c).join(' or ')}`)
  if (q.fabric.length) bits.push(`with ${q.fabric.map(labelOf).join(' or ').toLowerCase()} fabric`)
  if (q.status.length) bits.push(`status ${q.status.map(s => STATUS_BY[s]?.label || s).join(' or ').toLowerCase()}`)
  if (q.minScore !== '') bits.push(`verification score at least ${q.minScore}`)
  if (q.maxScore !== '') bits.push(`verification score at most ${q.maxScore}`)
  if (q.verifiedOnly) bits.push('verified (GST checked or sample approved)')
  if (q.live) bits.push('live (orders at Tradio now)')
  return bits.join(', ')
}

/** What "Ask Kriyaa" sends: the words typed in the search bar, else the current filters, else a useful default. */
export function kriyaaPromptFor(q, searchText) {
  const text = String(searchText ?? '').trim()
  if (text) return `Search the partner directory for: ${text}. Tell me the best matches and what is still unverified about them.`
  const filters = describeQuery(q)
  if (filters) return `From the partner directory, list the partners that are ${filters}. Say which MOQs are only claims.`
  return 'From the partner directory, which low-MOQ garment manufacturers look strongest, and what is still unverified about them?'
}
