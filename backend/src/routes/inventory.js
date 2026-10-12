// A factory's stock: the items it keeps, what is in the store and with its job workers, counts that
// correct the book, and stock issued to orders.
//
// Every number comes from the stock ledger (lib/inventory/stock.js): nothing here stores a balance.
// Private to the company: every query is scoped by the caller's own organization (taken from the
// session), brands and Tradio staff cannot use these routes (requireInventory), and another company's
// id is a 404.
import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import mongoose from 'mongoose'
import { InventoryItem, StockLedger, StockIssue, Supplier, Order, Organization, AuditLog } from '../db/index.js'
import { requireAuth } from '../middleware/auth.js'
import { userKey } from '../lib/limiterKey.js'
import { requireInventory, isId } from '../lib/procurement.js'
import { INVENTORY_CATEGORIES } from '../models/InventoryItem.js'
import { allocateIssueNumber } from '../lib/counters.js'
import { itemKey, balances, balanceOf, takeStock, writeLedger, round3, STORE } from '../lib/inventory/stock.js'
import { istToday } from '../lib/inventory/grn.js'
import { usageForOrder } from '../lib/inventory/usage.js'

const router = Router()
router.use(requireAuth, requireInventory)

const skipInTest = () => process.env.NODE_ENV === 'test'
const writeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 400, keyGenerator: userKey, skip: skipInTest, message: { error: 'Too many changes. Please wait.' },
  standardHeaders: true, legacyHeaders: false, validate: false,
})

const mine = req => ({ ownerOrgId: req.user.orgId })
const fail = (res, status, error, extra = {}) => res.status(status).json({ error, ...extra })
const escapeRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const newId = () => new mongoose.Types.ObjectId()

const itemView = (i, bal, lastRate = 0) => {
  const onHand = bal?.store || 0
  return {
    id: String(i._id), name: i.name, unit: i.unit, category: i.category, supplierIds: (i.supplierIds || []).map(String),
    reorderLevel: i.reorderLevel || 0, hsnCode: i.hsnCode || '', notes: i.notes || '', isActive: i.isActive !== false,
    onHand, atJobWork: bal?.atJobWork || 0, low: (i.reorderLevel || 0) > 0 && onHand < i.reorderLevel, lastRate,
  }
}

/** What each item last cost when it came in (receipts only): a starting figure for the value on a challan. */
async function lastRates(orgId, itemIds = null) {
  const match = { ownerOrgId: new mongoose.Types.ObjectId(String(orgId)), type: 'receipt', unitCost: { $gt: 0 }, ...(itemIds ? { itemId: { $in: itemIds.map(i => new mongoose.Types.ObjectId(String(i))) } } : {}) }
  const rows = await StockLedger.aggregate([{ $match: match }, { $sort: { at: -1, _id: -1 } }, { $group: { _id: '$itemId', rate: { $first: '$unitCost' } } }])
  return new Map(rows.map(r => [String(r._id), r.rate]))
}

const ledgerView = (r, names = new Map()) => ({
  id: String(r._id), at: r.at, type: r.type, qty: r.qty, unit: r.unit, location: r.location, itemId: String(r.itemId), itemName: names.get(String(r.itemId)) || '',
  refType: r.refType, refId: r.refId, orderId: r.orderId || null, note: r.note || '',
})

async function itemFields(req, body, existing = null) {
  const out = {}
  if (body.name !== undefined || !existing) {
    out.name = text(body.name, 300)
    if (!out.name) return { error: 'Name the item' }
  }
  if (body.unit !== undefined || !existing) {
    out.unit = text(body.unit, 20) || 'pcs'
  }
  if (body.category !== undefined) {
    if (!INVENTORY_CATEGORIES.includes(body.category)) return { error: 'Choose a kind of item from the list' }
    out.category = body.category
  }
  if (body.reorderLevel !== undefined) {
    const n = Number(body.reorderLevel)
    if (!Number.isFinite(n) || n < 0 || n > 1e8) return { error: 'The reorder level must be a number from 0 up' }
    out.reorderLevel = round3(n)
  }
  if (body.hsnCode !== undefined) out.hsnCode = text(body.hsnCode, 8)
  if (body.notes !== undefined) out.notes = text(body.notes, 500)
  if (body.supplierIds !== undefined) {
    if (!Array.isArray(body.supplierIds) || body.supplierIds.length > 20 || body.supplierIds.some(v => !isId(String(v)))) return { error: 'Choose suppliers from your list' }
    const ids = [...new Set(body.supplierIds.map(String))]
    const found = ids.length ? await Supplier.countDocuments({ _id: { $in: ids }, ...mine(req) }) : 0
    if (found !== ids.length) return { error: 'Choose suppliers from your list' }
    out.supplierIds = ids
  }
  const name = out.name ?? existing?.name, unit = out.unit ?? existing?.unit
  if (out.name !== undefined || out.unit !== undefined) out.key = itemKey(name, unit)
  return { out }
}

// ── Items ──

// GET /api/inventory/items - the stock list with what is in the store and with job workers. ?q= ?category= ?low=1 ?archived=1
router.get('/items', async (req, res) => {
  try {
    const filter = { ...mine(req) }
    if (req.query.archived !== '1') filter.isActive = true
    if (INVENTORY_CATEGORIES.includes(req.query.category)) filter.category = req.query.category
    if (typeof req.query.q === 'string' && req.query.q.trim()) filter.name = new RegExp(escapeRe(req.query.q.trim().slice(0, 60)), 'i')
    const [items, bal, rates] = await Promise.all([InventoryItem.find(filter).sort({ name: 1 }).limit(1000).lean(), balances(req.user.orgId), lastRates(req.user.orgId)])
    let out = items.map(i => itemView(i, bal.get(String(i._id)), rates.get(String(i._id)) || 0))
    if (req.query.low === '1') out = out.filter(i => i.low)
    res.json(out)
  } catch (err) { console.error('[inventory]', err); fail(res, 500, 'Server error') }
})

// POST /api/inventory/items - add an item by hand (goods received add theirs themselves)
router.post('/items', writeLimiter, async (req, res) => {
  try {
    const f = await itemFields(req, req.body || {})
    if (f.error) return fail(res, 400, f.error)
    const taken = await InventoryItem.findOne({ ...mine(req), key: f.out.key }, '_id').lean()
    if (taken) return fail(res, 409, 'That item is already in your stock list', { itemId: String(taken._id) })
    const item = await InventoryItem.create({ ...mine(req), category: 'other', ...f.out, createdBy: req.user.actorId })
    res.status(201).json(itemView(item.toObject(), null))
  } catch (err) { console.error('[inventory]', err); fail(res, 500, 'Server error') }
})

// GET /api/inventory/items/:id - one item: where its stock is, and its latest movements
router.get('/items/:id', async (req, res) => {
  try {
    if (!isId(req.params.id)) return fail(res, 404, 'Item not found')
    const item = await InventoryItem.findOne({ _id: req.params.id, ...mine(req) }).lean()
    if (!item) return fail(res, 404, 'Item not found')
    const [bal, ledger] = await Promise.all([
      balances(req.user.orgId, { itemIds: [item._id] }),
      StockLedger.find({ ...mine(req), itemId: item._id }).sort({ at: -1, _id: -1 }).limit(100).lean(),
    ])
    const b = bal.get(String(item._id))
    const jwIds = Object.keys(b?.byLocation || {}).filter(l => l.startsWith('jw:')).map(l => l.slice(3)).filter(isId)
    const sup = jwIds.length ? await Supplier.find({ _id: { $in: jwIds }, ...mine(req) }, 'name').lean() : []
    const names = new Map(sup.map(s => [String(s._id), s.name]))
    const locations = Object.entries(b?.byLocation || {}).filter(([, q]) => q !== 0).map(([loc, qty]) => ({ location: loc, label: loc === STORE ? 'In the store' : `With ${names.get(loc.slice(3)) || 'a job worker'}`, qty }))
    res.json({ ...itemView(item, b, (await lastRates(req.user.orgId, [item._id])).get(String(item._id)) || 0), locations, ledger: ledger.map(r => ledgerView(r)) })
  } catch (err) { console.error('[inventory]', err); fail(res, 500, 'Server error') }
})

// POST /api/inventory/items/:id - change an item (its unit only while it has no movements)
router.post('/items/:id', writeLimiter, async (req, res) => {
  try {
    if (!isId(req.params.id)) return fail(res, 404, 'Item not found')
    const existing = await InventoryItem.findOne({ _id: req.params.id, ...mine(req) }).lean()
    if (!existing) return fail(res, 404, 'Item not found')
    const f = await itemFields(req, req.body || {}, existing)
    if (f.error) return fail(res, 400, f.error)
    if (f.out.unit !== undefined && f.out.unit !== existing.unit && await StockLedger.exists({ ...mine(req), itemId: existing._id }))
      return fail(res, 409, 'The unit cannot change once stock has moved. Add a new item in the other unit')
    if (f.out.key && f.out.key !== existing.key && await InventoryItem.exists({ ...mine(req), key: f.out.key })) return fail(res, 409, 'Another item already has that name and unit')
    const item = await InventoryItem.findOneAndUpdate({ _id: existing._id, ...mine(req) }, { $set: f.out }, { new: true }).lean()
    const bal = await balances(req.user.orgId, { itemIds: [item._id] })
    res.json(itemView(item, bal.get(String(item._id))))
  } catch (err) { console.error('[inventory]', err); fail(res, 500, 'Server error') }
})

// POST /api/inventory/items/:id/archive and /restore - an item with movements is never deleted
for (const [action, isActive] of [['archive', false], ['restore', true]]) {
  router.post(`/items/:id/${action}`, writeLimiter, async (req, res) => {
    try {
      if (!isId(req.params.id)) return fail(res, 404, 'Item not found')
      const before = await InventoryItem.findOne({ _id: req.params.id, ...mine(req) }, 'key').lean()
      if (!before) return fail(res, 404, 'Item not found')
      if (isActive && String(before.key).startsWith('merged:')) return fail(res, 409, 'This item was combined into another. Add a new item instead')
      const item = await InventoryItem.findOneAndUpdate({ _id: req.params.id, ...mine(req) }, { $set: { isActive } }, { new: true }).lean()
      if (!item) return fail(res, 404, 'Item not found')
      const bal = await balances(req.user.orgId, { itemIds: [item._id] })
      res.json(itemView(item, bal.get(String(item._id))))
    } catch (err) { console.error('[inventory]', err); fail(res, 500, 'Server error') }
  })
}

// POST /api/inventory/items/:id/merge { intoId } - this item is the same thing as another: its stock moves there
// (as two matching count corrections, so the ledger stays whole), it is archived, and goods that come in under its
// name are booked to the other from now on
router.post('/items/:id/merge', writeLimiter, async (req, res) => {
  try {
    if (!isId(req.params.id)) return fail(res, 404, 'Item not found')
    if (!isId(req.body?.intoId)) return fail(res, 400, 'Choose the item to combine it with')
    if (String(req.params.id) === String(req.body.intoId)) return fail(res, 400, 'Choose a different item')
    const [from, into] = await Promise.all([
      InventoryItem.findOne({ _id: req.params.id, ...mine(req) }).lean(),
      InventoryItem.findOne({ _id: req.body.intoId, ...mine(req), isActive: true }).lean(),
    ])
    if (!from) return fail(res, 404, 'Item not found')
    if (!into) return fail(res, 400, 'Choose an item from your stock list')
    if (itemKey('', from.unit) !== itemKey('', into.unit)) return fail(res, 409, `They are counted in different units (${from.unit} and ${into.unit}), so they cannot be combined`)

    const bal = (await balances(req.user.orgId, { itemIds: [from._id] })).get(String(from._id))
    const refId = String(newId())
    const at = new Date()
    const rows = []
    for (const [location, qty] of Object.entries(bal?.byLocation || {})) {
      if (qty === 0) continue
      const base = { ownerOrgId: req.user.orgId, location, type: 'adjustment', unit: from.unit, refType: 'adjustment', refId, at, by: req.user.actorId }
      rows.push({ ...base, itemId: from._id, qty: -qty, note: `Combined into ${into.name}`.slice(0, 300), key: `merge:${refId}:out:${location}` })
      rows.push({ ...base, itemId: into._id, qty, note: `Combined from ${from.name}`.slice(0, 300), key: `merge:${refId}:in:${location}` })
    }
    // The ledger rows go first, checked like any move out (a second merge at the same moment finds nothing left to take and is refused):
    // if the server stopped after them the stock is already where it belongs, and merging again finishes the rest.
    if (rows.length) {
      const taken = await takeStock(req.user.orgId, rows, new Map([[String(from._id), from]]))
      if (!taken.ok) return fail(res, 409, 'This item changed while it was being combined. Open it and try again')
    }
    await InventoryItem.updateOne({ _id: from._id, ...mine(req) }, { $set: { isActive: false, key: `merged:${from._id}` } })
    await InventoryItem.updateOne({ _id: into._id, ...mine(req) }, { $addToSet: { aliases: from.key, supplierIds: { $each: from.supplierIds || [] } } })
    await AuditLog.create({ byUser: req.user.id, action: 'Stock Items Combined', detail: `${from.name} was combined into ${into.name} by ${req.user.name}` }).catch(() => {})
    const after = await balances(req.user.orgId, { itemIds: [into._id] })
    res.json(itemView(await InventoryItem.findById(into._id).lean(), after.get(String(into._id))))
  } catch (err) { console.error('[inventory]', err); fail(res, 500, 'Server error') }
})

// ── Ledger ──

// GET /api/inventory/ledger - movements, newest first. ?itemId= ?orderId= ?limit=
router.get('/ledger', async (req, res) => {
  try {
    const filter = { ...mine(req) }
    if (req.query.itemId) { if (!isId(req.query.itemId)) return res.json([]); filter.itemId = req.query.itemId }
    if (typeof req.query.orderId === 'string' && req.query.orderId) filter.orderId = req.query.orderId
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500)
    const rows = await StockLedger.find(filter).sort({ at: -1, _id: -1 }).limit(limit).lean()
    const items = await InventoryItem.find({ _id: { $in: [...new Set(rows.map(r => String(r.itemId)))] }, ...mine(req) }, 'name').lean()
    const names = new Map(items.map(i => [String(i._id), i.name]))
    res.json(rows.map(r => ledgerView(r, names)))
  } catch (err) { console.error('[inventory]', err); fail(res, 500, 'Server error') }
})

// POST /api/inventory/adjustments { itemId, counted | delta, reason } - put the book right after a count
router.post('/adjustments', writeLimiter, async (req, res) => {
  try {
    const b = req.body || {}
    if (!isId(b.itemId)) return fail(res, 400, 'Choose an item')
    const item = await InventoryItem.findOne({ _id: b.itemId, ...mine(req) }).lean()
    if (!item) return fail(res, 400, 'Choose an item from your stock list')
    const reason = text(b.reason, 300)
    if (!reason) return fail(res, 400, 'Say why the stock is being adjusted')
    if ((b.counted === undefined) === (b.delta === undefined)) return fail(res, 400, 'Give either the quantity counted or the change, not both')
    const have = await balanceOf(req.user.orgId, item._id)
    let delta
    if (b.counted !== undefined) {
      const counted = Number(b.counted)
      if (!Number.isFinite(counted) || counted < 0 || counted > 1e9) return fail(res, 400, 'The quantity counted must be a number from 0 up')
      delta = round3(counted - have)
    } else {
      delta = round3(Number(b.delta))
      if (!Number.isFinite(delta) || Math.abs(delta) > 1e9) return fail(res, 400, 'The change must be a number')
    }
    if (delta === 0) return fail(res, 400, 'The count matches the book. Nothing to adjust')
    const refId = String(newId())
    const row = { ownerOrgId: req.user.orgId, itemId: item._id, location: STORE, type: 'adjustment', qty: delta, unit: item.unit, refType: 'adjustment', refId, note: reason, at: new Date(), by: req.user.actorId, key: `adj:${refId}` }
    if (delta < 0) {
      const taken = await takeStock(req.user.orgId, [row], new Map([[String(item._id), item]]))
      if (!taken.ok) return fail(res, 400, taken.error, { available: taken.available })
    } else await writeLedger([row])
    await AuditLog.create({ byUser: req.user.id, action: 'Stock Adjusted', detail: `${item.name}: ${delta > 0 ? '+' : ''}${delta} ${item.unit} (${reason}) by ${req.user.name}` }).catch(() => {})
    const bal = await balances(req.user.orgId, { itemIds: [item._id] })
    res.status(201).json({ item: itemView(item, bal.get(String(item._id))), delta })
  } catch (err) { console.error('[inventory]', err); fail(res, 500, 'Server error') }
})

// GET /api/inventory/usage?orderId= - what the order was planned to use (its frozen bill of materials) against what was issued to it
router.get('/usage', async (req, res) => {
  try {
    const u = await usageForOrder(req, req.query.orderId)
    if (!u) return fail(res, 404, 'Order not found')
    res.json(u)
  } catch (err) { console.error('[inventory]', err); fail(res, 500, 'Server error') }
})

// ── Issues to orders ──

const issueView = (s, extra = {}) => ({
  id: String(s._id), number: s.number, type: s.type, orderId: s.orderId, stageIndex: s.stageIndex ?? null, note: s.note || '', issuedOn: s.issuedOn || null,
  lines: (s.lines || []).map(l => ({ lineId: l.lineId, itemId: String(l.itemId), name: l.name, unit: l.unit, qty: l.qty })), createdAt: s.createdAt, ...extra,
})

// GET /api/inventory/issues - slips newest first. ?orderId=
router.get('/issues', async (req, res) => {
  try {
    const filter = { ...mine(req) }
    if (typeof req.query.orderId === 'string' && req.query.orderId) filter.orderId = req.query.orderId
    const slips = await StockIssue.find(filter).sort({ createdAt: -1 }).limit(300).lean()
    res.json(slips.map(s => issueView(s)))
  } catch (err) { console.error('[inventory]', err); fail(res, 500, 'Server error') }
})

// GET /api/inventory/issues/:id
router.get('/issues/:id', async (req, res) => {
  try {
    if (!isId(req.params.id)) return fail(res, 404, 'Slip not found')
    const s = await StockIssue.findOne({ _id: req.params.id, ...mine(req) }).lean()
    if (!s) return fail(res, 404, 'Slip not found')
    res.json(issueView(s))
  } catch (err) { console.error('[inventory]', err); fail(res, 500, 'Server error') }
})

// POST /api/inventory/issues { orderId, lines: [{ itemId, qty }], type?: 'issue' | 'return', stageIndex?, note?, issuedOn? }
router.post('/issues', writeLimiter, async (req, res) => {
  try {
    const b = req.body || {}
    const type = b.type === 'return' ? 'return' : 'issue'
    if (typeof b.orderId !== 'string' || !b.orderId || b.orderId.length > 100) return fail(res, 400, 'Choose the order this is for')
    const order = await Order.findOne({ _id: b.orderId, 'assignments.mfrId': req.user.id }, 'product styleNumber').lean()
    if (!order) return fail(res, 400, 'Choose one of your orders')
    if (!Array.isArray(b.lines) || b.lines.length === 0 || b.lines.length > 50) return fail(res, 400, 'Say what was issued')
    let stageIndex = null
    if (b.stageIndex !== undefined && b.stageIndex !== null) {
      stageIndex = Number(b.stageIndex)
      if (!Number.isInteger(stageIndex) || stageIndex < 0 || stageIndex > 200) return fail(res, 400, 'Choose a production step from the list')
    }
    const issuedOn = b.issuedOn ? String(b.issuedOn) : istToday()
    if (!DATE_RE.test(issuedOn)) return fail(res, 400, 'The date is not valid')

    const merged = new Map()
    for (const l of b.lines) {
      if (!isId(l?.itemId)) return fail(res, 400, 'Choose an item for every line')
      const qty = Number(l.qty)
      if (!Number.isFinite(qty) || qty <= 0 || qty > 1e9) return fail(res, 400, 'Each quantity must be more than zero')
      merged.set(String(l.itemId), round3((merged.get(String(l.itemId)) || 0) + qty))
    }
    const items = await InventoryItem.find({ _id: { $in: [...merged.keys()] }, ...mine(req), isActive: true }).lean()
    if (items.length !== merged.size) return fail(res, 400, 'Choose items from your stock list')
    const byId = new Map(items.map(i => [String(i._id), i]))

    const slipId = newId()
    const now = new Date()
    const lines = [...merged].map(([itemId, qty]) => ({ lineId: String(newId()), itemId, name: byId.get(itemId).name, unit: byId.get(itemId).unit, qty }))
    const rows = lines.map(l => ({
      ownerOrgId: req.user.orgId, itemId: l.itemId, location: STORE, type, qty: type === 'issue' ? -l.qty : l.qty, unit: l.unit,
      refType: 'issue', refId: String(slipId), refLineId: l.lineId, orderId: order._id, note: `${type === 'issue' ? 'Issued to' : 'Returned from'} ${order._id}`, at: now, by: req.user.actorId, key: `issue:${slipId}:${l.lineId}`,
    }))

    if (type === 'return') {
      // Only what was issued to this order can come back from it.
      const net = await StockLedger.aggregate([
        { $match: { ownerOrgId: new mongoose.Types.ObjectId(String(req.user.orgId)), orderId: order._id, refType: 'issue', itemId: { $in: lines.map(l => new mongoose.Types.ObjectId(l.itemId)) } } },
        { $group: { _id: '$itemId', qty: { $sum: '$qty' } } },
      ])
      const issued = new Map(net.map(n => [String(n._id), round3(-n.qty)]))
      for (const l of lines) if (l.qty > (issued.get(l.itemId) || 0) + 1e-9) return fail(res, 400, `Only ${issued.get(l.itemId) || 0} ${l.unit} of "${l.name}" has been issued to this order`)
      await writeLedger(rows)
    } else {
      const taken = await takeStock(req.user.orgId, rows, byId)
      if (!taken.ok) return fail(res, 400, taken.error, { available: taken.available, itemId: taken.itemId })
    }

    const org = await Organization.findById(req.user.orgId, 'code').lean()
    const number = await allocateIssueNumber({ orgId: String(req.user.orgId), orgCode: org.code })
    const slip = await StockIssue.create({ _id: slipId, ...mine(req), number, type, orderId: order._id, stageIndex, lines, note: text(b.note, 500), issuedOn, createdBy: req.user.actorId })
    await AuditLog.create({ byUser: req.user.id, action: type === 'issue' ? 'Stock Issued' : 'Stock Returned', detail: `${number}: ${lines.length} item(s) ${type === 'issue' ? 'to' : 'from'} ${order._id} by ${req.user.name}` }).catch(() => {})
    res.status(201).json(issueView(slip.toObject()))
  } catch (err) { console.error('[inventory]', err); fail(res, 500, 'Server error') }
})

export default router
