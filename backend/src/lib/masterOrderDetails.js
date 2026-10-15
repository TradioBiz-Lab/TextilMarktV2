// The commercial details a master order carries beyond its name and season: the customer's PO number and date,
// the date the order should ship by, and free notes. All optional. Shared by create and edit so both apply the
// same rules: a field that is sent is validated; '' or null clears it.

export const MO_DETAIL_FIELDS = ['poNumber', 'poDate', 'shipBy', 'notes']

// A real calendar day as 'YYYY-MM-DD' (so 2026-02-30 is refused rather than rolled over to 2 March), or null.
export const isoDay = v => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null
  const d = new Date(`${v}T00:00:00Z`)
  return isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? null : d
}

/** { set } with the fields present in `body`, ready for $set, or { error }. */
export function parseMasterOrderDetails(body) {
  const set = {}
  const has = k => Object.prototype.hasOwnProperty.call(body || {}, k)
  if (has('poNumber')) {
    const v = body.poNumber == null ? '' : body.poNumber
    if (typeof v !== 'string' || v.trim().length > 60) return { error: 'Customer PO number must be text of at most 60 characters' }
    set.poNumber = v.trim()
  }
  for (const [k, label] of [['poDate', 'PO date'], ['shipBy', 'Ship-by date']]) {
    if (!has(k)) continue
    if (body[k] === '' || body[k] === null) { set[k] = null; continue }
    const d = isoDay(body[k])
    if (!d) return { error: `${label} must be a date (YYYY-MM-DD)` }
    set[k] = d
  }
  if (has('notes')) {
    const v = body.notes == null ? '' : body.notes
    if (typeof v !== 'string' || v.length > 2000) return { error: 'Notes must be text of at most 2000 characters' }
    set.notes = v.trim()
  }
  return { set }
}

/** The details as the API returns them: dates as 'YYYY-MM-DD'. */
export const masterOrderDetailsOut = mo => ({
  poNumber: mo.poNumber || '',
  poDate: mo.poDate ? new Date(mo.poDate).toISOString().slice(0, 10) : null,
  shipBy: mo.shipBy ? new Date(mo.shipBy).toISOString().slice(0, 10) : null,
  notes: mo.notes || '',
})
