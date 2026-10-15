// A material line's details beyond its name and quantity: the unit, who supplies it, the purchase order it is on and
// when it is expected. All optional. Shared by the add, edit and bulk routes so all three apply the same rules: a field
// that is sent is checked; '' or null clears it.

import { isoDay } from './masterOrderDetails.js'

const TEXT_FIELDS = [['unit', 'Unit', 30], ['supplier', 'Supplier', 200], ['poNumber', 'PO number', 60]]

/** { set } with the fields present in `body` (expectedDate as 'YYYY-MM-DD' or null), or { error }. */
export function materialDetails(body) {
  const set = {}
  const has = k => Object.prototype.hasOwnProperty.call(body || {}, k) && body[k] !== undefined
  for (const [k, label, max] of TEXT_FIELDS) {
    if (!has(k)) continue
    const v = body[k] == null ? '' : body[k]
    if (typeof v !== 'string' || v.trim().length > max) return { error: `${label} must be text of at most ${max} characters` }
    set[k] = v.trim()
  }
  if (has('expectedDate')) {
    const v = body.expectedDate
    if (v === '' || v === null) set.expectedDate = null
    else if (!isoDay(v)) return { error: 'Expected date must be a date (YYYY-MM-DD)' }
    else set.expectedDate = v
  }
  return { set }
}

/** A new line's details, blanks filled in. */
export const newMaterialDetails = set => ({ unit: set.unit ?? '', supplier: set.supplier ?? '', poNumber: set.poNumber ?? '', expectedDate: set.expectedDate ?? null })
