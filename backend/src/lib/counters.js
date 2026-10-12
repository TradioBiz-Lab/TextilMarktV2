// Server-side numbering for IDs people read (order IDs, master order IDs, PO numbers, and later GRN
// numbers).
//
// The browser used to work out "highest number I can see, plus one". That only works while one
// kind of user creates everything: once manufacturers and brands both create orders, neither can see
// all of the numbers in a series, and two people creating at once collide. Numbering lives here
// instead, advanced with one atomic update per number, so it is correct for concurrent requests and
// would stay correct if the server ever ran more than one process.
import { Counter, Order, MasterOrder, PurchaseOrder } from '../db/index.js'
import { fiscalYearCode } from './fiscalYear.js'

const escapeRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The next number in a series. The first use of a series starts from the highest number already in
 * use (`seedFn`), so a series that predates counters carries on where the old numbering stopped
 * instead of colliding with it.
 */
export async function nextSeq(key, seedFn) {
  const bump = () => Counter.findOneAndUpdate({ _id: key }, { $inc: { seq: 1 } }, { new: true, lean: true })
  let doc = await bump()
  if (doc) return doc.seq
  const base = seedFn ? await seedFn() : 0
  // Two first callers can both get here; the second create is refused and both just advance.
  try { await Counter.create({ _id: key, seq: base }) } catch (err) { if (err?.code !== 11000) throw err }
  doc = await bump()
  return doc.seq
}

const trailingNumber = id => {
  const n = parseInt(String(id).slice(String(id).lastIndexOf('-') + 1), 10)
  return Number.isFinite(n) ? n : 0
}
const padded = n => String(n).padStart(3, '0')

/** A style's category as it appears in its ID: letters and digits only, at most six. */
export const categoryForId = category => String(category || 'XX').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'XX'

/** Next order ID, e.g. ZAR-TSHRT-SS26-004: numbered per buyer, category and season. */
export async function allocateOrderId({ buyerCode, category, season }) {
  const prefix = `${buyerCode}-${categoryForId(category)}-${season || 'XX'}-`
  const seq = await nextSeq(`order:${prefix}`, async () => {
    const ids = await Order.find({ _id: new RegExp(`^${escapeRe(prefix)}\\d+$`) }, { _id: 1 }).lean()
    return ids.reduce((max, o) => Math.max(max, trailingNumber(o._id)), 0)
  })
  return `${prefix}${padded(seq)}`
}

/** Next master order ID, e.g. MO-ZAR-SS26-003: numbered per buyer across seasons. */
export async function allocateMasterOrderId({ buyerCode, season }) {
  const seq = await nextSeq(`mo:${buyerCode}`, async () => {
    const ids = await MasterOrder.find({ _id: new RegExp(`^MO-${escapeRe(buyerCode)}-`) }, { _id: 1 }).lean()
    return ids.reduce((max, m) => Math.max(max, trailingNumber(m._id)), 0)
  })
  return `MO-${buyerCode}-${season || 'XX'}-${padded(seq)}`
}

/**
 * Next purchase order number, e.g. PO-TPR-2627-0007: numbered per factory per Indian financial year,
 * so each factory's series starts again at 0001 every April.
 */
export async function allocatePoId({ orgId, orgCode, now = new Date() }) {
  const fy = fiscalYearCode(now)
  const prefix = `PO-${orgCode}-${fy}-`
  const seq = await nextSeq(`po:${orgId}:${fy}`, async () => {
    const ids = await PurchaseOrder.find({ _id: new RegExp(`^${escapeRe(prefix)}\\d+$`) }, { _id: 1 }).lean()
    return ids.reduce((max, p) => Math.max(max, trailingNumber(p._id)), 0)
  })
  return `${prefix}${String(seq).padStart(4, '0')}`
}
