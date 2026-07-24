import mongoose from 'mongoose'
import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { Order } from '../db/index.js'
import { User }         from '../models/User.js'
import { Notification } from '../models/Notification.js'
import { AuditLog }     from '../models/AuditLog.js'
import { MasterOrder }  from '../models/MasterOrder.js'
import { Document }     from '../models/Document.js'
import { DEFAULT_STAGE_NAMES, ORDER_STATUS_VALUES }  from '../models/Order.js'

// Categories are now free-text — no validation needed
const VALID_SEASONS    = ['SS26', 'FW26', 'SS27', 'FW27', 'SS28']
const MAX_PRODUCT_PHOTO_SIZE = 1024 * 1024 // 1MB raw — reference thumbnail, not full-res
import { requireAuth, requireAdmin } from '../middleware/auth.js'
// Email triggers for orders are intentionally suppressed — order activity is portal-notifications only

// 60 order creations per admin per hour — prevents runaway scripting
const createOrderLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 60,
  keyGenerator: req => req.user?.id || req.ip,
  message: { error: 'Too many order creation requests. Please wait.' },
  standardHeaders: true, legacyHeaders: false, validate: false,
})

// 10 bulk (CSV) order-creation requests per admin per hour — separate from the
// per-order limiter above since one bulk request creates many orders at once
const bulkOrderLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 10,
  keyGenerator: req => req.user?.id || req.ip,
  message: { error: 'Too many bulk upload requests. Please wait.' },
  standardHeaders: true, legacyHeaders: false, validate: false,
})

// 30 materials-bulk-upload requests per admin per hour
const materialsBulkLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 30,
  keyGenerator: req => req.user?.id || req.ip,
  message: { error: 'Too many bulk materials upload requests. Please wait.' },
  standardHeaders: true, legacyHeaders: false, validate: false,
})

// 120 stage/status patches per user per hour
const updateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 120,
  keyGenerator: req => req.user?.id || req.ip,
  message: { error: 'Too many update requests. Please wait.' },
  standardHeaders: true, legacyHeaders: false, validate: false,
})

// Max 3 escalations per buyer per 60 min (prevents email spam to master admins)
const escalationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  keyGenerator: req => `${req.user?.id}-escalate`,
  message: { error: 'Too many escalations. Please wait before escalating again.' },
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
})

const router = Router()
const MFR_FIELDS = 'name company code'
const BUYER_FIELDS = 'name company code'

const enrichOrder = (o, viewerMfrId = null) => {
  const buyer = o.buyerId && typeof o.buyerId === 'object' && o.buyerId.company ? o.buyerId : null
  // Manufacturers only see their own assignment — not competitors' qty/status/notes
  const allAssignments = o.assignments || []
  const visibleAssignments = viewerMfrId
    ? allAssignments.filter(a => (a.mfrId?._id?.toString() ?? a.mfrId?.toString()) === viewerMfrId)
    : allAssignments
  return {
  id: o._id, masterOrderId: o.masterOrderId || null,
  buyerId: buyer ? buyer._id.toString() : (o.buyerId?.toString?.() ?? o.buyerId),
  buyerCompany: buyer?.company ?? null, buyerName: buyer?.name ?? null, buyerCode: buyer?.code ?? null,
  product: o.product, category: o.category,
  imageDataUrl: o.imageDataUrl || null, imageUrl: o.imageUrl || null,
  season: o.season, totalQty: o.totalQty, delivery: o.delivery, createdAt: o.createdAt,
  assignments: visibleAssignments.map(a => {
    const mfr = a.mfrId && typeof a.mfrId === 'object' && a.mfrId.company ? a.mfrId : null
    return {
      id:         a._id,
      mid:        mfr ? mfr._id.toString() : (a.mfrId?.toString?.() ?? a.mfrId),
      mfrCompany: mfr?.company  ?? null,
      mfrCode:    mfr?.code     ?? null,
      mfrName:    mfr?.name     ?? null,
      qty:        a.qty,
      status:     a.status,
      sub:        a.sub,
      note:       a.note,
      updatedAt:  a.updatedAt,
      stages:     (a.stages || []).map(s => {
        const responsible = s.responsibleId && typeof s.responsibleId === 'object' && s.responsibleId.name ? s.responsibleId : null
        return {
          name: s.name, unitsDone: s.unitsDone,
          totalUnits: s.totalUnits, startDate: s.startDate || null, eta: s.eta, stageDate: s.stageDate || null, note: s.note,
          responsibleId: responsible ? responsible._id.toString() : (s.responsibleId?.toString?.() ?? s.responsibleId ?? null),
          responsibleName: responsible?.name ?? null,
          responsibleRole: responsible?.role ?? null,
          responsibleCompany: responsible?.company ?? null,
          description: s.description || '',
          updates: (s.updates || []).map(u => ({
            text: u.text,
            byUser: u.byUser?._id?.toString() ?? u.byUser?.toString(),
            byUserName: u.byUser?.name ?? null,
            at: u.at,
          })),
          materials: (s.materials || []).map(m => ({
            name: m.name, requiredQty: m.requiredQty, unit: m.unit, supplier: m.supplier,
            poNumber: m.poNumber, expectedDate: m.expectedDate, status: m.status,
            orderedQty: m.orderedQty, receivedQty: m.receivedQty, note: m.note,
          })),
        }
      }),
    }
  }),
}
}

// GET /api/orders
router.get('/', requireAuth, async (req, res) => {
  try {
    let query
    if (req.user.role === 'admin')        query = Order.find()
    else if (req.user.role === 'buyer')   query = Order.find({ buyerId: req.user.id })
    else                                  query = Order.find({ 'assignments.mfrId': req.user.id })

    const orders = await query.populate('buyerId', BUYER_FIELDS).populate('assignments.mfrId', MFR_FIELDS).populate('assignments.stages.responsibleId', 'name company code role').populate('assignments.stages.updates.byUser', 'name').sort({ createdAt: -1 }).lean()
    const viewerMfrId = req.user.role === 'manufacturer' ? req.user.id : null
    res.json(orders.map(o => enrichOrder(o, viewerMfrId)))
  } catch (err) {
    console.error('[orders]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// GET /api/orders/:id
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id).populate('buyerId', BUYER_FIELDS).populate('assignments.mfrId', MFR_FIELDS).populate('assignments.stages.responsibleId', 'name company code role').populate('assignments.stages.updates.byUser', 'name').lean()
    if (!order) return res.status(404).json({ error: 'Order not found' })

    const buyerIdStr = order.buyerId?._id?.toString() ?? order.buyerId?.toString()
    if (req.user.role === 'buyer' && buyerIdStr !== req.user.id)
      return res.status(403).json({ error: 'Forbidden' })

    if (req.user.role === 'manufacturer') {
      const assigned = (order.assignments || []).some(a => {
        const id = a.mfrId?._id?.toString() ?? a.mfrId?.toString()
        return id === req.user.id
      })
      if (!assigned) return res.status(403).json({ error: 'Forbidden' })
    }

    const viewerMfrId = req.user.role === 'manufacturer' ? req.user.id : null
    res.json(enrichOrder(order, viewerMfrId))
  } catch (err) {
    console.error('[orders]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// Shared by POST / (single order) and POST /bulk — validates a full order payload
// and creates it if valid. Centralizes rules (including the B1 required-end-date
// check) so both call sites can't drift out of sync. Returns the raw created
// Mongoose doc on success (not populated/enriched — that's caller-specific).
async function validateAndCreateOrder({ id, buyerId, product, category, season, totalQty, delivery, createdAt, masterOrderId, assignments: asgns, stageEtas, stageStartDates, stageNames: customStages, stageResponsibleIds, stageDescriptions, stageTotalUnits, imageDataUrl, imageUrl }) {
  if (!id || !buyerId || !product || !totalQty || !delivery)
    return { ok: false, error: 'Missing required fields' }
  if (typeof id !== 'string' || typeof product !== 'string')
    return { ok: false, error: 'Invalid input types' }
  if (id.length > 100 || product.length > 300)
    return { ok: false, error: 'Input too long' }
  if (!/^[A-Z0-9\-]+$/i.test(id))
    return { ok: false, error: 'Order ID may only contain letters, numbers, and hyphens' }
  if (category && typeof category === 'string' && category.length > 50)
    return { ok: false, error: 'Category too long' }
  if (season && !VALID_SEASONS.includes(season))
    return { ok: false, error: `Invalid season. Must be one of: ${VALID_SEASONS.join(', ')}` }
  const deliveryDate = new Date(delivery)
  if (isNaN(deliveryDate.getTime()))
    return { ok: false, error: 'Invalid delivery date' }
  if (!asgns || !Array.isArray(asgns) || asgns.length === 0)
    return { ok: false, error: 'At least one assignment required' }
  if (!mongoose.Types.ObjectId.isValid(buyerId)) return { ok: false, error: 'Invalid buyer ID' }
  const buyerCheck = await User.findById(buyerId, 'role isActive').lean()
  if (!buyerCheck || buyerCheck.role !== 'buyer') return { ok: false, error: 'Buyer not found' }
  if (!buyerCheck.isActive) return { ok: false, error: 'Buyer account is inactive' }

  // Validate masterOrderId if provided: must exist and belong to the same buyer
  if (masterOrderId) {
    const mo = await MasterOrder.findById(masterOrderId, 'buyerId').lean()
    if (!mo) return { ok: false, error: `Master order "${masterOrderId}" not found` }
    if (mo.buyerId.toString() !== buyerId) return { ok: false, error: 'Master order does not belong to the selected buyer' }
  }

  // Validate each assignment has valid mid and qty
  for (const a of asgns) {
    if (!a.mid) return { ok: false, error: 'Each assignment must have a manufacturer' }
    const aqty = parseInt(a.qty, 10)
    if (isNaN(aqty) || aqty < 1) return { ok: false, error: 'Each assignment quantity must be a positive number' }
    if (!mongoose.Types.ObjectId.isValid(a.mid)) return { ok: false, error: `Invalid manufacturer ID: ${a.mid}` }
  }

  // Batch-fetch all manufacturer users in one query instead of N individual lookups
  const mfrIds = asgns.map(a => a.mid)
  const mfrUsers = await User.find({ _id: { $in: mfrIds } }, 'role isActive').lean()
  const mfrMap = Object.fromEntries(mfrUsers.map(u => [u._id.toString(), u]))
  for (const a of asgns) {
    const mfrUser = mfrMap[a.mid]
    if (!mfrUser || mfrUser.role !== 'manufacturer') return { ok: false, error: `User ${a.mid} is not a manufacturer` }
    if (!mfrUser.isActive) return { ok: false, error: `Manufacturer ${a.mid} is inactive` }
  }

  // Validate sum of assignment quantities equals totalQty
  const assignedTotal = asgns.reduce((sum, a) => sum + parseInt(a.qty, 10), 0)
  if (assignedTotal !== parseInt(totalQty, 10)) {
    return { ok: false, error: `Assignment quantities (${assignedTotal}) must sum to total quantity (${totalQty})` }
  }

  // Dynamic stages: admin can define custom stage names, or fall back to defaults
  const stages = (Array.isArray(customStages) && customStages.length > 0)
    ? customStages.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim().slice(0, 100))
    : DEFAULT_STAGE_NAMES
  if (stages.length === 0)
    return { ok: false, error: 'At least one production stage is required' }
  if (stages.length > 50)
    return { ok: false, error: 'Too many stages (max 50)' }

  const etas = stageEtas || stages.map(() => null)
  const startDates = stageStartDates || stages.map(() => null)

  // Every stage requires an explicit start date AND end date — a valid date string or
  // literal 'NA'. No more blank/null — a stage with no enforced date is exactly the gap
  // that caused a real missed-deadline incident (see docs/MIGRATION_PLAN.md context).
  // When both sides are real (non-'NA') dates, start must be on or before end.
  for (let i = 0; i < stages.length; i++) {
    const startVal = startDates[i]
    const endVal = etas[i]
    if (!startVal) return { ok: false, error: `Stage "${stages[i]}" is missing a start date` }
    if (startVal !== 'NA' && isNaN(new Date(startVal).getTime()))
      return { ok: false, error: `Stage "${stages[i]}" has an invalid start date` }
    if (!endVal) return { ok: false, error: `Stage "${stages[i]}" is missing an end date` }
    if (endVal !== 'NA' && isNaN(new Date(endVal).getTime()))
      return { ok: false, error: `Stage "${stages[i]}" has an invalid end date` }
    if (startVal !== 'NA' && endVal !== 'NA' && new Date(startVal) > new Date(endVal))
      return { ok: false, error: `Stage "${stages[i]}" start date must be on or before its end date` }
  }

  // Optional per-stage responsible person (admin or manufacturer), index-aligned with
  // stages. Applied identically across every manufacturer split — one accountable
  // person per stage, not per split.
  const stageResponsibleIdsResolved = stages.map(() => null)
  if (Array.isArray(stageResponsibleIds)) {
    const ids = stageResponsibleIds.filter(Boolean)
    if (ids.length > 0) {
      if (!ids.every(rid => mongoose.Types.ObjectId.isValid(rid)))
        return { ok: false, error: 'Invalid responsible person ID' }
      const respUsers = await User.find({ _id: { $in: ids } }, 'role isActive').lean()
      const respMap = Object.fromEntries(respUsers.map(u => [u._id.toString(), u]))
      for (let i = 0; i < stages.length; i++) {
        const rid = stageResponsibleIds[i]
        if (!rid) continue
        const u = respMap[rid]
        if (!u || (u.role !== 'admin' && u.role !== 'manufacturer'))
          return { ok: false, error: `Responsible person for stage "${stages[i]}" must be an admin or manufacturer` }
        if (!u.isActive)
          return { ok: false, error: `Responsible person for stage "${stages[i]}" is inactive` }
        stageResponsibleIdsResolved[i] = rid
      }
    }
  }

  // Optional per-stage description, index-aligned with stages.
  const stageDescriptionsResolved = stages.map(() => '')
  if (Array.isArray(stageDescriptions)) {
    for (let i = 0; i < stages.length; i++) {
      const d = stageDescriptions[i]
      if (typeof d === 'string' && d.trim()) {
        if (d.trim().length > 1000) return { ok: false, error: `Description for stage "${stages[i]}" is too long (max 1000 characters)` }
        stageDescriptionsResolved[i] = d.trim()
      }
    }
  }

  // Optional per-stage target quantity — not every stage tracks the full order qty
  // (e.g. "Lab Dip Approval" might target 3 dips, not 600 pieces). Defaults to the
  // assignment's qty when not provided.
  const stageTotalUnitsResolved = stages.map(() => null)
  if (Array.isArray(stageTotalUnits)) {
    for (let i = 0; i < stages.length; i++) {
      const t = stageTotalUnits[i]
      if (t === undefined || t === null || t === '') continue
      const parsed = parseInt(t, 10)
      if (isNaN(parsed) || parsed < 1) return { ok: false, error: `Target quantity for stage "${stages[i]}" must be a positive number` }
      stageTotalUnitsResolved[i] = parsed
    }
  }

  // Optional cover photo — either an uploaded base64 image (capped small) or an
  // external link fallback, never both.
  if (imageDataUrl && imageUrl) return { ok: false, error: 'Provide either an uploaded photo or a link, not both' }
  if (imageDataUrl) {
    const m = /^data:(image\/jpeg|image\/jpg|image\/png);base64,(.+)$/.exec(imageDataUrl)
    if (!m) return { ok: false, error: 'Photo must be a JPEG or PNG image' }
    if (m[2].length * 0.75 > MAX_PRODUCT_PHOTO_SIZE) return { ok: false, error: 'Photo too large — keep it under 1MB' }
  }
  if (imageUrl) {
    if (imageUrl.trim().length > 2000) return { ok: false, error: 'Image URL too long' }
    try { const u = new URL(imageUrl.trim()); if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error() }
    catch { return { ok: false, error: 'Invalid image URL — must be a valid http(s) link' } }
  }

  try {
    const created = await Order.create({
      _id: id, buyerId, product, category, season, totalQty, masterOrderId: masterOrderId || null,
      imageDataUrl: imageDataUrl || null, imageUrl: imageUrl ? imageUrl.trim() : null,
      delivery: new Date(delivery),
      createdAt: createdAt ? new Date(createdAt) : undefined,
      assignments: asgns.map((a, i) => ({
        mfrId: a.mid, qty: a.qty, status: 'Processing',
        sub: a.sub || `M${i + 1}`, note: '',
        stages: stages.map((name, si) => ({
          name, unitsDone: 0, totalUnits: stageTotalUnitsResolved[si] ?? a.qty,
          startDate: startDates[si] || null, eta: etas[si] || null, note: '',
          description: stageDescriptionsResolved[si] || '',
          responsibleId: stageResponsibleIdsResolved[si] || null,
        })),
      })),
    })
    return { ok: true, order: created }
  } catch (err) {
    if (err.code === 11000) return { ok: false, error: 'Order ID already exists' }
    throw err
  }
}

// POST /api/orders
router.post('/', requireAuth, requireAdmin, createOrderLimiter, async (req, res) => {
  try {
    const result = await validateAndCreateOrder(req.body)
    if (!result.ok) {
      const status = result.error === 'Order ID already exists' ? 409 : 400
      return res.status(status).json({ error: result.error })
    }

    const order = await Order.findById(result.order._id).populate('buyerId', BUYER_FIELDS).populate('assignments.mfrId', MFR_FIELDS).populate('assignments.stages.responsibleId', 'name company code role').populate('assignments.stages.updates.byUser', 'name').lean()

    res.status(201).json(enrichOrder(order))
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/orders/bulk — CSV-driven bulk creation of many product-level orders
// under one Master Order (B2 of the TNA CSV bulk-upload feature)
router.post('/bulk', requireAuth, requireAdmin, bulkOrderLimiter, async (req, res) => {
  try {
    const { masterOrderId, rows } = req.body
    if (!masterOrderId) return res.status(400).json({ error: 'masterOrderId is required' })
    if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'At least one row is required' })
    if (rows.length > 100) return res.status(400).json({ error: 'Too many rows (max 100 per bulk upload)' })

    const mo = await MasterOrder.findById(masterOrderId).lean()
    if (!mo) return res.status(400).json({ error: `Master order "${masterOrderId}" not found` })
    const buyerId = mo.buyerId.toString()
    const buyer = await User.findById(buyerId, 'code isActive role').lean()
    if (!buyer || buyer.role !== 'buyer') return res.status(400).json({ error: 'Buyer not found' })
    if (!buyer.isActive) return res.status(400).json({ error: 'Buyer account is inactive' })

    // Starting sequence number for auto-generated IDs — mirrors the frontend's
    // genId() convention (AdminOrders.jsx), then incremented in-memory per row
    // within this batch rather than re-queried each time. Single-instance
    // assumption (see CLAUDE.md) — safe only because AppSail runs one process.
    let seq = (await Order.countDocuments({ _id: new RegExp(`^${buyer.code}-`) })) + 1

    const results = []
    let created = 0, failed = 0

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      try {
        let orderId = row.orderId
        if (!orderId) {
          const firstMfr = await User.findById(row.assignments?.[0]?.mid, 'code').lean().catch(() => null)
          const cat = (row.category || 'XX').toUpperCase().slice(0, 6)
          const season = row.season || mo.season || 'XX'
          orderId = `${buyer.code}-${firstMfr?.code || 'XX'}-${cat}-${season}-${String(seq).padStart(3, '0')}`
          seq++
        }

        const result = await validateAndCreateOrder({
          id: orderId, buyerId, product: row.product, category: row.category,
          season: row.season || mo.season, totalQty: row.totalQty, delivery: row.delivery,
          masterOrderId, assignments: row.assignments, stageNames: row.stageNames,
          stageStartDates: row.stageStartDates, stageEtas: row.stageEtas,
          stageResponsibleIds: row.stageResponsibleIds, stageDescriptions: row.stageDescriptions,
          stageTotalUnits: row.stageTotalUnits,
        })

        if (result.ok) {
          created++
          results.push({ row: i, success: true, orderId: result.order._id })
        } else {
          failed++
          results.push({ row: i, success: false, error: result.error })
        }
      } catch (err) {
        failed++
        results.push({ row: i, success: false, error: 'Server error creating this row' })
      }
    }

    await AuditLog.create({
      byUser: req.user.id,
      action: 'Bulk Order Upload',
      detail: `Bulk upload: ${created} created, ${failed} failed under ${masterOrderId}`,
    })

    res.status(200).json({ total: rows.length, created, failed, results })
  } catch (err) {
    console.error('[orders bulk]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// PATCH /api/orders/:orderId/assignments/:mfrId  — update order-level status + note
router.post('/:orderId/assignments/:mfrId', requireAuth, updateLimiter, async (req, res) => {
  try {
    const { orderId, mfrId } = req.params
    const { status, note } = req.body

    if (!mongoose.Types.ObjectId.isValid(mfrId))
      return res.status(400).json({ error: 'Invalid manufacturer ID' })
    // BRD §3: Buyers cannot update production stages or status
    if (req.user.role === 'buyer')
      return res.status(403).json({ error: 'Buyers cannot update order status' })
    if (req.user.role === 'manufacturer' && String(req.user.id) !== String(mfrId))
      return res.status(403).json({ error: 'Forbidden' })
    if (!status || !ORDER_STATUS_VALUES.includes(status))
      return res.status(400).json({ error: `Invalid status. Must be one of: ${ORDER_STATUS_VALUES.join(', ')}` })
    if (note !== undefined && note !== null && typeof note === 'string' && note.length > 1000)
      return res.status(400).json({ error: 'Note too long (max 1000 characters)' })

    const order = await Order.findOneAndUpdate(
      { _id: orderId, 'assignments.mfrId': mfrId },
      { $set: {
        'assignments.$.status':    status,
        'assignments.$.note':      note ?? '',
        'assignments.$.updatedAt': new Date(),
      }},
      { new: true }
    ).populate('buyerId', BUYER_FIELDS).populate('assignments.mfrId', MFR_FIELDS).populate('assignments.stages.responsibleId', 'name company code role').populate('assignments.stages.updates.byUser', 'name').lean()

    if (!order) return res.status(404).json({ error: 'Order or assignment not found' })

    await AuditLog.create({
      byUser: req.user.id,
      action: 'Status Updated',
      detail: `${orderId}: assignment status → ${status}${note ? ' | ' + note.slice(0, 200) : ''}`,
    })

    res.json(enrichOrder(order))
  } catch (err) {
    console.error('[orders]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// PATCH /api/orders/:orderId/assignments/:mfrId/stages/:stageIndex — update one stage
router.post('/:orderId/assignments/:mfrId/stages/:stageIndex', requireAuth, updateLimiter, async (req, res) => {
  try {
    const { orderId, mfrId } = req.params
    if (!mongoose.Types.ObjectId.isValid(mfrId))
      return res.status(400).json({ error: 'Invalid manufacturer ID' })
    const mfrObjectId = new mongoose.Types.ObjectId(mfrId)
    const stageIndex = parseInt(req.params.stageIndex, 10)
    const { unitsDone, note, eta, startDate, stageDate, override } = req.body
    const hasEta = Object.prototype.hasOwnProperty.call(req.body, 'eta')
    const hasStartDate = Object.prototype.hasOwnProperty.call(req.body, 'startDate')
    const isMasterOverride = override === true

    // BRD §3: Buyers cannot update production stages
    if (req.user.role === 'buyer')
      return res.status(403).json({ error: 'Buyers cannot update production stages' })
    if (req.user.role === 'manufacturer' && String(req.user.id) !== String(mfrId))
      return res.status(403).json({ error: 'Forbidden' })
    if (isMasterOverride && !(req.user.role === 'admin' && req.user.adminType === 'master'))
      return res.status(403).json({ error: 'Only master admin can override a stage' })
    // Validate unitsDone is a non-negative number
    const parsedUnits = parseInt(unitsDone, 10)
    if (isNaN(parsedUnits) || parsedUnits < 0)
      return res.status(400).json({ error: 'unitsDone must be a non-negative number' })
    if (note !== undefined && note !== null && typeof note === 'string' && note.length > 1000)
      return res.status(400).json({ error: 'Note too long (max 1000 characters)' })

    // Validate unitsDone does not exceed totalUnits for this assignment's stage
    const existingOrder = await Order.findById(orderId).lean()
    if (!existingOrder) return res.status(404).json({ error: 'Order not found' })
    const existingAsgn = (existingOrder.assignments || []).find(a => a.mfrId?.toString() === mfrId)
    if (!existingAsgn) return res.status(404).json({ error: 'Assignment not found' })

    const stageCount = existingAsgn.stages?.length || 0
    if (isNaN(stageIndex) || stageIndex < 0 || stageIndex >= stageCount)
      return res.status(400).json({ error: `Invalid stage index (0–${stageCount - 1})` })

    const totalUnits = existingAsgn.stages?.[stageIndex]?.totalUnits ?? 0
    if (parsedUnits > totalUnits)
      return res.status(400).json({ error: `unitsDone (${parsedUnits}) cannot exceed totalUnits (${totalUnits})` })

    // Materials gate: a stage with 1+ material lines cannot advance past its current
    // unitsDone while any line isn't cleared — applies uniformly to manufacturer
    // updates and admin Stage Override alike (both share this route). The "Trims
    // Order" stage itself is about placing the order, not having it in hand, so
    // 'ordered' already satisfies it there; every other stage still requires the
    // material to actually be 'received'.
    const gateStageName = (existingAsgn.stages?.[stageIndex]?.name || '').trim().toLowerCase()
    const isTrimsOrderStage = gateStageName === 'trims order'
    const stageMaterials = existingAsgn.stages?.[stageIndex]?.materials || []
    const currentUnits = existingAsgn.stages?.[stageIndex]?.unitsDone || 0
    const pendingMaterials = stageMaterials.filter(m => isTrimsOrderStage ? m.status === 'pending' : m.status !== 'received')
    if (!isMasterOverride && pendingMaterials.length > 0 && parsedUnits > currentUnits)
      return res.status(400).json({ error: `Cannot advance this stage — ${pendingMaterials.length} material(s) still pending${isTrimsOrderStage ? '' : '/ordered'}` })

    // Build the $set — always update units/note/stageDate for the target stage.
    // eta/startDate are only touched when explicitly present in the body — this route is
    // mainly used for progress updates (unitsDone/note/stageDate) that never include a date,
    // and both dates are required-and-never-blank once an order exists, so a value-less
    // request must not silently null them out.
    const setFields = {
      [`assignments.$[asgn].stages.${stageIndex}.unitsDone`]:  parsedUnits,
      [`assignments.$[asgn].stages.${stageIndex}.note`]:       note ?? '',
      [`assignments.$[asgn].stages.${stageIndex}.stageDate`]:  stageDate ?? null,
      'assignments.$[asgn].updatedAt': new Date(),
    }
    if (hasEta) setFields[`assignments.$[asgn].stages.${stageIndex}.eta`] = eta
    if (hasStartDate) setFields[`assignments.$[asgn].stages.${stageIndex}.startDate`] = startDate

    // Always reset all subsequent stages to 0 when updating a stage.
    // Production is sequential — if you're working on stage N, stages N+1… cannot be ahead.
    for (let i = stageIndex + 1; i < stageCount; i++) {
      setFields[`assignments.$[asgn].stages.${i}.unitsDone`] = 0
      setFields[`assignments.$[asgn].stages.${i}.note`] = ''
    }

    // NOTE: arrayFilters do NOT auto-cast strings → ObjectId, so we must pass the ObjectId
    const order = await Order.findOneAndUpdate(
      { _id: orderId, 'assignments.mfrId': mfrObjectId },
      { $set: setFields },
      { arrayFilters: [{ 'asgn.mfrId': mfrObjectId }], new: true }
    ).populate('buyerId', BUYER_FIELDS).populate('assignments.mfrId', MFR_FIELDS).populate('assignments.stages.responsibleId', 'name company code role').populate('assignments.stages.updates.byUser', 'name').lean()

    if (!order) return res.status(404).json({ error: 'Order or assignment not found' })

    const updatedAsgn = (order.assignments || []).find(a => {
      const id = a.mfrId?._id?.toString() ?? a.mfrId?.toString()
      return id === mfrId
    })
    const stageName = updatedAsgn?.stages?.[stageIndex]?.name || `Stage ${stageIndex + 1}`

    await AuditLog.create({
      byUser: req.user.id,
      action: isMasterOverride ? 'Stage Override' : 'Stage Updated',
      detail: `${orderId}: ${stageName} — ${parsedUnits}/${totalUnits} units by ${req.user.name}${isMasterOverride ? ' [MASTER OVERRIDE]' : ''}`,
    })

    res.json(enrichOrder(order))
  } catch (err) {
    console.error('[orders]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// PATCH /api/orders/:orderId/assignments/:mfrId/stages/:stageIndex/eta — adjust a stage's
// planned start date and/or end date after creation (admin only). Accepts either or both
// of `eta`/`startDate` in the body — only the fields actually present get updated, so a
// partial update never silently nulls out the other date (both are required, never blank,
// once an order is created).
router.post('/:orderId/assignments/:mfrId/stages/:stageIndex/eta', requireAuth, requireAdmin, updateLimiter, async (req, res) => {
  try {
    const { orderId, mfrId } = req.params
    if (!mongoose.Types.ObjectId.isValid(mfrId))
      return res.status(400).json({ error: 'Invalid manufacturer ID' })
    const mfrObjectId = new mongoose.Types.ObjectId(mfrId)
    const stageIndex = parseInt(req.params.stageIndex, 10)
    const hasEta = Object.prototype.hasOwnProperty.call(req.body, 'eta')
    const hasStartDate = Object.prototype.hasOwnProperty.call(req.body, 'startDate')
    const hasResponsibleId = Object.prototype.hasOwnProperty.call(req.body, 'responsibleId')
    const hasTotalUnits = Object.prototype.hasOwnProperty.call(req.body, 'totalUnits')
    const hasDescription = Object.prototype.hasOwnProperty.call(req.body, 'description')
    const { eta, startDate, responsibleId, totalUnits, description } = req.body

    if (!hasEta && !hasStartDate && !hasResponsibleId && !hasTotalUnits && !hasDescription)
      return res.status(400).json({ error: 'Provide eta, startDate, responsibleId, totalUnits, and/or description to update' })

    if (hasResponsibleId && responsibleId) {
      if (!mongoose.Types.ObjectId.isValid(responsibleId))
        return res.status(400).json({ error: 'Invalid responsible person ID' })
      const responsibleUser = await User.findById(responsibleId, 'role isActive').lean()
      if (!responsibleUser || (responsibleUser.role !== 'admin' && responsibleUser.role !== 'manufacturer'))
        return res.status(400).json({ error: 'Responsible person must be an admin or manufacturer' })
      if (!responsibleUser.isActive)
        return res.status(400).json({ error: 'Responsible person is inactive' })
    }

    // Validate stageIndex against actual stage count
    const existingOrder = await Order.findById(orderId).lean()
    if (!existingOrder) return res.status(404).json({ error: 'Order not found' })
    const existingAsgn = (existingOrder.assignments || []).find(a => a.mfrId?.toString() === mfrId)
    if (!existingAsgn) return res.status(404).json({ error: 'Assignment not found' })
    const stageCount = existingAsgn.stages?.length || 0
    if (isNaN(stageIndex) || stageIndex < 0 || stageIndex >= stageCount)
      return res.status(400).json({ error: `Invalid stage index (0–${stageCount - 1})` })

    const currentStage = existingAsgn.stages[stageIndex]

    // Target quantity for this stage — not every stage tracks progress against the full
    // order qty (e.g. "Lab Dip Approval" might target 3 dips, not 600 pieces).
    let parsedTotalUnits
    if (hasTotalUnits) {
      parsedTotalUnits = parseInt(totalUnits, 10)
      if (isNaN(parsedTotalUnits) || parsedTotalUnits < 1)
        return res.status(400).json({ error: 'Target quantity must be a positive number' })
      if (parsedTotalUnits < (currentStage.unitsDone || 0))
        return res.status(400).json({ error: `Target quantity cannot be less than units already completed (${currentStage.unitsDone})` })
    }

    // Static description of what this stage involves — separate from `note` (the
    // transient last-progress-update note).
    let trimmedDescription
    if (hasDescription) {
      if (description !== null && typeof description !== 'string')
        return res.status(400).json({ error: 'Description must be text' })
      trimmedDescription = (description || '').trim()
      if (trimmedDescription.length > 1000)
        return res.status(400).json({ error: 'Description too long (max 1000 characters)' })
    }

    // A date field must be a real date or literal 'NA' — never blank (matches the
    // required-at-creation rule; a PATCH shouldn't be able to null one out).
    const invalidDateMsg = (label, val) => {
      if (val === null || val === undefined || val === '')
        return `${label} cannot be blank — use "NA" if it doesn't apply`
      if (val !== 'NA' && isNaN(new Date(val).getTime()))
        return `Invalid ${label} — must be a date or "NA"`
      return null
    }
    if (hasEta) {
      const err = invalidDateMsg('end date', eta)
      if (err) return res.status(400).json({ error: err })
    }
    if (hasStartDate) {
      const err = invalidDateMsg('start date', startDate)
      if (err) return res.status(400).json({ error: err })
    }

    // Ordering check against whichever side isn't being changed in this request
    const effectiveStart = hasStartDate ? startDate : currentStage.startDate
    const effectiveEnd = hasEta ? eta : currentStage.eta
    if (effectiveStart && effectiveEnd && effectiveStart !== 'NA' && effectiveEnd !== 'NA'
        && new Date(effectiveStart) > new Date(effectiveEnd)) {
      return res.status(400).json({ error: 'Start date must be on or before the end date' })
    }

    const setFields = { 'assignments.$[asgn].updatedAt': new Date() }
    if (hasEta) setFields[`assignments.$[asgn].stages.${stageIndex}.eta`] = eta
    if (hasStartDate) setFields[`assignments.$[asgn].stages.${stageIndex}.startDate`] = startDate
    if (hasResponsibleId) setFields[`assignments.$[asgn].stages.${stageIndex}.responsibleId`] = responsibleId || null
    if (hasTotalUnits) setFields[`assignments.$[asgn].stages.${stageIndex}.totalUnits`] = parsedTotalUnits
    if (hasDescription) setFields[`assignments.$[asgn].stages.${stageIndex}.description`] = trimmedDescription

    const order = await Order.findOneAndUpdate(
      { _id: orderId, 'assignments.mfrId': mfrObjectId },
      { $set: setFields },
      { arrayFilters: [{ 'asgn.mfrId': mfrObjectId }], new: true }
    ).populate('buyerId', BUYER_FIELDS).populate('assignments.mfrId', MFR_FIELDS).populate('assignments.stages.responsibleId', 'name company code role').populate('assignments.stages.updates.byUser', 'name').lean()

    if (!order) return res.status(404).json({ error: 'Order or assignment not found' })

    const stageName = currentStage.name || `Stage ${stageIndex + 1}`
    const changes = []
    if (hasEta) changes.push(`end date → ${eta}`)
    if (hasStartDate) changes.push(`start date → ${startDate}`)
    if (hasResponsibleId) changes.push(`responsible → ${responsibleId || 'unassigned'}`)
    if (hasTotalUnits) changes.push(`target qty → ${parsedTotalUnits}`)
    if (hasDescription) changes.push('description updated')
    await AuditLog.create({
      byUser: req.user.id,
      action: 'Stage Dates Adjusted',
      detail: `${orderId}: Stage ${stageIndex + 1} (${stageName}) ${changes.join(', ')}`,
    })

    res.json(enrichOrder(order))
  } catch (err) {
    console.error('[orders]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/orders/:orderId/assignments/:mfrId/stages/:stageIndex/delete — remove one
// stage from an assignment's stage list (admin only). Shifts subsequent stage indices
// down by one, and re-points any evidence/PO documents that referenced a later stage.
// Refuses if the target stage itself has linked documents, to avoid silently orphaning
// evidence — remove those first.
router.post('/:orderId/assignments/:mfrId/stages/:stageIndex/delete', requireAuth, requireAdmin, updateLimiter, async (req, res) => {
  try {
    const { orderId, mfrId } = req.params
    if (!mongoose.Types.ObjectId.isValid(mfrId))
      return res.status(400).json({ error: 'Invalid manufacturer ID' })
    const mfrObjectId = new mongoose.Types.ObjectId(mfrId)
    const stageIndex = parseInt(req.params.stageIndex, 10)

    const existingOrder = await Order.findById(orderId).lean()
    if (!existingOrder) return res.status(404).json({ error: 'Order not found' })
    const existingAsgn = (existingOrder.assignments || []).find(a => a.mfrId?.toString() === mfrId)
    if (!existingAsgn) return res.status(404).json({ error: 'Assignment not found' })
    const stageCount = existingAsgn.stages?.length || 0
    if (isNaN(stageIndex) || stageIndex < 0 || stageIndex >= stageCount)
      return res.status(400).json({ error: `Invalid stage index (0–${stageCount - 1})` })
    if (stageCount <= 1)
      return res.status(400).json({ error: 'Cannot delete the only remaining stage' })

    const removedStage = existingAsgn.stages[stageIndex]

    const linkedDocs = await Document.countDocuments({ orderId, mfrId: mfrObjectId, stageIndex, isActive: true })
    if (linkedDocs > 0)
      return res.status(400).json({ error: `Cannot delete — ${linkedDocs} document(s) are linked to this stage. Remove those first.` })

    const newStages = existingAsgn.stages.filter((_, i) => i !== stageIndex)

    await Order.updateOne(
      { _id: orderId, 'assignments.mfrId': mfrObjectId },
      { $set: { 'assignments.$[asgn].stages': newStages, 'assignments.$[asgn].updatedAt': new Date() } },
      { arrayFilters: [{ 'asgn.mfrId': mfrObjectId }] }
    )

    // Documents linked to a later stage need their stageIndex shifted down to match.
    await Document.updateMany(
      { orderId, mfrId: mfrObjectId, isActive: true, stageIndex: { $gt: stageIndex } },
      { $inc: { stageIndex: -1 } }
    )

    const order = await Order.findById(orderId)
      .populate('buyerId', BUYER_FIELDS).populate('assignments.mfrId', MFR_FIELDS)
      .populate('assignments.stages.responsibleId', 'name company code role')
      .populate('assignments.stages.updates.byUser', 'name').lean()

    await AuditLog.create({
      byUser: req.user.id,
      action: 'Stage Deleted',
      detail: `${orderId}: removed stage "${removedStage.name}" (was stage ${stageIndex + 1})`,
    })

    res.json(enrichOrder(order))
  } catch (err) {
    console.error('[orders]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/orders/:orderId/assignments/:mfrId/stages/:stageIndex/updates — post a
// ticket-style progress note on a stage. Same permission boundary as the general
// stage-update route: admin always, or the manufacturer of this exact assignment.
router.post('/:orderId/assignments/:mfrId/stages/:stageIndex/updates', requireAuth, updateLimiter, async (req, res) => {
  try {
    const { orderId, mfrId } = req.params
    if (!mongoose.Types.ObjectId.isValid(mfrId))
      return res.status(400).json({ error: 'Invalid manufacturer ID' })
    const mfrObjectId = new mongoose.Types.ObjectId(mfrId)
    const stageIndex = parseInt(req.params.stageIndex, 10)
    const { text } = req.body

    if (req.user.role === 'buyer')
      return res.status(403).json({ error: 'Buyers cannot update production stages' })
    if (req.user.role === 'manufacturer' && String(req.user.id) !== String(mfrId))
      return res.status(403).json({ error: 'Forbidden' })
    if (!text?.trim()) return res.status(400).json({ error: 'Update text is required' })
    if (text.trim().length > 1000) return res.status(400).json({ error: 'Update too long (max 1000 characters)' })

    const existingOrder = await Order.findById(orderId).lean()
    if (!existingOrder) return res.status(404).json({ error: 'Order not found' })
    const existingAsgn = (existingOrder.assignments || []).find(a => a.mfrId?.toString() === mfrId)
    if (!existingAsgn) return res.status(404).json({ error: 'Assignment not found' })
    const stageCount = existingAsgn.stages?.length || 0
    if (isNaN(stageIndex) || stageIndex < 0 || stageIndex >= stageCount)
      return res.status(400).json({ error: `Invalid stage index (0–${stageCount - 1})` })

    const order = await Order.findOneAndUpdate(
      { _id: orderId, 'assignments.mfrId': mfrObjectId },
      { $push: { [`assignments.$[asgn].stages.${stageIndex}.updates`]: { text: text.trim(), byUser: req.user.id, at: new Date() } } },
      { arrayFilters: [{ 'asgn.mfrId': mfrObjectId }], new: true }
    ).populate('buyerId', BUYER_FIELDS).populate('assignments.mfrId', MFR_FIELDS).populate('assignments.stages.responsibleId', 'name company code role').populate('assignments.stages.updates.byUser', 'name').lean()

    if (!order) return res.status(404).json({ error: 'Order or assignment not found' })

    const stageName = existingAsgn.stages[stageIndex]?.name || `Stage ${stageIndex + 1}`
    await AuditLog.create({
      byUser: req.user.id,
      action: 'Stage Update Added',
      detail: `${orderId}: ${stageName} — ${text.trim().slice(0, 100)}`,
    })

    res.json(enrichOrder(order))
  } catch (err) {
    console.error('[orders]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/orders/:orderId/assignments/:mfrId/stages/:stageIndex/materials — add a
// materials/PO checklist line. Managed by any admin, or the stage's own responsible person.
router.post('/:orderId/assignments/:mfrId/stages/:stageIndex/materials', requireAuth, updateLimiter, async (req, res) => {
  try {
    const { orderId, mfrId } = req.params
    if (!mongoose.Types.ObjectId.isValid(mfrId))
      return res.status(400).json({ error: 'Invalid manufacturer ID' })
    const mfrObjectId = new mongoose.Types.ObjectId(mfrId)
    const stageIndex = parseInt(req.params.stageIndex, 10)
    const { name, requiredQty, unit, supplier, poNumber, expectedDate } = req.body

    if (!name?.trim()) return res.status(400).json({ error: 'Material name is required' })
    const reqQty = parseFloat(requiredQty)
    if (isNaN(reqQty) || reqQty < 0) return res.status(400).json({ error: 'Required quantity must be a non-negative number' })

    const existingOrder = await Order.findById(orderId).lean()
    if (!existingOrder) return res.status(404).json({ error: 'Order not found' })
    const existingAsgn = (existingOrder.assignments || []).find(a => a.mfrId?.toString() === mfrId)
    if (!existingAsgn) return res.status(404).json({ error: 'Assignment not found' })
    const stageCount = existingAsgn.stages?.length || 0
    if (isNaN(stageIndex) || stageIndex < 0 || stageIndex >= stageCount)
      return res.status(400).json({ error: `Invalid stage index (0–${stageCount - 1})` })

    const stage = existingAsgn.stages[stageIndex]
    const isResponsible = stage.responsibleId && String(stage.responsibleId) === String(req.user.id)
    if (req.user.role !== 'admin' && !isResponsible)
      return res.status(403).json({ error: "Only an admin or this stage's responsible person can manage materials" })

    const line = {
      name: name.trim().slice(0, 200), requiredQty: reqQty,
      unit: unit || '', supplier: supplier || '', poNumber: poNumber || '',
      expectedDate: expectedDate || null, status: 'pending', orderedQty: 0, receivedQty: 0, note: '',
    }

    const order = await Order.findOneAndUpdate(
      { _id: orderId, 'assignments.mfrId': mfrObjectId },
      { $push: { [`assignments.$[asgn].stages.${stageIndex}.materials`]: line } },
      { arrayFilters: [{ 'asgn.mfrId': mfrObjectId }], new: true }
    ).populate('buyerId', BUYER_FIELDS).populate('assignments.mfrId', MFR_FIELDS).populate('assignments.stages.responsibleId', 'name company code role').populate('assignments.stages.updates.byUser', 'name').lean()

    if (!order) return res.status(404).json({ error: 'Order or assignment not found' })

    await AuditLog.create({
      byUser: req.user.id,
      action: 'Stage Material Added',
      detail: `${orderId}: ${stage.name || `Stage ${stageIndex + 1}`} — added "${line.name}" (${line.requiredQty} ${line.unit})`,
    })

    res.json(enrichOrder(order))
  } catch (err) {
    console.error('[orders]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/orders/:orderId/assignments/:mfrId/stages/:stageIndex/materials/:lineIndex —
// update one materials line (status transitions, ordered/received qty, corrections).
router.post('/:orderId/assignments/:mfrId/stages/:stageIndex/materials/:lineIndex', requireAuth, updateLimiter, async (req, res) => {
  try {
    const { orderId, mfrId } = req.params
    if (!mongoose.Types.ObjectId.isValid(mfrId))
      return res.status(400).json({ error: 'Invalid manufacturer ID' })
    const mfrObjectId = new mongoose.Types.ObjectId(mfrId)
    const stageIndex = parseInt(req.params.stageIndex, 10)
    const lineIndex = parseInt(req.params.lineIndex, 10)
    const { name, requiredQty, unit, supplier, poNumber, expectedDate, status, orderedQty, receivedQty, note } = req.body

    const existingOrder = await Order.findById(orderId).lean()
    if (!existingOrder) return res.status(404).json({ error: 'Order not found' })
    const existingAsgn = (existingOrder.assignments || []).find(a => a.mfrId?.toString() === mfrId)
    if (!existingAsgn) return res.status(404).json({ error: 'Assignment not found' })
    const stageCount = existingAsgn.stages?.length || 0
    if (isNaN(stageIndex) || stageIndex < 0 || stageIndex >= stageCount)
      return res.status(400).json({ error: `Invalid stage index (0–${stageCount - 1})` })

    const stage = existingAsgn.stages[stageIndex]
    const isResponsible = stage.responsibleId && String(stage.responsibleId) === String(req.user.id)
    if (req.user.role !== 'admin' && !isResponsible)
      return res.status(403).json({ error: "Only an admin or this stage's responsible person can manage materials" })

    const lineCount = stage.materials?.length || 0
    if (isNaN(lineIndex) || lineIndex < 0 || lineIndex >= lineCount)
      return res.status(400).json({ error: `Invalid material line index (0–${lineCount - 1})` })

    if (status !== undefined && !['pending', 'ordered', 'received'].includes(status))
      return res.status(400).json({ error: 'Invalid status' })

    const prefix = `assignments.$[asgn].stages.${stageIndex}.materials.${lineIndex}`
    const setFields = {}
    if (name !== undefined) {
      if (!name.trim()) return res.status(400).json({ error: 'Material name is required' })
      setFields[`${prefix}.name`] = name.trim().slice(0, 200)
    }
    if (requiredQty !== undefined) {
      const q = parseFloat(requiredQty)
      if (isNaN(q) || q < 0) return res.status(400).json({ error: 'Required quantity must be a non-negative number' })
      setFields[`${prefix}.requiredQty`] = q
    }
    if (unit !== undefined) setFields[`${prefix}.unit`] = unit
    if (supplier !== undefined) setFields[`${prefix}.supplier`] = supplier
    if (poNumber !== undefined) setFields[`${prefix}.poNumber`] = poNumber
    if (expectedDate !== undefined) setFields[`${prefix}.expectedDate`] = expectedDate
    if (status !== undefined) setFields[`${prefix}.status`] = status
    if (orderedQty !== undefined) {
      const q = parseFloat(orderedQty)
      if (isNaN(q) || q < 0) return res.status(400).json({ error: 'Ordered quantity must be a non-negative number' })
      setFields[`${prefix}.orderedQty`] = q
    }
    if (receivedQty !== undefined) {
      const q = parseFloat(receivedQty)
      if (isNaN(q) || q < 0) return res.status(400).json({ error: 'Received quantity must be a non-negative number' })
      setFields[`${prefix}.receivedQty`] = q
    }
    if (note !== undefined) setFields[`${prefix}.note`] = note

    if (Object.keys(setFields).length === 0) return res.status(400).json({ error: 'No fields to update' })

    const order = await Order.findOneAndUpdate(
      { _id: orderId, 'assignments.mfrId': mfrObjectId },
      { $set: setFields },
      { arrayFilters: [{ 'asgn.mfrId': mfrObjectId }], new: true }
    ).populate('buyerId', BUYER_FIELDS).populate('assignments.mfrId', MFR_FIELDS).populate('assignments.stages.responsibleId', 'name company code role').populate('assignments.stages.updates.byUser', 'name').lean()

    if (!order) return res.status(404).json({ error: 'Order or assignment not found' })

    await AuditLog.create({
      byUser: req.user.id,
      action: 'Stage Material Updated',
      detail: `${orderId}: ${stage.name || `Stage ${stageIndex + 1}`} — "${stage.materials[lineIndex].name}"${status ? ` → ${status}` : ''}`,
    })

    res.json(enrichOrder(order))
  } catch (err) {
    console.error('[orders]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/orders/:orderId/assignments/:mfrId/stages/:stageIndex/materials/:lineIndex/delete
router.post('/:orderId/assignments/:mfrId/stages/:stageIndex/materials/:lineIndex/delete', requireAuth, updateLimiter, async (req, res) => {
  try {
    const { orderId, mfrId } = req.params
    if (!mongoose.Types.ObjectId.isValid(mfrId))
      return res.status(400).json({ error: 'Invalid manufacturer ID' })
    const mfrObjectId = new mongoose.Types.ObjectId(mfrId)
    const stageIndex = parseInt(req.params.stageIndex, 10)
    const lineIndex = parseInt(req.params.lineIndex, 10)

    const existingOrder = await Order.findById(orderId).lean()
    if (!existingOrder) return res.status(404).json({ error: 'Order not found' })
    const existingAsgn = (existingOrder.assignments || []).find(a => a.mfrId?.toString() === mfrId)
    if (!existingAsgn) return res.status(404).json({ error: 'Assignment not found' })
    const stageCount = existingAsgn.stages?.length || 0
    if (isNaN(stageIndex) || stageIndex < 0 || stageIndex >= stageCount)
      return res.status(400).json({ error: `Invalid stage index (0–${stageCount - 1})` })

    const stage = existingAsgn.stages[stageIndex]
    const isResponsible = stage.responsibleId && String(stage.responsibleId) === String(req.user.id)
    if (req.user.role !== 'admin' && !isResponsible)
      return res.status(403).json({ error: "Only an admin or this stage's responsible person can manage materials" })

    const lineCount = stage.materials?.length || 0
    if (isNaN(lineIndex) || lineIndex < 0 || lineIndex >= lineCount)
      return res.status(400).json({ error: `Invalid material line index (0–${lineCount - 1})` })

    const removedName = stage.materials[lineIndex].name

    // Remove-by-index: $unset leaves a null hole in the array, then $pull removes it —
    // the standard two-step Mongo pattern for deleting a specific array element by index.
    const unsetField = `assignments.$[asgn].stages.${stageIndex}.materials.${lineIndex}`
    await Order.updateOne(
      { _id: orderId, 'assignments.mfrId': mfrObjectId },
      { $unset: { [unsetField]: 1 } },
      { arrayFilters: [{ 'asgn.mfrId': mfrObjectId }] }
    )
    const pullField = `assignments.$[asgn].stages.${stageIndex}.materials`
    const order = await Order.findOneAndUpdate(
      { _id: orderId, 'assignments.mfrId': mfrObjectId },
      { $pull: { [pullField]: null } },
      { arrayFilters: [{ 'asgn.mfrId': mfrObjectId }], new: true }
    ).populate('buyerId', BUYER_FIELDS).populate('assignments.mfrId', MFR_FIELDS).populate('assignments.stages.responsibleId', 'name company code role').populate('assignments.stages.updates.byUser', 'name').lean()

    if (!order) return res.status(404).json({ error: 'Order or assignment not found' })

    await AuditLog.create({
      byUser: req.user.id,
      action: 'Stage Material Deleted',
      detail: `${orderId}: ${stage.name || `Stage ${stageIndex + 1}`} — removed "${removedName}"`,
    })

    res.json(enrichOrder(order))
  } catch (err) {
    console.error('[orders]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/orders/materials/bulk — CSV-driven bulk import of materials/PO lines onto
// existing orders' stages, keyed by orderId + manufacturer code + stage name. Decoupled
// from order creation — usable against any existing order at any time.
router.post('/materials/bulk', requireAuth, requireAdmin, materialsBulkLimiter, async (req, res) => {
  try {
    const { rows } = req.body
    if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'At least one row is required' })
    if (rows.length > 200) return res.status(400).json({ error: 'Too many rows (max 200 per bulk upload)' })

    const results = []
    let created = 0, failed = 0

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      try {
        const { orderId, mfrCode, stageName, name, requiredQty, unit, supplier, poNumber, expectedDate } = row
        if (!orderId || !mfrCode || !stageName || !name) {
          failed++; results.push({ row: i, success: false, error: 'orderId, mfrCode, stageName, and name are required' }); continue
        }
        const reqQty = parseFloat(requiredQty)
        if (isNaN(reqQty) || reqQty < 0) {
          failed++; results.push({ row: i, success: false, error: 'Required quantity must be a non-negative number' }); continue
        }

        const order = await Order.findById(orderId).lean()
        if (!order) { failed++; results.push({ row: i, success: false, error: `Order "${orderId}" not found` }); continue }

        const mfrUser = await User.findOne({ code: mfrCode, role: 'manufacturer' }, '_id').lean()
        if (!mfrUser) { failed++; results.push({ row: i, success: false, error: `Unknown manufacturer code "${mfrCode}"` }); continue }

        const asgn = (order.assignments || []).find(a => a.mfrId?.toString() === mfrUser._id.toString())
        if (!asgn) { failed++; results.push({ row: i, success: false, error: `Manufacturer "${mfrCode}" is not assigned to order "${orderId}"` }); continue }

        const stageIndex = (asgn.stages || []).findIndex(s => s.name?.toLowerCase() === String(stageName).toLowerCase())
        if (stageIndex === -1) { failed++; results.push({ row: i, success: false, error: `Stage "${stageName}" not found on this order/manufacturer` }); continue }

        const line = {
          name: String(name).trim().slice(0, 200), requiredQty: reqQty,
          unit: unit || '', supplier: supplier || '', poNumber: poNumber || '',
          expectedDate: expectedDate || null, status: 'pending', orderedQty: 0, receivedQty: 0, note: '',
        }
        await Order.updateOne(
          { _id: orderId, 'assignments.mfrId': mfrUser._id },
          { $push: { [`assignments.$[asgn].stages.${stageIndex}.materials`]: line } },
          { arrayFilters: [{ 'asgn.mfrId': mfrUser._id }] }
        )
        created++
        results.push({ row: i, success: true })
      } catch (err) {
        failed++
        results.push({ row: i, success: false, error: 'Server error creating this row' })
      }
    }

    await AuditLog.create({
      byUser: req.user.id,
      action: 'Bulk Materials Upload',
      detail: `Bulk materials upload: ${created} created, ${failed} failed`,
    })

    res.status(200).json({ total: rows.length, created, failed, results })
  } catch (err) {
    console.error('[orders materials bulk]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// PATCH /api/orders/:id — edit order top-level fields (admin only)
router.post('/:id', requireAuth, requireAdmin, updateLimiter, async (req, res) => {
  try {
    const { product, category, season, totalQty, delivery, imageDataUrl, imageUrl } = req.body
    const orderId = req.params.id

    const existing = await Order.findById(orderId).lean()
    if (!existing) return res.status(404).json({ error: 'Order not found' })

    const updates = {}

    if (product !== undefined) {
      if (typeof product !== 'string' || !product.trim()) return res.status(400).json({ error: 'Product name is required' })
      if (product.length > 300) return res.status(400).json({ error: 'Product name too long' })
      updates.product = product.trim()
    }

    if (category !== undefined) {
      if (typeof category === 'string' && category.length > 50) return res.status(400).json({ error: 'Category too long' })
      updates.category = category
    }

    if (season !== undefined) {
      if (!VALID_SEASONS.includes(season)) return res.status(400).json({ error: `Invalid season. Must be one of: ${VALID_SEASONS.join(', ')}` })
      updates.season = season
    }

    if (totalQty !== undefined) {
      const qty = parseInt(totalQty, 10)
      if (isNaN(qty) || qty < 1) return res.status(400).json({ error: 'Total quantity must be a positive number' })
      updates.totalQty = qty
    }

    if (delivery !== undefined) {
      const d = new Date(delivery)
      if (isNaN(d.getTime())) return res.status(400).json({ error: 'Invalid delivery date' })
      updates.delivery = d
    }

    // Photo: null/'' clears it, a value validates same as at creation. Only one of
    // imageDataUrl/imageUrl at a time.
    if (imageDataUrl !== undefined || imageUrl !== undefined) {
      const nextDataUrl = imageDataUrl !== undefined ? (imageDataUrl || null) : (existing.imageDataUrl || null)
      const nextUrl     = imageUrl !== undefined ? (imageUrl || null) : (existing.imageUrl || null)
      if (nextDataUrl && nextUrl) return res.status(400).json({ error: 'Provide either an uploaded photo or a link, not both' })
      if (nextDataUrl) {
        const m = /^data:(image\/jpeg|image\/jpg|image\/png);base64,(.+)$/.exec(nextDataUrl)
        if (!m) return res.status(400).json({ error: 'Photo must be a JPEG or PNG image' })
        if (m[2].length * 0.75 > MAX_PRODUCT_PHOTO_SIZE) return res.status(400).json({ error: 'Photo too large — keep it under 1MB' })
      }
      if (nextUrl) {
        if (nextUrl.trim().length > 2000) return res.status(400).json({ error: 'Image URL too long' })
        try { const u = new URL(nextUrl.trim()); if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error() }
        catch { return res.status(400).json({ error: 'Invalid image URL — must be a valid http(s) link' } )}
      }
      if (imageDataUrl !== undefined) updates.imageDataUrl = imageDataUrl || null
      if (imageUrl !== undefined) updates.imageUrl = imageUrl ? imageUrl.trim() : null
    }

    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No fields to update' })

    const order = await Order.findByIdAndUpdate(
      orderId,
      { $set: updates },
      { new: true }
    ).populate('buyerId', BUYER_FIELDS).populate('assignments.mfrId', MFR_FIELDS).populate('assignments.stages.responsibleId', 'name company code role').populate('assignments.stages.updates.byUser', 'name').lean()

    if (!order) return res.status(404).json({ error: 'Order not found' })

    const changedFields = Object.keys(updates).join(', ')
    await AuditLog.create({
      byUser: req.user.id,
      action: 'Order Edited',
      detail: `${orderId}: updated ${changedFields} by ${req.user.name}`,
    })

    res.json(enrichOrder(order))
  } catch (err) {
    console.error('[orders]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// DELETE /api/orders/:id — delete order (admin only)
router.post('/:id/delete', requireAuth, requireAdmin, async (req, res) => {
  try {
    const orderId = req.params.id
    const order = await Order.findById(orderId).lean()
    if (!order) return res.status(404).json({ error: 'Order not found' })

    await Order.findByIdAndDelete(orderId)

    await AuditLog.create({
      byUser: req.user.id,
      action: 'Order Deleted',
      detail: `${orderId} (${order.product}) deleted by ${req.user.name}`,
    })

    res.json({ ok: true })
  } catch (err) {
    console.error('[orders]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/orders/:id/escalate — buyer escalates an order to master admins
router.post('/:id/escalate', requireAuth, escalationLimiter, async (req, res) => {
  try {
    if (req.user.role !== 'buyer')
      return res.status(403).json({ error: 'Only buyers can escalate orders' })

    const order = await Order.findById(req.params.id).lean()
    if (!order) return res.status(404).json({ error: 'Order not found' })
    if (String(order.buyerId) !== req.user.id)
      return res.status(403).json({ error: 'Forbidden' })

    const { reason } = req.body
    if (!reason?.trim()) return res.status(400).json({ error: 'Escalation reason is required' })
    if (reason.length > 1000) return res.status(400).json({ error: 'Escalation reason too long (max 1000 characters)' })

    const masters = await User.find({ role: 'admin', adminType: 'master', isActive: true }, '_id email name')
    if (masters.length === 0) return res.status(500).json({ error: 'No master admins available' })

    const msg = `Escalation from ${req.user.name} (${req.user.company}): Order ${req.params.id} — ${reason.trim()}`

    await Notification.insertMany(
      masters.map(m => ({ toUser: m._id, type: 'alert', msg, orderId: req.params.id, isRead: false }))
    )

    await AuditLog.create({
      byUser: req.user.id,
      action: 'Order Escalated',
      detail: `${req.user.name} escalated order ${req.params.id}: ${reason.trim()}`,
    })

    res.json({ ok: true, notified: masters.length })
  } catch (err) {
    console.error('[orders]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

export default router
