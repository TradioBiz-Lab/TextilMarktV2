import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { MfrMasterProject, MfrProject, AuditLog } from '../db/index.js'
import { requireAuth } from '../middleware/auth.js'
import { validateImagePayload } from '../lib/imagePayload.js'
import { stageKindOf, deriveStageStatus, stageEtaVarianceDays } from '../models/shared/stage.js'

// Mirrors orders.js's bulkOrderLimiter — a manufacturer batch-creating many
// styles at once via the wizard's CSV/repeatable-row line-items step.
const bulkProjectLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 20,
  keyGenerator: req => req.user?.id || req.ip,
  message: { error: 'Too many bulk uploads. Please wait before trying again.' },
  standardHeaders: true, legacyHeaders: false, validate: false,
})

const router = Router()

// Both collections in this file are manufacturer-owned and PRIVATE — no admin
// override anywhere, on purpose (see MfrProject.js/MfrMasterProject.js's own
// comments). Every route below checks role === 'manufacturer' AND ownership;
// there is no branch that lets an admin or master admin through.
function requireOwnMfrProject(mfrId, project) {
  if (!project) return { status: 404, error: 'Project not found' }
  if (String(project.mfrId) !== String(mfrId)) return { status: 403, error: 'Forbidden' }
  return null
}

// ── MfrMasterProject ─────────────────────────────────────────────────────

router.get('/mfr-master-projects', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'manufacturer') return res.status(403).json({ error: 'Manufacturer only' })
    const projects = await MfrMasterProject.find({ mfrId: req.user.id, isActive: true }).sort({ createdAt: -1 }).lean()
    res.json(projects.map(p => ({
      id: p._id.toString(), buyerName: p.buyerName || '', season: p.season || '',
      notes: p.notes || '', createdAt: p.createdAt, updatedAt: p.updatedAt,
    })))
  } catch (err) {
    console.error('[mfrProjects]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

router.post('/mfr-master-projects', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'manufacturer') return res.status(403).json({ error: 'Manufacturer only' })
    const { buyerName, season, notes } = req.body
    const project = await MfrMasterProject.create({
      mfrId: req.user.id,
      buyerName: (buyerName || '').trim().slice(0, 200),
      season: (season || '').trim().slice(0, 60),
      notes: (notes || '').slice(0, 1000),
    })
    await AuditLog.create({ byUser: req.user.id, action: 'Mfr Master Project Created', detail: project.buyerName || project._id.toString() })
    res.status(201).json({ id: project._id.toString(), buyerName: project.buyerName, season: project.season, notes: project.notes })
  } catch (err) {
    console.error('[mfrProjects]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

router.post('/mfr-master-projects/:id/delete', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'manufacturer') return res.status(403).json({ error: 'Manufacturer only' })
    const project = await MfrMasterProject.findById(req.params.id)
    const denied = requireOwnMfrProject(req.user.id, project)
    if (denied) return res.status(denied.status).json({ error: denied.error })
    project.isActive = false
    await project.save()
    await AuditLog.create({ byUser: req.user.id, action: 'Mfr Master Project Deleted', detail: project.buyerName || project._id.toString() })
    res.json({ ok: true })
  } catch (err) {
    console.error('[mfrProjects]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── MfrProject ────────────────────────────────────────────────────────────

// TNA stage mapper - the MfrProject analogue of orders.js's enrichOrder stage
// map. No viewerMfrId narrowing (single owner, nothing to filter) and no
// populate on responsibleId/updates.byUser (this scope has no accountability-
// delegation across roles - the owning manufacturer is the only possible
// author - so a raw id string is enough; the frontend already knows who "you"
// are without a round-trip).
const mapStage = s => ({
  name: s.name, unitsDone: s.unitsDone, totalUnits: s.totalUnits,
  startDate: s.startDate || null, eta: s.eta, stageDate: s.stageDate || null, note: s.note,
  description: s.description || '',
  kind: stageKindOf(s), status: deriveStageStatus(s),
  blocked: !!s.blocked, blockedReason: s.blockedReason || '',
  baselineEta: s.baselineEta ?? s.eta ?? null,
  etaVarianceDays: stageEtaVarianceDays({ baselineEta: s.baselineEta ?? s.eta, eta: s.eta }),
  actualEnd: s.actualEnd || null,
  items: (s.items || []).map(it => ({
    name: it.name, colourway: it.colourway || '', status: it.status,
    plannedDate: it.plannedDate ?? it.dueDate ?? null,
    dueDate: it.dueDate || null, doneDate: it.doneDate || null, note: it.note || '',
  })),
  itemsDone: (s.items || []).filter(it => it.status === 'done').length,
  itemsTotal: (s.items || []).length,
  updates: (s.updates || []).map(u => ({
    text: u.text, byUser: u.byUser?.toString?.() ?? u.byUser, at: u.at,
  })),
  materials: (s.materials || []).map(m => ({
    id: m._id?.toString() ?? null,
    name: m.name, category: m.category || 'other', colourway: m.colourway || '',
    requiredQty: m.requiredQty, unit: m.unit, supplier: m.supplier,
    poNumber: m.poNumber, expectedDate: m.expectedDate, status: m.status,
    orderedQty: m.orderedQty, receivedQty: m.receivedQty, note: m.note,
  })),
})

const mapProject = p => ({
  id: p._id.toString(),
  mfrMasterProjectId: p.mfrMasterProjectId ? p.mfrMasterProjectId.toString() : null,
  styleName: p.styleName, buyerName: p.buyerName || '', category: p.category || '',
  season: p.season || '', totalQty: p.totalQty || 0, delivery: p.delivery || null,
  colourways: (p.colourways || []).map(c => ({ name: c.name, code: c.code || '' })),
  notes: p.notes || '',
  imageDataUrl: p.imageDataUrl || null, imageUrl: p.imageUrl || null,
  stages: (p.stages || []).map(mapStage),
  createdAt: p.createdAt, updatedAt: p.updatedAt,
})

router.get('/mfr-projects', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'manufacturer') return res.status(403).json({ error: 'Manufacturer only' })
    const query = { mfrId: req.user.id, isActive: true }
    if (req.query.mfrMasterProjectId) query.mfrMasterProjectId = req.query.mfrMasterProjectId
    const projects = await MfrProject.find(query).sort({ createdAt: -1 }).lean()
    res.json(projects.map(mapProject))
  } catch (err) {
    console.error('[mfrProjects]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

router.post('/mfr-projects', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'manufacturer') return res.status(403).json({ error: 'Manufacturer only' })
    const { mfrMasterProjectId, styleName, buyerName, category, season, totalQty, delivery, colourways, notes, imageDataUrl, imageUrl } = req.body
    if (!styleName?.trim()) return res.status(400).json({ error: 'Style name is required' })

    if (mfrMasterProjectId) {
      const parent = await MfrMasterProject.findById(mfrMasterProjectId).lean()
      const denied = requireOwnMfrProject(req.user.id, parent)
      if (denied) return res.status(denied.status).json({ error: 'Invalid master project' })
    }

    const imgCheck = validateImagePayload(imageDataUrl, imageUrl)
    if (!imgCheck.ok) return res.status(400).json({ error: imgCheck.error })

    const project = await MfrProject.create({
      mfrId: req.user.id,
      mfrMasterProjectId: mfrMasterProjectId || null,
      styleName: styleName.trim().slice(0, 200),
      buyerName: (buyerName || '').trim().slice(0, 200),
      category: (category || '').trim().slice(0, 60),
      season: (season || '').trim().slice(0, 60),
      totalQty: Number(totalQty) || 0,
      delivery: delivery || null,
      colourways: Array.isArray(colourways) ? colourways.filter(c => c?.name?.trim()).map(c => ({ name: c.name.trim().slice(0, 60), code: c.code || '' })) : [],
      notes: (notes || '').slice(0, 1000),
      imageDataUrl: imageDataUrl || null,
      imageUrl: imageUrl ? imageUrl.trim() : null,
    })
    await AuditLog.create({ byUser: req.user.id, action: 'Mfr Project Created', detail: project.styleName })
    res.status(201).json(mapProject(project.toObject()))
  } catch (err) {
    console.error('[mfrProjects]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/mfr-projects/bulk — CSV/repeatable-row batch creation of many styles
// under one MfrMasterProject (Order Setup Wizard's Line Items step, manufacturer
// path). Mirrors orders.js's POST /bulk shape (validate-every-row, all-or-nothing
// per row, {total,created,failed,results}) — owner-only, no admin variant, same
// privacy invariant as every other route in this file.
router.post('/mfr-projects/bulk', requireAuth, bulkProjectLimiter, async (req, res) => {
  try {
    if (req.user.role !== 'manufacturer') return res.status(403).json({ error: 'Manufacturer only' })
    const { mfrMasterProjectId, rows } = req.body
    if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'At least one row is required' })
    if (rows.length > 100) return res.status(400).json({ error: 'Too many rows (max 100 per bulk upload)' })

    if (mfrMasterProjectId) {
      const parent = await MfrMasterProject.findById(mfrMasterProjectId).lean()
      const denied = requireOwnMfrProject(req.user.id, parent)
      if (denied) return res.status(denied.status).json({ error: 'Invalid master project' })
    }

    const results = []
    let created = 0, failed = 0

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      try {
        if (!row.styleName?.trim()) {
          failed++
          results.push({ row: i, success: false, error: 'Style name is required' })
          continue
        }
        const imgCheck = validateImagePayload(row.imageDataUrl, row.imageUrl)
        if (!imgCheck.ok) {
          failed++
          results.push({ row: i, success: false, error: imgCheck.error })
          continue
        }
        const project = await MfrProject.create({
          mfrId: req.user.id,
          mfrMasterProjectId: mfrMasterProjectId || null,
          styleName: row.styleName.trim().slice(0, 200),
          buyerName: (row.buyerName || '').trim().slice(0, 200),
          category: (row.category || '').trim().slice(0, 60),
          season: (row.season || '').trim().slice(0, 60),
          totalQty: Number(row.totalQty) || 0,
          delivery: row.delivery || null,
          colourways: Array.isArray(row.colourways) ? row.colourways.filter(c => c?.name?.trim()).map(c => ({ name: c.name.trim().slice(0, 60), code: c.code || '' })) : [],
          notes: (row.notes || '').slice(0, 1000),
          imageDataUrl: row.imageDataUrl || null,
          imageUrl: row.imageUrl ? row.imageUrl.trim() : null,
        })
        created++
        results.push({ row: i, success: true, id: project._id.toString() })
      } catch (err) {
        failed++
        results.push({ row: i, success: false, error: 'Server error creating this row' })
      }
    }

    await AuditLog.create({
      byUser: req.user.id,
      action: 'Mfr Project Bulk Upload',
      detail: `Bulk upload: ${created} created, ${failed} failed`,
    })

    res.status(200).json({ total: rows.length, created, failed, results })
  } catch (err) {
    console.error('[mfrProjects]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

router.post('/mfr-projects/:id', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'manufacturer') return res.status(403).json({ error: 'Manufacturer only' })
    const project = await MfrProject.findById(req.params.id)
    const denied = requireOwnMfrProject(req.user.id, project)
    if (denied) return res.status(denied.status).json({ error: denied.error })

    const { styleName, buyerName, category, season, totalQty, delivery, colourways, notes } = req.body
    if (styleName !== undefined) {
      if (!styleName.trim()) return res.status(400).json({ error: 'Style name is required' })
      project.styleName = styleName.trim().slice(0, 200)
    }
    if (buyerName !== undefined) project.buyerName = (buyerName || '').trim().slice(0, 200)
    if (category !== undefined) project.category = (category || '').trim().slice(0, 60)
    if (season !== undefined) project.season = (season || '').trim().slice(0, 60)
    if (totalQty !== undefined) project.totalQty = Number(totalQty) || 0
    if (delivery !== undefined) project.delivery = delivery || null
    if (colourways !== undefined) project.colourways = Array.isArray(colourways) ? colourways.filter(c => c?.name?.trim()).map(c => ({ name: c.name.trim().slice(0, 60), code: c.code || '' })) : []
    if (notes !== undefined) project.notes = (notes || '').slice(0, 1000)

    await project.save()
    await AuditLog.create({ byUser: req.user.id, action: 'Mfr Project Updated', detail: project.styleName })
    res.json(mapProject(project.toObject()))
  } catch (err) {
    console.error('[mfrProjects]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

router.post('/mfr-projects/:id/delete', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'manufacturer') return res.status(403).json({ error: 'Manufacturer only' })
    const project = await MfrProject.findById(req.params.id)
    const denied = requireOwnMfrProject(req.user.id, project)
    if (denied) return res.status(denied.status).json({ error: denied.error })
    project.isActive = false
    await project.save()
    await AuditLog.create({ byUser: req.user.id, action: 'Mfr Project Deleted', detail: project.styleName })
    res.json({ ok: true })
  } catch (err) {
    console.error('[mfrProjects]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

export default router
export { requireOwnMfrProject, mapProject, mapStage }
