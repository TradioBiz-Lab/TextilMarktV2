// A company's business details (the header of its purchase orders): validation shared by the company's
// own page and by the master admin setting a company up.
import { GST_STATES, isValidGstin, normalizeGstin, isValidPan } from './gst.js'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const TEXT = { legalName: ['Legal name', 200], address: ['Address', 300], city: ['City', 80], phone: ['Phone', 40] }

/**
 * Clean the fields present in `input` (a partial update is fine).
 * @returns {{ok: true, profile: object} | {ok: false, error: string}}
 */
export function cleanProfile(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'Nothing to save' }
  const out = {}

  for (const [key, [label, max]] of Object.entries(TEXT)) {
    if (input[key] === undefined) continue
    if (typeof input[key] !== 'string') return { ok: false, error: `${label} must be text` }
    const v = input[key].trim()
    if (v.length > max) return { ok: false, error: `${label} is too long (most ${max} characters)` }
    out[key] = v
  }

  if (input.pincode !== undefined) {
    const v = String(input.pincode ?? '').trim()
    if (v && !/^\d{6}$/.test(v)) return { ok: false, error: 'PIN code must be 6 digits' }
    out.pincode = v
  }
  if (input.email !== undefined) {
    const v = String(input.email ?? '').trim().toLowerCase()
    if (v && (v.length > 254 || !EMAIL_RE.test(v))) return { ok: false, error: 'Enter a valid email address' }
    out.email = v
  }
  if (input.pan !== undefined) {
    const v = String(input.pan ?? '').trim().toUpperCase()
    if (v && !isValidPan(v)) return { ok: false, error: 'PAN is not valid (for example ABCDE1234F)' }
    out.pan = v
  }
  if (input.stateCode !== undefined) {
    const v = String(input.stateCode ?? '').trim()
    if (v && !GST_STATES[v]) return { ok: false, error: 'Choose a state from the list' }
    out.stateCode = v
  }
  if (input.gstin !== undefined) {
    const v = normalizeGstin(input.gstin)
    if (v && !isValidGstin(v)) return { ok: false, error: 'GSTIN is not valid: check each character' }
    out.gstin = v
    // The state is the first two digits of the GSTIN, so it cannot disagree with it.
    if (v) out.stateCode = v.slice(0, 2)
  }
  return Object.keys(out).length ? { ok: true, profile: out } : { ok: false, error: 'Nothing to save' }
}

/** A `$set` that changes only the given profile fields. */
export const profileSet = profile => Object.fromEntries(Object.entries(profile).map(([k, v]) => [`profile.${k}`, v]))

/** The profile as the API returns it: every field present, never undefined. */
export const profileView = p => ({
  legalName: p?.legalName || '', gstin: p?.gstin || '', pan: p?.pan || '', address: p?.address || '', city: p?.city || '',
  pincode: p?.pincode || '', stateCode: p?.stateCode || '', phone: p?.phone || '', email: p?.email || '',
})
