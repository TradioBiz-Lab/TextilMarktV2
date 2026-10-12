// A manufacturer's supplier book: the mills, dyers and trims shops it buys from, and what each sells.
//
// Private to the company. Every query below is scoped by the caller's own organization, taken from the
// session, so another factory's suppliers do not exist as far as this API is concerned (a request for
// one is a plain 404, never a 403 that would confirm it is there). Brands and Tradio staff cannot use
// these routes at all (requireProcurement).
import { Router } from 'express'
import mongoose from 'mongoose'
import rateLimit from 'express-rate-limit'
import { Supplier, SupplierItem, AuditLog } from '../db/index.js'
import { requireAuth } from '../middleware/auth.js'
import { userKey } from '../lib/limiterKey.js'
import { requireProcurement, cleanSupplier, cleanItem, isId } from '../lib/procurement.js'
import { stateName } from '../lib/gst.js'

const router = Router()
router.use(requireAuth, requireProcurement)

const skipInTest = () => process.env.NODE_ENV === 'test'
const writeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 300, keyGenerator: userKey, skip: skipInTest,
  message: { error: 'Too many changes. Please wait.' }, standardHeaders: true, legacyHeaders: false, validate: false,
})
const bulkLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 20, keyGenerator: userKey, skip: skipInTest,
  message: { error: 'Too many imports. Please wait.' }, standardHeaders: true, legacyHeaders: false, validate: false,
})

const BULK_MAX = 500
const mine = req => ({ ownerOrgId: req.user.orgId })

export const supplierView = (s, extra = {}) => ({
  id: String(s._id), name: s.name, type: s.type, email: s.email || '', phone: s.phone || '',
  contacts: (s.contacts || []).map(c => ({ name: c.name || '', role: c.role || '', phone: c.phone || '', email: c.email || '' })),
  gstin: s.gstin || '', stateCode: s.stateCode || '', stateName: stateName(s.stateCode),
  address: s.address || '', city: s.city || '', pincode: s.pincode || '',
  paymentTerms: s.paymentTerms || '', deliveryTerms: s.deliveryTerms || '', notes: s.notes || '',
  isActive: s.isActive !== false, visibility: s.visibility || 'private',
  createdAt: s.createdAt, updatedAt: s.updatedAt, ...extra,
})

export const itemView = i => ({
  id: String(i._id), supplierId: String(i.supplierId), category: i.category, name: i.name,
  specs: {
    composition: i.specs?.composition || '', gsm: i.specs?.gsm ?? null, widthInches: i.specs?.widthInches ?? null,
    construction: i.specs?.construction || '', colour: i.specs?.colour || '',
  },
  unit: i.unit || '', defaultRate: i.defaultRate || 0, moq: i.moq || 0, leadTimeDays: i.leadTimeDays ?? null,
  hsnCode: i.hsnCode || '', taxPct: i.taxPct ?? 0, isActive: i.isActive !== false, visibility: i.visibility || 'private',
})

const duplicate = res => res.status(409).json({ error: 'You already have a supplier with this name' })

// GET /api/suppliers - the company's suppliers (active ones unless ?all=1), with how many items each sells
router.get('/', async (req, res) => {
  try {
    const filter = { ...mine(req), ...(req.query.all === '1' ? {} : { isActive: true }) }
    if (req.query.type) filter.type = String(req.query.type)
    const suppliers = await Supplier.find(filter).collation({ locale: 'en', strength: 2 }).sort({ name: 1 }).lean()
    // Aggregation does not cast ids the way find() does.
    const counts = await SupplierItem.aggregate([
      { $match: { ownerOrgId: new mongoose.Types.ObjectId(String(req.user.orgId)), isActive: true } },
      { $group: { _id: '$supplierId', n: { $sum: 1 } } },
    ])
    const byId = new Map(counts.map(c => [String(c._id), c.n]))
    res.json(suppliers.map(s => supplierView(s, { itemCount: byId.get(String(s._id)) || 0 })))
  } catch (err) { console.error('[suppliers]', err); res.status(500).json({ error: 'Server error' }) }
})

// POST /api/suppliers - add a supplier
router.post('/', writeLimiter, async (req, res) => {
  try {
    const c = cleanSupplier(req.body)
    if (!c.ok) return res.status(400).json({ error: c.error })
    const s = await Supplier.create({ ...c.value, ...mine(req), createdBy: req.user.actorId, updatedBy: req.user.actorId })
    await AuditLog.create({ byUser: req.user.id, action: 'Supplier Added', detail: `${s.name} added to the supplier book by ${req.user.name}` })
    res.status(201).json(supplierView(s.toObject(), { itemCount: 0 }))
  } catch (err) {
    if (err?.code === 11000) return duplicate(res)
    console.error('[suppliers]', err); res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/suppliers/bulk - import many (a spreadsheet read in the browser): { suppliers: [...] }.
// Each row stands alone: one bad row never blocks the others.
router.post('/bulk', bulkLimiter, async (req, res) => {
  try {
    const rows = req.body?.suppliers
    if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'Send the suppliers to import' })
    if (rows.length > BULK_MAX) return res.status(400).json({ error: `Import at most ${BULK_MAX} suppliers at a time` })
    let created = 0
    const skipped = []
    for (const [i, row] of rows.entries()) {
      const c = cleanSupplier(row)
      if (!c.ok) { skipped.push({ row: i + 1, name: String(row?.name ?? ''), error: c.error }); continue }
      try {
        await Supplier.create({ ...c.value, ...mine(req), createdBy: req.user.actorId, updatedBy: req.user.actorId })
        created++
      } catch (err) {
        if (err?.code === 11000) skipped.push({ row: i + 1, name: c.value.name, error: 'You already have a supplier with this name' })
        else throw err
      }
    }
    if (created) await AuditLog.create({ byUser: req.user.id, action: 'Suppliers Imported', detail: `${created} supplier${created === 1 ? '' : 's'} imported by ${req.user.name}` })
    res.json({ created, skipped })
  } catch (err) { console.error('[suppliers]', err); res.status(500).json({ error: 'Server error' }) }
})

// GET /api/suppliers/:id - one supplier with everything it sells
router.get('/:id', async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ error: 'Supplier not found' })
    const s = await Supplier.findOne({ _id: req.params.id, ...mine(req) }).lean()
    if (!s) return res.status(404).json({ error: 'Supplier not found' })
    const items = await SupplierItem.find({ supplierId: s._id, ...mine(req) }).sort({ isActive: -1, name: 1 }).lean()
    res.json(supplierView(s, { items: items.map(itemView), itemCount: items.filter(i => i.isActive !== false).length }))
  } catch (err) { console.error('[suppliers]', err); res.status(500).json({ error: 'Server error' }) }
})

// POST /api/suppliers/:id - change a supplier (only the fields sent)
router.post('/:id', writeLimiter, async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ error: 'Supplier not found' })
    const c = cleanSupplier(req.body, { partial: true })
    if (!c.ok) return res.status(400).json({ error: c.error })
    const s = await Supplier.findOneAndUpdate({ _id: req.params.id, ...mine(req) }, { $set: { ...c.value, updatedBy: req.user.actorId } }, { new: true, runValidators: true }).lean()
    if (!s) return res.status(404).json({ error: 'Supplier not found' })
    await AuditLog.create({ byUser: req.user.id, action: 'Supplier Updated', detail: `${s.name} updated by ${req.user.name}` })
    res.json(supplierView(s))
  } catch (err) {
    if (err?.code === 11000) return duplicate(res)
    console.error('[suppliers]', err); res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/suppliers/:id/archive and /restore - a supplier is never deleted: POs sent to it keep their record
for (const [path, isActive, action] of [['archive', false, 'Archived'], ['restore', true, 'Restored']]) {
  router.post(`/:id/${path}`, writeLimiter, async (req, res) => {
    try {
      if (!isId(req.params.id)) return res.status(404).json({ error: 'Supplier not found' })
      const s = await Supplier.findOneAndUpdate({ _id: req.params.id, ...mine(req) }, { $set: { isActive, updatedBy: req.user.actorId } }, { new: true }).lean()
      if (!s) return res.status(404).json({ error: 'Supplier not found' })
      await AuditLog.create({ byUser: req.user.id, action: `Supplier ${action}`, detail: `${s.name} ${action.toLowerCase()} by ${req.user.name}` })
      res.json(supplierView(s))
    } catch (err) { console.error('[suppliers]', err); res.status(500).json({ error: 'Server error' }) }
  })
}

// POST /api/suppliers/:id/items - add something the supplier sells
router.post('/:id/items', writeLimiter, async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ error: 'Supplier not found' })
    const s = await Supplier.findOne({ _id: req.params.id, ...mine(req) }, '_id').lean()
    if (!s) return res.status(404).json({ error: 'Supplier not found' })
    const c = cleanItem(req.body)
    if (!c.ok) return res.status(400).json({ error: c.error })
    const item = await SupplierItem.create({ ...c.value, supplierId: s._id, ...mine(req) })
    res.status(201).json(itemView(item.toObject()))
  } catch (err) { console.error('[suppliers]', err); res.status(500).json({ error: 'Server error' }) }
})

// POST /api/suppliers/:id/items/bulk - import many items for one supplier: { items: [...] }
router.post('/:id/items/bulk', bulkLimiter, async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ error: 'Supplier not found' })
    const s = await Supplier.findOne({ _id: req.params.id, ...mine(req) }, '_id').lean()
    if (!s) return res.status(404).json({ error: 'Supplier not found' })
    const rows = req.body?.items
    if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'Send the items to import' })
    if (rows.length > BULK_MAX) return res.status(400).json({ error: `Import at most ${BULK_MAX} items at a time` })
    const docs = [], skipped = []
    rows.forEach((row, i) => {
      const c = cleanItem(row)
      if (c.ok) docs.push({ ...c.value, supplierId: s._id, ...mine(req) })
      else skipped.push({ row: i + 1, name: String(row?.name ?? ''), error: c.error })
    })
    if (docs.length) await SupplierItem.insertMany(docs)
    res.json({ created: docs.length, skipped })
  } catch (err) { console.error('[suppliers]', err); res.status(500).json({ error: 'Server error' }) }
})

// POST /api/suppliers/:id/items/:itemId - change an item
router.post('/:id/items/:itemId', writeLimiter, async (req, res) => {
  try {
    if (!isId(req.params.id) || !isId(req.params.itemId)) return res.status(404).json({ error: 'Item not found' })
    const c = cleanItem(req.body, { partial: true })
    if (!c.ok) return res.status(400).json({ error: c.error })
    // Nested objects are set field by field so changing the width does not wipe the composition.
    const { specs, ...rest } = c.value
    const $set = { ...rest, ...Object.fromEntries(Object.entries(specs || {}).map(([k, v]) => [`specs.${k}`, v])) }
    const item = await SupplierItem.findOneAndUpdate({ _id: req.params.itemId, supplierId: req.params.id, ...mine(req) }, { $set }, { new: true, runValidators: true }).lean()
    if (!item) return res.status(404).json({ error: 'Item not found' })
    res.json(itemView(item))
  } catch (err) { console.error('[suppliers]', err); res.status(500).json({ error: 'Server error' }) }
})

// POST /api/suppliers/:id/items/:itemId/archive and /restore
for (const [path, isActive] of [['archive', false], ['restore', true]]) {
  router.post(`/:id/items/:itemId/${path}`, writeLimiter, async (req, res) => {
    try {
      if (!isId(req.params.id) || !isId(req.params.itemId)) return res.status(404).json({ error: 'Item not found' })
      const item = await SupplierItem.findOneAndUpdate({ _id: req.params.itemId, supplierId: req.params.id, ...mine(req) }, { $set: { isActive } }, { new: true }).lean()
      if (!item) return res.status(404).json({ error: 'Item not found' })
      res.json(itemView(item))
    } catch (err) { console.error('[suppliers]', err); res.status(500).json({ error: 'Server error' }) }
  })
}

export default router
