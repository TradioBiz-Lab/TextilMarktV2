// GST basics for the supplier and purchase order screens. Mirrors backend/src/lib/gst.js; the server is
// the real check, this lets a form say "that GSTIN is not valid" as the user types.

export const GST_STATES = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand',
  '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim',
  '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya',
  '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
  '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa',
  '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory', '99': 'Centre Jurisdiction',
}

/** [{ code, name }] sorted by name, for a state select. */
export const GST_STATE_OPTIONS = Object.entries(GST_STATES).map(([code, name]) => ({ code, name })).sort((a, b) => a.name.localeCompare(b.name))

export const stateName = code => GST_STATES[String(code || '')] || ''

const GSTIN_SHAPE = /^(\d{2})[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/
const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'

export const normalizeGstin = v => String(v ?? '').toUpperCase().replace(/\s+/g, '')

/** The 15th character of a GSTIN, worked out from the first fourteen. */
export function gstinCheckChar(first14) {
  let sum = 0
  for (let i = 0; i < 14; i++) {
    const product = CHARS.indexOf(first14[i]) * (i % 2 === 0 ? 1 : 2)
    sum += Math.floor(product / 36) + (product % 36)
  }
  return CHARS[(36 - (sum % 36)) % 36]
}

export function isValidGstin(value) {
  const g = normalizeGstin(value)
  const m = GSTIN_SHAPE.exec(g)
  if (!m || !GST_STATES[m[1]]) return false
  return gstinCheckChar(g.slice(0, 14)) === g[14]
}

export const stateCodeFromGstin = value => (isValidGstin(value) ? normalizeGstin(value).slice(0, 2) : null)

export const isValidPan = value => /^[A-Z]{5}\d{4}[A-Z]$/.test(String(value ?? '').toUpperCase())

/** 'intra' (CGST and SGST), 'inter' (IGST) or 'unknown' (one combined GST figure). */
export function taxModeFor(supplierStateCode, buyerStateCode) {
  const a = String(supplierStateCode || ''), b = String(buyerStateCode || '')
  if (!GST_STATES[a] || !GST_STATES[b]) return 'unknown'
  return a === b ? 'intra' : 'inter'
}
