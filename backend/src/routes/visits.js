import { Router } from 'express'
import mongoose from 'mongoose'
import rateLimit from 'express-rate-limit'
import { FactoryVisit, User, Manufacturer, AuditLog } from '../db/index.js'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import { COORDINATOR_ROLE } from '../lib/coordinator.js'
import { cleanPoint, distanceM, isAway, dayIST, startOfDayIST, mapsUrlFor } from '../lib/geo.js'

// Factory visits: an Ops & QC coordinator checks in when he reaches one of his factories and checks out when he leaves.
// Each tap carries the phone's position and time; the server's own clock is the time that counts. Admins read the visits.
const router = Router()
router.use(requireAuth)

const tapLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 120,
  keyGenerator: req => req.user?.id || req.ip,
  message: { error: 'Too many check-ins. Please wait.' },
  standardHeaders: true, legacyHeaders: false, validate: false,
  skip: () => process.env.NODE_ENV === 'test',
})

const coordinatorOnly = (req, res, next) =>
  (req.user.role === COORDINATOR_ROLE ? next() : res.status(403).json({ error: 'Only a coordinator checks in at a factory' }))

const serverError = (res, err) => { console.error('[visits]', err); res.status(500).json({ error: 'Server error' }) }
const isId = v => typeof v === 'string' && mongoose.Types.ObjectId.isValid(v)

const pointOut = p => (p ? {
  at: p.at, deviceAt: p.deviceAt || null, lat: p.lat, lng: p.lng, accuracy: p.accuracy ?? null,
  distanceM: p.distanceM ?? null, away: isAway(p), mapsUrl: mapsUrlFor(p.lat, p.lng),
} : null)

export const visitOut = v => ({
  id: String(v._id),
  coordinatorId: String(v.coordinatorId?._id ?? v.coordinatorId), coordinatorName: v.coordinatorId?.name ?? null,
  factoryId: String(v.factoryId?._id ?? v.factoryId), factoryName: v.factoryId?.company ?? null,
  checkIn: pointOut(v.checkIn), checkOut: pointOut(v.checkOut),
  open: !v.closedBy, didNotCheckOut: v.closedBy === 'auto',
  minutes: v.checkOut ? Math.max(0, Math.round((new Date(v.checkOut.at) - new Date(v.checkIn.at)) / 60000)) : null,
})

// A visit still open from an earlier day in India is closed with no check-out time: nobody invents when he left.
export async function closeStaleVisits(filter = {}, now = new Date()) {
  const today = startOfDayIST(dayIST(now))
  await FactoryVisit.updateMany({ ...filter, closedBy: null, 'checkIn.at': { $lt: today } }, { $set: { closedBy: 'auto' } })
}

/** The coordinator's open visit (today's, still not checked out), or null. */
export async function openVisitOf(coordinatorId) {
  await closeStaleVisits({ coordinatorId })
  return FactoryVisit.findOne({ coordinatorId, closedBy: null }).lean()
}

// The factory's pin from its Partner Directory record.
const pinsFor = async factoryIds => {
  const rows = await Manufacturer.find({ linkedUserId: { $in: factoryIds } }, 'linkedUserId city geo').lean()
  return new Map(rows.map(p => [String(p.linkedUserId), p]))
}
const pinOf = p => (p?.geo && p.geo.lat != null && p.geo.lng != null ? { lat: p.geo.lat, lng: p.geo.lng } : null)

// GET /api/visits/mine - the coordinator's factories, his open visit, and today's visits.
router.get('/mine', coordinatorOnly, async (req, res) => {
  try {
    const ids = req.user.factoryIds
    const [factories, pins, open] = await Promise.all([
      User.find({ _id: { $in: ids }, role: 'manufacturer', isActive: true }, 'company name code').sort({ company: 1 }).lean(),
      pinsFor(ids),
      openVisitOf(req.user.id),
    ])
    const today = await FactoryVisit.find({ coordinatorId: req.user.id, 'checkIn.at': { $gte: startOfDayIST(dayIST()) } })
      .sort({ 'checkIn.at': -1 }).populate('factoryId', 'company').lean()
    res.json({
      factories: factories.map(f => {
        const pin = pinOf(pins.get(String(f._id)))
        return {
          id: String(f._id), name: f.company, city: pins.get(String(f._id))?.city || '',
          hasLocation: !!pin, directionsUrl: pin ? mapsUrlFor(pin.lat, pin.lng) : null,
        }
      }),
      open: open ? visitOut({ ...open, factoryId: { _id: open.factoryId, company: factories.find(f => String(f._id) === String(open.factoryId))?.company ?? null } }) : null,
      today: today.map(visitOut),
    })
  } catch (err) { serverError(res, err) }
})

// POST /api/visits/check-in { factoryId, lat, lng, accuracy?, deviceAt? }
router.post('/check-in', coordinatorOnly, tapLimiter, async (req, res) => {
  try {
    const { factoryId } = req.body || {}
    if (!isId(factoryId)) return res.status(400).json({ error: 'Choose a factory' })
    if (!req.user.factoryIds.includes(factoryId)) return res.status(403).json({ error: 'That factory is not allocated to you' })
    const cleaned = cleanPoint(req.body)
    if (cleaned.error) return res.status(400).json({ error: cleaned.error, ...(cleaned.code ? { code: cleaned.code } : {}) })
    const factory = await User.findOne({ _id: factoryId, role: 'manufacturer', isActive: true }, 'company').lean()
    if (!factory) return res.status(404).json({ error: 'Factory not found' })

    const open = await openVisitOf(req.user.id)
    if (open) {
      const at = await User.findById(open.factoryId, 'company').lean()
      return res.status(409).json({ error: `Check out of ${at?.company || 'the other factory'} first`, code: 'VISIT_OPEN', visitId: String(open._id) })
    }
    const pin = pinOf((await pinsFor([factoryId])).get(factoryId))
    let visit
    try {
      visit = await FactoryVisit.create({
        coordinatorId: req.user.id, factoryId,
        checkIn: { ...cleaned.point, at: new Date(), distanceM: distanceM(pin, cleaned.point) },
      })
    } catch (e) {
      // Two taps at once: the database's own "one open visit" rule caught the second.
      if (e.code === 11000) return res.status(409).json({ error: 'You are already checked in', code: 'VISIT_OPEN' })
      throw e
    }
    const p = visit.checkIn
    await AuditLog.create({
      byUser: req.user.id, action: 'Factory Check In',
      detail: `${req.user.name} checked in at ${factory.company} (${p.lat}, ${p.lng}${p.accuracy != null ? ` ±${p.accuracy} m` : ''}${p.distanceM != null ? `, ${p.distanceM} m from the factory` : ', factory has no location yet'})`,
    })
    res.status(201).json(visitOut({ ...visit.toObject(), factoryId: { _id: factoryId, company: factory.company } }))
  } catch (err) { serverError(res, err) }
})

// POST /api/visits/:id/check-out { lat, lng, accuracy?, deviceAt? }
router.post('/:id/check-out', coordinatorOnly, tapLimiter, async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ error: 'Visit not found' })
    const cleaned = cleanPoint(req.body)
    if (cleaned.error) return res.status(400).json({ error: cleaned.error, ...(cleaned.code ? { code: cleaned.code } : {}) })
    await closeStaleVisits({ coordinatorId: req.user.id })
    const existing = await FactoryVisit.findOne({ _id: req.params.id, coordinatorId: req.user.id }).lean()
    if (!existing) return res.status(404).json({ error: 'Visit not found' })
    if (existing.closedBy) return res.status(409).json({ error: 'That visit is already closed', code: 'VISIT_CLOSED' })
    const pin = pinOf((await pinsFor([existing.factoryId])).get(String(existing.factoryId)))
    const visit = await FactoryVisit.findOneAndUpdate(
      { _id: existing._id, coordinatorId: req.user.id, closedBy: null },
      { $set: { checkOut: { ...cleaned.point, at: new Date(), distanceM: distanceM(pin, cleaned.point) }, closedBy: 'coordinator' } },
      { new: true },
    ).populate('factoryId', 'company').lean()
    if (!visit) return res.status(409).json({ error: 'That visit is already closed', code: 'VISIT_CLOSED' })
    const out = visitOut(visit)
    await AuditLog.create({
      byUser: req.user.id, action: 'Factory Check Out',
      detail: `${req.user.name} checked out of ${out.factoryName || 'a factory'} after ${out.minutes} min (${visit.checkOut.lat}, ${visit.checkOut.lng}${visit.checkOut.distanceM != null ? `, ${visit.checkOut.distanceM} m from the factory` : ''})`,
    })
    res.json(out)
  } catch (err) { serverError(res, err) }
})

// GET /api/visits?from=YYYY-MM-DD&to=YYYY-MM-DD&coordinatorId=&factoryId= (admins). Days are days in India.
router.get('/', requireAdmin, async (req, res) => {
  try {
    await closeStaleVisits()
    const filter = {}
    const from = req.query.from ? startOfDayIST(String(req.query.from)) : null
    const to = req.query.to ? startOfDayIST(String(req.query.to)) : null
    if (req.query.from && !from) return res.status(400).json({ error: 'Invalid from date' })
    if (req.query.to && !to) return res.status(400).json({ error: 'Invalid to date' })
    if (from || to) filter['checkIn.at'] = { ...(from ? { $gte: from } : {}), ...(to ? { $lt: new Date(to.getTime() + 24 * 60 * 60 * 1000) } : {}) }
    for (const k of ['coordinatorId', 'factoryId']) {
      if (req.query[k] === undefined || req.query[k] === '') continue
      if (!isId(req.query[k])) return res.status(400).json({ error: `Invalid ${k}` })
      filter[k] = req.query[k]
    }
    const [visits, coordinators] = await Promise.all([
      FactoryVisit.find(filter).sort({ 'checkIn.at': -1 }).limit(500).populate('coordinatorId', 'name').populate('factoryId', 'company').lean(),
      User.find({ role: COORDINATOR_ROLE }, 'name isActive assignedFactories').sort({ name: 1 }).lean(),
    ])
    // Factories a coordinator is sent to that have no pin yet: nothing to measure a check-in against.
    const allocated = [...new Set(coordinators.flatMap(c => (c.assignedFactories || []).map(String)))]
    const [pins, factories] = await Promise.all([
      Manufacturer.find({ linkedUserId: { $in: allocated } }, 'linkedUserId geo').lean(),
      User.find({ _id: { $in: allocated }, role: 'manufacturer' }, 'company').sort({ company: 1 }).lean(),
    ])
    const pinned = new Map(pins.map(p => [String(p.linkedUserId), p]))
    res.json({
      visits: visits.map(visitOut),
      coordinators: coordinators.map(c => ({ id: String(c._id), name: c.name, isActive: c.isActive !== false })),
      factories: factories.map(f => ({ id: String(f._id), name: f.company })),
      missingLocation: factories.filter(f => !pinOf(pinned.get(String(f._id)))).map(f => ({
        id: String(f._id), name: f.company, partnerId: pinned.get(String(f._id)) ? String(pinned.get(String(f._id))._id) : null,
      })),
    })
  } catch (err) { serverError(res, err) }
})

export default router
