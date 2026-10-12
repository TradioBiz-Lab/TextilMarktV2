// Checking and shaping a style's measurement spec (the points a garment is measured at, with a target for
// each size and a tolerance). Extraction fills it from the tech pack; the factory can correct it; QC measures
// against it.
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const num = v => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : NaN)

export const SPEC_LIMITS = { points: 120, sizes: 12 }

/**
 * The points of a request: `sizes` names the columns, and every point has a value for each (null where
 * blank). @returns {{ok: true, sizes: string[], points: object[]} | {ok: false, error: string}}
 */
export function cleanSpec(body) {
  const b = body && typeof body === 'object' ? body : {}
  if (!Array.isArray(b.sizes) || b.sizes.length < 1 || b.sizes.length > SPEC_LIMITS.sizes) return { ok: false, error: `Give between 1 and ${SPEC_LIMITS.sizes} sizes` }
  const sizes = b.sizes.map(s => text(String(s ?? ''), 12))
  if (sizes.some(s => !s) || new Set(sizes.map(s => s.toLowerCase())).size !== sizes.length) return { ok: false, error: 'Every size needs its own name' }
  if (!Array.isArray(b.points) || b.points.length > SPEC_LIMITS.points) return { ok: false, error: `A spec can have at most ${SPEC_LIMITS.points} points` }
  const points = []
  for (const [i, p] of b.points.entries()) {
    const at = `Point ${i + 1}`
    const name = text(p?.name, 200)
    if (!name) return { ok: false, error: `${at}: name the point` }
    const tol = key => { const v = num(p?.[key]); return v === null ? null : (!Number.isFinite(v) || v < 0 || v > 100) ? NaN : v }
    const tolPlus = tol('tolPlus'), tolMinus = tol('tolMinus')
    if (Number.isNaN(tolPlus) || Number.isNaN(tolMinus)) return { ok: false, error: `${at}: the tolerance must be a number from 0 up` }
    const values = sizes.map((_, j) => num(p?.values?.[j]))
    if (values.some(v => Number.isNaN(v) || (v !== null && (v < 0 || v > 1000)))) return { ok: false, error: `${at}: a size's value must be a number from 0 up` }
    points.push({ code: text(p?.code, 10), name, tolPlus, tolMinus, values, confidence: null, needsReview: false })
  }
  return { ok: true, sizes, points }
}

export const specView = (s, extra = {}) => ({
  id: String(s._id), orderId: s.orderId, header: s.header || {}, sizes: s.sizes || [],
  points: (s.points || []).map(p => ({ code: p.code || '', name: p.name, tolPlus: p.tolPlus ?? null, tolMinus: p.tolMinus ?? null, values: p.values || [] })),
  sourceDocumentId: s.sourceDocumentId ? String(s.sourceDocumentId) : null, extractedAt: s.extractedAt || null, updatedAt: s.updatedAt, ...extra,
})
