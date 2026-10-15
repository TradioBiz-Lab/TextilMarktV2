// The commercial details a master order carries beyond its name and season: the customer's PO number and date,
// the date the order should ship by, the order value and its currency, payment terms, Incoterm, where it ships to,
// and free notes. All optional. Shared by create and edit so both apply the
// same rules: a field that is sent is validated; '' or null clears it.

export const MO_DETAIL_FIELDS = ['poNumber', 'poDate', 'shipBy', 'notes', 'currency', 'price', 'paymentTerms', 'incoterm', 'shipTo']

// What the customer pays and on what terms is between Tradio and the customer: a factory never receives these.
export const MO_COMMERCIAL_FIELDS = ['currency', 'price', 'paymentTerms']

// Incoterms 2020.
export const INCOTERMS = ['EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP']

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
  if (has('currency')) {
    const v = body.currency == null ? '' : body.currency
    if (typeof v !== 'string' || (v.trim() && !/^[A-Za-z]{3}$/.test(v.trim()))) return { error: 'Currency must be a 3-letter code such as INR or USD' }
    set.currency = v.trim().toUpperCase()
  }
  if (has('price')) {
    const v = body.price
    if (v === '' || v === null) set.price = null
    else {
      const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*\d+(\.\d{1,2})?\s*$/.test(v) ? Number(v) : NaN
      if (!Number.isFinite(n) || n < 0 || n > 1e12 || Math.round(n * 100) !== n * 100) return { error: 'Order value must be a number of at most 2 decimal places' }
      set.price = n
    }
  }
  for (const [k, label, max] of [['paymentTerms', 'Payment terms', 200], ['shipTo', 'Ship-to address', 500]]) {
    if (!has(k)) continue
    const v = body[k] == null ? '' : body[k]
    if (typeof v !== 'string' || v.trim().length > max) return { error: `${label} must be text of at most ${max} characters` }
    set[k] = v.trim()
  }
  if (has('incoterm')) {
    const v = body.incoterm == null ? '' : body.incoterm
    if (typeof v !== 'string' || (v.trim() && !INCOTERMS.includes(v.trim().toUpperCase()))) return { error: `Incoterm must be one of ${INCOTERMS.join(', ')}` }
    set.incoterm = v.trim().toUpperCase()
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
  currency: mo.currency || '',
  price: mo.price ?? null,
  paymentTerms: mo.paymentTerms || '',
  incoterm: mo.incoterm || '',
  shipTo: mo.shipTo || '',
})
