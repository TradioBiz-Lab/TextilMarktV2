// Pure decision logic for Zero Entry Capture: which order a message is about,
// which TNA stage it means, and whether the AI may write it without a human.
// No DB or network here so every rule is unit-testable.

export const CONFIDENCE_THRESHOLD = 0.8

// The AI speaks a fixed 9-stage vocabulary; orders carry the 12-stage TNA (or
// a custom one). The three fabric_* stages all land on Material Sourcing, the
// specific fabric step is kept in the stage note.
const STAGE_PATTERNS = {
  fabric_sourced:   /material sourcing/i,
  fabric_received:  /material sourcing/i,
  fabric_inspected: /material sourcing/i,
  cutting:          /^cutting/i,
  stitching:        /stitch/i,
  finishing:        /finish/i,
  qc:               /^qc\b|quality/i,
  packing:          /pack/i,
  dispatched:       /dispatch/i,
}

/** Index of the order stage a canonical stage maps to, or -1. */
export function mapStageIndex(canonical, stages) {
  const re = STAGE_PATTERNS[canonical]
  if (!re) return -1
  return (stages || []).findIndex(s => re.test(s.name || ''))
}

const norm = v => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * @param hints  style codes / names the model saw (strings, may be empty)
 * @param orders [{id, styleNumber, product}] the factory's active orders
 * @returns {{orderId: string|null, candidates: string[]}}
 */
export function matchOrder(hints, orders) {
  const hs = (hints || []).map(norm).filter(h => h.length >= 3)
  if (hs.length) {
    const hit = orders.filter(o => {
      const keys = [norm(o.styleNumber), norm(o.id), norm(o.product)].filter(Boolean)
      return hs.some(h => keys.some(k => k === h || (h.length >= 4 && (k.includes(h) || h.includes(k)) && k.length >= 4)))
    })
    if (hit.length === 1) return { orderId: hit[0].id, candidates: [] }
    if (hit.length > 1) return { orderId: null, candidates: hit.map(o => o.id) }
  }
  if (orders.length === 1) return { orderId: orders[0].id, candidates: [] }
  return { orderId: null, candidates: orders.map(o => o.id) }
}

/**
 * Decide whether a proposed stage change may be auto-applied.
 * @returns {{ok: boolean, reason?: string, noop?: boolean}}
 */
export function gateChange({ confidence, stageIndex, status, stages, defect }) {
  if (stageIndex < 0) return { ok: false, reason: 'Stage not found on this order' }
  if (confidence == null || confidence < CONFIDENCE_THRESHOLD)
    return { ok: false, reason: `Low confidence (${confidence ?? 'none'})` }
  if (defect) return { ok: false, reason: 'Defect flagged, needs a human decision' }
  const cur = stages[stageIndex]
  // Closing the Delivery step marks the order delivered, which is too consequential to do
  // from a photo or a message nobody has looked at.
  if (cur.isDelivery) return { ok: false, reason: 'Delivery needs a person to confirm it' }
  const curStatus = cur.status || 'not_started'
  const rank = { not_started: 0, in_progress: 1, done: 2 }
  if (curStatus === status) return { ok: true, noop: true }
  if (rank[status] < rank[curStatus]) return { ok: false, reason: 'Would move a stage backwards' }
  // Evidence for an earlier stage once later work has started reads as a
  // backwards move. Stages overlap in real TNAs, so only a stage that has
  // not started itself is held back.
  if (curStatus === 'not_started') {
    const furthest = stages.reduce((m, s, i) => ((s.status && s.status !== 'not_started') ? i : m), -1)
    if (furthest > stageIndex) return { ok: false, reason: 'Later stages already started, this looks like a backwards move' }
  }
  return { ok: true }
}
