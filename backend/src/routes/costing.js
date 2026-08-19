import { Router } from 'express'
import ExcelJS from 'exceljs'
import {
  CostSheet, Order, MfrProject, AuditLog, User, Notification, MaterialRequirement,
} from '../db/index.js'
import {
  fabricValue, rawMaterialTotal, labourTotal, totalLabourAndRawMaterial,
  overheadValue, rejectionValue, marginValue, tradioFeeValue, priceValue,
  baseCost, mfrMarginValue, mfrSellPrice,
} from '../models/CostSheet.js'
import { requireAuth, requireMaster } from '../middleware/auth.js'
import { assertScopeShape } from '../lib/scopeAccess.js'

const router = Router()

// ── Access control — a real 403 gate, separate from enrichCostSheet below.
// enrichCostSheet decides what a PERMITTED viewer sees; this decides WHO is
// permitted at all. Conflating the two was the exact hole the review caught:
// enrichCostSheet strips fields by role, it never checked whether the caller
// could open this specific document (manufacturer B reading manufacturer A's
// sheet on a split order). Every /:id* route below calls this first. ──────
async function assertCostSheetAccess(user, sheet) {
  if (sheet.scopeType === 'mfr_project') {
    const project = await MfrProject.findById(sheet.mfrProjectId, 'mfrId').lean()
    if (!project || String(project.mfrId) !== user.id) return { status: 403, error: 'Forbidden' }
    return null
  }
  // tradio_order
  if (user.role === 'admin') return null
  if (user.role === 'manufacturer') {
    if (String(sheet.mfrId) !== user.id) return { status: 403, error: 'Forbidden' }
    return null
  }
  if (user.role === 'buyer') {
    const order = await Order.findById(sheet.orderId, 'buyerId').lean()
    if (!order || String(order.buyerId) !== user.id) return { status: 403, error: 'Forbidden' }
    if (sheet.status !== 'approved') return { status: 403, error: 'Not yet available' }
    return null
  }
  return { status: 403, error: 'Forbidden' }
}

// ── Serialization — deny-list, not positional. Strips exactly the master-only
// source fields AND the computed outputs derived from them (Price/Margin/
// Tradio fee/Percentage) — a manufacturer who authored every other term must
// never be able to recover the margin by subtracting their own subtotal from
// a visible Price. The manufacturer's own subtotals and the whole actuals
// block stay visible to them; they authored those. ──────────────────────
function enrichCostSheet(sheet, user) {
  const isPrivileged = user.role === 'admin' // includes both master and regular admin for READ
  const isOwner = sheet.scopeType === 'tradio_order'
    ? user.role === 'manufacturer' && String(sheet.mfrId) === user.id
    : user.role === 'manufacturer' // ownership already confirmed by assertCostSheetAccess

  const base = {
    id: sheet._id.toString(), scopeType: sheet.scopeType,
    orderId: sheet.orderId || null, mfrProjectId: sheet.mfrProjectId ? sheet.mfrProjectId.toString() : null,
    mfrId: sheet.mfrId.toString(), styleRef: sheet.styleRef || '',
    fabricSource: sheet.fabricSource || null, currency: sheet.currency || 'INR',
    status: sheet.status,
    submittedAt: sheet.submittedAt || null, approvedAt: sheet.approvedAt || null,
  }

  if (user.role === 'buyer') {
    // Narrowest read in the whole feature — no content field, ever.
    return { ...base, finalNegotiatedPrice: sheet.finalNegotiatedPrice ?? null, currency: sheet.currency || 'INR' }
  }

  const content = {
    fabric: sheet.fabric ? {
      name: sheet.fabric.name || '', unit: sheet.fabric.unit || '',
      consumption: sheet.fabric.consumption ?? null, rate: sheet.fabric.rate ?? null,
      wastagePct: sheet.fabric.wastagePct || 0,
      supplier: sheet.fabric.supplier || '',
      materialRequirementId: sheet.fabric.materialRequirementId ? sheet.fabric.materialRequirementId.toString() : null,
      materialRequirementLineId: sheet.fabric.materialRequirementLineId ? sheet.fabric.materialRequirementLineId.toString() : null,
    } : null,
    process: (sheet.process || []).map(l => ({ label: l.label, supplier: l.supplier || '', value: l.value })),
    trims: (sheet.trims || []).map(l => ({ label: l.label, supplier: l.supplier || '', value: l.value })),
    labelsPackaging: (sheet.labelsPackaging || []).map(l => ({ label: l.label, supplier: l.supplier || '', value: l.value })),
    extraLines: (sheet.extraLines || []).map(l => ({ group: l.group, label: l.label, supplier: l.supplier || '', value: l.value })),
    labour: sheet.labour ? {
      cuttingThreads: sheet.labour.cuttingThreads || 0, making: sheet.labour.making || 0, finishingPacking: sheet.labour.finishingPacking || 0,
    } : { cuttingThreads: 0, making: 0, finishingPacking: 0 },
    overheadPct: sheet.overheadPct ?? 5, rejectionPct: sheet.rejectionPct ?? 3,
    fabricValue: fabricValue(sheet), rawMaterialTotal: rawMaterialTotal(sheet), labourTotal: labourTotal(sheet),
    totalLabourAndRawMaterial: totalLabourAndRawMaterial(sheet),
    overheadValue: overheadValue(sheet), rejectionValue: rejectionValue(sheet),
    // The manufacturer's own margin — content, not master-only (unlike
    // marginPct/tradioFeePct below). Visible to the owning manufacturer and
    // admin alike; admin needs baseCost/mfrSellPrice to know what Tradio's
    // own margin/fee are actually computed on top of.
    baseCost: baseCost(sheet), mfrMarginPct: sheet.mfrMarginPct ?? null,
    mfrMarginValue: mfrMarginValue(sheet), mfrSellPrice: mfrSellPrice(sheet),
    actualFabricConsumption: sheet.actualFabricConsumption ?? null,
    actualLabourCost: sheet.actualLabourCost ?? null,
    actualRejectionValue: sheet.actualRejectionValue ?? null,
  }

  if (isPrivileged) {
    return {
      ...base, ...content,
      marginPct: sheet.marginPct ?? null, tradioFeePct: sheet.tradioFeePct ?? null,
      finalNegotiatedPrice: sheet.finalNegotiatedPrice ?? null, negotiatedDiscountPct: sheet.negotiatedDiscountPct ?? null,
      marginValue: marginValue(sheet), tradioFeeValue: tradioFeeValue(sheet), price: priceValue(sheet),
    }
  }

  // Manufacturer (owner) — content + actuals, never the margin/fee/price layer.
  return { ...base, ...content }
}

function mapSheetSummary(s, user) {
  return enrichCostSheet(s, user)
}

// ── Routes ───────────────────────────────────────────────────────────────

router.get('/cost-sheets', requireAuth, async (req, res) => {
  try {
    const { orderId, mfrProjectId } = req.query
    if (!orderId && !mfrProjectId) return res.status(400).json({ error: 'orderId or mfrProjectId is required' })

    const query = orderId ? { scopeType: 'tradio_order', orderId } : { scopeType: 'mfr_project', mfrProjectId }
    // Manufacturer is always forced to their own mfrId server-side, mirroring
    // documents.js's buyer-can't-set-mfrId guard — never trust a client mfrId.
    if (req.user.role === 'manufacturer') query.mfrId = req.user.id
    else if (req.user.role === 'buyer') {
      if (!orderId) return res.status(403).json({ error: 'Forbidden' })
      const order = await Order.findById(orderId, 'buyerId').lean()
      if (!order || String(order.buyerId) !== req.user.id) return res.status(403).json({ error: 'Forbidden' })
      query.status = 'approved'
    } else if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' })

    if (mfrProjectId && req.user.role !== 'manufacturer') return res.status(403).json({ error: 'Forbidden' })

    const sheets = await CostSheet.find(query).lean()
    res.json(sheets.map(s => mapSheetSummary(s, req.user)))
  } catch (err) {
    console.error('[costing]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// Cross-checks the cost sheet's planned fabric consumption against the
// MaterialRequirement line it was pulled from (§5) — the one addition in this
// whole feature that directly serves TRADIO.md's actual stated motivation
// (the documented loss from an optimistic consumption estimate). Non-blocking
// by design — a real, deliberate difference can be correct — and scoped to
// the SAME order, so an mfr_project sheet can never resolve against a
// tradio_order requirement it has no relationship to.
async function computeConsumptionWarning(sheet) {
  if (sheet.scopeType !== 'tradio_order') return null
  const lineId = sheet.fabric?.materialRequirementLineId
  if (!lineId || sheet.fabric?.consumption == null) return null

  const reqDoc = await MaterialRequirement.findOne({ _id: sheet.fabric.materialRequirementId, orderId: sheet.orderId }).lean()
  if (!reqDoc) return null
  const line = (reqDoc.lines || []).find(l => String(l._id) === String(lineId))
  if (!line || !line.requiredQty) return null

  const order = await Order.findById(sheet.orderId, 'totalQty').lean()
  if (!order?.totalQty) return null

  const requiredPerUnit = line.requiredQty / order.totalQty
  const actualPerUnit = sheet.fabric.consumption
  const pctDiff = Math.round(((actualPerUnit - requiredPerUnit) / requiredPerUnit) * 1000) / 10
  return { requiredPerUnit, plannedPerUnit: actualPerUnit, pctDiff }
}

router.get('/cost-sheets/:id', requireAuth, async (req, res) => {
  try {
    const sheet = await CostSheet.findById(req.params.id).lean()
    if (!sheet) return res.status(404).json({ error: 'Cost sheet not found' })
    const denied = await assertCostSheetAccess(req.user, sheet)
    if (denied) return res.status(denied.status).json({ error: denied.error })
    const body = enrichCostSheet(sheet, req.user)
    if (req.user.role !== 'buyer') body.consumptionWarning = await computeConsumptionWarning(sheet)
    res.json(body)
  } catch (err) {
    console.error('[costing]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// Create-or-edit content fields (fabric/process/trims/labelsPackaging/
// extraLines/labour/overheadPct/rejectionPct). Manufacturer on their own
// sheet while draft; master admin on any, any time (the explicit
// on-behalf-of authoring escape hatch, and the mechanism for split-order
// costing per §1d).
router.post('/cost-sheets', requireAuth, async (req, res) => {
  try {
    const { scopeType, orderId, mfrProjectId, mfrId, styleRef, fabricSource, currency,
      fabric, process: processLines, trims, labelsPackaging, extraLines, labour, overheadPct, rejectionPct, mfrMarginPct } = req.body

    try {
      await assertScopeShape(scopeType, orderId, mfrProjectId, req.user)
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message })
    }
    if (req.user.role === 'buyer') return res.status(403).json({ error: 'Buyers cannot author cost sheets' })

    const isMaster = req.user.role === 'admin' && req.user.adminType === 'master'
    const targetMfrId = scopeType === 'mfr_project' ? req.user.id : (mfrId || req.user.id)
    if (req.user.role === 'manufacturer' && targetMfrId !== req.user.id)
      return res.status(403).json({ error: 'Forbidden' })
    if (req.user.role === 'admin' && !isMaster)
      return res.status(403).json({ error: 'Master admin only' })
    if (scopeType === 'tradio_order' && req.user.role !== 'admin' && req.user.role !== 'manufacturer')
      return res.status(403).json({ error: 'Forbidden' })

    const filter = scopeType === 'tradio_order'
      ? { scopeType, orderId, mfrId: targetMfrId }
      : { scopeType, mfrProjectId, mfrId: targetMfrId }

    let sheet = await CostSheet.findOne(filter)
    if (sheet && sheet.status !== 'draft' && req.user.role !== 'admin')
      return res.status(400).json({ error: 'Cost sheet is no longer editable — it has been submitted' })

    if (!sheet) {
      sheet = new CostSheet({ ...filter, createdBy: req.user.id, styleRef: styleRef || '' })
    } else if (styleRef !== undefined) {
      sheet.styleRef = styleRef
    }

    if (fabricSource !== undefined) {
      if (!['tradio', 'buyer', 'manufacturer'].includes(fabricSource)) return res.status(400).json({ error: 'Invalid fabricSource' })
      sheet.fabricSource = fabricSource
    }
    if (currency !== undefined) sheet.currency = currency
    if (fabric !== undefined) {
      if (fabric.wastagePct != null && Number(fabric.wastagePct) < 0)
        return res.status(400).json({ error: 'Wastage % must be a non-negative number' })
      sheet.fabric = {
        name: fabric.name || '', unit: fabric.unit || '',
        consumption: fabric.consumption != null ? Number(fabric.consumption) : null,
        rate: fabric.rate != null ? Number(fabric.rate) : null,
        wastagePct: fabric.wastagePct != null ? Number(fabric.wastagePct) : 0,
        supplier: fabric.supplier || '',
        materialRequirementId: fabric.materialRequirementId || sheet.fabric?.materialRequirementId || null,
        materialRequirementLineId: fabric.materialRequirementLineId || sheet.fabric?.materialRequirementLineId || null,
      }
    }
    if (processLines !== undefined) sheet.process = validateLines(processLines)
    if (trims !== undefined) sheet.trims = validateLines(trims)
    if (labelsPackaging !== undefined) sheet.labelsPackaging = validateLines(labelsPackaging)
    if (extraLines !== undefined) {
      for (const l of extraLines) if (!['material', 'labour'].includes(l.group)) return res.status(400).json({ error: 'Invalid extraLines group' })
      sheet.extraLines = validateLines(extraLines).map((l, i) => ({ ...l, group: extraLines[i].group }))
    }
    if (labour !== undefined) {
      sheet.labour = {
        cuttingThreads: Number(labour.cuttingThreads) || 0,
        making: Number(labour.making) || 0,
        finishingPacking: Number(labour.finishingPacking) || 0,
      }
    }
    if (overheadPct !== undefined) sheet.overheadPct = Number(overheadPct)
    if (rejectionPct !== undefined) sheet.rejectionPct = Number(rejectionPct)
    if (mfrMarginPct !== undefined) sheet.mfrMarginPct = mfrMarginPct === null || mfrMarginPct === '' ? null : Number(mfrMarginPct)

    await sheet.save()
    await AuditLog.create({ byUser: req.user.id, action: 'Cost Sheet Saved', detail: `${orderId || mfrProjectId} (${sheet.mfrId})` })
    const body = enrichCostSheet(sheet.toObject(), req.user)
    body.consumptionWarning = await computeConsumptionWarning(sheet.toObject())
    res.json(body)
  } catch (err) {
    console.error('[costing]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// Real cost sheets are visibly reused across similar style variants (§8.4 of
// the plan) — copies content fields onto a NEW scope for the SAME
// manufacturer, resetting status to draft and never carrying over margin/fee/
// negotiated-price (those are the whole point of never being silently
// inherited). Requires a target — copying the source scope's own key verbatim
// would 500 on the unique index every time, and the point is a different
// style (§1d: one Order = one product).
router.post('/cost-sheets/:id/duplicate', requireAuth, async (req, res) => {
  try {
    const source = await CostSheet.findById(req.params.id)
    if (!source) return res.status(404).json({ error: 'Cost sheet not found' })
    const accessErr = await assertCostSheetAccess(req.user, source)
    if (accessErr) return res.status(accessErr.status).json({ error: accessErr.error })

    const { targetOrderId, targetMfrProjectId, styleRef } = req.body
    if (!targetOrderId && !targetMfrProjectId) return res.status(400).json({ error: 'targetOrderId or targetMfrProjectId is required' })
    if (targetOrderId && targetMfrProjectId) return res.status(400).json({ error: 'Provide exactly one target' })
    const targetScopeType = targetOrderId ? 'tradio_order' : 'mfr_project'

    try {
      await assertScopeShape(targetScopeType, targetOrderId || null, targetMfrProjectId || null, req.user)
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message })
    }

    // Same write-permission shape as POST /cost-sheets above — a manufacturer
    // may only duplicate their own sheet; only master admin may act on
    // another manufacturer's behalf. For mfr_project targets, assertScopeShape
    // already refused any caller who doesn't own that project (no admin
    // override, ever), so these checks only add anything for tradio_order.
    const isMaster = req.user.role === 'admin' && req.user.adminType === 'master'
    if (req.user.role === 'manufacturer' && String(source.mfrId) !== req.user.id)
      return res.status(403).json({ error: 'Forbidden' })
    if (req.user.role === 'admin' && !isMaster)
      return res.status(403).json({ error: 'Master admin only' })
    if (targetScopeType === 'tradio_order' && req.user.role !== 'admin' && req.user.role !== 'manufacturer')
      return res.status(403).json({ error: 'Forbidden' })

    const targetFilter = targetScopeType === 'tradio_order'
      ? { scopeType: targetScopeType, orderId: targetOrderId, mfrId: source.mfrId }
      : { scopeType: targetScopeType, mfrProjectId: targetMfrProjectId, mfrId: source.mfrId }

    const existing = await CostSheet.findOne(targetFilter, '_id').lean()
    if (existing) return res.status(400).json({ error: 'A cost sheet already exists for that scope' })

    const dup = new CostSheet({
      ...targetFilter,
      createdBy: req.user.id,
      styleRef: styleRef || source.styleRef,
      fabricSource: source.fabricSource,
      currency: source.currency,
      fabric: {
        name: source.fabric?.name || '', unit: source.fabric?.unit || '',
        consumption: source.fabric?.consumption ?? null, rate: source.fabric?.rate ?? null,
        wastagePct: source.fabric?.wastagePct || 0,
        supplier: source.fabric?.supplier || '',
        // Provenance does NOT carry over — a different scope has a different
        // (or no) MaterialRequirement, the old join key would resolve wrong.
        materialRequirementId: null, materialRequirementLineId: null,
      },
      process: source.process, trims: source.trims, labelsPackaging: source.labelsPackaging, extraLines: source.extraLines,
      labour: source.labour, overheadPct: source.overheadPct, rejectionPct: source.rejectionPct,
      // mfrMarginPct is content, not master-only (same category as overheadPct/
      // rejectionPct above) — it carries over. status defaults to 'draft';
      // marginPct/tradioFeePct/finalNegotiatedPrice/negotiatedDiscountPct (the
      // MASTER-only Tradio block) all default to null — never copied from source.
      mfrMarginPct: source.mfrMarginPct ?? null,
    })
    await dup.save()
    await AuditLog.create({ byUser: req.user.id, action: 'Cost Sheet Duplicated', detail: `${req.params.id} -> ${targetOrderId || targetMfrProjectId} (${dup.mfrId})` })
    res.status(201).json(enrichCostSheet(dup.toObject(), req.user))
  } catch (err) {
    console.error('[costing]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

function validateLines(lines) {
  if (!Array.isArray(lines)) throw Object.assign(new Error('Expected an array of lines'), { status: 400 })
  return lines.map(l => ({ label: String(l.label || '').slice(0, 200), supplier: String(l.supplier || '').slice(0, 200), value: Number(l.value) || 0 }))
}

// Master-only: the margin/fee/negotiated-price layer. Never touched by the
// general content route above, regardless of caller.
router.post('/cost-sheets/:id/margin', requireAuth, requireMaster, async (req, res) => {
  try {
    const sheet = await CostSheet.findById(req.params.id)
    if (!sheet) return res.status(404).json({ error: 'Cost sheet not found' })
    if (sheet.scopeType === 'mfr_project')
      return res.status(400).json({ error: 'Margin does not apply to a non-Tradio project' })

    const { marginPct, tradioFeePct, finalNegotiatedPrice, negotiatedDiscountPct } = req.body
    if (marginPct !== undefined) sheet.marginPct = marginPct === null ? null : Number(marginPct)
    if (tradioFeePct !== undefined) sheet.tradioFeePct = tradioFeePct === null ? null : Number(tradioFeePct)
    if (finalNegotiatedPrice !== undefined) sheet.finalNegotiatedPrice = finalNegotiatedPrice === null ? null : Number(finalNegotiatedPrice)
    if (negotiatedDiscountPct !== undefined) sheet.negotiatedDiscountPct = negotiatedDiscountPct === null ? null : Number(negotiatedDiscountPct)

    await sheet.save()
    // Dedicated audit entry — the single most commercially sensitive field in
    // this feature gets its own trail, not folded into the generic write log.
    await AuditLog.create({ byUser: req.user.id, action: 'Cost Sheet Margin Set', detail: `${sheet.orderId}: marginPct=${sheet.marginPct}, tradioFeePct=${sheet.tradioFeePct}, finalPrice=${sheet.finalNegotiatedPrice}` })
    res.json(enrichCostSheet(sheet.toObject(), req.user))
  } catch (err) {
    console.error('[costing]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// Actuals — the entire moat-capture payload (§1e). Deliberately its own route,
// exempt from the submit content-lock: actuals by definition arrive AFTER
// production, i.e. after the sheet is already submitted (or even approved).
router.post('/cost-sheets/:id/actuals', requireAuth, async (req, res) => {
  try {
    const sheet = await CostSheet.findById(req.params.id)
    if (!sheet) return res.status(404).json({ error: 'Cost sheet not found' })
    const isMaster = req.user.role === 'admin' && req.user.adminType === 'master'
    const isOwner = req.user.role === 'manufacturer' && String(sheet.mfrId) === req.user.id
    if (!isMaster && !isOwner) return res.status(403).json({ error: 'Forbidden' })
    if (!['submitted', 'approved'].includes(sheet.status))
      return res.status(400).json({ error: 'Actuals can only be recorded once a sheet has been submitted' })

    const { actualFabricConsumption, actualLabourCost, actualRejectionValue } = req.body
    if (actualFabricConsumption !== undefined) sheet.actualFabricConsumption = actualFabricConsumption === null ? null : Number(actualFabricConsumption)
    if (actualLabourCost !== undefined) sheet.actualLabourCost = actualLabourCost === null ? null : Number(actualLabourCost)
    if (actualRejectionValue !== undefined) sheet.actualRejectionValue = actualRejectionValue === null ? null : Number(actualRejectionValue)

    await sheet.save()
    await AuditLog.create({ byUser: req.user.id, action: 'Cost Sheet Actuals Recorded', detail: `${sheet.orderId || sheet.mfrProjectId}: fabric=${sheet.actualFabricConsumption}` })
    res.json(enrichCostSheet(sheet.toObject(), req.user))
  } catch (err) {
    console.error('[costing]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// draft -> submitted. Manufacturer on their own sheet, or master on any
// (mirrors their content-authoring power).
router.post('/cost-sheets/:id/submit', requireAuth, async (req, res) => {
  try {
    const sheet = await CostSheet.findById(req.params.id)
    if (!sheet) return res.status(404).json({ error: 'Cost sheet not found' })
    const isMaster = req.user.role === 'admin' && req.user.adminType === 'master'
    const isOwner = req.user.role === 'manufacturer' && String(sheet.mfrId) === req.user.id
    if (!isMaster && !isOwner) return res.status(403).json({ error: 'Forbidden' })
    if (sheet.status !== 'draft') return res.status(400).json({ error: `Cannot submit from status "${sheet.status}"` })

    sheet.status = 'submitted'
    sheet.submittedAt = new Date()
    sheet.submittedBy = req.user.id
    await sheet.save()
    await AuditLog.create({ byUser: req.user.id, action: 'Cost Sheet Submitted', detail: `${sheet.orderId || sheet.mfrProjectId} (${sheet.mfrId})` })

    // The single biggest workflow gap without this: nothing tells master admin
    // a submission is waiting. Same escalate-route pattern already used
    // elsewhere in this codebase (orders.js) — every master, one Notification
    // each. mfr_project has no master-admin step, so nothing to notify there.
    if (sheet.scopeType === 'tradio_order') {
      const masters = await User.find({ role: 'admin', adminType: 'master', isActive: true }, '_id').lean()
      if (masters.length) {
        await Notification.insertMany(masters.map(m => ({
          toUser: m._id, type: 'alert',
          msg: `Cost sheet submitted for review: ${sheet.orderId} (${req.user.name || req.user.email})`,
          orderId: sheet.orderId, isRead: false,
        })))
      }
    }

    res.json(enrichCostSheet(sheet.toObject(), req.user))
  } catch (err) {
    console.error('[costing]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// submitted -> draft, manufacturer's own self-service undo. Only from
// submitted, never approved — once master admin has acted, reopening is
// their call, not the manufacturer's to yank back.
router.post('/cost-sheets/:id/withdraw', requireAuth, async (req, res) => {
  try {
    const sheet = await CostSheet.findById(req.params.id)
    if (!sheet) return res.status(404).json({ error: 'Cost sheet not found' })
    const isOwner = req.user.role === 'manufacturer' && String(sheet.mfrId) === req.user.id
    if (!isOwner) return res.status(403).json({ error: 'Forbidden' })
    if (sheet.status !== 'submitted') return res.status(400).json({ error: `Cannot withdraw from status "${sheet.status}"` })

    sheet.status = 'draft'
    sheet.submittedAt = null
    sheet.submittedBy = null
    await sheet.save()
    await AuditLog.create({ byUser: req.user.id, action: 'Cost Sheet Withdrawn', detail: `${sheet.orderId || sheet.mfrProjectId} (${sheet.mfrId})` })
    res.json(enrichCostSheet(sheet.toObject(), req.user))
  } catch (err) {
    console.error('[costing]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// submitted -> approved. tradio_order: master admin only. mfr_project: owner
// self-approves — there's no Tradio party in a non-Tradio deal.
router.post('/cost-sheets/:id/approve', requireAuth, async (req, res) => {
  try {
    const sheet = await CostSheet.findById(req.params.id)
    if (!sheet) return res.status(404).json({ error: 'Cost sheet not found' })

    if (sheet.scopeType === 'tradio_order') {
      const isMaster = req.user.role === 'admin' && req.user.adminType === 'master'
      if (!isMaster) return res.status(403).json({ error: 'Master admin only' })
    } else {
      const isOwner = req.user.role === 'manufacturer' && String(sheet.mfrId) === req.user.id
      if (!isOwner) return res.status(403).json({ error: 'Forbidden' })
    }
    if (sheet.status !== 'submitted' && !(sheet.status === 'draft' && req.user.role === 'admin'))
      return res.status(400).json({ error: `Cannot approve from status "${sheet.status}"` })

    sheet.status = 'approved'
    sheet.approvedAt = new Date()
    sheet.approvedBy = req.user.id
    await sheet.save()
    await AuditLog.create({ byUser: req.user.id, action: 'Cost Sheet Approved', detail: `${sheet.orderId || sheet.mfrProjectId} (${sheet.mfrId})` })
    res.json(enrichCostSheet(sheet.toObject(), req.user))
  } catch (err) {
    console.error('[costing]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── Phase 2: downloadable Excel, for offline buyer sharing ─────────────────
// The whole point of this route is that it can NEVER show more than the
// on-screen view would — so it builds its rows from enrichCostSheet's own
// output, the same function the read API uses, rather than a second,
// independently-written field list that could quietly drift out of sync.
router.get('/cost-sheets/:id/export.xlsx', requireAuth, async (req, res) => {
  try {
    const sheet = await CostSheet.findById(req.params.id).lean()
    if (!sheet) return res.status(404).json({ error: 'Cost sheet not found' })
    const denied = await assertCostSheetAccess(req.user, sheet)
    if (denied) return res.status(denied.status).json({ error: denied.error })

    // ?view=internal is permission-checked server-side, never client-trusted —
    // only an admin who already has full read access can ask for their own
    // full-detail copy. Anyone else gets exactly what their normal enrichCostSheet
    // read would show, same as the on-screen view.
    const wantsInternal = req.query.view === 'internal'
    if (wantsInternal && req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' })
    const data = enrichCostSheet(sheet, wantsInternal ? { role: 'admin' } : req.user)

    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Cost Sheet')
    ws.columns = [{ width: 32 }, { width: 18 }]

    const addRow = (label, value, opts = {}) => {
      const row = ws.addRow([label, value])
      if (opts.bold) row.font = { bold: true }
      if (opts.section) { row.font = { bold: true }; row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } } }
    }

    if (data.finalNegotiatedPrice !== undefined && data.fabric === undefined) {
      // Buyer view — nothing but the approved final price, ever.
      ws.addRow(['Order', data.orderId || ''])
      ws.addRow(['Status', data.status])
      addRow('Final Price', `${data.currency || 'INR'} ${data.finalNegotiatedPrice ?? '—'}`, { bold: true })
    } else {
      ws.addRow(['Order/Project', data.orderId || data.mfrProjectId || ''])
      ws.addRow(['Style Ref', data.styleRef || ''])
      ws.addRow(['Status', data.status])
      ws.addRow([])
      addRow('RAW MATERIAL', '', { section: true })
      addRow('Fabric', data.fabricValue?.toFixed(2) ?? '0.00')
      if (data.fabric?.wastagePct > 0) ws.addRow([`  (includes +${data.fabric.wastagePct}% wastage)`, ''])
      const lineLabel = l => `  ${l.label}${l.supplier ? ` — ${l.supplier}` : ''}`
      for (const l of data.process || []) ws.addRow([lineLabel(l), l.value])
      for (const l of data.trims || []) ws.addRow([lineLabel(l), l.value])
      for (const l of data.labelsPackaging || []) ws.addRow([lineLabel(l), l.value])
      for (const l of (data.extraLines || []).filter(l => l.group === 'material')) ws.addRow([lineLabel(l), l.value])
      addRow('Raw Material Total', data.rawMaterialTotal?.toFixed(2), { bold: true })
      ws.addRow([])
      addRow('LABOUR', '', { section: true })
      ws.addRow(['Cutting & Threads', data.labour?.cuttingThreads ?? 0])
      ws.addRow(['Making', data.labour?.making ?? 0])
      ws.addRow(['Finishing & Packing', data.labour?.finishingPacking ?? 0])
      for (const l of (data.extraLines || []).filter(l => l.group === 'labour')) ws.addRow([`  ${l.label}`, l.value])
      addRow('Labour Total', data.labourTotal?.toFixed(2), { bold: true })
      ws.addRow([])
      addRow('Total Labour & Raw Material', data.totalLabourAndRawMaterial?.toFixed(2), { bold: true })
      ws.addRow([`Overhead @${data.overheadPct}%`, data.overheadValue?.toFixed(2)])
      ws.addRow([`Rejection @${data.rejectionPct}%`, data.rejectionValue?.toFixed(2)])
      addRow('Your Base Cost', data.baseCost?.toFixed(2), { bold: true })
      if (data.mfrMarginPct != null) {
        ws.addRow([`Your Margin @${data.mfrMarginPct}%`, data.mfrMarginValue?.toFixed(2) ?? '—'])
        addRow('Your Price', data.mfrSellPrice?.toFixed(2) ?? '—', { bold: true })
      }

      // Tradio's margin/fee/price — internal view only. Absent entirely from `data` for
      // a manufacturer viewer, so this block simply never executes for them —
      // no separate check needed here, enrichCostSheet already decided it.
      if (data.marginPct !== undefined) {
        ws.addRow([])
        addRow('COMMERCIAL (INTERNAL ONLY)', '', { section: true })
        ws.addRow([`Margin (Factory) @${data.marginPct ?? '—'}%`, data.marginValue?.toFixed(2) ?? '—'])
        ws.addRow([`Tradio Fee @${data.tradioFeePct ?? '—'}%`, data.tradioFeeValue?.toFixed(2) ?? '—'])
        addRow('Price', data.price?.toFixed(2) ?? '—', { bold: true })
        addRow('Final Negotiated Price', data.finalNegotiatedPrice?.toFixed?.(2) ?? data.finalNegotiatedPrice ?? '—', { bold: true })
        ws.addRow(['Percentage (discount)', data.negotiatedDiscountPct ?? '—'])
      }
    }

    const buffer = await wb.xlsx.writeBuffer()
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="cost-sheet-${sheet._id}.xlsx"`)
    res.send(Buffer.from(buffer))
  } catch (err) {
    console.error('[costing]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

export default router
export { assertCostSheetAccess, enrichCostSheet }
