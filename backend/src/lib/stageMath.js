// Intentional, reviewed duplicates of the identically-named functions in
// frontend/src/constants.js (~lines 116-264). The frontend needs them for UI
// rendering; this copy lets the assistant's check_delivery_risk tool do the
// same date arithmetic in-process, server-side, without an HTTP round-trip.
// If the variance/overrun formulas ever change, update both files together.
//
// stageVariance() is deliberately NOT ported here — the backend already has
// its own equivalent, stageEtaVarianceDays(), exported from
// backend/src/models/Order.js and already computed into every stage's
// etaVarianceDays field by enrichOrder. Reuse that instead of a third copy.

// India Standard Time is a fixed UTC+5:30 offset (no DST) — the app's day
// boundary always ticks over at IST midnight, regardless of the server's own
// local timezone.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000

// Whole-day index (safe for subtraction) for a plain 'YYYY-MM-DD' string or a
// full ISO datetime string — reads the calendar-date component directly via
// Date.UTC rather than round-tripping through the runtime's local timezone.
export const dayNumber = dateStr => {
  if (!dateStr) return null
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number)
  if (!y || !m || !d) return null
  return Date.UTC(y, m - 1, d) / 86400000
}

// Today's date, anchored to India Standard Time.
export const getToday = () => new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10)

/**
 * The date that actually governs delivery-risk/overdue/sort math for a stage:
 * the current revision if one has been made, else the frozen baseline. `eta`
 * starts null at creation (see validateAndCreateOrder / stages/insert) — it's
 * only set once someone explicitly revises the schedule — so without this
 * fallback every stage would read as having no target date until its first
 * revision.
 */
export const effectiveEta = stage => {
  const eta = stage?.eta
  if (eta && eta !== 'NA') return eta
  const base = stage?.baselineEta
  return (base && base !== 'NA') ? base : null
}

/**
 * Days late (positive) or early (negative) that a stage ACTUALLY finished vs
 * its original `baselineEta` — null until it's actually done, and null if no
 * baseline was ever captured. Always measured against the frozen plan, never
 * the current/revised `eta` — a stage that's had its target eta pushed still
 * reports how far the real outcome landed from what was originally promised.
 */
export const stageActualVariance = stage => {
  const planned = stage?.baselineEta, actual = stage?.actualEnd
  if (!planned || !actual || planned === 'NA') return null
  const a = dayNumber(planned), b = dayNumber(actual)
  return a == null || b == null ? null : b - a
}

/**
 * Days by which the plan overruns the promised delivery date, or null when
 * it doesn't. `assignment` narrows to one manufacturer split; omit it to
 * consider every assignment on the order.
 */
export const deliveryOverrunDays = (order, assignment) => {
  if (!order?.delivery) return null
  const deliveryDay = dayNumber(new Date(order.delivery).toISOString())
  if (deliveryDay == null) return null
  const sources = assignment ? [assignment] : (order.assignments || [])
  const etas = sources
    .flatMap(a => a.stages || [])
    .map(s => { const e = effectiveEta(s); return e ? dayNumber(e) : null })
    .filter(d => d != null)
  if (etas.length === 0) return null
  const last = Math.max(...etas)
  return last > deliveryDay ? last - deliveryDay : null
}

// ── The mandatory Delivery step ──────────────────────────────────────────────
// Every TNA ends in a Delivery step, flagged `isDelivery` on the stage. Closing
// it is what marks the manufacturer split delivered, and reopening it puts the
// split back to Processing, so the status can never disagree with the step.
export const DELIVERY_STEP_NAME = 'Delivery'
export const isDeliveryName = name => String(name ?? '').trim().toLowerCase() === 'delivery'
export const deliveryStageIndex = stages => (stages || []).findIndex(s => !!s?.isDelivery)

/** A fresh, not-started Delivery step planned for `dateISO` ('YYYY-MM-DD'), the order's promised delivery date. */
export const makeDeliveryStage = dateISO => ({
  name: DELIVERY_STEP_NAME, unitsDone: 0, totalUnits: 1,
  startDate: dateISO, eta: null, baselineEta: dateISO,
  note: '', description: '', responsibleId: null,
  kind: 'milestone', status: 'not_started', blocked: false, blockedReason: '',
  isDelivery: true, updates: [], materials: [], items: [], actualEnd: null,
})

// ── The standard plan for a style still in New Product Development ───────────
// Short steps from the request landing to the style being ready to go into production. Matching a factory takes
// 3-4 days and the proto / fit sample 4-5; the plan books the longer figure. Sharing the fit sample is given a day,
// its approval three, and the pricing approval two. Each step starts when the one before it ends. There is no
// Delivery step: one is added when the style moves to production.
export const DEVELOPMENT_PLAN = Object.freeze([
  { name: 'Request Received', days: 0 },
  { name: 'Manufacturer Matching', days: 4 },
  { name: 'Proto/Fit Sample', days: 5 },
  { name: 'Fit Sample Shared', days: 1 },
  { name: 'Fit Sample Approved', days: 3 },
  { name: 'Pricing Approved', days: 2 },
  { name: 'Ready for Production', days: 0 },
])

const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }

/** The development plan's steps as fresh, not-started milestones, the first one starting on `startISO` ('YYYY-MM-DD'). */
export function makeDevelopmentStages(startISO) {
  let cursor = startISO
  return DEVELOPMENT_PLAN.map(({ name, days }) => {
    const startDate = cursor
    cursor = addDays(cursor, days)
    return {
      name, unitsDone: 0, totalUnits: 1, startDate, eta: null, baselineEta: cursor,
      note: '', description: '', responsibleId: null,
      kind: 'milestone', status: 'not_started', blocked: false, blockedReason: '',
      isDelivery: false, updates: [], materials: [], items: [], actualEnd: null,
    }
  })
}

/**
 * The split's new status after its Delivery step was written, or null to leave
 * it alone. Done means Delivered; anything else only matters when the split was
 * Delivered, in which case it goes back to Processing.
 */
export function statusAfterDeliveryStep(currentStatus, stepStatus) {
  if (stepStatus === 'done') return currentStatus === 'Delivered' ? null : 'Delivered'
  return currentStatus === 'Delivered' ? 'Processing' : null
}
