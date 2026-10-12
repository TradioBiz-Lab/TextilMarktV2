// Keeps a factory's material lines in step with the purchase orders that buy them.
//
// A production step such as "Material Sourcing" carries material lines (fabric, trims) with a status:
// pending, ordered, received. A step that has material lines cannot advance until they are received
// (the gate in routes/orders.js). Before purchase orders that was ticked by hand. Now:
//
//   a PO is sent        its material lines become "ordered", carrying the PO number and supplier
//   goods are received  the lines' received quantity grows, and a line becomes "received" once it has
//                       the quantity it needs, which opens the gate for the step
//   a sent PO is cancelled   the quantity it was holding is released again
//
// A PO line points at its material by where it was picked (order, step index, material index) and the
// material's name. If steps were inserted or removed since, the same position can hold something else,
// so the name is checked, and failing that the order's other steps are searched for the same name. A
// line that cannot be found is reported, never guessed at: the PO still stands and the material can be
// ticked by hand as before.
import mongoose from 'mongoose'
import { Order } from '../db/index.js'

const oid = v => new mongoose.Types.ObjectId(String(v))
const partyOf = a => String(a.mfrId?._id ?? a.mfrId)

/**
 * Where a PO line's material is on the order now: { stageIndex, materialIndex, material }, or null
 * when it can no longer be found. `partyId` is the factory (only its own split is searched).
 */
export function locateMaterial(order, partyId, ref) {
  const asgn = (order?.assignments || []).find(a => partyOf(a) === String(partyId))
  if (!asgn) return null
  const stages = asgn.stages || []
  const here = stages[ref.stageIndex]?.materials?.[ref.materialIndex]
  if (here && (!ref.name || here.name === ref.name)) return { stageIndex: ref.stageIndex, materialIndex: ref.materialIndex, material: here }
  if (!ref.name) return null
  for (let s = 0; s < stages.length; s++) {
    const mats = stages[s].materials || []
    for (let m = 0; m < mats.length; m++) if (mats[m].name === ref.name) return { stageIndex: s, materialIndex: m, material: mats[m] }
  }
  return null
}

async function writeMaterial(orderId, partyId, at, fields) {
  const prefix = `assignments.$[a].stages.${at.stageIndex}.materials.${at.materialIndex}`
  const $set = Object.fromEntries(Object.entries(fields).map(([k, v]) => [`${prefix}.${k}`, v]))
  await Order.updateOne({ _id: orderId, 'assignments.mfrId': oid(partyId) }, { $set }, { arrayFilters: [{ 'a.mfrId': oid(partyId) }] })
}

/** Run `fn(order, at, line)` for each PO line that names a material; collect what could not be found. */
async function eachLinkedLine(partyId, po, lines, fn) {
  const missing = []
  for (const line of lines) {
    if (!line.materialRef) continue
    const order = await Order.findById(line.materialRef.orderId).lean()
    const at = order && locateMaterial(order, partyId, line.materialRef)
    if (!at) { missing.push({ lineId: line.lineId, description: line.description }); continue }
    await fn(order, at, line)
  }
  return missing
}

/** A PO has just been sent: its linked material lines are now on order. */
export function syncOnSend({ partyId, po, supplier }) {
  return eachLinkedLine(partyId, po, po.lines, (order, at, line) => {
    const m = at.material
    const expected = line.expectedDate || po.expectedDate
    return writeMaterial(order._id, partyId, at, {
      status: m.status === 'received' ? 'received' : 'ordered',
      orderedQty: (m.orderedQty || 0) + line.qty,
      poNumber: po._id, poId: po._id, supplier: supplier.name, supplierId: supplier._id,
      ...(expected ? { expectedDate: expected } : {}),
    })
  })
}

/**
 * Goods have come in against a PO. `received` is [{ line, qty }] (the PO line and how much of it
 * arrived in this delivery).
 */
export function syncOnReceive({ partyId, po, received }) {
  const byLine = new Map(received.map(r => [r.line.lineId, r]))
  return eachLinkedLine(partyId, po, received.map(r => r.line), (order, at, line) => {
    const m = at.material
    const got = (m.receivedQty || 0) + byLine.get(line.lineId).qty
    const done = got >= (m.requiredQty || 0)
    return writeMaterial(order._id, partyId, at, {
      receivedQty: got,
      status: done ? 'received' : (m.status === 'pending' ? 'ordered' : m.status),
    })
  })
}

/** A sent PO was cancelled before anything arrived: the quantity it held is released. */
export function syncOnCancel({ partyId, po }) {
  return eachLinkedLine(partyId, po, po.lines, (order, at, line) => {
    const m = at.material
    const ordered = Math.max(0, (m.orderedQty || 0) - line.qty)
    const status = m.status === 'received' ? 'received' : ordered > 0 ? 'ordered' : 'pending'
    return writeMaterial(order._id, partyId, at, {
      orderedQty: ordered, status,
      ...(m.poId === po._id ? { poId: null, poNumber: '', supplierId: null } : {}),
    })
  })
}
