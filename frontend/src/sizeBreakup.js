// A style's size breakup in the browser: pieces of each colour in each size (backend/src/lib/sizeBreakup.js holds the
// rules the server enforces). Pure helpers for the grid and its editor.

/** "S, M , L" -> ['S', 'M', 'L'] (blanks dropped). */
export const parseSizes = text => String(text || '').split(',').map(s => s.trim()).filter(Boolean)

/** { bySize, byColour, total } of a breakup ({ sizes, rows: [{ colour, qty }] }); zeros for none. A blank cell is zero. */
export function breakupTotals(b) {
  const sizes = b?.sizes || []
  const rows = b?.rows || []
  const n = v => { const x = Number(v); return Number.isFinite(x) && x > 0 ? Math.floor(x) : 0 }
  const bySize = sizes.map((_, i) => rows.reduce((t, r) => t + n(r.qty?.[i]), 0))
  const byColour = rows.map(r => sizes.reduce((t, _, i) => t + n(r.qty?.[i]), 0))
  return { bySize, byColour, total: bySize.reduce((a, x) => a + x, 0) }
}

/**
 * The grid the editor opens with: the style's saved breakup, or an empty one with a row for each of its colours (one
 * unnamed row when it has none). Cells are text while they are being typed.
 */
export function editorGrid(order) {
  const b = order?.sizeBreakup
  if (b?.sizes?.length) return { sizes: b.sizes.join(', '), rows: b.rows.map(r => ({ colour: r.colour, qty: b.sizes.map((_, i) => String(r.qty?.[i] ?? 0)) })) }
  const colours = (order?.colourways || []).map(c => c.name).filter(Boolean)
  return { sizes: '', rows: (colours.length ? colours : ['']).map(colour => ({ colour, qty: [] })) }
}

/** Each row's cells fitted to the sizes now typed: kept by position, blank where a size was added. */
export const fitRows = (rows, count) => rows.map(r => ({ ...r, qty: Array.from({ length: count }, (_, i) => r.qty?.[i] ?? '') }))

/**
 * What the editor holds -> { body } to send, or { error } to show. Rows with no colour and no pieces are left out, so a
 * spare empty row does not block saving. An empty grid (no sizes, nothing typed) sends a clear.
 */
export function editorPayload(grid) {
  const sizes = parseSizes(grid.sizes)
  const rows = fitRows(grid.rows || [], sizes.length)
    .map(r => ({ colour: (r.colour || '').trim(), qty: r.qty.map(q => String(q ?? '').trim()) }))
    .filter(r => r.colour || r.qty.some(q => q !== '' && q !== '0'))
  if (!sizes.length && !rows.length) return { body: { sizes: [], rows: [] } }
  if (!sizes.length) return { error: 'Type the sizes first, separated by commas, for example S, M, L, XL' }
  if (!rows.length) return { error: 'Add the pieces for at least one colour' }
  const seen = new Set()
  for (const s of sizes) { if (seen.has(s.toLowerCase())) return { error: `Size ${s} is there twice` }; seen.add(s.toLowerCase()) }
  for (const r of rows) {
    if (!r.colour && rows.length > 1) return { error: 'Name every colour' }
    if (r.qty.some(q => q !== '' && !/^\d+$/.test(q))) return { error: `${r.colour || 'The row'}: quantities must be whole numbers of pieces` }
  }
  return { body: { sizes, rows: rows.map(r => ({ colour: r.colour, qty: r.qty.map(q => (q === '' ? 0 : Number(q))) })) } }
}

/**
 * A plain line when the breakup's total and the style's quantity differ, else ''. It is told, never refused: a breakup
 * often arrives before the quantity is final.
 */
export function totalNote(breakupTotal, styleQty) {
  if (!styleQty || !breakupTotal || breakupTotal === styleQty) return ''
  const gap = Math.abs(breakupTotal - styleQty)
  return `The breakup adds up to ${breakupTotal} pieces, ${gap} ${breakupTotal > styleQty ? 'more' : 'fewer'} than the style's quantity of ${styleQty}.`
}
