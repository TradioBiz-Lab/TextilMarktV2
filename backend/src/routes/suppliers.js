import { Router } from 'express'
import { Supplier, AuditLog } from '../db/index.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()

const mapSupplier = s => ({
  id: s._id.toString(), name: s.name, category: s.category,
  contactName: s.contactName || '', phone: s.phone || '', email: s.email || '', address: s.address || '',
  ownerType: s.ownerType, mfrId: s.mfrId ? s.mfrId.toString() : null,
})

// GET /api/suppliers — admin/buyer see the global (Tradio-shared) catalog;
// manufacturer sees global + their own private suppliers, never another
// manufacturer's. Same cross-tenant discipline as every other manufacturer-
// scoped read in this app.
router.get('/suppliers', requireAuth, async (req, res) => {
  try {
    const query = req.user.role === 'manufacturer'
      ? { isActive: true, $or: [{ ownerType: 'tradio' }, { ownerType: 'manufacturer', mfrId: req.user.id }] }
      : { isActive: true, ownerType: 'tradio' }
    const suppliers = await Supplier.find(query).sort({ name: 1 }).lean()
    res.json(suppliers.map(mapSupplier))
  } catch (err) {
    console.error('[suppliers]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

router.post('/suppliers', requireAuth, async (req, res) => {
  try {
    if (req.user.role === 'buyer') return res.status(403).json({ error: 'Buyers cannot manage suppliers' })
    const { name, category, contactName, phone, email, address } = req.body
    if (!name?.trim()) return res.status(400).json({ error: 'Supplier name is required' })
    if (category && !['fabric', 'trim', 'accessory', 'other'].includes(category))
      return res.status(400).json({ error: 'Invalid category' })

    // ownerType/mfrId are always server-derived from the caller's own role —
    // never client-trusted, same rule costing.js's targetMfrId already enforces.
    const isMfr = req.user.role === 'manufacturer'
    const supplier = await Supplier.create({
      name: name.trim().slice(0, 200), category: category || 'other',
      contactName: (contactName || '').trim().slice(0, 200),
      phone: (phone || '').trim().slice(0, 40),
      email: (email || '').trim().slice(0, 200),
      address: (address || '').slice(0, 500),
      ownerType: isMfr ? 'manufacturer' : 'tradio',
      mfrId: isMfr ? req.user.id : null,
      createdBy: req.user.id,
    })
    await AuditLog.create({ byUser: req.user.id, action: 'Supplier Created', detail: supplier.name })
    res.status(201).json(mapSupplier(supplier.toObject()))
  } catch (err) {
    console.error('[suppliers]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

async function requireOwnSupplier(req, res) {
  const supplier = await Supplier.findById(req.params.id)
  if (!supplier || !supplier.isActive) { res.status(404).json({ error: 'Supplier not found' }); return null }
  if (supplier.ownerType === 'manufacturer') {
    if (String(supplier.mfrId) !== req.user.id) { res.status(403).json({ error: 'Forbidden' }); return null }
  } else if (req.user.role !== 'admin') {
    res.status(403).json({ error: 'Only an admin can manage a Tradio-shared supplier' }); return null
  }
  return supplier
}

router.post('/suppliers/:id', requireAuth, async (req, res) => {
  try {
    const supplier = await requireOwnSupplier(req, res)
    if (!supplier) return
    const { name, category, contactName, phone, email, address } = req.body
    if (name !== undefined) {
      if (!name.trim()) return res.status(400).json({ error: 'Supplier name is required' })
      supplier.name = name.trim().slice(0, 200)
    }
    if (category !== undefined) {
      if (!['fabric', 'trim', 'accessory', 'other'].includes(category)) return res.status(400).json({ error: 'Invalid category' })
      supplier.category = category
    }
    if (contactName !== undefined) supplier.contactName = (contactName || '').trim().slice(0, 200)
    if (phone !== undefined) supplier.phone = (phone || '').trim().slice(0, 40)
    if (email !== undefined) supplier.email = (email || '').trim().slice(0, 200)
    if (address !== undefined) supplier.address = (address || '').slice(0, 500)
    await supplier.save()
    await AuditLog.create({ byUser: req.user.id, action: 'Supplier Updated', detail: supplier.name })
    res.json(mapSupplier(supplier.toObject()))
  } catch (err) {
    console.error('[suppliers]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

router.post('/suppliers/:id/delete', requireAuth, async (req, res) => {
  try {
    const supplier = await requireOwnSupplier(req, res)
    if (!supplier) return
    supplier.isActive = false
    await supplier.save()
    await AuditLog.create({ byUser: req.user.id, action: 'Supplier Deleted', detail: supplier.name })
    res.json({ ok: true })
  } catch (err) {
    console.error('[suppliers]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

export default router
