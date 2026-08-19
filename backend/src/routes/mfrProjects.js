import { Router } from 'express'
import { MfrMasterProject, MfrProject, AuditLog } from '../db/index.js'
import { requireAuth } from '../middleware/auth.js'

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

const mapProject = p => ({
  id: p._id.toString(),
  mfrMasterProjectId: p.mfrMasterProjectId ? p.mfrMasterProjectId.toString() : null,
  styleName: p.styleName, buyerName: p.buyerName || '', category: p.category || '',
  season: p.season || '', totalQty: p.totalQty || 0, delivery: p.delivery || null,
  colourways: (p.colourways || []).map(c => ({ name: c.name, code: c.code || '' })),
  notes: p.notes || '', createdAt: p.createdAt, updatedAt: p.updatedAt,
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
    const { mfrMasterProjectId, styleName, buyerName, category, season, totalQty, delivery, colourways, notes } = req.body
    if (!styleName?.trim()) return res.status(400).json({ error: 'Style name is required' })

    if (mfrMasterProjectId) {
      const parent = await MfrMasterProject.findById(mfrMasterProjectId).lean()
      const denied = requireOwnMfrProject(req.user.id, parent)
      if (denied) return res.status(denied.status).json({ error: 'Invalid master project' })
    }

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
    })
    await AuditLog.create({ byUser: req.user.id, action: 'Mfr Project Created', detail: project.styleName })
    res.status(201).json(mapProject(project.toObject()))
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
export { requireOwnMfrProject }
