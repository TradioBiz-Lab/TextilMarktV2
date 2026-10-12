// Stock: finding the item a line means, writing movements to the ledger, and reading balances.
//
// The stock ledger is the only record of how much there is: a balance is the sum of an item's rows at a
// location. Rows are never edited or deleted, and each carries a key so that writing the same movement
// twice (a retry after a crash) records it once. Everything here is scoped by the organization given: a
// company's stock is its own, and nothing takes an organization from a request.
import mongoose from 'mongoose'
import { InventoryItem, StockLedger } from '../../db/index.js'
import { STORE } from '../../models/StockLedger.js'

export { STORE }

const norm = v => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
const oid = v => new mongoose.Types.ObjectId(String(v))

/** Quantities are kept to three decimals, the way a weighing scale reads. */
export const round3 = n => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000

/** How a received line finds its item again: its name and unit, ignoring case and spacing. */
export const itemKey = (name, unit) => `${norm(name)}|${norm(unit)}`

/** The location of stock held by a job worker (a dyer, printer or embroiderer it was sent to). */
export const jobworkLocation = supplierId => `jw:${supplierId}`

const CATEGORY_WORDS = [
  ['yarn', /\b(yarn|cone|ne\s?\d|denier)\b/i],
  ['packaging', /\b(label|tag|polybag|poly bag|carton|sticker|hangtag|hang tag|box|tissue|bag|barcode)\b/i],
  ['trims', /\b(zip|zipper|button|elastic|drawcord|drawstring|thread|velcro|toggle|tape|rivet|eyelet|stopper|lining|interlining|pocketing|snap)\b/i],
  ['fabric', /\b(fabric|jersey|fleece|polar|rib|twill|denim|lycra|spandex|interlock|pique|terry|mesh|poplin|cloth|knit|woven|gsm|canvas|satin|chambray|viscose|cotton)\b/i],
]
/** A best guess at the kind of thing from how it is written; a person can correct it. */
export function guessCategory(name, unit) {
  for (const [category, re] of CATEGORY_WORDS) if (re.test(name || '')) return category
  if (/^(m|mtr|mtrs|meter|meters|metre|metres|yd|yds|yard|yards)$/i.test(String(unit || '').trim())) return 'fabric'
  return 'other'
}

/**
 * The item for a name and unit in a company's stock, made if it is not there yet. A supplier that supplied it
 * is remembered on the item.
 */
export async function itemFor({ orgId, name, unit, category, supplierId = null, hsnCode = '', userId = null }) {
  const key = itemKey(name, unit)
  const cleanName = String(name).trim().slice(0, 300)
  const cleanUnit = String(unit || 'pcs').trim().slice(0, 20) || 'pcs'
  // An item combined into another is still found by its old name, and goods arriving for an archived item bring it back.
  const filter = { ownerOrgId: orgId, $or: [{ key }, { aliases: key }] }
  const update = {
    $setOnInsert: { ownerOrgId: orgId, key, name: cleanName, unit: cleanUnit, category: category || guessCategory(cleanName, cleanUnit), hsnCode: String(hsnCode || '').slice(0, 8), createdBy: userId },
    $set: { isActive: true },
    ...(supplierId ? { $addToSet: { supplierIds: supplierId } } : {}),
  }
  for (let attempt = 0; ; attempt++) {
    try { return await InventoryItem.findOneAndUpdate(filter, update, { upsert: true, new: true }).lean() }
    catch (err) { if (err?.code !== 11000 || attempt >= 2) throw err }
  }
}

/** Is this the error of a write that only hit rows already there (a repeated insert)? */
const onlyDuplicates = err => err?.code === 11000 || (Array.isArray(err?.writeErrors) && err.writeErrors.length > 0 && err.writeErrors.every(e => (e.code ?? e.err?.code) === 11000))

/** Write ledger rows; a row whose key is already there is the same movement written before, and is left as it is. */
export async function writeLedger(rows) {
  if (!rows.length) return
  try { await StockLedger.insertMany(rows, { ordered: false }) }
  catch (err) { if (!onlyDuplicates(err)) throw err }
}

/**
 * What is in stock, by item and location, from the ledger.
 * @returns {Promise<Map<string, { store: number, atJobWork: number, byLocation: Record<string, number> }>>} keyed by item id
 */
export async function balances(orgId, { itemIds = null, location = null } = {}) {
  const match = { ownerOrgId: oid(orgId) }
  if (itemIds) match.itemId = { $in: itemIds.map(oid) }
  if (location) match.location = location
  const rows = await StockLedger.aggregate([{ $match: match }, { $group: { _id: { itemId: '$itemId', location: '$location' }, qty: { $sum: '$qty' } } }])
  const out = new Map()
  for (const r of rows) {
    const id = String(r._id.itemId)
    const e = out.get(id) || { store: 0, atJobWork: 0, byLocation: {} }
    const qty = round3(r.qty)
    e.byLocation[r._id.location] = qty
    if (r._id.location === STORE) e.store = qty
    else e.atJobWork = round3(e.atJobWork + qty)
    out.set(id, e)
  }
  return out
}

/**
 * One item's balance at one location. `throughId` counts only the rows written up to and including that one
 * (ObjectIds rise as rows are written), which is how two moves racing for the same stock are put in order.
 */
export async function balanceOf(orgId, itemId, location = STORE, { throughId = null } = {}) {
  const match = { ownerOrgId: oid(orgId), itemId: oid(itemId), location, ...(throughId ? { _id: { $lte: oid(throughId) } } : {}) }
  const [r] = await StockLedger.aggregate([{ $match: match }, { $group: { _id: null, qty: { $sum: '$qty' } } }])
  return round3(r?.qty || 0)
}

/**
 * Take stock out of a location (an issue, a send to a job worker) without ever letting it go below zero. The rows
 * are written, then each balance is read again counting only the rows up to this move's own: if another request
 * took the stock in between, the one written later loses, its rows are removed and it is refused. Exactly one
 * of two moves racing for the last of it wins, and the store never ends up negative.
 * @param {object[]} rows  negative-qty ledger rows, one item per row
 * @returns {Promise<{ ok: true } | { ok: false, error: string, itemId: string, available: number }>}
 */
export async function takeStock(orgId, rows, namesById = new Map()) {
  const mine = rows.map(r => ({ ...r, _id: r._id || new mongoose.Types.ObjectId() }))
  const need = new Map()
  for (const r of mine) {
    const k = `${r.itemId}|${r.location || STORE}`
    const e = need.get(k) || { itemId: String(r.itemId), location: r.location || STORE, qty: 0, through: r._id }
    e.qty = round3(e.qty + Math.abs(r.qty))
    if (String(r._id) > String(e.through)) e.through = r._id
    need.set(k, e)
  }
  const refuse = (n, have) => {
    const name = namesById.get(n.itemId)?.name || 'This item'
    const unit = namesById.get(n.itemId)?.unit || ''
    return { ok: false, itemId: n.itemId, available: Math.max(0, have), error: `Only ${Math.max(0, have)} ${unit} of "${name}" ${n.location === STORE ? 'in the store' : 'is with the job worker'}`.replace(/\s+/g, ' ') }
  }
  for (const n of need.values()) {
    const have = await balanceOf(orgId, n.itemId, n.location)
    if (have + 1e-9 < n.qty) return refuse(n, have)
  }
  await writeLedger(mine)
  for (const n of need.values()) {
    const through = await balanceOf(orgId, n.itemId, n.location, { throughId: n.through })
    if (through < -1e-9) {
      await StockLedger.deleteMany({ ownerOrgId: oid(orgId), key: { $in: mine.map(r => r.key) } })
      return refuse(n, await balanceOf(orgId, n.itemId, n.location))
    }
  }
  return { ok: true }
}
