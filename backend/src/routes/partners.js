// The companies a brand or manufacturer is connected with, and nobody else.
//
// This is the only list of other companies a brand or manufacturer can read. Choosing a customer
// for a new order, or a manufacturer to assign, happens from here, so neither side can enumerate
// the platform's other companies.
import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { Organization, Partnership, User } from '../db/index.js'
import { ensureOrgsByPartyIds, roleForOrgType } from '../lib/orgs.js'

const router = Router()

// GET /api/partners - for a brand: its manufacturers; for a manufacturer: its brands.
// `id` is the company's primary account (the id orders use for buyerId and assignment `mid`).
router.get('/', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'buyer' && req.user.role !== 'manufacturer')
      return res.status(403).json({ error: 'Companies only' })
    const mine = (await ensureOrgsByPartyIds([req.user.id])).get(String(req.user.id))
    if (!mine) return res.json([])

    const [ownField, otherField] = req.user.role === 'buyer' ? ['brandOrgId', 'mfrOrgId'] : ['mfrOrgId', 'brandOrgId']
    const links = await Partnership.find({ [ownField]: mine._id, status: 'active' }, otherField).lean()
    const orgs = await Organization.find({ _id: { $in: links.map(l => l[otherField]) }, isActive: true }).lean()
    const owners = await User.find({ _id: { $in: orgs.map(o => o.ownerUserId) } }, 'name').lean()
    const ownerName = new Map(owners.map(u => [String(u._id), u.name]))

    const list = orgs.map(o => ({
      id: String(o.ownerUserId), orgId: String(o._id), company: o.name, code: o.code,
      name: ownerName.get(String(o.ownerUserId)) || '', role: roleForOrgType(o.type),
    }))
    list.sort((a, b) => a.company.localeCompare(b.company))
    res.json(list)
  } catch (err) {
    console.error('[partners]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

export default router
