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
