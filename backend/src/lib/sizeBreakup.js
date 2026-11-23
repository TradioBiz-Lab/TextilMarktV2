// A style's size breakup: how many pieces of each colour in each size, as the customer's order gives it (Cocoblu sends
// a grid like this with every purchase order). Sizes are the style's own ("28, 30, 32" for trousers, "S, M, L" for
// shirts), so there is no fixed list. Quantities only: no prices, barcodes or other per-size details.
//
//   { sizes: ['S', 'M', 'L'], rows: [{ colour: 'Olivine', qty: [40, 80, 80] }, ...] }
//
// Pure: validation and totals, used by the route and its tests. The browser has the same totals in
// frontend/src/sizeBreakup.js.

export const MAX_SIZES = 24
export const MAX_COLOURS = 60
export const MAX_SIZE_LEN = 12
export const MAX_COLOUR_LEN = 60
export const MAX_CELL = 1000000

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const key = s => s.toLowerCase()

/**
 * What was sent -> { value } (the breakup to store, or null to clear it) or { error }.
 * An empty or missing grid clears the breakup. A blank cell is zero.
 */
export function cleanSizeBreakup(body) {
  if (body === null || body === undefined) return { value: null }
  if (!isObj(body)) return { error: 'Invalid size breakup' }
  let { sizes, rows } = body
  if (typeof sizes === 'string') sizes = sizes.split(',')
  if (sizes === undefined || sizes === null) sizes = []
  if (rows === undefined || rows === null) rows = []
  if (!Array.isArray(sizes) || !Array.isArray(rows)) return { error: 'Invalid size breakup' }
  if (sizes.length === 0 && rows.length === 0) return { value: null }
  if (sizes.length === 0) return { error: 'Add at least one size' }
  if (rows.length === 0) return { error: 'Add at least one colour' }
  if (sizes.length > MAX_SIZES) return { error: `Too many sizes (${MAX_SIZES} at most)` }
  if (rows.length > MAX_COLOURS) return { error: `Too many colours (${MAX_COLOURS} at most)` }

  const cleanSizes = []
  for (const s of sizes) {
    if (typeof s !== 'string' && typeof s !== 'number') return { error: 'A size must be text, such as S or 32' }
    const t = String(s).trim()
    if (!t) return { error: 'A size is empty' }
    if (t.length > MAX_SIZE_LEN) return { error: `Size "${t.slice(0, 20)}" is too long (${MAX_SIZE_LEN} characters at most)` }
    if (cleanSizes.some(x => key(x) === key(t))) return { error: `Size ${t} is there twice` }
    cleanSizes.push(t)
  }

  const cleanRows = []
  for (const r of rows) {
    if (!isObj(r)) return { error: 'Invalid size breakup' }
    if (r.colour !== undefined && r.colour !== null && typeof r.colour !== 'string') return { error: 'A colour must be text' }
    const colour = (r.colour || '').trim()
    if (colour.length > MAX_COLOUR_LEN) return { error: `Colour "${colour.slice(0, 20)}" is too long (${MAX_COLOUR_LEN} characters at most)` }
    if (!colour && rows.length > 1) return { error: 'Name every colour' }
    if (cleanRows.some(x => key(x.colour) === key(colour))) return { error: `Colour ${colour} is there twice` }
    if (!Array.isArray(r.qty) || r.qty.length !== cleanSizes.length) return { error: `${colour || 'The row'} needs one quantity for each size` }
    const qty = []
    for (const q of r.qty) {
      const n = q === null || q === undefined || q === '' ? 0 : typeof q === 'string' && /^\s*\d+\s*$/.test(q) ? Number(q) : q
      if (!Number.isInteger(n) || n < 0 || n > MAX_CELL) return { error: 'Quantities must be whole numbers of pieces, zero or more' }
      qty.push(n)
    }
    cleanRows.push({ colour, qty })
  }
  return { value: { sizes: cleanSizes, rows: cleanRows } }
}

/** { bySize: [..], byColour: [..], total } for a stored breakup; zeros for none. */
export function sizeBreakupTotals(b) {
  if (!b?.sizes?.length) return { bySize: [], byColour: [], total: 0 }
  const bySize = b.sizes.map((_, i) => (b.rows || []).reduce((n, r) => n + (r.qty?.[i] || 0), 0))
  const byColour = (b.rows || []).map(r => (r.qty || []).reduce((n, q) => n + (q || 0), 0))
  return { bySize, byColour, total: bySize.reduce((a, n) => a + n, 0) }
}

/** The breakup as the API returns it (null when the style has none), with its total. */
export function sizeBreakupOut(b) {
  if (!b?.sizes?.length) return null
  return {
    sizes: [...b.sizes],
    rows: (b.rows || []).map(r => ({ colour: r.colour || '', qty: b.sizes.map((_, i) => r.qty?.[i] || 0) })),
    total: sizeBreakupTotals(b).total,
    updatedAt: b.updatedAt || null,
  }
}
