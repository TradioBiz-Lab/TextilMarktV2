// Legacy status flow (kept for admin/mfr pages not yet migrated)
export const STATUS_FLOW = [
  'Order Confirmed', 'Material Sourcing', 'In Production',
  'Quality Inspection', 'Packaging', 'Ready to Ship', 'In Transit', 'Delivered',
]
export const ALL_ST = [...STATUS_FLOW, 'On Hold', 'Delayed']

// Default production stages — admin can define custom stages per order
export const DEFAULT_STAGE_NAMES = [
  'Lab Dip Approval', 'PP Sample',
  'Material Sourcing', 'Knitting', 'Dyeing', 'Processing',
  'Cutting', 'Stitching', 'Finishing', 'Packing', 'QC', 'Dispatch',
]

// BRD §4 — Order-level status overlay (4 values, stored on assignment.status)
export const ORDER_STATUSES = ['Processing', 'On Hold', 'Delayed', 'Delivered']

export const ST = {
  // Legacy
  'Order Confirmed':    { bg: '#dbeafe', c: '#1d4ed8' },
  'Material Sourcing':  { bg: '#ede9fe', c: '#6d28d9' },
  'In Production':      { bg: '#fef9c3', c: '#92400e' },
  'Quality Inspection': { bg: '#ffedd5', c: '#c2410c' },
  'Packaging':          { bg: '#cffafe', c: '#0e7490' },
  'Ready to Ship':      { bg: '#e0e7ff', c: '#3730a3' },
  'In Transit':         { bg: '#ccfbf1', c: '#0f766e' },
  // Current 4-value system
  'Processing': { bg: '#dbeafe', c: '#1d4ed8' },
  'Delivered':  { bg: '#dcfce7', c: '#15803d' },
  'On Hold':    { bg: '#f1f5f9', c: '#475569' },
  'Delayed':    { bg: '#fee2e2', c: '#b91c1c' },
  // Reporting page — schedule-derived status per line item (distinct from the 4-value overlay above)
  'On Track':   { bg: '#dcfce7', c: '#15803d' },
  'In Progress':{ bg: '#dbeafe', c: '#1d4ed8' },
  'Complete':   { bg: '#dcfce7', c: '#15803d' },
}

// Reporting page — the 3 schedule-derived statuses, computed from the active stage's ETA
export const REPORT_STATUSES = ['In Progress', 'On Track', 'Delayed']

export const DOC_TYPES = [
  { v: 'PO', l: 'Purchase Order' },
  { v: 'buyer_order', l: 'Buyer Order' },
  { v: 'tech_pack', l: 'Tech Pack' },
  { v: 'cost_sheet', l: 'Cost Sheet' },
  { v: 'RFQ', l: 'RFQ' },
  { v: 'terms', l: 'Terms & Conditions' },
  { v: 'compliance_cert', l: 'Compliance Certificate' },
  { v: 'factory_audit', l: 'Factory Audit Report' },
  { v: 'chemical_cert', l: 'Chemical Test Certificate' },
  { v: 'environmental_cert', l: 'Environmental Certification' },
  { v: 'insurance', l: 'Insurance Certificate' },
  { v: 'mfr_profile', l: 'Manufacturer Profile' },
  // Wiki — link-only reference categories (externalUrl only, see WikiPage.jsx)
  { v: 'wiki_inspection_form', l: 'Inspection / Testing Form' },
  { v: 'wiki_fit_comments', l: 'Fit Comments' },
  { v: 'wiki_photos', l: 'Photos (lab dip / approval)' },
]

// Single source of truth for the Wiki's "Files" tab category filter — the three
// link-only Document types above.
export const WIKI_DOC_TYPES = DOC_TYPES.filter(d => d.v.startsWith('wiki_'))

// Wiki "Pages" tab — Tech Pack/SOP content authored as in-app Markdown pages
// (WikiPage model), not file uploads.
export const WIKI_PAGE_CATEGORIES = [
  { v: 'tech_pack', l: 'Tech Pack' },
  { v: 'sop', l: 'SOP' },
]

// Production stage evidence document types
export const STAGE_DOC_TYPES = [
  { v: 'material_po',    l: 'Material PO',         stageIndex: 0 },
  { v: 'knitting_grn',   l: 'Knitting GRN',        stageIndex: 1 },
  { v: 'knitting_qc',    l: 'Knitting QC',         stageIndex: 1 },
  { v: 'dyeing_grn',     l: 'Dyeing GRN',          stageIndex: 2 },
  { v: 'dyeing_qc',      l: 'Dyeing QC',           stageIndex: 2 },
  { v: 'processing_grn', l: 'Processing GRN',      stageIndex: 3 },
  { v: 'processing_qc',  l: 'Processing QC',       stageIndex: 3 },
  { v: 'cutting_qc',     l: 'Cutting QC',          stageIndex: 4 },
  { v: 'stitching_qc',   l: 'Stitching QC',        stageIndex: 5 },
  { v: 'final_qc',       l: 'Final QC',            stageIndex: 8 },
  { v: 'packing_qc',     l: 'Packing QC',          stageIndex: 7 },
  { v: 'dispatch_docs',  l: 'Dispatch Documents',   stageIndex: 9 },
]

// Map stageIndex → allowed evidence doc types for that stage
export const STAGE_DOC_MAP = STAGE_DOC_TYPES.reduce((acc, d) => {
  if (!acc[d.stageIndex]) acc[d.stageIndex] = []
  acc[d.stageIndex].push(d)
  return acc
}, {})

export const DOC_ICONS = {
  PO: '📋', buyer_order: '🛒', tech_pack: '📐', cost_sheet: '💰', RFQ: '📩', terms: '📄',
  compliance_cert: '🛡', factory_audit: '🔍', chemical_cert: '🧪',
  environmental_cert: '🌿', insurance: '🏥',
  // Stage evidence docs
  material_po: '📦', knitting_grn: '🧶', knitting_qc: '✅',
  dyeing_grn: '🎨', dyeing_qc: '✅', processing_grn: '⚙️', processing_qc: '✅',
  cutting_qc: '✂️', stitching_qc: '🪡', final_qc: '🏆',
  packing_qc: '📦', dispatch_docs: '🚚',
  mfr_profile: '🏭',
  wiki_inspection_form: '🔍', wiki_fit_comments: '📝', wiki_photos: '📷',
}

export const CATEGORIES = ['TSHRT', 'JEANS', 'BEDSH', 'SHIRT', 'DRESS', 'JACKET', 'POLO', 'SHORTS', 'HOODIE']
export const SEASONS = ['SS26', 'FW26', 'SS27', 'FW27', 'SS28']

export const T = {
  bg: '#F8FAFC', surface: '#FFFFFF', border: '#e2e8f0', borderHover: '#CBD5E1',
  primary: '#F97316', primaryDark: '#EA580C', primaryLight: '#FFF7ED',
  // textMuted/textLight darkened from slate-500/slate-400 — the previous values read
  // as too low-contrast on line items (order rows, bulk-edit grids): ~4.8:1 and ~2.6:1
  // against a white surface, the latter failing WCAG AA outright. Now ~7.6:1 / ~4.8:1.
  text: '#0f172a', textMuted: '#475569', textLight: '#64748b',
  success: '#10B981', successBg: '#ECFDF5', successBorder: '#6EE7B7',
  danger: '#EF4444', dangerBg: '#FEF2F2', dangerBorder: '#FCA5A5',
  warning: '#C2410C', warningBg: '#FFF7ED', warningBorder: '#FDBA74',
  info: '#002B5B', infoBg: '#E6F0FF', infoBorder: '#93c5fd',
  master: '#7c3aed', masterBg: '#ede9fe',
  sidebar: '#003B73', sidebarBorder: 'rgba(255,255,255,0.1)',
  sidebarGradient: 'linear-gradient(180deg, #0a4f8a 0%, #003B73 50%, #001c38 100%)',
  heroGradient: 'linear-gradient(135deg, #0a4f8a 0%, #003B73 55%, #002347 100%)',
}

// India Standard Time is a fixed UTC+5:30 offset (no DST) — the app's day
// boundary (today/overdue/expiry) always ticks over at IST midnight, regardless
// of the server's or browser's own local timezone.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000

// Whole-day index (safe for subtraction) for a plain 'YYYY-MM-DD' string or a
// full ISO datetime string — reads the calendar-date component directly via
// Date.UTC rather than round-tripping through the runtime's local timezone
// (new Date(dateOnlyString) parses as UTC midnight; calling .setHours() on it
// resets to LOCAL midnight, which silently shifts the date by a day in any
// timezone behind UTC — this avoids that entirely).
export const dayNumber = dateStr => {
  if (!dateStr) return null
  const [y, m, d] = dateStr.slice(0, 10).split('-').map(Number)
  if (!y || !m || !d) return null
  return Date.UTC(y, m - 1, d) / 86400000
}

// Today's date, anchored to India Standard Time.
export const getToday = () => new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10)

export const isExpiringSoon = d => {
  if (!d) return false
  const days = dayNumber(d) - dayNumber(getToday())
  return days >= 0 && days <= 30
}
export const isExpired = d => {
  if (!d) return false
  return dayNumber(d) - dayNumber(getToday()) < 0
}
export const fmtN = n => n?.toLocaleString?.() ?? n

// ── Stage derivation ────────────────────────────────────────────────────────
// Mirrors backend/src/models/Order.js. The server already normalizes these in
// enrichOrder, so `kind`/`status` arrive resolved; the fallbacks here exist only
// so a stale cached order (or a frontend deployed ahead of the backend — Slate
// auto-deploys on push, AppSail does not) still renders sensibly.

export const STAGE_KINDS = ['milestone', 'checklist', 'quantity']

export const STAGE_STATUS_LABELS = {
  not_started: 'Not started',
  in_progress: 'In progress',
  done: 'Done',
}

export const stageKindOf = s => s?.kind ?? 'quantity'

export const stageStatusOf = s => {
  if (s?.status) return s.status
  const done = s?.unitsDone || 0
  const total = s?.totalUnits || 0
  if (total > 0 && done >= total) return 'done'
  return done > 0 ? 'in_progress' : 'not_started'
}

export const isStageDone = s => stageStatusOf(s) === 'done'

/** Percent complete, by kind. Checklists count items, not units. */
export const stagePct = s => {
  if (stageKindOf(s) === 'checklist' && (s?.itemsTotal || 0) > 0)
    return Math.round(((s.itemsDone || 0) / s.itemsTotal) * 100)
  if (isStageDone(s)) return 100
  const total = s?.totalUnits || 0
  return total > 0 ? Math.round(((s.unitsDone || 0) / total) * 100) : 0
}

/** Short progress label for a stage row — "2 of 3", "6,200 / 10,800", or the status. */
export const stageProgressLabel = s => {
  const kind = stageKindOf(s)
  if (kind === 'checklist' && (s?.itemsTotal || 0) > 0) return `${s.itemsDone || 0} of ${s.itemsTotal}`
  if (kind === 'quantity') return `${fmtN(s?.unitsDone || 0)} / ${fmtN(s?.totalUnits || 0)}`
  return STAGE_STATUS_LABELS[stageStatusOf(s)]
}

export const stageIsOverdue = s => {
  if (isStageDone(s)) return false
  if (!s?.eta || s.eta === 'NA') return false
  const d = dayNumber(s.eta)
  return d != null && d - dayNumber(getToday()) < 0
}

/** Days late (positive) or early (negative) vs the frozen baseline; null if not measurable. */
export const stageVariance = s => {
  if (typeof s?.etaVarianceDays === 'number') return s.etaVarianceDays
  const base = s?.baselineEta, now = s?.eta
  if (!base || !now || base === 'NA' || now === 'NA') return null
  const a = dayNumber(base), b = dayNumber(now)
  return a == null || b == null ? null : b - a
}

/**
 * Days late (positive) or early (negative) that a stage ACTUALLY finished vs
 * its original `baselineEta` — null until it's actually done, and null if no
 * baseline was ever captured. Always measured against the frozen plan, never
 * the current/revised `eta` — a stage that's had its target eta pushed still
 * reports how far the real outcome landed from what was originally promised.
 */
export const stageActualVariance = s => {
  const planned = s?.baselineEta, actual = s?.actualEnd
  if (!planned || !actual || planned === 'NA') return null
  const a = dayNumber(planned), b = dayNumber(actual)
  return a == null || b == null ? null : b - a
}

// Shared step×style matrix building blocks — used by both the admin Order
// Management matrix and the buyer dashboard's read-only equivalent, so the
// two views can never silently drift into different cell colors/labels.
export const CELL_STATE = {
  done:    { bg: '#d1fae5', fg: '#047857', label: 'Done' },
  blocked: { bg: '#fee2e2', fg: '#b91c1c', label: 'Blocked' },
  overdue: { bg: '#fee2e2', fg: '#b91c1c', label: 'Overdue' },
  active:  { bg: '#dbeafe', fg: '#1d4ed8', label: 'In progress' },
  pending: { bg: '#f1f5f9', fg: '#64748b', label: 'Upcoming' },
}

export const cellState = stage => {
  if (!stage) return null
  if (isStageDone(stage)) return 'done'
  if (stage.blocked) return 'blocked'
  if (stageIsOverdue(stage)) return 'overdue'
  if (stageStatusOf(stage) === 'in_progress') return 'active'
  return 'pending'
}

// The step spine for a group of styles: the union of stage names across every
// order×assignment column, longest plan first — sibling styles in a master
// order are normally cut to the same plan, so this is usually just one list.
export const buildMatrixSpine = entries => {
  const spine = []
  const seen = new Set()
  const ordered = [...entries].sort((a, b) => (b.asgn.stages?.length || 0) - (a.asgn.stages?.length || 0))
  for (const { asgn } of ordered) {
    for (const s of asgn.stages || []) {
      const key = s.name.trim().toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      spine.push(s.name.trim())
    }
  }
  return spine
}

/**
 * Every stage currently in play — NOT just the first incomplete one.
 *
 * Replaces the "active stage = first incomplete" assumption that five surfaces
 * each reimplemented. That assumption breaks the moment steps overlap, which
 * real TNA plans do (FPT/PP/GPT samples run concurrently).
 *
 * The window is bounded in BOTH directions. An earlier version only bounded it
 * forward, so any step whose start date had ever passed stayed on the list
 * forever — which turned the daily list into every open step on the book. A
 * step qualifies when it is unfinished AND any of: it is blocked, it is being
 * worked on, its planned window touches the ±windowDays band around today, or
 * (when includeOverdue) its deadline has passed and it was never closed.
 */
export const inFlightStages = (assignment, { windowDays = 3, includeOverdue = true } = {}) => {
  const today = dayNumber(getToday())
  const within = d => d != null && Math.abs(d - today) <= windowDays
  return (assignment?.stages || [])
    .map((s, i) => ({ stage: s, index: i }))
    .filter(({ stage: s }) => {
      if (isStageDone(s)) return false
      if (s.blocked) return true
      if (stageStatusOf(s) === 'in_progress') return true
      if (includeOverdue && stageIsOverdue(s)) return true
      const start = s.startDate && s.startDate !== 'NA' ? dayNumber(s.startDate) : null
      const eta = s.eta && s.eta !== 'NA' ? dayNumber(s.eta) : null
      if (within(start) || within(eta)) return true
      // A long step whose window straddles today, with both ends outside the band.
      return start != null && eta != null && start <= today && eta >= today
    })
}

/**
 * Days by which the plan overruns the promised delivery date, or null when it
 * doesn't. Nothing used to compare the two, so an order could promise 25-Aug
 * while its own last step ran to 16-Sep and no screen said a word.
 */
export const deliveryOverrunDays = (order, assignment) => {
  if (!order?.delivery) return null
  const deliveryDay = dayNumber(new Date(order.delivery).toISOString())
  if (deliveryDay == null) return null
  const sources = assignment ? [assignment] : (order.assignments || [])
  const etas = sources
    .flatMap(a => a.stages || [])
    .map(s => (s.eta && s.eta !== 'NA' ? dayNumber(s.eta) : null))
    .filter(d => d != null)
  if (etas.length === 0) return null
  const last = Math.max(...etas)
  return last > deliveryDay ? last - deliveryDay : null
}

/** The single stage to show when only one fits — earliest ETA among those in flight. */
export const primaryStage = assignment => {
  const live = inFlightStages(assignment)
  if (live.length === 0) return null
  return live.slice().sort((a, b) => {
    const ea = a.stage.eta && a.stage.eta !== 'NA' ? dayNumber(a.stage.eta) : Infinity
    const eb = b.stage.eta && b.stage.eta !== 'NA' ? dayNumber(b.stage.eta) : Infinity
    return ea - eb || a.index - b.index
  })[0]
}
