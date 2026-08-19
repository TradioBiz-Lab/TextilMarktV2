import mongoose from 'mongoose'
import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { Order } from '../db/index.js'
import { User }         from '../models/User.js'
import { Notification } from '../models/Notification.js'
import { AuditLog }     from '../models/AuditLog.js'
import { MasterOrder }  from '../models/MasterOrder.js'
import { Document }     from '../models/Document.js'
import { InventoryMovement } from '../models/InventoryMovement.js'
import { CostSheet } from '../models/CostSheet.js'
import { MaterialRequirement } from '../models/MaterialRequirement.js'
import {
  DEFAULT_STAGE_NAMES, ORDER_STATUS_VALUES, STAGE_KINDS, STAGE_STATUS_VALUES,
  stageKindOf, deriveStageStatus, mirroredUnits, stageEtaVarianceDays, deriveActualEnd, deliveryVarianceDays,
} from '../models/Order.js'
import { dayNumber, getToday } from '../lib/stageMath.js'
import { captureConsumptionOnDelivery } from '../lib/consumptionCapture.js'

// Categories are now free-text — no validation needed
const VALID_SEASONS    = ['SS26', 'FW26', 'SS27', 'FW27', 'SS28']
const MAX_PRODUCT_PHOTO_SIZE = 1024 * 1024 // 1MB raw — reference thumbnail, not full-res
import { requireAuth, requireAdmin } from '../middleware/auth.js'
// Email triggers for orders are intentionally suppressed — order activity is portal-notifications only

// Rate limits are real behaviour, not test behaviour — a suite that writes 200
// stages would trip updateLimiter (120/hr) and fail for a reason it isn't
// asserting. Bypass only under NODE_ENV=test.
const skipInTest = () => process.env.NODE_ENV === 'test'

// 60 order creations per admin per hour — prevents runaway scripting
const createOrderLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 60,
  keyGenerator: req => req.user?.id || req.ip,
  message: { error: 'Too many order creation requests. Please wait.' },
  standardHeaders: true, legacyHeaders: false, validate: false, skip: skipInTest,
})

// 10 bulk (CSV) order-creation requests per admin per hour — separate from the
// per-order limiter above since one bulk request creates many orders at once
const bulkOrderLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 10,
  keyGenerator: req => req.user?.id || req.ip,
  message: { error: 'Too many bulk upload requests. Please wait.' },
  standardHeaders: true, legacyHeaders: false, validate: false, skip: skipInTest,
})

// 30 materials-bulk-upload requests per admin per hour
const materialsBulkLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 30,
  keyGenerator: req => req.user?.id || req.ip,
  message: { error: 'Too many bulk materials upload requests. Please wait.' },
  standardHeaders: true, legacyHeaders: false, validate: false, skip: skipInTest,
})

// 120 stage/status patches per user per hour. Kriyaa's write tools loop back
// through these same routes carrying the admin's own session cookie (see
// assistant.js's loopbackFetch), so without a split, heavy AI-driven editing
// would exhaust the same bucket the admin's own manual UI edits draw from
// and lock them out of their own dashboard. The X-Kriyaa-Loopback header,
// set only by that internal loopback call, buckets Kriyaa's traffic
// separately per admin so the two can never contend for the same 120/hr.
const updateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 120,
  keyGenerator: req => {
    const base = req.user?.id || req.ip
    return req.headers['x-kriyaa-loopback'] ? `${base}:kriyaa` : base
  },
  message: { error: 'Too many update requests. Please wait.' },
  standardHeaders: true, legacyHeaders: false, validate: false, skip: skipInTest,
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
  skip: skipInTest,
})

const router = Router()
const MFR_FIELDS = 'name company code'
const BUYER_FIELDS = 'name company code'

// Who may be a stage's accountable owner. Buyers are included because real TNA
// plans assign the approval steps (lab dip, FPT/PP/GPT, final inspection) to the
// buyer — roughly a third of the plan. Being responsible grants a deliberately
// narrow write: the stage's own status and an update comment, nothing else.
// See buyerMayWriteStage() and the explicit denies on the materials routes.
const RESPONSIBLE_ROLES = ['admin', 'manufacturer', 'buyer']

/**
 * The one exception to "buyers can never write stage fields" (BRD §3).
 * Scoped to stages the buyer is the responsibleId of, and — at the call sites —
 * to `status`, `blocked` and update comments. Never dates, units, materials,
 * responsibility, or order status.
 */
const buyerMayWriteStage = (user, stage) =>
  user.role === 'buyer' && !!stage?.responsibleId && String(stage.responsibleId) === String(user.id)

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
  baselineDelivery: o.baselineDelivery || null,
  deliveryVarianceDays: deliveryVarianceDays(o),
  colourways: (o.colourways || []).map(c => ({ name: c.name, code: c.code || '' })),
  callout: o.callout || '',
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
          // Legacy stages carry none of these — resolved here (the only
          // serialization point) rather than by migrating live documents.
          kind:   stageKindOf(s),
          status: deriveStageStatus(s),
          blocked: !!s.blocked,
          blockedReason: s.blockedReason || '',
          // Falls back to eta so a stage that predates the field reads as zero
          // slippage; the /eta route captures the real baseline on first revision.
          baselineEta: s.baselineEta ?? s.eta ?? null,
          etaVarianceDays: stageEtaVarianceDays({ baselineEta: s.baselineEta ?? s.eta, eta: s.eta }),
          // When the stage actually finished — null until status reaches 'done'.
          actualEnd: s.actualEnd || null,
          items: (s.items || []).map(it => ({
            name: it.name, colourway: it.colourway || '', status: it.status,
            plannedDate: it.plannedDate ?? it.dueDate ?? null,
            dueDate: it.dueDate || null, doneDate: it.doneDate || null, note: it.note || '',
          })),
          itemsDone: (s.items || []).filter(it => it.status === 'done').length,
          itemsTotal: (s.items || []).length,
          updates: (s.updates || []).map(u => ({
            text: u.text,
            byUser: u.byUser?._id?.toString() ?? u.byUser?.toString(),
            byUserName: u.byUser?.name ?? null,
            at: u.at,
          })),
          materials: (s.materials || []).map(m => ({
            id: m._id?.toString() ?? null,
            name: m.name, category: m.category || 'other', colourway: m.colourway || '',
            requiredQty: m.requiredQty, unit: m.unit, supplier: m.supplier,
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
async function validateAndCreateOrder({ id, buyerId, product, category, season, totalQty, delivery, createdAt, masterOrderId, assignments: asgns, stageEtas, stageStartDates, stageNames: customStages, stageResponsibleIds, stageDescriptions, stageTotalUnits, stageKinds, colourways, callout, imageDataUrl, imageUrl }) {
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
        if (!u || !RESPONSIBLE_ROLES.includes(u.role))
          return { ok: false, error: `Responsible person for stage "${stages[i]}" must be an admin, manufacturer, or buyer` }
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

  // Optional per-stage kind. Absent means 'quantity' — identical to how every
  // order behaved before this field existed. Deliberately NOT inferred from
  // whether stageTotalUnits was supplied: the single-order form sends no target
  // quantities at all, so inference would silently make every form-created order
  // all-milestone. One rule, no inference.
  const stageKindsResolved = stages.map(() => 'quantity')
  if (Array.isArray(stageKinds)) {
    for (let i = 0; i < stages.length; i++) {
      const k = stageKinds[i]
      if (k === undefined || k === null || k === '') continue
      if (!STAGE_KINDS.includes(k)) return { ok: false, error: `Invalid kind "${k}" for stage "${stages[i]}" — must be one of: ${STAGE_KINDS.join(', ')}` }
      stageKindsResolved[i] = k
    }
  }

  // Optional colourway list — names the per-colour stages generate their
  // checklist items from.
  const colourwaysResolved = []
  if (Array.isArray(colourways)) {
    for (const c of colourways) {
      const name = (typeof c === 'string' ? c : c?.name || '').trim()
      if (!name) continue
      if (name.length > 60) return { ok: false, error: `Colourway name too long: "${name.slice(0, 20)}…"` }
      if (colourwaysResolved.some(x => x.name.toLowerCase() === name.toLowerCase())) continue
      colourwaysResolved.push({ name, code: (typeof c === 'object' && c?.code ? String(c.code).trim() : '') })
    }
    if (colourwaysResolved.length > 40) return { ok: false, error: 'Too many colourways (max 40)' }
  }

  if (callout !== undefined && callout !== null) {
    if (typeof callout !== 'string') return { ok: false, error: 'Callout must be text' }
    if (callout.trim().length > 500) return { ok: false, error: 'Callout too long (max 500 characters)' }
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
      baselineDelivery: new Date(delivery),
      colourways: colourwaysResolved,
      callout: callout ? callout.trim() : '',
      createdAt: createdAt ? new Date(createdAt) : undefined,
      assignments: asgns.map((a, i) => ({
        mfrId: a.mid, qty: a.qty, status: 'Processing',
        sub: a.sub || `M${i + 1}`, note: '',
        stages: stages.map((name, si) => {
          const kind = stageKindsResolved[si]
          // A milestone or checklist stage has no meaningful garment count, so it
          // defaults to a target of 1 rather than the assignment quantity — the
          // old default is what produced "0 / 10,800 units" on a lab-dip step.
          // It must never be 0: the "first incomplete stage" predicate that five
          // frontend surfaces rely on is `unitsDone < totalUnits`, and 0 < 0 is
          // false, which would read the stage as permanently complete.
          const fallbackTotal = kind === 'quantity' ? a.qty : 1
          return {
            name, unitsDone: 0,
            totalUnits: stageTotalUnitsResolved[si] ?? fallbackTotal,
            startDate: startDates[si] || null, eta: etas[si] || null, note: '',
            // Baseline is frozen at creation; `eta` is the one that moves.
            baselineEta: etas[si] || null,
            kind, status: 'not_started', blocked: false, blockedReason: '',
            description: stageDescriptionsResolved[si] || '',
            responsibleId: stageResponsibleIdsResolved[si] || null,
          }
        }),
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

    // Phase 4 of the Materials Management + Costing Engine plan — the
    // consumption-moat capture. Idempotent (upsert-keyed), so re-marking
    // Delivered never duplicates a row; a no-op if no cost sheet exists yet.
    // Awaited (not fire-and-forget) so the write is guaranteed done before
    // this response returns; wrapped so a capture failure never fails the
    // status update itself — it's a best-effort side effect, not the point
    // of this request.
    if (status === 'Delivered') {
      try { await captureConsumptionOnDelivery(orderId, mfrId) }
      catch (err) { console.error('[consumptionCapture]', err) }
    }

    res.json(enrichOrder(order))
  } catch (err) {
    console.error('[orders]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/orders/:orderId/assignments/:mfrId/stages/bulk — update many stages in one write.
//
// MUST stay registered ABOVE the /:stageIndex route below: Express matches in
// declaration order, so the other route would otherwise capture this path with
// stageIndex = 'bulk' → NaN → a misleading "Invalid stage index".
//
// This is what makes the daily-update grid viable. It also fixes a reachable
// failure: the previous approach fired one request per changed stage, and
// updateLimiter allows 120/hr/user — two bulk edits on a 27-stage order plus an
// apply-to-siblings run exhausts it. Progress on quantity stages deliberately
// stays on the single-stage route, where the materials gate lives.
const BULK_STAGE_MAX = 50
router.post('/:orderId/assignments/:mfrId/stages/bulk', requireAuth, updateLimiter, async (req, res) => {
  try {
    const { orderId, mfrId } = req.params
    if (!mongoose.Types.ObjectId.isValid(mfrId))
      return res.status(400).json({ error: 'Invalid manufacturer ID' })
    const mfrObjectId = new mongoose.Types.ObjectId(mfrId)

    const { stages: rows } = req.body
    if (!Array.isArray(rows) || rows.length === 0)
      return res.status(400).json({ error: 'Provide a non-empty stages array' })
    if (rows.length > BULK_STAGE_MAX)
      return res.status(400).json({ error: `Too many stages in one request (max ${BULK_STAGE_MAX})` })

    if (req.user.role === 'manufacturer' && String(req.user.id) !== String(mfrId))
      return res.status(403).json({ error: 'Forbidden' })

    const existingOrder = await Order.findById(orderId).lean()
    if (!existingOrder) return res.status(404).json({ error: 'Order not found' })
    const existingAsgn = (existingOrder.assignments || []).find(a => a.mfrId?.toString() === mfrId)
    if (!existingAsgn) return res.status(404).json({ error: 'Assignment not found' })
    const allStages = existingAsgn.stages || []

    const seen = new Set()
    const setFields = { 'assignments.$[asgn].updatedAt': new Date() }
    const touched = []

    // Validate EVERY row before writing ANY. All-or-nothing is the point: the
    // old serial loop could fail on stage 14 and leave 13 saved.
    for (const row of rows) {
      const i = parseInt(row?.index, 10)
      if (isNaN(i) || i < 0 || i >= allStages.length)
        return res.status(400).json({ error: `Invalid stage index ${row?.index} (0–${allStages.length - 1})` })
      if (seen.has(i))
        return res.status(400).json({ error: `Duplicate entry for stage index ${i}` })
      seen.add(i)

      const stage = allStages[i]
      const kind = row.kind ?? stageKindOf(stage)
      const has = k => Object.prototype.hasOwnProperty.call(row, k)
      const p = f => `assignments.$[asgn].stages.${i}.${f}`

      if (req.user.role === 'buyer') {
        if (!buyerMayWriteStage(req.user, stage))
          return res.status(403).json({ error: `Forbidden on stage ${i + 1} — buyers may only update stages they own` })
        const attempted = Object.keys(row).filter(k => !['index', 'status', 'blocked', 'blockedReason'].includes(k))
        if (attempted.length)
          return res.status(403).json({ error: `Buyers may only set status (not: ${attempted.join(', ')})` })
      }

      if (has('kind')) {
        if (!STAGE_KINDS.includes(row.kind))
          return res.status(400).json({ error: `Invalid kind "${row.kind}" on stage ${i + 1}` })
        setFields[p('kind')] = row.kind
      }

      if (has('totalUnits')) {
        const t = parseInt(row.totalUnits, 10)
        if (isNaN(t) || t < 1) return res.status(400).json({ error: `Target quantity on stage ${i + 1} must be a positive number` })
        if (t < (stage.unitsDone || 0)) return res.status(400).json({ error: `Target quantity on stage ${i + 1} cannot be below units already completed (${stage.unitsDone})` })
        setFields[p('totalUnits')] = t
      }

      if (has('responsibleId')) {
        if (row.responsibleId) {
          if (!mongoose.Types.ObjectId.isValid(row.responsibleId))
            return res.status(400).json({ error: `Invalid responsible person ID on stage ${i + 1}` })
          const u = await User.findById(row.responsibleId, 'role isActive').lean()
          if (!u || !RESPONSIBLE_ROLES.includes(u.role))
            return res.status(400).json({ error: `Responsible person on stage ${i + 1} must be an admin, manufacturer, or buyer` })
          if (!u.isActive) return res.status(400).json({ error: `Responsible person on stage ${i + 1} is inactive` })
        }
        setFields[p('responsibleId')] = row.responsibleId || null
      }

      if (has('description')) {
        const d = String(row.description ?? '').trim()
        if (d.length > 1000) return res.status(400).json({ error: `Description on stage ${i + 1} is too long (max 1000 characters)` })
        setFields[p('description')] = d
      }

      if (has('blocked')) setFields[p('blocked')] = !!row.blocked
      if (has('blockedReason')) {
        const r = String(row.blockedReason ?? '').trim()
        if (r.length > 300) return res.status(400).json({ error: `Blocked reason on stage ${i + 1} is too long (max 300 characters)` })
        setFields[p('blockedReason')] = r
      }

      // Dates: same rules as the single-stage /eta route, including the
      // baseline capture on first revision.
      const badDate = (label, v) => {
        if (v === null || v === undefined || v === '') return `${label} on stage ${i + 1} cannot be blank — use "NA"`
        if (v !== 'NA' && isNaN(new Date(v).getTime())) return `Invalid ${label} on stage ${i + 1}`
        return null
      }
      if (has('eta')) {
        const err = badDate('end date', row.eta); if (err) return res.status(400).json({ error: err })
      }
      if (has('startDate')) {
        const err = badDate('start date', row.startDate); if (err) return res.status(400).json({ error: err })
      }
      const effStart = has('startDate') ? row.startDate : stage.startDate
      const effEnd = has('eta') ? row.eta : stage.eta
      if (effStart && effEnd && effStart !== 'NA' && effEnd !== 'NA' && new Date(effStart) > new Date(effEnd))
        return res.status(400).json({ error: `Stage ${i + 1}: start date must be on or before the end date` })
      if (has('startDate')) setFields[p('startDate')] = row.startDate
      if (has('eta')) {
        setFields[p('eta')] = row.eta
        if (row.eta !== stage.eta && !stage.baselineEta) setFields[p('baselineEta')] = stage.eta ?? row.eta
      }

      // Backdating — "it actually finished on the 3rd" — same rule as the
      // single-stage route: only meaningful alongside status: 'done' below,
      // harmless (and ignored) otherwise.
      if (has('actualEnd')) {
        if (typeof row.actualEnd !== 'string' || isNaN(new Date(row.actualEnd).getTime()))
          return res.status(400).json({ error: `Invalid actual completion date on stage ${i + 1}` })
        if (dayNumber(row.actualEnd) > dayNumber(getToday()))
          return res.status(400).json({ error: `Actual completion date on stage ${i + 1} cannot be in the future` })
      }

      if (has('status')) {
        if (!STAGE_STATUS_VALUES.includes(row.status))
          return res.status(400).json({ error: `Invalid status "${row.status}" on stage ${i + 1}` })
        if (kind === 'quantity')
          return res.status(400).json({ error: `Stage ${i + 1} tracks units — update its progress from the stage itself, not here` })
        // Checklist full-close gate: the stage can't say done while its own
        // items say otherwise. No override.
        if (kind === 'checklist' && row.status === 'done') {
          const items = stage.items || []
          const pendingItems = items.filter(it => it.status !== 'done')
          if (pendingItems.length > 0)
            return res.status(400).json({ error: `Stage ${i + 1}: cannot mark done — ${pendingItems.length} of ${items.length} checklist item(s) still pending` })
        }
        const nextUnits = mirroredUnits(row.status, has('totalUnits') ? parseInt(row.totalUnits, 10) : (stage.totalUnits ?? 0))
        // The mirror raises unitsDone, so the materials gate must apply here too.
        const isTrims = (stage.name || '').trim().toLowerCase() === 'trims order'
        const pending = (stage.materials || []).filter(m => isTrims ? m.status === 'pending' : m.status !== 'received')
        if (pending.length > 0 && nextUnits > (stage.unitsDone || 0))
          return res.status(400).json({ error: `Stage ${i + 1}: cannot advance — ${pending.length} material(s) still pending${isTrims ? '' : '/ordered'}` })
        setFields[p('status')] = row.status
        setFields[p('unitsDone')] = nextUnits
        setFields[p('actualEnd')] = deriveActualEnd(row.status, stage.actualEnd, has('actualEnd') ? row.actualEnd : undefined)
      } else if (has('kind') && row.kind !== 'quantity') {
        // Kind flipped without an explicit status — re-derive so the two can't disagree.
        const s = deriveStageStatus(stage)
        if (row.kind === 'checklist' && s === 'done') {
          const items = stage.items || []
          const pendingItems = items.filter(it => it.status !== 'done')
          if (pendingItems.length > 0)
            return res.status(400).json({ error: `Stage ${i + 1}: cannot mark done — ${pendingItems.length} of ${items.length} checklist item(s) still pending` })
        }
        setFields[p('status')] = s
        setFields[p('unitsDone')] = mirroredUnits(s, has('totalUnits') ? parseInt(row.totalUnits, 10) : (stage.totalUnits ?? 0))
        setFields[p('actualEnd')] = deriveActualEnd(s, stage.actualEnd)
      }

      touched.push(i)
    }

    // One atomic write — single-document updates are atomic in MongoDB.
    const order = await Order.findOneAndUpdate(
      { _id: orderId, 'assignments.mfrId': mfrObjectId },
      { $set: setFields },
      { arrayFilters: [{ 'asgn.mfrId': mfrObjectId }], new: true }
    ).populate('buyerId', BUYER_FIELDS).populate('assignments.mfrId', MFR_FIELDS).populate('assignments.stages.responsibleId', 'name company code role').populate('assignments.stages.updates.byUser', 'name').lean()

    if (!order) return res.status(404).json({ error: 'Order or assignment not found' })

    // One audit entry summarizing the batch, not one per stage.
    await AuditLog.create({
      byUser: req.user.id,
      action: 'Stages Bulk Updated',
      detail: `${orderId}: ${touched.length} stage(s) updated by ${req.user.name} [${touched.map(i => i + 1).join(', ')}]`,
    })

    res.json({ ...enrichOrder(order, req.user.role === 'manufacturer' ? String(req.user.id) : null), updated: touched.length })
  } catch (err) {
    console.error('[orders]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/orders/:orderId/assignments/:mfrId/stages/insert — insert a new stage
// into an already-created order's plan (admin only). The stage list is otherwise
// fixed at creation — this is the one way to add a step later (e.g. a TNA
// revision adds "Fit Sample" that wasn't in the original plan). Registered above
// the generic /stages/:stageIndex route, same reason /stages/bulk is: Express
// would otherwise match "insert" as a stageIndex and 400 on the parseInt.
router.post('/:orderId/assignments/:mfrId/stages/insert', requireAuth, requireAdmin, updateLimiter, async (req, res) => {
  try {
    const { orderId, mfrId } = req.params
    if (!mongoose.Types.ObjectId.isValid(mfrId))
      return res.status(400).json({ error: 'Invalid manufacturer ID' })
    const mfrObjectId = new mongoose.Types.ObjectId(mfrId)

    const { name, kind, totalUnits, startDate, eta, description, responsibleId, status, actualEnd } = req.body
    if (!name?.trim()) return res.status(400).json({ error: 'Stage name is required' })
    if (kind !== undefined && kind !== null && !STAGE_KINDS.includes(kind))
      return res.status(400).json({ error: `Invalid kind — must be one of: ${STAGE_KINDS.join(', ')}` })
    const resolvedKind = kind || 'quantity'
    if (status !== undefined && status !== null && !STAGE_STATUS_VALUES.includes(status))
      return res.status(400).json({ error: `Invalid status — must be one of: ${STAGE_STATUS_VALUES.join(', ')}` })

    // Same date rules as creation and /eta: a real date or literal "NA", never blank.
    const invalidDateMsg = (label, val) => {
      if (val === null || val === undefined || val === '') return `${label} cannot be blank — use "NA" if it doesn't apply`
      if (val !== 'NA' && isNaN(new Date(val).getTime())) return `Invalid ${label} — must be a date or "NA"`
      return null
    }
    let dateErr = invalidDateMsg('start date', startDate)
    if (dateErr) return res.status(400).json({ error: dateErr })
    dateErr = invalidDateMsg('end date', eta)
    if (dateErr) return res.status(400).json({ error: dateErr })
    if (startDate !== 'NA' && eta !== 'NA' && new Date(startDate) > new Date(eta))
      return res.status(400).json({ error: 'Start date must be on or before the end date' })

    let resolvedResponsibleId = null
    if (responsibleId) {
      if (!mongoose.Types.ObjectId.isValid(responsibleId))
        return res.status(400).json({ error: 'Invalid responsible person ID' })
      const u = await User.findById(responsibleId, 'role isActive').lean()
      if (!u || !RESPONSIBLE_ROLES.includes(u.role))
        return res.status(400).json({ error: 'Responsible person must be an admin, manufacturer, or buyer' })
      if (!u.isActive) return res.status(400).json({ error: 'Responsible person is inactive' })
      resolvedResponsibleId = responsibleId
    }

    const existingOrder = await Order.findById(orderId).lean()
    if (!existingOrder) return res.status(404).json({ error: 'Order not found' })
    const existingAsgn = (existingOrder.assignments || []).find(a => a.mfrId?.toString() === mfrId)
    if (!existingAsgn) return res.status(404).json({ error: 'Assignment not found' })
    const stages = existingAsgn.stages || []
    if (stages.length >= 50)
      return res.status(400).json({ error: 'This order already has the maximum of 50 stages' })

    const index = req.body.index === undefined || req.body.index === null ? stages.length : parseInt(req.body.index, 10)
    if (isNaN(index) || index < 0 || index > stages.length)
      return res.status(400).json({ error: `Invalid insert position (0–${stages.length})` })

    const resolvedTotalUnits = totalUnits != null
      ? parseInt(totalUnits, 10)
      : (resolvedKind === 'quantity' ? (existingAsgn.qty || 1) : 1)
    if (isNaN(resolvedTotalUnits) || resolvedTotalUnits < 1)
      return res.status(400).json({ error: 'Target quantity must be a positive number' })

    // A new stage can be inserted already-closed (e.g. a TNA revision adds a step
    // that, per the buyer's own tracker, already happened). If status isn't
    // 'done', actualEnd is never taken from the request — it's always derived.
    const resolvedStatus = status || 'not_started'
    const resolvedActualEnd = resolvedStatus === 'done' ? (actualEnd || new Date().toISOString().slice(0, 10)) : null
    const resolvedUnitsDone = mirroredUnits(resolvedStatus, resolvedTotalUnits)

    const newStage = {
      name: name.trim(), unitsDone: resolvedUnitsDone, totalUnits: resolvedTotalUnits,
      startDate, eta, baselineEta: eta, stageDate: null, note: '',
      description: (description || '').trim(), responsibleId: resolvedResponsibleId,
      kind: resolvedKind, status: resolvedStatus, blocked: false, blockedReason: '',
      updates: [], materials: [], items: [], actualEnd: resolvedActualEnd,
    }

    // Same landmine as the delete route below: this is a whole-array $set from a
    // .lean() read, so every existing stage must have its legacy fields resolved
    // explicitly rather than left to Mongoose's cast-time defaults.
    const normalizedExisting = stages.map(s => ({
      ...s,
      kind: stageKindOf(s),
      status: deriveStageStatus(s),
      blocked: !!s.blocked,
      blockedReason: s.blockedReason || '',
      baselineEta: s.baselineEta ?? s.eta ?? null,
    }))
    const newStages = [...normalizedExisting.slice(0, index), newStage, ...normalizedExisting.slice(index)]

    await Order.updateOne(
      { _id: orderId, 'assignments.mfrId': mfrObjectId },
      { $set: { 'assignments.$[asgn].stages': newStages, 'assignments.$[asgn].updatedAt': new Date() } },
      { arrayFilters: [{ 'asgn.mfrId': mfrObjectId }] }
    )

    // Documents linked to a stage at/after the insertion point shift up to match.
    await Document.updateMany(
      { orderId, mfrId: mfrObjectId, isActive: true, stageIndex: { $gte: index } },
      { $inc: { stageIndex: 1 } }
    )

    const order = await Order.findById(orderId)
      .populate('buyerId', BUYER_FIELDS).populate('assignments.mfrId', MFR_FIELDS)
      .populate('assignments.stages.responsibleId', 'name company code role')
      .populate('assignments.stages.updates.byUser', 'name').lean()

    await AuditLog.create({
      byUser: req.user.id,
      action: 'Stage Inserted',
      detail: `${orderId}: added stage "${newStage.name}" at position ${index + 1} by ${req.user.name}`,
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
    const { unitsDone, note, eta, startDate, stageDate, status, blocked, blockedReason, override, actualEnd } = req.body
    const has = k => Object.prototype.hasOwnProperty.call(req.body, k)
    const hasEta = has('eta')
    const hasStartDate = has('startDate')
    const hasActualEnd = has('actualEnd')
    const isMasterOverride = override === true

    if (req.user.role === 'manufacturer' && String(req.user.id) !== String(mfrId))
      return res.status(403).json({ error: 'Forbidden' })
    if (isMasterOverride && !(req.user.role === 'admin' && req.user.adminType === 'master'))
      return res.status(403).json({ error: 'Only master admin can override a stage' })
    if (note !== undefined && note !== null && typeof note === 'string' && note.length > 1000)
      return res.status(400).json({ error: 'Note too long (max 1000 characters)' })
    // Backdating a completion date — "mark it done, it actually finished on
    // the 3rd." Only meaningful alongside a done-transition; if the stage
    // isn't ending up 'done' in this request, resolvedActualEnd below is null
    // regardless, same as if this were never sent.
    if (hasActualEnd) {
      if (typeof actualEnd !== 'string' || isNaN(new Date(actualEnd).getTime()))
        return res.status(400).json({ error: 'Invalid actual completion date' })
      if (dayNumber(actualEnd) > dayNumber(getToday()))
        return res.status(400).json({ error: 'Actual completion date cannot be in the future' })
    }

    const existingOrder = await Order.findById(orderId).lean()
    if (!existingOrder) return res.status(404).json({ error: 'Order not found' })
    const existingAsgn = (existingOrder.assignments || []).find(a => a.mfrId?.toString() === mfrId)
    if (!existingAsgn) return res.status(404).json({ error: 'Assignment not found' })

    const stageCount = existingAsgn.stages?.length || 0
    if (isNaN(stageIndex) || stageIndex < 0 || stageIndex >= stageCount)
      return res.status(400).json({ error: `Invalid stage index (0–${stageCount - 1})` })

    const stage = existingAsgn.stages[stageIndex]
    const kind = stageKindOf(stage)
    const totalUnits = stage.totalUnits ?? 0
    const currentUnits = stage.unitsDone || 0

    // BRD §3 carve-out: buyers own the approval steps in a real TNA, so a buyer
    // who is this stage's responsibleId may set its status and blocked flag —
    // and nothing else. Every other buyer write stays forbidden.
    if (req.user.role === 'buyer') {
      if (!buyerMayWriteStage(req.user, stage))
        return res.status(403).json({ error: 'Buyers cannot update production stages' })
      const BUYER_WRITABLE = new Set(['status', 'blocked', 'blockedReason'])
      const attempted = Object.keys(req.body).filter(k => !BUYER_WRITABLE.has(k))
      if (attempted.length)
        return res.status(403).json({ error: `Buyers may only set status on a stage they own (not: ${attempted.join(', ')})` })
    }

    if (has('status') && !STAGE_STATUS_VALUES.includes(status))
      return res.status(400).json({ error: `Invalid status — must be one of: ${STAGE_STATUS_VALUES.join(', ')}` })
    if (blockedReason !== undefined && blockedReason !== null && String(blockedReason).length > 300)
      return res.status(400).json({ error: 'Blocked reason too long (max 300 characters)' })

    // Resolve status and unitsDone together, so they can never disagree.
    //   quantity  → units are authoritative, status is derived from them
    //   otherwise → status is authoritative, units mirror it
    // The mirror is what lets the five frontend "first incomplete stage"
    // derivations (`unitsDone < totalUnits`) keep working unchanged.
    let nextStatus
    let nextUnits
    if (kind === 'quantity') {
      // A write that doesn't mention units (flagging blocked, adding a note)
      // holds the current progress rather than being rejected for omitting it.
      if (!has('unitsDone')) {
        nextUnits = currentUnits
        nextStatus = deriveStageStatus({ unitsDone: currentUnits, totalUnits })
      } else {
        const parsedUnits = parseInt(unitsDone, 10)
        if (isNaN(parsedUnits) || parsedUnits < 0)
          return res.status(400).json({ error: 'unitsDone must be a non-negative number' })
        if (parsedUnits > totalUnits)
          return res.status(400).json({ error: `unitsDone (${parsedUnits}) cannot exceed totalUnits (${totalUnits})` })
        nextUnits = parsedUnits
        nextStatus = deriveStageStatus({ unitsDone: parsedUnits, totalUnits })
      }
    } else {
      if (has('unitsDone') && !has('status')) {
        // A quantity-shaped write against a milestone — accept it by translating.
        const parsedUnits = parseInt(unitsDone, 10)
        if (isNaN(parsedUnits) || parsedUnits < 0)
          return res.status(400).json({ error: 'unitsDone must be a non-negative number' })
        if (parsedUnits > totalUnits)
          return res.status(400).json({ error: `unitsDone (${parsedUnits}) cannot exceed totalUnits (${totalUnits})` })
        nextStatus = deriveStageStatus({ unitsDone: parsedUnits, totalUnits })
      } else {
        nextStatus = has('status') ? status : deriveStageStatus(stage)
      }
      nextUnits = mirroredUnits(nextStatus, totalUnits)
    }

    // Checklist full-close gate: a checklist stage's own status can't say 'done'
    // while its own items say otherwise. No override (unlike the materials gate
    // below) — this is the stage agreeing with itself, not an external PO.
    if (kind === 'checklist' && nextStatus === 'done') {
      const items = stage.items || []
      const pendingItems = items.filter(it => it.status !== 'done')
      if (pendingItems.length > 0)
        return res.status(400).json({ error: `Cannot mark done — ${pendingItems.length} of ${items.length} checklist item(s) still pending` })
    }

    // Materials gate: a stage with 1+ material lines cannot advance past its current
    // unitsDone while any line isn't cleared — applies uniformly to manufacturer
    // updates and admin Stage Override alike (both share this route). The "Trims
    // Order" stage itself is about placing the order, not having it in hand, so
    // 'ordered' already satisfies it there; every other stage still requires the
    // material to actually be 'received'. Milestones reach this via the mirror:
    // flipping one to `done` raises unitsDone, so it trips the same check.
    const gateStageName = (stage.name || '').trim().toLowerCase()
    const isTrimsOrderStage = gateStageName === 'trims order'
    const stageMaterials = stage.materials || []
    const pendingMaterials = stageMaterials.filter(m => isTrimsOrderStage ? m.status === 'pending' : m.status !== 'received')
    if (!isMasterOverride && pendingMaterials.length > 0 && nextUnits > currentUnits)
      return res.status(400).json({ error: `Cannot advance this stage — ${pendingMaterials.length} material(s) still pending${isTrimsOrderStage ? '' : '/ordered'}` })

    // Only fields actually present in the request are written. eta/startDate were
    // already conditional; note/stageDate now are too, because a status-only
    // update (the daily-update grid) must not silently blank a note someone typed.
    const setFields = {
      [`assignments.$[asgn].stages.${stageIndex}.unitsDone`]: nextUnits,
      [`assignments.$[asgn].stages.${stageIndex}.status`]:    nextStatus,
      [`assignments.$[asgn].stages.${stageIndex}.actualEnd`]: deriveActualEnd(nextStatus, stage.actualEnd, hasActualEnd ? actualEnd : undefined),
      'assignments.$[asgn].updatedAt': new Date(),
    }
    if (has('note'))      setFields[`assignments.$[asgn].stages.${stageIndex}.note`] = note ?? ''
    if (has('stageDate')) setFields[`assignments.$[asgn].stages.${stageIndex}.stageDate`] = stageDate ?? null
    if (has('blocked'))   setFields[`assignments.$[asgn].stages.${stageIndex}.blocked`] = !!blocked
    if (has('blockedReason')) setFields[`assignments.$[asgn].stages.${stageIndex}.blockedReason`] = String(blockedReason ?? '').trim()
    if (hasEta) setFields[`assignments.$[asgn].stages.${stageIndex}.eta`] = eta
    if (hasStartDate) setFields[`assignments.$[asgn].stages.${stageIndex}.startDate`] = startDate

    // NO sequential reset. Stages are tracked independently: real TNA plans run
    // steps in parallel (FPT/PP/GPT samples overlap; approvals start before the
    // prior approval closes), and the old rule zeroed unitsDone AND note on every
    // later stage on every write — including note-only saves — destroying work to
    // maintain a property nothing read. Out-of-order progress is now reported as a
    // warning below instead of silently erased.

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
      detail: `${orderId}: ${stageName} — ${nextStatus}${kind === 'quantity' ? ` (${nextUnits}/${totalUnits} units)` : ''} by ${req.user.name}${isMasterOverride ? ' [MASTER OVERRIDE]' : ''}`,
    })

    // Advisory only — what the sequential reset used to enforce destructively.
    // Genuinely parallel plans will trip this legitimately, so it never blocks.
    const warnings = []
    if (nextStatus === 'done') {
      const openEarlier = (updatedAsgn?.stages || [])
        .slice(0, stageIndex)
        .map((s, i) => ({ s, i }))
        .filter(({ s }) => deriveStageStatus(s) !== 'done')
      if (openEarlier.length) {
        const names = openEarlier.slice(0, 3).map(({ s, i }) => `${i + 1}. ${s.name}`).join(', ')
        warnings.push(`"${stageName}" is marked done while ${openEarlier.length} earlier step(s) are still open: ${names}${openEarlier.length > 3 ? '…' : ''}`)
      }
    }

    res.json({ ...enrichOrder(order, req.user.role === 'manufacturer' ? String(req.user.id) : null), warnings })
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
    const hasKind = Object.prototype.hasOwnProperty.call(req.body, 'kind')
    // Direct override of the normally system-managed baseline/actual dates —
    // master admin only (see the gate below). A short-term data-entry escape
    // hatch for getting real historical dates into the system; everywhere
    // else, baselineEta is captured automatically on first eta revision and
    // actualEnd is auto-stamped/cleared alongside status.
    const hasBaselineEta = Object.prototype.hasOwnProperty.call(req.body, 'baselineEta')
    const hasActualEnd = Object.prototype.hasOwnProperty.call(req.body, 'actualEnd')
    const hasName = Object.prototype.hasOwnProperty.call(req.body, 'name')
    const { eta, startDate, responsibleId, totalUnits, description, kind, baselineEta, actualEnd, name } = req.body

    if (!hasEta && !hasStartDate && !hasResponsibleId && !hasTotalUnits && !hasDescription && !hasKind && !hasBaselineEta && !hasActualEnd && !hasName)
      return res.status(400).json({ error: 'Provide eta, startDate, responsibleId, totalUnits, description, kind, name, baselineEta, and/or actualEnd to update' })

    let trimmedName
    if (hasName) {
      if (typeof name !== 'string' || !name.trim())
        return res.status(400).json({ error: 'Stage name cannot be blank' })
      trimmedName = name.trim()
      if (trimmedName.length > 200)
        return res.status(400).json({ error: 'Stage name too long (max 200 characters)' })
    }

    if ((hasBaselineEta || hasActualEnd) && !(req.user.role === 'admin' && req.user.adminType === 'master'))
      return res.status(403).json({ error: 'Only the master admin can set the planned or actual date directly' })

    if (hasKind && !STAGE_KINDS.includes(kind))
      return res.status(400).json({ error: `Invalid kind — must be one of: ${STAGE_KINDS.join(', ')}` })

    if (hasResponsibleId && responsibleId) {
      if (!mongoose.Types.ObjectId.isValid(responsibleId))
        return res.status(400).json({ error: 'Invalid responsible person ID' })
      const responsibleUser = await User.findById(responsibleId, 'role isActive').lean()
      if (!responsibleUser || !RESPONSIBLE_ROLES.includes(responsibleUser.role))
        return res.status(400).json({ error: 'Responsible person must be an admin, manufacturer, or buyer' })
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
    if (hasBaselineEta) {
      const err = invalidDateMsg('planned date', baselineEta)
      if (err) return res.status(400).json({ error: err })
    }
    // actualEnd is stricter than the other date fields: a real completion date
    // (or nothing), never 'NA', never in the future.
    if (hasActualEnd) {
      if (typeof actualEnd !== 'string' || isNaN(new Date(actualEnd).getTime()))
        return res.status(400).json({ error: 'Invalid actual completion date' })
      if (dayNumber(actualEnd) > dayNumber(getToday()))
        return res.status(400).json({ error: 'Actual completion date cannot be in the future' })
    }

    // Ordering check against whichever side isn't being changed in this request
    const effectiveStart = hasStartDate ? startDate : currentStage.startDate
    const effectiveEnd = hasEta ? eta : currentStage.eta
    if (effectiveStart && effectiveEnd && effectiveStart !== 'NA' && effectiveEnd !== 'NA'
        && new Date(effectiveStart) > new Date(effectiveEnd)) {
      return res.status(400).json({ error: 'Start date must be on or before the end date' })
    }

    const setFields = { 'assignments.$[asgn].updatedAt': new Date() }
    if (hasName) setFields[`assignments.$[asgn].stages.${stageIndex}.name`] = trimmedName
    if (hasEta) setFields[`assignments.$[asgn].stages.${stageIndex}.eta`] = eta
    if (hasStartDate) setFields[`assignments.$[asgn].stages.${stageIndex}.startDate`] = startDate
    if (hasResponsibleId) setFields[`assignments.$[asgn].stages.${stageIndex}.responsibleId`] = responsibleId || null
    if (hasTotalUnits) setFields[`assignments.$[asgn].stages.${stageIndex}.totalUnits`] = parsedTotalUnits
    if (hasDescription) setFields[`assignments.$[asgn].stages.${stageIndex}.description`] = trimmedDescription

    // Capture the baseline at the exact moment it would otherwise be lost.
    // A read-time `baselineEta ?? eta` fallback is not enough on its own: once
    // eta is revised the fallback moves with it and variance is pinned at zero
    // forever. Stages predating this field therefore report 0 days of slippage
    // until their first revision, then measure correctly from there — the
    // original baseline is genuinely gone and is not invented here.
    if (hasEta && eta !== currentStage.eta && !currentStage.baselineEta)
      setFields[`assignments.$[asgn].stages.${stageIndex}.baselineEta`] = currentStage.eta ?? eta

    // Master-only direct overrides (gated above). An explicit baselineEta wins
    // over the auto-capture just above, since it's a deliberate correction.
    if (hasBaselineEta) setFields[`assignments.$[asgn].stages.${stageIndex}.baselineEta`] = baselineEta

    // Setting actualEnd directly means "this is done" — mirror status/units the
    // same way every other actualEnd-setting path in this app does, so a stage
    // never ends up with a completion date while still reading not_started.
    // The checklist gate still applies (a stage can't contradict its own
    // items); the materials gate does not — this route is specifically for
    // entering real historical data the master admin already knows is true.
    if (hasActualEnd) {
      const kind = stageKindOf(currentStage)
      if (kind === 'checklist') {
        const items = currentStage.items || []
        const pendingItems = items.filter(it => it.status !== 'done')
        if (pendingItems.length > 0)
          return res.status(400).json({ error: `Cannot mark done — ${pendingItems.length} of ${items.length} checklist item(s) still pending` })
      }
      const effectiveTotal = hasTotalUnits ? parsedTotalUnits : (currentStage.totalUnits ?? 0)
      setFields[`assignments.$[asgn].stages.${stageIndex}.status`] = 'done'
      setFields[`assignments.$[asgn].stages.${stageIndex}.unitsDone`] = mirroredUnits('done', effectiveTotal)
      setFields[`assignments.$[asgn].stages.${stageIndex}.actualEnd`] = actualEnd
    }

    // Changing kind re-derives status and re-mirrors units, or a stage could end
    // up 40% complete and simultaneously 'not_started'.
    if (hasKind) {
      setFields[`assignments.$[asgn].stages.${stageIndex}.kind`] = kind
      const effectiveTotal = hasTotalUnits ? parsedTotalUnits : (currentStage.totalUnits ?? 0)
      const nextStatus = deriveStageStatus(currentStage)
      if (kind === 'checklist' && nextStatus === 'done') {
        const items = currentStage.items || []
        const pendingItems = items.filter(it => it.status !== 'done')
        if (pendingItems.length > 0)
          return res.status(400).json({ error: `Cannot mark done — ${pendingItems.length} of ${items.length} checklist item(s) still pending` })
      }
      setFields[`assignments.$[asgn].stages.${stageIndex}.status`] = nextStatus
      if (kind !== 'quantity')
        setFields[`assignments.$[asgn].stages.${stageIndex}.unitsDone`] = mirroredUnits(nextStatus, effectiveTotal)
      setFields[`assignments.$[asgn].stages.${stageIndex}.actualEnd`] = deriveActualEnd(nextStatus, currentStage.actualEnd)
    }

    const order = await Order.findOneAndUpdate(
      { _id: orderId, 'assignments.mfrId': mfrObjectId },
      { $set: setFields },
      { arrayFilters: [{ 'asgn.mfrId': mfrObjectId }], new: true }
    ).populate('buyerId', BUYER_FIELDS).populate('assignments.mfrId', MFR_FIELDS).populate('assignments.stages.responsibleId', 'name company code role').populate('assignments.stages.updates.byUser', 'name').lean()

    if (!order) return res.status(404).json({ error: 'Order or assignment not found' })

    const stageName = currentStage.name || `Stage ${stageIndex + 1}`
    const changes = []
    if (hasName) changes.push(`name → "${trimmedName}"`)
    if (hasEta) changes.push(`end date → ${eta}`)
    if (hasStartDate) changes.push(`start date → ${startDate}`)
    if (hasResponsibleId) changes.push(`responsible → ${responsibleId || 'unassigned'}`)
    if (hasTotalUnits) changes.push(`target qty → ${parsedTotalUnits}`)
    if (hasDescription) changes.push('description updated')
    if (hasKind) changes.push(`kind → ${kind}`)
    if (hasBaselineEta) changes.push(`planned date → ${baselineEta} [MASTER OVERRIDE]`)
    if (hasActualEnd) changes.push(`actual end → ${actualEnd} [MASTER OVERRIDE]`)
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

    // This is the ONLY write in this file that $sets the whole stages array
    // rather than dotted paths, and `existingAsgn` came from a .lean() read — so
    // fields absent on documents predating them (kind/status/blocked/baselineEta)
    // would be filled in by Mongoose's schema defaults during the cast. That
    // would stamp status:'not_started' onto completed stages as a side effect of
    // deleting an unrelated one. Resolve every such field explicitly here so the
    // result never depends on cast semantics in either direction.
    const newStages = existingAsgn.stages
      .filter((_, i) => i !== stageIndex)
      .map(s => ({
        ...s,
        kind: stageKindOf(s),
        status: deriveStageStatus(s),
        blocked: !!s.blocked,
        blockedReason: s.blockedReason || '',
        baselineEta: s.baselineEta ?? s.eta ?? null,
      }))

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

    // Part of the buyer carve-out: a buyer who owns this stage may comment on it,
    // since they own the approval steps and their reply IS the update. They still
    // cannot write any other stage field. Checked after the stage is loaded,
    // because ownership is per-stage.
    if (req.user.role === 'buyer' && !buyerMayWriteStage(req.user, existingAsgn.stages[stageIndex]))
      return res.status(403).json({ error: 'Buyers cannot update production stages' })

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

    res.json(enrichOrder(order, req.user.role === 'manufacturer' ? String(req.user.id) : null))
  } catch (err) {
    console.error('[orders]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── Stage checklist items ───────────────────────────────────────────────────
// A `checklist` stage holds the actual deliverables it produces — "Lab Dip —
// Red", "— Peacot", "— Olivine" — because a real step is often several things
// finishing on different days ("we had to submit 3 and it was not together").
// Distinct from materials, which are procurement and gate production; these are
// the step's own output. Same permission shape as materials: any admin, or the
// stage's responsible person. Buyers are denied — their carve-out is stage
// status only.
async function loadStageForItems(req, res) {
  const { orderId, mfrId } = req.params
  if (!mongoose.Types.ObjectId.isValid(mfrId)) {
    res.status(400).json({ error: 'Invalid manufacturer ID' })
    return null
  }
  const stageIndex = parseInt(req.params.stageIndex, 10)
  const existingOrder = await Order.findById(orderId).lean()
  if (!existingOrder) { res.status(404).json({ error: 'Order not found' }); return null }
  const existingAsgn = (existingOrder.assignments || []).find(a => a.mfrId?.toString() === mfrId)
  if (!existingAsgn) { res.status(404).json({ error: 'Assignment not found' }); return null }
  const stageCount = existingAsgn.stages?.length || 0
  if (isNaN(stageIndex) || stageIndex < 0 || stageIndex >= stageCount) {
    res.status(400).json({ error: `Invalid stage index (0–${stageCount - 1})` })
    return null
  }
  const stage = existingAsgn.stages[stageIndex]
  if (req.user.role === 'buyer') {
    res.status(403).json({ error: 'Buyers cannot manage checklist items' })
    return null
  }
  const isResponsible = stage.responsibleId && String(stage.responsibleId) === String(req.user.id)
  if (req.user.role !== 'admin' && !isResponsible) {
    res.status(403).json({ error: "Only an admin or this stage's responsible person can manage checklist items" })
    return null
  }
  return { orderId, mfrObjectId: new mongoose.Types.ObjectId(mfrId), stageIndex, stage, order: existingOrder }
}

const ITEMS_POPULATE = q => q
  .populate('buyerId', BUYER_FIELDS).populate('assignments.mfrId', MFR_FIELDS)
  .populate('assignments.stages.responsibleId', 'name company code role')
  .populate('assignments.stages.updates.byUser', 'name')

// Add one item, or — with fromColourways — one per colourway on the order, so
// the same three colour names aren't retyped on every per-colour step.
router.post('/:orderId/assignments/:mfrId/stages/:stageIndex/items', requireAuth, updateLimiter, async (req, res) => {
  try {
    const ctx = await loadStageForItems(req, res)
    if (!ctx) return
    const { name, colourway, dueDate, note, fromColourways } = req.body

    let lines = []
    if (fromColourways) {
      const colours = ctx.order.colourways || []
      if (colours.length === 0)
        return res.status(400).json({ error: 'This order has no colourways yet — add them to the order first' })
      const prefix = (name || ctx.stage.name || 'Item').trim().slice(0, 150)
      lines = colours.map(c => ({
        name: `${prefix} — ${c.name}`, colourway: c.name,
        status: 'pending', dueDate: dueDate || null, doneDate: null, note: '',
      }))
    } else {
      if (!name?.trim()) return res.status(400).json({ error: 'Item name is required' })
      lines = [{
        name: name.trim().slice(0, 200), colourway: (colourway || '').trim(),
        status: 'pending', dueDate: dueDate || null, doneDate: null, note: (note || '').trim(),
      }]
    }

    const existingCount = (ctx.stage.items || []).length
    if (existingCount + lines.length > 60)
      return res.status(400).json({ error: 'Too many checklist items on this stage (max 60)' })

    const order = await ITEMS_POPULATE(Order.findOneAndUpdate(
      { _id: ctx.orderId, 'assignments.mfrId': ctx.mfrObjectId },
      { $push: { [`assignments.$[asgn].stages.${ctx.stageIndex}.items`]: { $each: lines } } },
      { arrayFilters: [{ 'asgn.mfrId': ctx.mfrObjectId }], new: true }
    )).lean()
    if (!order) return res.status(404).json({ error: 'Order or assignment not found' })

    await AuditLog.create({
      byUser: req.user.id,
      action: 'Stage Item Added',
      detail: `${ctx.orderId}: ${ctx.stage.name || `Stage ${ctx.stageIndex + 1}`} — added ${lines.length} item(s)`,
    })
    res.json(enrichOrder(order, req.user.role === 'manufacturer' ? String(req.user.id) : null))
  } catch (err) {
    console.error('[orders]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

router.post('/:orderId/assignments/:mfrId/stages/:stageIndex/items/:lineIndex', requireAuth, updateLimiter, async (req, res) => {
  try {
    const ctx = await loadStageForItems(req, res)
    if (!ctx) return
    const lineIndex = parseInt(req.params.lineIndex, 10)
    const items = ctx.stage.items || []
    if (isNaN(lineIndex) || lineIndex < 0 || lineIndex >= items.length)
      return res.status(400).json({ error: `Invalid item index (0–${items.length - 1})` })

    const has = k => Object.prototype.hasOwnProperty.call(req.body, k)
    const { status, name, colourway, dueDate, doneDate, note } = req.body
    const base = `assignments.$[asgn].stages.${ctx.stageIndex}.items.${lineIndex}`
    const setFields = {}

    if (has('status')) {
      if (!['pending', 'done'].includes(status))
        return res.status(400).json({ error: 'Item status must be pending or done' })
      setFields[`${base}.status`] = status
      // Stamp the completion date automatically unless one was given.
      if (status === 'done' && !has('doneDate'))
        setFields[`${base}.doneDate`] = new Date().toISOString().slice(0, 10)
      if (status === 'pending') setFields[`${base}.doneDate`] = null
    }
    if (has('name')) {
      if (!name?.trim()) return res.status(400).json({ error: 'Item name cannot be blank' })
      setFields[`${base}.name`] = name.trim().slice(0, 200)
    }
    if (has('colourway')) setFields[`${base}.colourway`] = String(colourway || '').trim()
    if (has('dueDate')) {
      setFields[`${base}.dueDate`] = dueDate || null
      // Capture the planned date at the exact moment it would otherwise be lost —
      // same pattern as stage.baselineEta vs stage.eta on the /eta route.
      const item = items[lineIndex]
      if (dueDate !== item.dueDate && !item.plannedDate)
        setFields[`${base}.plannedDate`] = item.dueDate ?? dueDate
    }
    if (has('doneDate')) setFields[`${base}.doneDate`] = doneDate || null
    if (has('note')) setFields[`${base}.note`] = String(note || '').trim().slice(0, 500)

    if (Object.keys(setFields).length === 0)
      return res.status(400).json({ error: 'Nothing to update' })
    setFields['assignments.$[asgn].updatedAt'] = new Date()

    const order = await ITEMS_POPULATE(Order.findOneAndUpdate(
      { _id: ctx.orderId, 'assignments.mfrId': ctx.mfrObjectId },
      { $set: setFields },
      { arrayFilters: [{ 'asgn.mfrId': ctx.mfrObjectId }], new: true }
    )).lean()
    if (!order) return res.status(404).json({ error: 'Order or assignment not found' })

    await AuditLog.create({
      byUser: req.user.id,
      action: 'Stage Item Updated',
      detail: `${ctx.orderId}: ${ctx.stage.name || `Stage ${ctx.stageIndex + 1}`} — "${items[lineIndex].name}"${has('status') ? ` → ${status}` : ''}`,
    })
    res.json(enrichOrder(order, req.user.role === 'manufacturer' ? String(req.user.id) : null))
  } catch (err) {
    console.error('[orders]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

router.post('/:orderId/assignments/:mfrId/stages/:stageIndex/items/:lineIndex/delete', requireAuth, updateLimiter, async (req, res) => {
  try {
    const ctx = await loadStageForItems(req, res)
    if (!ctx) return
    const lineIndex = parseInt(req.params.lineIndex, 10)
    const items = ctx.stage.items || []
    if (isNaN(lineIndex) || lineIndex < 0 || lineIndex >= items.length)
      return res.status(400).json({ error: `Invalid item index (0–${items.length - 1})` })

    // Items carry no external references (unlike materials, which Document rows
    // point at by index), so a straightforward rewrite is safe here.
    const next = items.filter((_, i) => i !== lineIndex)
    const order = await ITEMS_POPULATE(Order.findOneAndUpdate(
      { _id: ctx.orderId, 'assignments.mfrId': ctx.mfrObjectId },
      { $set: {
        [`assignments.$[asgn].stages.${ctx.stageIndex}.items`]: next,
        'assignments.$[asgn].updatedAt': new Date(),
      } },
      { arrayFilters: [{ 'asgn.mfrId': ctx.mfrObjectId }], new: true }
    )).lean()
    if (!order) return res.status(404).json({ error: 'Order or assignment not found' })

    await AuditLog.create({
      byUser: req.user.id,
      action: 'Stage Item Removed',
      detail: `${ctx.orderId}: ${ctx.stage.name || `Stage ${ctx.stageIndex + 1}`} — removed "${items[lineIndex].name}"`,
    })
    res.json(enrichOrder(order, req.user.role === 'manufacturer' ? String(req.user.id) : null))
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
    const { name, category, colourway, requiredQty, unit, supplier, poNumber, expectedDate } = req.body

    if (!name?.trim()) return res.status(400).json({ error: 'Material name is required' })
    const reqQty = parseFloat(requiredQty)
    if (isNaN(reqQty) || reqQty < 0) return res.status(400).json({ error: 'Required quantity must be a non-negative number' })
    if (category !== undefined && !['fabric', 'trim', 'accessory', 'other'].includes(category))
      return res.status(400).json({ error: 'Invalid category' })

    const existingOrder = await Order.findById(orderId).lean()
    if (!existingOrder) return res.status(404).json({ error: 'Order not found' })
    const existingAsgn = (existingOrder.assignments || []).find(a => a.mfrId?.toString() === mfrId)
    if (!existingAsgn) return res.status(404).json({ error: 'Assignment not found' })
    const stageCount = existingAsgn.stages?.length || 0
    if (isNaN(stageIndex) || stageIndex < 0 || stageIndex >= stageCount)
      return res.status(400).json({ error: `Invalid stage index (0–${stageCount - 1})` })

    const stage = existingAsgn.stages[stageIndex]
    // Explicit deny, load-bearing: the isResponsible check below used to exclude
    // buyers only as a side effect of their never being assignable as a stage
    // owner. They now are, so procurement needs its own guard (BRD §3).
    if (req.user.role === 'buyer')
      return res.status(403).json({ error: 'Buyers cannot manage materials' })
    const isResponsible = stage.responsibleId && String(stage.responsibleId) === String(req.user.id)
    if (req.user.role !== 'admin' && !isResponsible)
      return res.status(403).json({ error: "Only an admin or this stage's responsible person can manage materials" })

    const line = {
      name: name.trim().slice(0, 200),
      category: category || 'other', colourway: colourway || '',
      requiredQty: reqQty,
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

    res.json(enrichOrder(order, req.user.role === 'manufacturer' ? String(req.user.id) : null))
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
    const { name, category, colourway, requiredQty, unit, supplier, poNumber, expectedDate, status, orderedQty, receivedQty, note } = req.body

    const existingOrder = await Order.findById(orderId).lean()
    if (!existingOrder) return res.status(404).json({ error: 'Order not found' })
    const existingAsgn = (existingOrder.assignments || []).find(a => a.mfrId?.toString() === mfrId)
    if (!existingAsgn) return res.status(404).json({ error: 'Assignment not found' })
    const stageCount = existingAsgn.stages?.length || 0
    if (isNaN(stageIndex) || stageIndex < 0 || stageIndex >= stageCount)
      return res.status(400).json({ error: `Invalid stage index (0–${stageCount - 1})` })

    const stage = existingAsgn.stages[stageIndex]
    // Explicit deny, load-bearing: the isResponsible check below used to exclude
    // buyers only as a side effect of their never being assignable as a stage
    // owner. They now are, so procurement needs its own guard (BRD §3).
    if (req.user.role === 'buyer')
      return res.status(403).json({ error: 'Buyers cannot manage materials' })
    const isResponsible = stage.responsibleId && String(stage.responsibleId) === String(req.user.id)
    if (req.user.role !== 'admin' && !isResponsible)
      return res.status(403).json({ error: "Only an admin or this stage's responsible person can manage materials" })

    const lineCount = stage.materials?.length || 0
    if (isNaN(lineIndex) || lineIndex < 0 || lineIndex >= lineCount)
      return res.status(400).json({ error: `Invalid material line index (0–${lineCount - 1})` })

    if (status !== undefined && !['pending', 'ordered', 'received'].includes(status))
      return res.status(400).json({ error: 'Invalid status' })
    if (category !== undefined && !['fabric', 'trim', 'accessory', 'other'].includes(category))
      return res.status(400).json({ error: 'Invalid category' })

    const prefix = `assignments.$[asgn].stages.${stageIndex}.materials.${lineIndex}`
    const setFields = {}
    if (name !== undefined) {
      if (!name.trim()) return res.status(400).json({ error: 'Material name is required' })
      setFields[`${prefix}.name`] = name.trim().slice(0, 200)
    }
    if (category !== undefined) setFields[`${prefix}.category`] = category
    if (colourway !== undefined) setFields[`${prefix}.colourway`] = colourway
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

    // Captured before the write — the delta this receiving update represents,
    // for the InventoryMovement 'in' row below. Never the new total: re-saving
    // the same or a corrected-downward qty must not re-book a full receipt.
    const priorLine = stage.materials[lineIndex]
    const receivedDelta = receivedQty !== undefined ? parseFloat(receivedQty) - (priorLine.receivedQty || 0) : 0

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

    // Phase 4 — the Finance-module data seam (§1g). A positive delta only;
    // a downward correction is not a negative receipt, just leave no movement.
    // Awaited (best-effort, wrapped) — same discipline as the Delivered hook.
    if (receivedDelta > 0) {
      try {
        await InventoryMovement.create({
          mfrId: mfrObjectId, materialName: priorLine.name, direction: 'in',
          qty: receivedDelta, unit: priorLine.unit || '',
          scopeType: 'tradio_order', orderId, orderRef: orderId,
          sourceType: 'material_receipt',
          sourceRef: { stageIndex, materialLineId: priorLine._id },
        })
      } catch (err) { console.error('[inventoryMovement]', err) }
    }

    res.json(enrichOrder(order, req.user.role === 'manufacturer' ? String(req.user.id) : null))
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
    // Explicit deny, load-bearing: the isResponsible check below used to exclude
    // buyers only as a side effect of their never being assignable as a stage
    // owner. They now are, so procurement needs its own guard (BRD §3).
    if (req.user.role === 'buyer')
      return res.status(403).json({ error: 'Buyers cannot manage materials' })
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

    res.json(enrichOrder(order, req.user.role === 'manufacturer' ? String(req.user.id) : null))
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
        const { orderId, mfrCode, stageName, name, category, colourway, requiredQty, unit, supplier, poNumber, expectedDate } = row
        if (!orderId || !mfrCode || !stageName || !name) {
          failed++; results.push({ row: i, success: false, error: 'orderId, mfrCode, stageName, and name are required' }); continue
        }
        const reqQty = parseFloat(requiredQty)
        if (isNaN(reqQty) || reqQty < 0) {
          failed++; results.push({ row: i, success: false, error: 'Required quantity must be a non-negative number' }); continue
        }
        if (category !== undefined && category !== '' && !['fabric', 'trim', 'accessory', 'other'].includes(category)) {
          failed++; results.push({ row: i, success: false, error: `Invalid category "${category}"` }); continue
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
          name: String(name).trim().slice(0, 200),
          category: category || 'other', colourway: colourway || '',
          requiredQty: reqQty,
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
    const { product, category, season, totalQty, delivery, imageDataUrl, imageUrl, colourways, callout } = req.body
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

      // Creation enforces `Σ assignment.qty === totalQty`, but editing used to
      // change only the order total — leaving the splits stale. Since every
      // screen shows the assignment qty, the edit looked like it hadn't saved at
      // all, and the order silently violated its own invariant.
      const asgns = existing.assignments || []
      const currentSum = asgns.reduce((n, a) => n + (a.qty || 0), 0)
      if (qty !== currentSum) {
        if (asgns.length === 1) {
          updates['assignments.0.qty'] = qty
          // Stage targets that were defaulted to the assignment qty follow it.
          // Only quantity-kind stages, never a milestone/checklist target, and
          // never below what's already been completed.
          ;(asgns[0].stages || []).forEach((s, i) => {
            if (stageKindOf(s) !== 'quantity') return
            if ((s.totalUnits ?? 0) !== currentSum) return  // deliberately overridden — leave it
            updates[`assignments.0.stages.${i}.totalUnits`] = Math.max(qty, s.unitsDone || 0)
          })
        } else {
          // Reallocating between manufacturers is a commercial decision, not
          // something to infer. Say exactly what the splits are today.
          const detail = asgns.map(a => `${a.sub}: ${a.qty}`).join(', ')
          return res.status(400).json({
            error: `Total quantity must match the manufacturer splits (currently ${detail} = ${currentSum}). Adjust the splits first.`,
          })
        }
      }
    }

    if (delivery !== undefined) {
      const d = new Date(delivery)
      if (isNaN(d.getTime())) return res.status(400).json({ error: 'Invalid delivery date' })
      // Same baselineEta/eta convention as stages: capture the OLD delivery as
      // the frozen baseline the first time it's ever revised, so a later
      // correction (e.g. realigning it to the TNA plan's last stage) can't
      // erase how far the promise itself has moved from what was first
      // committed. Only fires once — a legacy order with no baseline yet, or
      // a genuinely new one, gets it backfilled here; after that it's frozen.
      if (!existing.baselineDelivery && existing.delivery && d.getTime() !== new Date(existing.delivery).getTime()) {
        updates.baselineDelivery = existing.delivery
      }
      updates.delivery = d
    }

    if (colourways !== undefined) {
      if (!Array.isArray(colourways)) return res.status(400).json({ error: 'Colourways must be a list' })
      const next = []
      for (const c of colourways) {
        const name = (typeof c === 'string' ? c : c?.name || '').trim()
        if (!name) continue
        if (name.length > 60) return res.status(400).json({ error: `Colourway name too long: "${name.slice(0, 20)}…"` })
        if (next.some(x => x.name.toLowerCase() === name.toLowerCase())) continue
        next.push({ name, code: (typeof c === 'object' && c?.code ? String(c.code).trim() : '') })
      }
      if (next.length > 40) return res.status(400).json({ error: 'Too many colourways (max 40)' })
      updates.colourways = next
    }

    if (callout !== undefined) {
      if (callout !== null && typeof callout !== 'string') return res.status(400).json({ error: 'Callout must be text' })
      const c = (callout || '').trim()
      if (c.length > 500) return res.status(400).json({ error: 'Callout too long (max 500 characters)' })
      updates.callout = c
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

    // A submitted/approved CostSheet is a commercial record, not disposable
    // planning data — refuse rather than silently destroying the only
    // context that makes it interpretable. Draft sheets have no such value
    // and are cascade-deleted below instead.
    const blockingSheet = await CostSheet.findOne({ scopeType: 'tradio_order', orderId, status: { $ne: 'draft' } }, '_id').lean()
    if (blockingSheet) {
      return res.status(400).json({ error: 'Cannot delete this order — it has a submitted or approved cost sheet. Withdraw or reopen it first.' })
    }

    await Order.findByIdAndDelete(orderId)
    // Draft cost sheets and the requirement doc have no value once the order
    // is gone and become unreachable anyway (their scoping resolves through
    // Order.find(...)) — cascade them. ConsumptionRecord and InventoryMovement
    // are deliberately NOT touched: they're the consumption-moat dataset and
    // the Finance ledger, both already denormalized with an orderRef label so
    // they stay attributable after the order id they point at is gone.
    await CostSheet.deleteMany({ scopeType: 'tradio_order', orderId })
    await MaterialRequirement.deleteMany({ scopeType: 'tradio_order', orderId })

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
