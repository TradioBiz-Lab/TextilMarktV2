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
    .map(s => (s.eta && s.eta !== 'NA' ? dayNumber(s.eta) : null))
    .filter(d => d != null)
  if (etas.length === 0) return null
  const last = Math.max(...etas)
  return last > deliveryDay ? last - deliveryDay : null
}
