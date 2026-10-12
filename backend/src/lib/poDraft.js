// Turning a request into a purchase order draft: validating it against the company's own suppliers,
// catalog and orders, working the money out (lib/poMath.js), and numbering a new one. The PO routes and
// the BOM's "generate POs" use the same code, so a PO made from a bill of materials is checked exactly
// like one made by hand.
import mongoose from 'mongoose'
import { PurchaseOrder, Supplier, SupplierItem, Organization, Order } from '../db/index.js'
import { isId } from './procurement.js'
import { allocatePoId } from './counters.js'
import { cleanLine, computeTotals, moqWarnings } from './poMath.js'
import { taxModeFor } from './gst.js'
import { locateMaterial } from './poSync.js'

const mine = req => ({ ownerOrgId: req.user.orgId })

const supplierSnapshot = s => ({
  name: s.name, email: s.email || '', phone: s.phone || '', gstin: s.gstin || '', stateCode: s.stateCode || '',
  address: s.address || '', city: s.city || '', pincode: s.pincode || '', contactName: s.contacts?.[0]?.name || '',
})
const buyerSnapshot = (org, user) => {
  const p = org.profile || {}
  return {
    name: p.legalName || org.name, email: p.email || user.email || '', phone: p.phone || '', gstin: p.gstin || '', pan: p.pan || '',
    stateCode: p.stateCode || '', address: p.address || '', city: p.city || '', pincode: p.pincode || '',
  }
}

export const newLineId = () => String(new mongoose.Types.ObjectId())

/**
 * Check a request and compute the PO it describes. `existing` is the draft being edited (its
 * supplier and lines carry over unless the request replaces them).
 * @returns {Promise<{ok: true, data: object, warnings: object[]} | {ok: false, status: number, error: string}>}
 */
export async function prepare(req, body, existing = null, { dropStaleLinks = false, trustBomRefs = false } = {}) {
  const supplierId = body.supplierId ?? existing?.supplierId
  if (!isId(supplierId)) return { ok: false, status: 400, error: 'Choose a supplier' }
  const supplier = await Supplier.findOne({ _id: supplierId, ...mine(req) }).lean()
  if (!supplier) return { ok: false, status: 400, error: 'Choose one of your suppliers' }
  if (supplier.isActive === false && String(existing?.supplierId) !== String(supplier._id)) return { ok: false, status: 400, error: 'That supplier is archived. Restore it first' }

  const raw = body.lines ?? existing?.lines ?? []
  if (!Array.isArray(raw) || raw.length > 200) return { ok: false, status: 400, error: 'A purchase order can have at most 200 lines' }
  const keepIds = new Set((existing?.lines || []).map(l => l.lineId))
  const lines = []
  for (const [i, r] of raw.entries()) {
    const c = cleanLine(trustBomRefs || !r || typeof r !== 'object' ? r : { ...r, bomRefs: undefined }, i + 1)
    if (!c.ok) return { ok: false, status: 400, error: c.error }
    lines.push({ ...c.line, lineId: typeof r.lineId === 'string' && keepIds.has(r.lineId) ? r.lineId : newLineId(), receivedQty: 0 })
  }
  // Carry received quantities over when the same line is kept (an edit never loses what arrived), and the
  // bill of materials links it already had. A browser cannot add links: only the server's generator can.
  for (const l of lines) {
    const before = (existing?.lines || []).find(e => e.lineId === l.lineId)
    l.receivedQty = before?.receivedQty || 0
    if (!trustBomRefs) l.bomRefs = (before?.bomRefs || []).map(r => ({ bomId: String(r.bomId), orderId: r.orderId, lineId: r.lineId, colour: r.colour || '', qty: r.qty }))
  }

  // Catalog items must be this supplier's own.
  const itemIds = [...new Set(lines.map(l => l.itemId).filter(Boolean))]
  const items = itemIds.length ? await SupplierItem.find({ _id: { $in: itemIds }, supplierId: supplier._id, ...mine(req) }).lean() : []
  if (items.length !== itemIds.length) return { ok: false, status: 400, error: 'A line names an item that is not in this supplier\'s catalog' }

  // Material links must be on orders this factory is on, and the material must still be there.
  const staleLinks = []
  const orderIds = [...new Set(lines.map(l => l.materialRef?.orderId).filter(Boolean))]
  if (orderIds.length) {
    const orders = await Order.find({ _id: { $in: orderIds }, 'assignments.mfrId': req.user.id }, 'assignments').lean()
    const byId = new Map(orders.map(o => [o._id, o]))
    for (const [i, l] of lines.entries()) {
      if (!l.materialRef) continue
      const order = byId.get(l.materialRef.orderId)
      const at = order && locateMaterial(order, req.user.id, l.materialRef)
      if (!at) {
        // Sending must not be held up by a material line that has since been removed: the link is dropped and reported.
        if (dropStaleLinks) { staleLinks.push(l.description); l.materialRef = null; continue }
        return { ok: false, status: 400, error: `Line ${i + 1}: that material is not on one of your orders any more` }
      }
      l.materialRef = { orderId: l.materialRef.orderId, stageIndex: at.stageIndex, materialIndex: at.materialIndex, name: at.material.name }
    }
  }

  const org = await Organization.findById(req.user.orgId).lean()
  const taxMode = taxModeFor(supplier.stateCode, org?.profile?.stateCode)
  const calc = computeTotals(lines, taxMode)
  const priced = lines.map((l, i) => ({ ...l, ...calc.lines[i] }))

  const expectedDate = body.expectedDate === undefined ? existing?.expectedDate ?? null : (body.expectedDate || null)
  if (expectedDate && !/^\d{4}-\d{2}-\d{2}$/.test(expectedDate)) return { ok: false, status: 400, error: 'The delivery date is not a valid date' }
  const pick = (key, label, max) => {
    const v = body[key] === undefined ? existing?.[key] ?? '' : String(body[key] ?? '').trim()
    if (v.length > max) return { error: `${label} is too long (most ${max} characters)` }
    return { v }
  }
  const shipTo = pick('shipTo', 'Deliver to', 400), terms = pick('terms', 'Terms', 2000), note = pick('internalNote', 'Note', 1000)
  const pay = body.paymentTerms === undefined && !existing ? { v: supplier.paymentTerms || '' } : pick('paymentTerms', 'Payment terms', 200)
  for (const p of [shipTo, terms, note, pay]) if (p.error) return { ok: false, status: 400, error: p.error }

  return {
    ok: true, supplier, org,
    data: {
      supplierId: supplier._id, supplierSnapshot: supplierSnapshot(supplier), buyerSnapshot: buyerSnapshot(org, req.user),
      lines: priced, taxMode: calc.taxMode, totals: calc.totals, expectedDate,
      shipTo: shipTo.v, paymentTerms: pay.v, terms: terms.v, internalNote: note.v,
    },
    warnings: moqWarnings(lines, new Map(items.map(i => [String(i._id), i]))),
    staleLinks,
  }
}

/** One history entry for a PO. */
export const stamp = (req, action, note = '') => ({ at: new Date(), by: req.user.actorId, byName: req.user.name, action, note })

/**
 * Create a draft from a request body (see prepare). A number taken by a hand-made id is skipped.
 * @returns {Promise<{ok: true, po: object, supplier: object, warnings: object[]} | {ok: false, status: number, error: string}>}
 */
export async function createDraft(req, body, opts = {}) {
  const p = await prepare(req, body || {}, null, opts)
  if (!p.ok) return p
  let po
  for (let attempt = 0; ; attempt++) {
    const _id = await allocatePoId({ orgId: String(req.user.orgId), orgCode: p.org.code })
    try {
      po = await PurchaseOrder.create({ _id, ...mine(req), ...p.data, status: 'draft', createdBy: req.user.actorId, timeline: [stamp(req, 'Draft created')] })
      break
    } catch (err) { if (err?.code !== 11000 || attempt >= 4) throw err }
  }
  return { ok: true, po, supplier: p.supplier, warnings: p.warnings }
}
