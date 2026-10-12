// Suppliers and purchase orders: who may use them, and how a request's fields are checked.
//
// Everything here belongs to one manufacturer organization. The routes scope every query by the
// caller's own organization (taken from the session, never from the request), and brands and Tradio
// staff do not get in at all: what a factory buys, from whom and at what rate is its own business.
import mongoose from 'mongoose'
import { isStandalone } from './platform.js'
import { SUPPLIER_TYPES } from '../models/Supplier.js'
import { ITEM_CATEGORIES } from '../models/SupplierItem.js'
import { GST_STATES, isValidGstin, normalizeGstin } from './gst.js'

/**
 * Put on every procurement route. The modules exist only in the standalone product (the Tradio
 * portal is unchanged), and only for a manufacturer's own session: a master admin looking at a
 * factory is that factory's session, read-only unless acting for it, so they see what it sees.
 */
export function requireProcurement(req, res, next) {
  if (!isStandalone()) return res.status(404).json({ error: 'Not found' })
  if (req.user?.role !== 'manufacturer' || !req.user.orgId)
    return res.status(403).json({ error: 'Suppliers and purchase orders are for manufacturers' })
  next()
}

/**
 * Put on every stock and goods received route. Same rule as procurement: the standalone product only, and a
 * manufacturer's own session (a master admin looking at a factory is that factory's session, read-only).
 */
export function requireInventory(req, res, next) {
  if (!isStandalone()) return res.status(404).json({ error: 'Not found' })
  if (req.user?.role !== 'manufacturer' || !req.user.orgId)
    return res.status(403).json({ error: 'Stock and goods received notes are for manufacturers' })
  next()
}

/**
 * Put on every cost sheet route. The module exists only in the standalone product, and for the two sides of
 * a sheet: the factory that prepares it and the brand it is shared with. Each route then scopes to what
 * that side may reach. A master admin looking at a company is that company's own session, read-only.
 */
export function requireCosting(req, res, next) {
  if (!isStandalone()) return res.status(404).json({ error: 'Not found' })
  if ((req.user?.role !== 'manufacturer' && req.user?.role !== 'buyer') || !req.user.orgId)
    return res.status(403).json({ error: 'Cost sheets are for manufacturers and their customers' })
  next()
}

export const isId = v => mongoose.Types.ObjectId.isValid(v) && String(new mongoose.Types.ObjectId(String(v))) === String(v)

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function text(input, key, label, max, out, { required = false } = {}) {
  if (input[key] === undefined) return required ? `${label} is required` : null
  if (typeof input[key] !== 'string') return `${label} must be text`
  const v = input[key].trim()
  if (required && !v) return `${label} is required`
  if (v.length > max) return `${label} is too long (most ${max} characters)`
  out[key] = v
  return null
}

const num = (v, label, { min = 0, max = Infinity } = {}) => {
  const n = Number(v)
  if (!Number.isFinite(n) || n < min || n > max) return { error: `${label} must be a number from ${min}${Number.isFinite(max) ? ` to ${max}` : ' up'}` }
  return { value: n }
}

/**
 * A supplier from a request body. `partial` checks only the fields present (an edit); otherwise the
 * name is required (a create).
 * @returns {{ok: true, value: object} | {ok: false, error: string}}
 */
export function cleanSupplier(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'Nothing to save' }
  const out = {}
  const problems = [
    text(input, 'name', 'Name', 200, out, { required: !partial }),
    text(input, 'phone', 'Phone', 40, out),
    text(input, 'address', 'Address', 400, out),
    text(input, 'city', 'City', 80, out),
    text(input, 'paymentTerms', 'Payment terms', 200, out),
    text(input, 'deliveryTerms', 'Delivery terms', 200, out),
    text(input, 'notes', 'Notes', 1000, out),
  ]
  const first = problems.find(Boolean)
  if (first) return { ok: false, error: first }

  if (input.type !== undefined) {
    if (!SUPPLIER_TYPES.includes(input.type)) return { ok: false, error: 'Choose a supplier type from the list' }
    out.type = input.type
  }
  if (input.email !== undefined) {
    const v = String(input.email ?? '').trim().toLowerCase()
    if (v && (v.length > 254 || !EMAIL_RE.test(v))) return { ok: false, error: 'Enter a valid email address' }
    out.email = v
  }
  if (input.pincode !== undefined) {
    const v = String(input.pincode ?? '').trim()
    if (v && !/^\d{6}$/.test(v)) return { ok: false, error: 'PIN code must be 6 digits' }
    out.pincode = v
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
    if (v) out.stateCode = v.slice(0, 2)       // the GSTIN decides the state
  }
  if (input.visibility !== undefined && input.visibility !== 'private') return { ok: false, error: 'Suppliers are private to your company' }
  if (input.contacts !== undefined) {
    if (!Array.isArray(input.contacts) || input.contacts.length > 10) return { ok: false, error: 'Add at most 10 contacts' }
    const contacts = []
    for (const [i, c] of input.contacts.entries()) {
      if (!c || typeof c !== 'object') return { ok: false, error: `Contact ${i + 1} is not valid` }
      const entry = {}
      const bad = text(c, 'name', 'Contact name', 120, entry) || text(c, 'role', 'Contact role', 80, entry) || text(c, 'phone', 'Contact phone', 40, entry)
      if (bad) return { ok: false, error: bad }
      if (c.email !== undefined) {
        const e = String(c.email ?? '').trim().toLowerCase()
        if (e && !EMAIL_RE.test(e)) return { ok: false, error: `Contact ${i + 1}: enter a valid email address` }
        entry.email = e
      }
      if (entry.name || entry.phone || entry.email) contacts.push({ name: '', role: '', phone: '', email: '', ...entry })
    }
    out.contacts = contacts
  }
  return Object.keys(out).length ? { ok: true, value: out } : { ok: false, error: 'Nothing to save' }
}

/** A catalog item from a request body (create needs a name; an edit may send any subset). */
export function cleanItem(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'Nothing to save' }
  const out = {}
  const first = [text(input, 'name', 'Item name', 200, out, { required: !partial }), text(input, 'unit', 'Unit', 20, out)].find(Boolean)
  if (first) return { ok: false, error: first }
  if (input.category !== undefined) {
    if (!ITEM_CATEGORIES.includes(input.category)) return { ok: false, error: 'Choose fabric, trim or other' }
    out.category = input.category
  }
  for (const [key, label, opts] of [['defaultRate', 'Rate', { min: 0, max: 1e8 }], ['moq', 'Minimum order', { min: 0, max: 1e9 }], ['taxPct', 'GST rate', { min: 0, max: 40 }], ['leadTimeDays', 'Lead time', { min: 0, max: 365 }]]) {
    const v = input[key]
    if (v === undefined) continue
    if (v === null || v === '') { if (key === 'leadTimeDays') out[key] = null; continue }   // lead time may be cleared; the others keep their value
    const r = num(v, label, opts)
    if (r.error) return { ok: false, error: r.error }
    out[key] = r.value
  }
  if (input.hsnCode !== undefined) {
    const v = String(input.hsnCode ?? '').replace(/\s+/g, '')
    if (v && !/^\d{4,8}$/.test(v)) return { ok: false, error: 'HSN code must be 4 to 8 digits' }
    out.hsnCode = v
  }
  if (input.visibility !== undefined && input.visibility !== 'private') return { ok: false, error: 'Catalog items are private to your company' }
  if (input.specs !== undefined) {
    const s = input.specs
    if (!s || typeof s !== 'object' || Array.isArray(s)) return { ok: false, error: 'Specs are not valid' }
    const specs = {}
    const bad = text(s, 'composition', 'Composition', 120, specs) || text(s, 'construction', 'Construction', 80, specs) || text(s, 'colour', 'Colour', 80, specs)
    if (bad) return { ok: false, error: bad }
    for (const [key, label, max] of [['gsm', 'GSM', 2000], ['widthInches', 'Width', 400]]) {
      if (s[key] === undefined) continue
      if (s[key] === null || s[key] === '') { specs[key] = null; continue }
      const r = num(s[key], label, { min: 0, max })
      if (r.error) return { ok: false, error: r.error }
      specs[key] = r.value
    }
    out.specs = specs
  }
  return Object.keys(out).length ? { ok: true, value: out } : { ok: false, error: 'Nothing to save' }
}
