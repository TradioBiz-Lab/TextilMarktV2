import { Router } from 'express'
import mongoose from 'mongoose'
import rateLimit from 'express-rate-limit'
import { MaterialDefinition, MaterialRequirement, Order, AuditLog, Notification } from '../db/index.js'
import { REQUIREMENT_CATEGORIES } from '../models/MaterialRequirement.js'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import { assertScopeShape } from '../lib/scopeAccess.js'

const skipInTest = () => process.env.NODE_ENV === 'test'
const requirementsBulkLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 30,
  keyGenerator: req => req.user?.id || req.ip,
  message: { error: 'Too many bulk requirement upload requests. Please wait.' },
  standardHeaders: true, legacyHeaders: false, validate: false, skip: skipInTest,
})

const router = Router()

// ── MaterialDefinition — the catalog ────────────────────────────────────────

router.get('/material-definitions', requireAuth, async (req, res) => {
  try {
    const query = { isActive: true }
    if (req.query.category) query.category = req.query.category
    const defs = await MaterialDefinition.find(query).sort({ name: 1 }).lean()
    res.json(defs.map(d => ({
      id: d._id.toString(), name: d.name, category: d.category,
      defaultUnit: d.defaultUnit || '', defaultSupplier: d.defaultSupplier || '', spec: d.spec || '',
    })))
  } catch (err) {
    console.error('[materials]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

router.post('/material-definitions', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { name, category, defaultUnit, defaultSupplier, spec } = req.body
    if (!name?.trim()) return res.status(400).json({ error: 'Name is required' })
    if (!['fabric', 'trim', 'accessory', 'other'].includes(category))
      return res.status(400).json({ error: 'Invalid category' })
    const def = await MaterialDefinition.create({
      name: name.trim().slice(0, 200), category,
      defaultUnit: defaultUnit || '', defaultSupplier: defaultSupplier || '', spec: (spec || '').slice(0, 500),
      createdBy: req.user.id,
    })
    res.status(201).json({ id: def._id.toString(), name: def.name, category: def.category, defaultUnit: def.defaultUnit, defaultSupplier: def.defaultSupplier, spec: def.spec })
  } catch (err) {
    console.error('[materials]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

router.post('/material-definitions/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const def = await MaterialDefinition.findById(req.params.id)
    if (!def || !def.isActive) return res.status(404).json({ error: 'Material definition not found' })
    const { name, category, defaultUnit, defaultSupplier, spec, isActive } = req.body
    if (name !== undefined) {
      if (!name.trim()) return res.status(400).json({ error: 'Name is required' })
      def.name = name.trim().slice(0, 200)
    }
    if (category !== undefined) {
      if (!['fabric', 'trim', 'accessory', 'other'].includes(category)) return res.status(400).json({ error: 'Invalid category' })
      def.category = category
    }
    if (defaultUnit !== undefined) def.defaultUnit = defaultUnit
    if (defaultSupplier !== undefined) def.defaultSupplier = defaultSupplier
    if (spec !== undefined) def.spec = spec.slice(0, 500)
    if (isActive !== undefined) def.isActive = !!isActive
    await def.save()
    res.json({ id: def._id.toString(), name: def.name, category: def.category, defaultUnit: def.defaultUnit, defaultSupplier: def.defaultSupplier, spec: def.spec })
  } catch (err) {
    console.error('[materials]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── MaterialRequirement — the planning layer ───────────────────────────────
// Phase 1 scope: catalog + content authoring only. The push-to-stage action
// (record-push) and PO generation are Phase 2 — see the plan.

const mapLine = l => ({
  id: l._id.toString(), category: l.category, name: l.name,
  materialDefinitionId: l.materialDefinitionId ? l.materialDefinitionId.toString() : null,
  colourway: l.colourway || '', requiredQty: l.requiredQty, unit: l.unit || '',
  supplier: l.supplier || '', note: l.note || '',
  wastagePct: l.wastagePct || 0, rate: l.rate ?? null,
  // Quantity to actually order, grossed up for wastage — derived, never stored
  // (same discipline as CostSheet's computed totals).
  qtyToOrder: Math.round((l.requiredQty * (1 + (l.wastagePct || 0) / 100)) * 1000) / 1000,
  status: l.status, orderedQty: l.orderedQty, receivedQty: l.receivedQty, poNumber: l.poNumber || '',
  pushedTo: (l.pushedTo || []).map(p => ({
    mfrId: p.mfrId.toString(), stageIndex: p.stageIndex, materialLineId: p.materialLineId.toString(), pushedAt: p.pushedAt,
  })),
})

// Manufacturer viewers on tradio_order scope only ever see lines pushed to
// them — the direct analogue of enrichOrder's viewerMfrId stripping.
//
// tradio_order lines derive status/orderedQty/receivedQty/poNumber from the
// pushed stage material line, never from their own stored fields (which stay
// at schema defaults and would otherwise silently drift out of sync with the
// real receiving state the moment anyone marks a line ordered/received on
// the stage side) — "derive, don't duplicate," same discipline this app
// already applies to etaVarianceDays. That means this is async: resolving a
// pushed line's live status requires reading the Order it was pushed onto.
async function enrichMaterialRequirement(doc, viewer) {
  const base = {
    id: doc._id ? doc._id.toString() : null, scopeType: doc.scopeType,
    orderId: doc.orderId || null, mfrProjectId: doc.mfrProjectId ? doc.mfrProjectId.toString() : null,
  }

  let order = null
  if (doc.scopeType === 'tradio_order' && doc.orderId && (doc.lines || []).some(l => (l.pushedTo || []).length > 0)) {
    order = await Order.findById(doc.orderId, 'assignments.mfrId assignments.stages.materials').lean()
  }

  // viewerMfrId narrows which push-target's live status to resolve against,
  // for the manufacturer's own filtered view — a line pushed to more than
  // one manufacturer on a split order must never resolve against a DIFFERENT
  // manufacturer's stage. Admin/buyer (viewerMfrId null) resolve against the
  // first push overall, since they see every push target already.
  function resolveLine(l, viewerMfrId) {
    const mapped = mapLine(l)
    if (!order) return mapped
    const relevant = viewerMfrId ? mapped.pushedTo.filter(p => p.mfrId === viewerMfrId) : mapped.pushedTo
    const push = relevant[0]
    if (!push) return mapped
    const asgn = (order.assignments || []).find(a => String(a.mfrId) === String(push.mfrId))
    const stage = asgn?.stages?.[push.stageIndex]
    const material = (stage?.materials || []).find(m => String(m._id) === String(push.materialLineId))
    if (!material) return mapped
    return { ...mapped, status: material.status, orderedQty: material.orderedQty, receivedQty: material.receivedQty, poNumber: material.poNumber || '' }
  }

  if (doc.scopeType === 'mfr_project' || viewer.role === 'admin' || viewer.role === 'buyer') {
    return { ...base, lines: (doc.lines || []).map(l => resolveLine(l, null)) }
  }
  // manufacturer, tradio_order scope
  const mine = (doc.lines || []).filter(l => (l.pushedTo || []).some(p => String(p.mfrId) === String(viewer.id)))
  return {
    ...base,
    lines: mine.map(l => ({
      ...resolveLine(l, String(viewer.id)),
      pushedTo: l.pushedTo.filter(p => String(p.mfrId) === String(viewer.id)).map(p => ({
        mfrId: p.mfrId.toString(), stageIndex: p.stageIndex, materialLineId: p.materialLineId.toString(), pushedAt: p.pushedAt,
      })),
    })),
  }
}

async function loadRequirementForRead(req, res) {
  const { orderId, mfrProjectId } = req.query
  if (!orderId && !mfrProjectId) { res.status(400).json({ error: 'orderId or mfrProjectId is required' }); return null }

  if (orderId) {
    const order = await Order.findById(orderId, 'buyerId assignments.mfrId').lean()
    if (!order) { res.status(404).json({ error: 'Order not found' }); return null }
    if (req.user.role === 'buyer' && String(order.buyerId) !== req.user.id) { res.status(403).json({ error: 'Forbidden' }); return null }
    if (req.user.role === 'manufacturer') {
      const assigned = (order.assignments || []).some(a => String(a.mfrId) === req.user.id)
      if (!assigned) { res.status(403).json({ error: 'Forbidden' }); return null }
    }
    const doc = await MaterialRequirement.findOne({ scopeType: 'tradio_order', orderId }).lean()
    return doc || { scopeType: 'tradio_order', orderId, lines: [] }
  }

  if (req.user.role !== 'manufacturer') { res.status(403).json({ error: 'Forbidden' }); return null }
  const project = await mongoose.model('MfrProject').findById(mfrProjectId, 'mfrId').lean()
  if (!project) { res.status(404).json({ error: 'Project not found' }); return null }
  if (String(project.mfrId) !== req.user.id) { res.status(403).json({ error: 'Forbidden' }); return null }
  const doc = await MaterialRequirement.findOne({ scopeType: 'mfr_project', mfrProjectId }).lean()
  return doc || { scopeType: 'mfr_project', mfrProjectId, lines: [] }
}

router.get('/material-requirements', requireAuth, async (req, res) => {
  try {
    const doc = await loadRequirementForRead(req, res)
    if (!doc) return // response already sent
    res.json(await enrichMaterialRequirement(doc, req.user))
  } catch (err) {
    console.error('[materials]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// Find-or-create the one document for this scope, then push a line — an
// upsert, since exactly one MaterialRequirement exists per scope (§1c).
async function addLine(req, res) {
  try {
    const { scopeType, orderId, mfrProjectId, category, name, materialDefinitionId, colourway, requiredQty, unit, supplier, wastagePct, rate, note } = req.body

    try {
      await assertScopeShape(scopeType, orderId, mfrProjectId, req.user)
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message })
    }
    // Explicit deny, load-bearing — matches orders.js's materials-route convention.
    if (req.user.role === 'buyer') return res.status(403).json({ error: 'Buyers cannot manage material requirements' })
    if (scopeType === 'tradio_order' && req.user.role !== 'admin')
      return res.status(403).json({ error: 'Only an admin can manage material requirements on a Tradio order' })
    // mfr_project: assertScopeShape already confirmed ownership above.

    if (!name?.trim()) return res.status(400).json({ error: 'Material name is required' })
    if (!REQUIREMENT_CATEGORIES.includes(category)) return res.status(400).json({ error: 'Invalid category' })
    const reqQty = parseFloat(requiredQty)
    if (isNaN(reqQty) || reqQty < 0) return res.status(400).json({ error: 'Required quantity must be a non-negative number' })
    let wastage = 0
    if (wastagePct !== undefined && wastagePct !== null && wastagePct !== '') {
      wastage = parseFloat(wastagePct)
      if (isNaN(wastage) || wastage < 0) return res.status(400).json({ error: 'Wastage % must be a non-negative number' })
    }
    let parsedRate = null
    if (rate !== undefined && rate !== null && rate !== '') {
      parsedRate = parseFloat(rate)
      if (isNaN(parsedRate) || parsedRate < 0) return res.status(400).json({ error: 'Rate must be a non-negative number' })
    }

    const line = {
      category, name: name.trim().slice(0, 200),
      materialDefinitionId: materialDefinitionId || null, colourway: colourway || '',
      requiredQty: reqQty, unit: unit || '', supplier: supplier || '',
      wastagePct: wastage, rate: parsedRate, note: note || '',
    }

    const filter = scopeType === 'tradio_order' ? { scopeType, orderId } : { scopeType, mfrProjectId }
    const doc = await MaterialRequirement.findOneAndUpdate(
      filter,
      { $push: { lines: line }, $setOnInsert: { createdBy: req.user.id } },
      { upsert: true, new: true }
    ).lean()

    await AuditLog.create({ byUser: req.user.id, action: 'Material Requirement Line Added', detail: `${scopeType === 'tradio_order' ? orderId : mfrProjectId}: added "${line.name}"` })
    res.json(await enrichMaterialRequirement(doc, req.user))
  } catch (err) {
    console.error('[materials]', err)
    res.status(500).json({ error: 'Server error' })
  }
}
router.post('/material-requirements', requireAuth, addLine)

// CSV-driven bulk import of requirement lines onto existing orders' planning
// docs, keyed by orderId — mirrors orders.js's /materials/bulk shape (same
// validate-every-row-first, all-or-nothing-per-row, {total,created,failed,
// results} response). Admin-only (§8.6) — this is authoring the Tradio-order
// planning layer, same restriction as the single-line route above; a
// manufacturer's own mfr_project lines are few enough not to need this.
router.post('/material-requirements/bulk', requireAuth, requireAdmin, requirementsBulkLimiter, async (req, res) => {
  try {
    const { rows } = req.body
    if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'At least one row is required' })
    if (rows.length > 200) return res.status(400).json({ error: 'Too many rows (max 200 per bulk upload)' })

    const results = []
    let created = 0, failed = 0

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      try {
        const { orderId, category, name, requiredQty, unit, supplier, colourway } = row
        if (!orderId || !name) {
          failed++; results.push({ row: i, success: false, error: 'orderId and name are required' }); continue
        }
        const reqQty = parseFloat(requiredQty)
        if (isNaN(reqQty) || reqQty < 0) {
          failed++; results.push({ row: i, success: false, error: 'Required quantity must be a non-negative number' }); continue
        }
        const cat = category || 'other'
        if (!REQUIREMENT_CATEGORIES.includes(cat)) {
          failed++; results.push({ row: i, success: false, error: `Invalid category "${category}"` }); continue
        }
        const order = await Order.exists({ _id: orderId })
        if (!order) { failed++; results.push({ row: i, success: false, error: `Order "${orderId}" not found` }); continue }

        const line = {
          category: cat, name: String(name).trim().slice(0, 200),
          colourway: colourway || '', requiredQty: reqQty, unit: unit || '', supplier: supplier || '',
        }
        await MaterialRequirement.findOneAndUpdate(
          { scopeType: 'tradio_order', orderId },
          { $push: { lines: line }, $setOnInsert: { createdBy: req.user.id } },
          { upsert: true }
        )
        created++
        results.push({ row: i, success: true })
      } catch (err) {
        failed++
        results.push({ row: i, success: false, error: 'Server error creating this row' })
      }
    }

    await AuditLog.create({ byUser: req.user.id, action: 'Bulk Material Requirements Upload', detail: `${created} created, ${failed} failed` })
    res.status(200).json({ total: rows.length, created, failed, results })
  } catch (err) {
    console.error('[materials]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

router.post('/material-requirements/:id/lines/:lineId', requireAuth, async (req, res) => {
  try {
    const doc = await MaterialRequirement.findById(req.params.id)
    if (!doc) return res.status(404).json({ error: 'Requirement not found' })

    if (req.user.role === 'buyer') return res.status(403).json({ error: 'Buyers cannot manage material requirements' })
    if (doc.scopeType === 'tradio_order' && req.user.role !== 'admin')
      return res.status(403).json({ error: 'Only an admin can manage material requirements on a Tradio order' })
    if (doc.scopeType === 'mfr_project') {
      const project = await mongoose.model('MfrProject').findById(doc.mfrProjectId, 'mfrId').lean()
      if (!project || String(project.mfrId) !== req.user.id) return res.status(403).json({ error: 'Forbidden' })
    }

    const line = doc.lines.id(req.params.lineId)
    if (!line) return res.status(404).json({ error: 'Line not found' })

    const { category, name, colourway, requiredQty, unit, supplier, wastagePct, rate, note } = req.body
    if (category !== undefined) {
      if (!REQUIREMENT_CATEGORIES.includes(category)) return res.status(400).json({ error: 'Invalid category' })
      line.category = category
    }
    if (name !== undefined) {
      if (!name.trim()) return res.status(400).json({ error: 'Material name is required' })
      line.name = name.trim().slice(0, 200)
    }
    if (colourway !== undefined) line.colourway = colourway
    if (requiredQty !== undefined) {
      const q = parseFloat(requiredQty)
      if (isNaN(q) || q < 0) return res.status(400).json({ error: 'Required quantity must be a non-negative number' })
      line.requiredQty = q
    }
    if (unit !== undefined) line.unit = unit
    if (supplier !== undefined) line.supplier = supplier
    if (wastagePct !== undefined) {
      const w = wastagePct === null || wastagePct === '' ? 0 : parseFloat(wastagePct)
      if (isNaN(w) || w < 0) return res.status(400).json({ error: 'Wastage % must be a non-negative number' })
      line.wastagePct = w
    }
    if (rate !== undefined) {
      if (rate === null || rate === '') { line.rate = null }
      else {
        const r = parseFloat(rate)
        if (isNaN(r) || r < 0) return res.status(400).json({ error: 'Rate must be a non-negative number' })
        line.rate = r
      }
    }
    if (note !== undefined) line.note = note

    await doc.save()
    await AuditLog.create({ byUser: req.user.id, action: 'Material Requirement Line Updated', detail: `${doc.orderId || doc.mfrProjectId}: "${line.name}"` })
    res.json(await enrichMaterialRequirement(doc.toObject(), req.user))
  } catch (err) {
    console.error('[materials]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

router.post('/material-requirements/:id/lines/:lineId/delete', requireAuth, async (req, res) => {
  try {
    const doc = await MaterialRequirement.findById(req.params.id)
    if (!doc) return res.status(404).json({ error: 'Requirement not found' })

    if (req.user.role === 'buyer') return res.status(403).json({ error: 'Buyers cannot manage material requirements' })
    if (doc.scopeType === 'tradio_order' && req.user.role !== 'admin')
      return res.status(403).json({ error: 'Only an admin can manage material requirements on a Tradio order' })
    if (doc.scopeType === 'mfr_project') {
      const project = await mongoose.model('MfrProject').findById(doc.mfrProjectId, 'mfrId').lean()
      if (!project || String(project.mfrId) !== req.user.id) return res.status(403).json({ error: 'Forbidden' })
    }

    const line = doc.lines.id(req.params.lineId)
    if (!line) return res.status(404).json({ error: 'Line not found' })
    const name = line.name
    line.deleteOne()
    await doc.save()
    await AuditLog.create({ byUser: req.user.id, action: 'Material Requirement Line Deleted', detail: `${doc.orderId || doc.mfrProjectId}: "${name}"` })
    res.json(await enrichMaterialRequirement(doc.toObject(), req.user))
  } catch (err) {
    console.error('[materials]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── Phase 2: push a requirement line onto a real TNA stage ─────────────────
// Server-side and atomic — one request, one handler — rather than the
// frontend-orchestrated addStageMaterial-then-record-push originally sketched:
// a failed second call there would leave an orphan stage material line with
// no pushedTo record, and that phantom line still blocks the stage via the
// existing materials-received gate. Fabric requirements push to whichever
// stage the admin identifies as that order's fabric-sourcing stage, trims to
// its trims-ordering stage — same generic action either way, no name heuristic.
router.post('/material-requirements/:id/lines/:lineId/push', requireAuth, requireAdmin, async (req, res) => {
  try {
    const doc = await MaterialRequirement.findById(req.params.id)
    if (!doc) return res.status(404).json({ error: 'Requirement not found' })
    if (doc.scopeType !== 'tradio_order')
      return res.status(400).json({ error: 'Push only applies to Tradio-order requirements — a non-Tradio project has no TNA stages' })

    const line = doc.lines.id(req.params.lineId)
    if (!line) return res.status(404).json({ error: 'Line not found' })

    const { mfrId, stageIndex } = req.body
    if (!mongoose.Types.ObjectId.isValid(mfrId)) return res.status(400).json({ error: 'Invalid manufacturer ID' })
    const stageIdx = parseInt(stageIndex, 10)

    const order = await Order.findById(doc.orderId).lean()
    if (!order) return res.status(404).json({ error: 'Order not found' })
    const assignment = (order.assignments || []).find(a => String(a.mfrId) === String(mfrId))
    if (!assignment) return res.status(404).json({ error: 'That manufacturer is not assigned to this order' })
    const stageCount = assignment.stages?.length || 0
    if (isNaN(stageIdx) || stageIdx < 0 || stageIdx >= stageCount)
      return res.status(400).json({ error: `Invalid stage index (0–${stageCount - 1})` })

    const mfrObjectId = new mongoose.Types.ObjectId(mfrId)
    const newStageLine = {
      name: line.name, category: line.category, colourway: line.colourway || '',
      requiredQty: line.requiredQty, unit: line.unit || '', supplier: line.supplier || '',
      poNumber: '', expectedDate: null, status: 'pending', orderedQty: 0, receivedQty: 0, note: '',
    }

    // $push appends at the end — findOneAndUpdate is atomic per document, so
    // reading the last element back out is safe (no concurrent-write race).
    const updatedOrder = await Order.findOneAndUpdate(
      { _id: doc.orderId, 'assignments.mfrId': mfrObjectId },
      { $push: { [`assignments.$[asgn].stages.${stageIdx}.materials`]: newStageLine } },
      { arrayFilters: [{ 'asgn.mfrId': mfrObjectId }], new: true }
    ).lean()
    if (!updatedOrder) return res.status(404).json({ error: 'Order or assignment not found' })

    const updatedAsgn = updatedOrder.assignments.find(a => String(a.mfrId) === String(mfrId))
    const materials = updatedAsgn.stages[stageIdx].materials
    const newMaterialLineId = materials[materials.length - 1]._id

    line.pushedTo.push({ mfrId: mfrObjectId, stageIndex: stageIdx, materialLineId: newMaterialLineId, pushedAt: new Date(), pushedBy: req.user.id })
    await doc.save()

    await AuditLog.create({ byUser: req.user.id, action: 'Material Requirement Pushed to Stage', detail: `${doc.orderId}: "${line.name}" -> ${updatedAsgn.stages[stageIdx].name}` })
    await Notification.create({
      toUser: mfrId, type: 'order',
      msg: `New material requirement on ${doc.orderId}: "${line.name}" (${line.requiredQty} ${line.unit || ''}) added to ${updatedAsgn.stages[stageIdx].name}`,
      orderId: doc.orderId,
    })

    res.json(await enrichMaterialRequirement(doc.toObject(), req.user))
  } catch (err) {
    console.error('[materials]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── Clone a whole BOM to another product ────────────────────────────────────
// The "clone function" from the wizard's Materials step — authoring a BOM
// product-by-product doesn't mean retyping a near-identical one from scratch.
// Mirrors costing.js's /duplicate shape and reset rules exactly: content
// copies over, but pushedTo/status/PO fields never do (a new scope has no
// relationship yet to whatever stage the source was pushed onto).
router.post('/material-requirements/:id/duplicate', requireAuth, async (req, res) => {
  try {
    const source = await MaterialRequirement.findById(req.params.id).lean()
    if (!source) return res.status(404).json({ error: 'Requirement not found' })

    if (req.user.role === 'buyer') return res.status(403).json({ error: 'Buyers cannot manage material requirements' })
    if (source.scopeType === 'tradio_order' && req.user.role !== 'admin')
      return res.status(403).json({ error: 'Only an admin can manage material requirements on a Tradio order' })
    if (source.scopeType === 'mfr_project') {
      const project = await mongoose.model('MfrProject').findById(source.mfrProjectId, 'mfrId').lean()
      if (!project || String(project.mfrId) !== req.user.id) return res.status(403).json({ error: 'Forbidden' })
    }

    const { targetOrderId, targetMfrProjectId } = req.body
    if (!targetOrderId && !targetMfrProjectId) return res.status(400).json({ error: 'targetOrderId or targetMfrProjectId is required' })
    if (targetOrderId && targetMfrProjectId) return res.status(400).json({ error: 'Provide exactly one target' })
    const targetScopeType = targetOrderId ? 'tradio_order' : 'mfr_project'

    try {
      await assertScopeShape(targetScopeType, targetOrderId || null, targetMfrProjectId || null, req.user)
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message })
    }
    if (targetScopeType === 'tradio_order' && req.user.role !== 'admin')
      return res.status(403).json({ error: 'Only an admin can manage material requirements on a Tradio order' })

    const targetFilter = targetScopeType === 'tradio_order' ? { scopeType: targetScopeType, orderId: targetOrderId } : { scopeType: targetScopeType, mfrProjectId: targetMfrProjectId }
    const existing = await MaterialRequirement.findOne(targetFilter, '_id').lean()
    if (existing) return res.status(400).json({ error: 'A material requirement already exists for that scope — add lines to it directly instead' })

    const clonedLines = (source.lines || []).map(l => ({
      category: l.category, name: l.name, materialDefinitionId: l.materialDefinitionId || null,
      colourway: l.colourway || '', requiredQty: l.requiredQty, unit: l.unit || '', supplier: l.supplier || '',
      wastagePct: l.wastagePct || 0, rate: l.rate ?? null, note: l.note || '',
      // Deliberately NOT copied: status/orderedQty/receivedQty/poNumber/pushedTo —
      // a new scope has no receiving history and nothing pushed to any stage yet.
    }))

    const dup = await MaterialRequirement.create({
      ...targetFilter, createdBy: req.user.id, lines: clonedLines,
    })
    await AuditLog.create({ byUser: req.user.id, action: 'Material Requirement Duplicated', detail: `${req.params.id} -> ${targetOrderId || targetMfrProjectId} (${clonedLines.length} lines)` })
    res.status(201).json(await enrichMaterialRequirement(dup.toObject(), req.user))
  } catch (err) {
    console.error('[materials]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── PO generation (mfr_project scope only) ─────────────────────────────────
// No new PurchaseOrder collection — a PO is just a set of requirement lines
// sharing a poNumber (derive, don't duplicate, same discipline as the rest
// of this app). tradio_order scope already has a working PO mechanism —
// MaterialRequirementsPanel's existing "Raise PO" action, which operates on
// the PUSHED stage material line (the actual source of truth for that scope,
// per enrichMaterialRequirement above). Writing status/poNumber onto THIS
// doc's own line for an already-pushed tradio_order line would be silently
// overridden by that same derivation on the next read — so this route only
// makes sense, and is only offered, for mfr_project scope, where the line's
// own stored fields are authoritative (no stage to push to).
router.post('/material-requirements/:id/generate-po', requireAuth, async (req, res) => {
  try {
    const doc = await MaterialRequirement.findById(req.params.id)
    if (!doc) return res.status(404).json({ error: 'Requirement not found' })
    if (doc.scopeType !== 'mfr_project')
      return res.status(400).json({ error: 'Use the Raise PO action on the pushed stage line for a Tradio order' })

    const project = await mongoose.model('MfrProject').findById(doc.mfrProjectId, 'mfrId').lean()
    if (!project || String(project.mfrId) !== req.user.id) return res.status(403).json({ error: 'Forbidden' })

    const { lineIds, poNumber, notes } = req.body
    if (!Array.isArray(lineIds) || lineIds.length === 0) return res.status(400).json({ error: 'lineIds is required' })

    const lines = lineIds.map(id => doc.lines.id(id)).filter(Boolean)
    if (lines.length !== lineIds.length) return res.status(400).json({ error: 'One or more lines were not found' })

    const scopeRef = doc.orderId || doc.mfrProjectId.toString()
    const resolvedPoNumber = (poNumber && String(poNumber).trim())
      || `PO-${scopeRef}-${Date.now().toString(36).toUpperCase()}`

    for (const line of lines) {
      line.status = 'ordered'
      line.poNumber = resolvedPoNumber
      if (line.orderedQty < line.requiredQty) line.orderedQty = line.requiredQty
      if (notes) line.note = notes
    }
    await doc.save()

    await AuditLog.create({ byUser: req.user.id, action: 'Material PO Generated', detail: `${scopeRef}: ${resolvedPoNumber} (${lines.length} lines)` })
    res.json(await enrichMaterialRequirement(doc.toObject(), req.user))
  } catch (err) {
    console.error('[materials]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

export default router
