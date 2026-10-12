// A style's measurement spec, as read from its tech pack. It belongs to the order, so the two sides of the
// order can read it: the factory that read it in (and may correct it) and the brand the order is for.
// Another company, or another brand's order, gets "not found".
import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { SpecSheet, Order, Organization, AuditLog } from '../db/index.js'
import { requireAuth } from '../middleware/auth.js'
import { userKey } from '../lib/limiterKey.js'
import { requireCosting, isId } from '../lib/procurement.js'
import { cleanSpec, specView } from '../lib/specSheet.js'

const router = Router()
router.use(requireAuth, requireCosting)

const skipInTest = () => process.env.NODE_ENV === 'test'
const writeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 300, keyGenerator: userKey, skip: skipInTest, message: { error: 'Too many changes. Please wait.' },
  standardHeaders: true, legacyHeaders: false, validate: false,
})
const fail = (res, status, error) => res.status(status).json({ error })
const isFactory = req => req.user.role === 'manufacturer'

/** The order, if this caller is on it: the factory has a split of it, or the brand placed it. */
const reachableOrder = (req, orderId) => {
  if (typeof orderId !== 'string' || !orderId || orderId.length > 100) return null
  return Order.findOne(isFactory(req) ? { _id: orderId, 'assignments.mfrId': req.user.id } : { _id: orderId, buyerId: req.user.id }, '_id').lean()
}

// GET /api/spec-sheets?orderId= - the spec(s) read for an order: a factory sees its own, a brand every factory's
router.get('/', async (req, res) => {
  try {
    const order = await reachableOrder(req, req.query.orderId)
    if (!order) return fail(res, 404, 'Order not found')
    const sheets = await SpecSheet.find({ orderId: order._id, ...(isFactory(req) ? { ownerOrgId: req.user.orgId } : {}) }).sort({ updatedAt: -1 }).lean()
    const orgs = new Map((await Organization.find({ _id: { $in: sheets.map(s => s.ownerOrgId) } }, 'name').lean()).map(o => [String(o._id), o.name]))
    res.json(sheets.map(s => specView(s, { factoryName: orgs.get(String(s.ownerOrgId)) || '', editable: isFactory(req) })))
  } catch (err) { console.error('[spec]', err); fail(res, 500, 'Server error') }
})

// POST /api/spec-sheets/:id { sizes, points } - the factory that read it corrects it
router.post('/:id', writeLimiter, async (req, res) => {
  try {
    if (!isFactory(req)) return fail(res, 403, 'Only the factory can correct a spec')
    const own = isId(req.params.id) ? await SpecSheet.findOne({ _id: req.params.id, ownerOrgId: req.user.orgId }, '_id orderId').lean() : null
    if (!own) return fail(res, 404, 'Spec not found')
    const clean = cleanSpec(req.body)
    if (!clean.ok) return fail(res, 400, clean.error)
    const saved = await SpecSheet.findOneAndUpdate({ _id: own._id, ownerOrgId: req.user.orgId }, { $set: { sizes: clean.sizes, points: clean.points, updatedBy: req.user.actorId } }, { new: true }).lean()
    await AuditLog.create({ byUser: req.user.id, action: 'Spec Sheet Corrected', detail: `${own.orderId}: measurement spec corrected by ${req.user.name} (${clean.points.length} points)` })
    res.json(specView(saved, { editable: true }))
  } catch (err) { console.error('[spec]', err); fail(res, 500, 'Server error') }
})

export default router
