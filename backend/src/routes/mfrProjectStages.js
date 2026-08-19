import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { MfrProject, AuditLog, InventoryMovement } from '../db/index.js'
import { requireAuth } from '../middleware/auth.js'
import {
  STAGE_KINDS, STAGE_STATUS_VALUES,
  stageKindOf, deriveStageStatus, mirroredUnits, deriveActualEnd,
} from '../models/shared/stage.js'
import { dayNumber, getToday } from '../lib/stageMath.js'
import { requireOwnMfrProject, mapProject } from './mfrProjects.js'

// TNA for MfrProject (Order Setup Wizard, Phase 4) — mirrors orders.js's stage
// surface with the assignment/buyer/responsibleId indirection stripped out.
// A manufacturer's own project has exactly one implicit owner and no
// manufacturer-split or buyer party at all, so every route here is a flat
// owner-only gate (requireOwnMfrProject, no admin branch, ever) rather than
// the admin/manufacturer/buyer three-way permission shape orders.js needs.
// Stage-insert (mid-plan restructuring) is deliberately not mirrored in this
// pass — a manufacturer sets up their own plan once via /seed and edits it
// with bulk/single-stage updates; the smaller, higher-value surface (seed,
// bulk, single-stage, eta, delete, updates, items CRUD, materials CRUD)
// covers real day-to-day TNA use without the extra reindexing complexity
// orders.js's /stages/insert carries for a feature this scope doesn't need yet.

const skipInTest = () => process.env.NODE_ENV === 'test'
const updateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 120,
  keyGenerator: req => req.user?.id || req.ip,
  message: { error: 'Too many update requests. Please wait.' },
  standardHeaders: true, legacyHeaders: false, validate: false, skip: skipInTest,
})

const router = Router()
const BULK_STAGE_MAX = 50

async function loadOwnProject(req, res) {
  if (req.user.role !== 'manufacturer') { res.status(403).json({ error: 'Manufacturer only' }); return null }
  const project = await MfrProject.findById(req.params.id)
  const denied = requireOwnMfrProject(req.user.id, project)
  if (denied) { res.status(denied.status).json({ error: denied.error }); return null }
  return project
}

function stageAt(project, stageIndex, res) {
  const count = project.stages?.length || 0
  if (isNaN(stageIndex) || stageIndex < 0 || stageIndex >= count) {
    res.status(400).json({ error: `Invalid stage index (0–${count - 1})` })
    return null
  }
  return project.stages[stageIndex]
}

// POST /api/mfr-projects/:id/stages/seed — one-time creation-time stage
// builder, called once the project already exists (the wizard puts TNA after
// costing). Refuses once any stage exists — use bulk/single-stage/delete to
// revise a plan afterward, matching Order creation's own one-shot stage list.
router.post('/mfr-projects/:id/stages/seed', requireAuth, updateLimiter, async (req, res) => {
  try {
    const project = await loadOwnProject(req, res)
    if (!project) return
    if ((project.stages || []).length > 0)
      return res.status(400).json({ error: 'This project already has stages — use bulk update or add/delete individual stages instead' })

    const { stageNames, stageStartDates, stageEtas, stageKinds } = req.body
    if (!Array.isArray(stageNames) || stageNames.length === 0)
      return res.status(400).json({ error: 'Provide at least one stage name' })
    if (stageNames.length > BULK_STAGE_MAX)
      return res.status(400).json({ error: `Too many stages (max ${BULK_STAGE_MAX})` })

    const badDate = (label, v) => {
      if (v === null || v === undefined || v === '') return `${label} cannot be blank — use "NA" if it doesn't apply`
      if (v !== 'NA' && isNaN(new Date(v).getTime())) return `Invalid ${label}`
      return null
    }

    const stages = []
    for (let i = 0; i < stageNames.length; i++) {
      const name = String(stageNames[i] || '').trim().slice(0, 200)
      if (!name) return res.status(400).json({ error: `Stage ${i + 1} name is required` })
      const startDate = stageStartDates?.[i]
      const eta = stageEtas?.[i]
      const errS = badDate('start date', startDate); if (errS) return res.status(400).json({ error: `Stage ${i + 1}: ${errS}` })
      const errE = badDate('end date', eta); if (errE) return res.status(400).json({ error: `Stage ${i + 1}: ${errE}` })
      if (startDate !== 'NA' && eta !== 'NA' && new Date(startDate) > new Date(eta))
        return res.status(400).json({ error: `Stage ${i + 1}: start date must be on or before the end date` })
      const kind = stageKinds?.[i]
      if (kind !== undefined && kind !== null && kind !== '' && !STAGE_KINDS.includes(kind))
        return res.status(400).json({ error: `Stage ${i + 1}: invalid kind "${kind}"` })
      stages.push({
        name, startDate, eta, baselineEta: eta,
        kind: kind || 'quantity', totalUnits: kind === 'quantity' ? (Number(project.totalQty) || 1) : 1,
        unitsDone: 0, status: 'not_started',
      })
    }

    project.stages = stages
    await project.save()
    await AuditLog.create({ byUser: req.user.id, action: 'Mfr Project Stages Seeded', detail: `${project._id}: ${stages.length} stage(s)` })
    res.json(mapProject(project.toObject()))
  } catch (err) {
    console.error('[mfrProjectStages]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/mfr-projects/:id/stages/bulk — validate every row before writing
// any (all-or-nothing), one atomic save. Mirrors orders.js's stages/bulk.
router.post('/mfr-projects/:id/stages/bulk', requireAuth, updateLimiter, async (req, res) => {
  try {
    const project = await loadOwnProject(req, res)
    if (!project) return
    const { stages: rows } = req.body
    if (!Array.isArray(rows) || rows.length === 0)
      return res.status(400).json({ error: 'Provide a non-empty stages array' })
    if (rows.length > BULK_STAGE_MAX)
      return res.status(400).json({ error: `Too many stages in one request (max ${BULK_STAGE_MAX})` })

    const allStages = project.stages || []
    const seen = new Set()
    const touched = []

    for (const row of rows) {
      const i = parseInt(row?.index, 10)
      if (isNaN(i) || i < 0 || i >= allStages.length)
        return res.status(400).json({ error: `Invalid stage index ${row?.index} (0–${allStages.length - 1})` })
      if (seen.has(i)) return res.status(400).json({ error: `Duplicate entry for stage index ${i}` })
      seen.add(i)

      const stage = allStages[i]
      const kind = row.kind ?? stageKindOf(stage)
      const has = k => Object.prototype.hasOwnProperty.call(row, k)

      if (has('kind') && !STAGE_KINDS.includes(row.kind))
        return res.status(400).json({ error: `Invalid kind "${row.kind}" on stage ${i + 1}` })
      if (has('totalUnits')) {
        const t = parseInt(row.totalUnits, 10)
        if (isNaN(t) || t < 1) return res.status(400).json({ error: `Target quantity on stage ${i + 1} must be a positive number` })
        if (t < (stage.unitsDone || 0)) return res.status(400).json({ error: `Target quantity on stage ${i + 1} cannot be below units already completed (${stage.unitsDone})` })
      }
      if (has('description')) {
        const d = String(row.description ?? '').trim()
        if (d.length > 1000) return res.status(400).json({ error: `Description on stage ${i + 1} is too long (max 1000 characters)` })
      }
      if (has('blockedReason')) {
        const r = String(row.blockedReason ?? '').trim()
        if (r.length > 300) return res.status(400).json({ error: `Blocked reason on stage ${i + 1} is too long (max 300 characters)` })
      }

      const badDate = (label, v) => {
        if (v === null || v === undefined || v === '') return `${label} on stage ${i + 1} cannot be blank — use "NA"`
        if (v !== 'NA' && isNaN(new Date(v).getTime())) return `Invalid ${label} on stage ${i + 1}`
        return null
      }
      if (has('eta')) { const err = badDate('end date', row.eta); if (err) return res.status(400).json({ error: err }) }
      if (has('startDate')) { const err = badDate('start date', row.startDate); if (err) return res.status(400).json({ error: err }) }
      const effStart = has('startDate') ? row.startDate : stage.startDate
      const effEnd = has('eta') ? row.eta : stage.eta
      if (effStart && effEnd && effStart !== 'NA' && effEnd !== 'NA' && new Date(effStart) > new Date(effEnd))
        return res.status(400).json({ error: `Stage ${i + 1}: start date must be on or before the end date` })

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
        if (kind === 'checklist' && row.status === 'done') {
          const items = stage.items || []
          const pendingItems = items.filter(it => it.status !== 'done')
          if (pendingItems.length > 0)
            return res.status(400).json({ error: `Stage ${i + 1}: cannot mark done — ${pendingItems.length} of ${items.length} checklist item(s) still pending` })
        }
        const nextUnits = mirroredUnits(row.status, has('totalUnits') ? parseInt(row.totalUnits, 10) : (stage.totalUnits ?? 0))
        const isTrims = (stage.name || '').trim().toLowerCase() === 'trims order'
        const pending = (stage.materials || []).filter(m => isTrims ? m.status === 'pending' : m.status !== 'received')
        if (pending.length > 0 && nextUnits > (stage.unitsDone || 0))
          return res.status(400).json({ error: `Stage ${i + 1}: cannot advance — ${pending.length} material(s) still pending${isTrims ? '' : '/ordered'}` })
      }

      touched.push(i)
    }

    // All rows validated — apply in one pass, one save.
    for (const row of rows) {
      const i = parseInt(row.index, 10)
      const stage = allStages[i]
      const has = k => Object.prototype.hasOwnProperty.call(row, k)
      if (has('kind')) stage.kind = row.kind
      if (has('totalUnits')) stage.totalUnits = parseInt(row.totalUnits, 10)
      if (has('responsibleId')) { /* not applicable to this single-owner scope — ignored */ }
      if (has('description')) stage.description = String(row.description ?? '').trim()
      if (has('blocked')) stage.blocked = !!row.blocked
      if (has('blockedReason')) stage.blockedReason = String(row.blockedReason ?? '').trim()
      if (has('startDate')) stage.startDate = row.startDate
      if (has('eta')) {
        if (row.eta !== stage.eta && !stage.baselineEta) stage.baselineEta = stage.eta ?? row.eta
        stage.eta = row.eta
      }
      if (has('status')) {
        const kind = row.kind ?? stageKindOf(stage)
        stage.status = row.status
        stage.unitsDone = mirroredUnits(row.status, has('totalUnits') ? parseInt(row.totalUnits, 10) : (stage.totalUnits ?? 0))
        stage.actualEnd = deriveActualEnd(row.status, stage.actualEnd, has('actualEnd') ? row.actualEnd : undefined)
      } else if (has('kind') && row.kind !== 'quantity') {
        const s = deriveStageStatus(stage)
        stage.status = s
        stage.unitsDone = mirroredUnits(s, has('totalUnits') ? parseInt(row.totalUnits, 10) : (stage.totalUnits ?? 0))
        stage.actualEnd = deriveActualEnd(s, stage.actualEnd)
      }
    }

    await project.save()
    await AuditLog.create({ byUser: req.user.id, action: 'Mfr Project Stages Bulk Updated', detail: `${project._id}: ${touched.length} stage(s) updated [${touched.map(i => i + 1).join(', ')}]` })
    res.json({ ...mapProject(project.toObject()), updated: touched.length })
  } catch (err) {
    console.error('[mfrProjectStages]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/mfr-projects/:id/stages/:stageIndex — day-to-day progress update.
router.post('/mfr-projects/:id/stages/:stageIndex', requireAuth, updateLimiter, async (req, res) => {
  try {
    const project = await loadOwnProject(req, res)
    if (!project) return
    const stageIndex = parseInt(req.params.stageIndex, 10)
    const stage = stageAt(project, stageIndex, res)
    if (!stage) return

    const { unitsDone, note, eta, startDate, stageDate, status, blocked, blockedReason, actualEnd } = req.body
    const has = k => Object.prototype.hasOwnProperty.call(req.body, k)
    const hasActualEnd = has('actualEnd')

    if (note !== undefined && note !== null && typeof note === 'string' && note.length > 1000)
      return res.status(400).json({ error: 'Note too long (max 1000 characters)' })
    if (hasActualEnd) {
      if (typeof actualEnd !== 'string' || isNaN(new Date(actualEnd).getTime()))
        return res.status(400).json({ error: 'Invalid actual completion date' })
      if (dayNumber(actualEnd) > dayNumber(getToday()))
        return res.status(400).json({ error: 'Actual completion date cannot be in the future' })
    }
    if (has('status') && !STAGE_STATUS_VALUES.includes(status))
      return res.status(400).json({ error: `Invalid status — must be one of: ${STAGE_STATUS_VALUES.join(', ')}` })
    if (blockedReason !== undefined && blockedReason !== null && String(blockedReason).length > 300)
      return res.status(400).json({ error: 'Blocked reason too long (max 300 characters)' })

    const kind = stageKindOf(stage)
    const totalUnits = stage.totalUnits ?? 0
    const currentUnits = stage.unitsDone || 0
    let nextStatus, nextUnits
    if (kind === 'quantity') {
      if (!has('unitsDone')) {
        nextUnits = currentUnits
        nextStatus = deriveStageStatus({ unitsDone: currentUnits, totalUnits })
      } else {
        const parsedUnits = parseInt(unitsDone, 10)
        if (isNaN(parsedUnits) || parsedUnits < 0) return res.status(400).json({ error: 'unitsDone must be a non-negative number' })
        if (parsedUnits > totalUnits) return res.status(400).json({ error: `unitsDone (${parsedUnits}) cannot exceed totalUnits (${totalUnits})` })
        nextUnits = parsedUnits
        nextStatus = deriveStageStatus({ unitsDone: parsedUnits, totalUnits })
      }
    } else {
      if (has('unitsDone') && !has('status')) {
        const parsedUnits = parseInt(unitsDone, 10)
        if (isNaN(parsedUnits) || parsedUnits < 0) return res.status(400).json({ error: 'unitsDone must be a non-negative number' })
        if (parsedUnits > totalUnits) return res.status(400).json({ error: `unitsDone (${parsedUnits}) cannot exceed totalUnits (${totalUnits})` })
        nextStatus = deriveStageStatus({ unitsDone: parsedUnits, totalUnits })
      } else {
        nextStatus = has('status') ? status : deriveStageStatus(stage)
      }
      nextUnits = mirroredUnits(nextStatus, totalUnits)
    }

    if (kind === 'checklist' && nextStatus === 'done') {
      const items = stage.items || []
      const pendingItems = items.filter(it => it.status !== 'done')
      if (pendingItems.length > 0)
        return res.status(400).json({ error: `Cannot mark done — ${pendingItems.length} of ${items.length} checklist item(s) still pending` })
    }

    const gateStageName = (stage.name || '').trim().toLowerCase()
    const isTrimsOrderStage = gateStageName === 'trims order'
    const pendingMaterials = (stage.materials || []).filter(m => isTrimsOrderStage ? m.status === 'pending' : m.status !== 'received')
    if (pendingMaterials.length > 0 && nextUnits > currentUnits)
      return res.status(400).json({ error: `Cannot advance this stage — ${pendingMaterials.length} material(s) still pending${isTrimsOrderStage ? '' : '/ordered'}` })

    stage.unitsDone = nextUnits
    stage.status = nextStatus
    stage.actualEnd = deriveActualEnd(nextStatus, stage.actualEnd, hasActualEnd ? actualEnd : undefined)
    if (has('note')) stage.note = note ?? ''
    if (has('stageDate')) stage.stageDate = stageDate ?? null
    if (has('blocked')) stage.blocked = !!blocked
    if (has('blockedReason')) stage.blockedReason = String(blockedReason ?? '').trim()
    if (has('eta')) stage.eta = eta
    if (has('startDate')) stage.startDate = startDate

    await project.save()
    await AuditLog.create({
      byUser: req.user.id, action: 'Mfr Project Stage Updated',
      detail: `${project._id}: ${stage.name} — ${nextStatus}${kind === 'quantity' ? ` (${nextUnits}/${totalUnits} units)` : ''}`,
    })
    res.json(mapProject(project.toObject()))
  } catch (err) {
    console.error('[mfrProjectStages]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/mfr-projects/:id/stages/:stageIndex/eta — adjust a stage's metadata
// (dates/kind/totalUnits/description/name) after creation.
router.post('/mfr-projects/:id/stages/:stageIndex/eta', requireAuth, updateLimiter, async (req, res) => {
  try {
    const project = await loadOwnProject(req, res)
    if (!project) return
    const stageIndex = parseInt(req.params.stageIndex, 10)
    const stage = stageAt(project, stageIndex, res)
    if (!stage) return

    const has = k => Object.prototype.hasOwnProperty.call(req.body, k)
    const { eta, startDate, totalUnits, description, kind, name } = req.body
    if (!has('eta') && !has('startDate') && !has('totalUnits') && !has('description') && !has('kind') && !has('name'))
      return res.status(400).json({ error: 'Provide eta, startDate, totalUnits, description, kind, and/or name to update' })

    let trimmedName
    if (has('name')) {
      if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'Stage name cannot be blank' })
      trimmedName = name.trim().slice(0, 200)
    }
    if (has('kind') && !STAGE_KINDS.includes(kind))
      return res.status(400).json({ error: `Invalid kind — must be one of: ${STAGE_KINDS.join(', ')}` })

    let parsedTotalUnits
    if (has('totalUnits')) {
      parsedTotalUnits = parseInt(totalUnits, 10)
      if (isNaN(parsedTotalUnits) || parsedTotalUnits < 1) return res.status(400).json({ error: 'Target quantity must be a positive number' })
      if (parsedTotalUnits < (stage.unitsDone || 0))
        return res.status(400).json({ error: `Target quantity cannot be less than units already completed (${stage.unitsDone})` })
    }

    let trimmedDescription
    if (has('description')) {
      if (description !== null && typeof description !== 'string') return res.status(400).json({ error: 'Description must be text' })
      trimmedDescription = (description || '').trim()
      if (trimmedDescription.length > 1000) return res.status(400).json({ error: 'Description too long (max 1000 characters)' })
    }

    const invalidDateMsg = (label, val) => {
      if (val === null || val === undefined || val === '') return `${label} cannot be blank — use "NA" if it doesn't apply`
      if (val !== 'NA' && isNaN(new Date(val).getTime())) return `Invalid ${label} — must be a date or "NA"`
      return null
    }
    if (has('eta')) { const err = invalidDateMsg('end date', eta); if (err) return res.status(400).json({ error: err }) }
    if (has('startDate')) { const err = invalidDateMsg('start date', startDate); if (err) return res.status(400).json({ error: err }) }

    const effectiveStart = has('startDate') ? startDate : stage.startDate
    const effectiveEnd = has('eta') ? eta : stage.eta
    if (effectiveStart && effectiveEnd && effectiveStart !== 'NA' && effectiveEnd !== 'NA' && new Date(effectiveStart) > new Date(effectiveEnd))
      return res.status(400).json({ error: 'Start date must be on or before the end date' })

    if (has('name')) stage.name = trimmedName
    if (has('startDate')) stage.startDate = startDate
    if (has('totalUnits')) stage.totalUnits = parsedTotalUnits
    if (has('description')) stage.description = trimmedDescription
    if (has('eta')) {
      if (eta !== stage.eta && !stage.baselineEta) stage.baselineEta = stage.eta ?? eta
      stage.eta = eta
    }
    if (has('kind')) {
      const effectiveTotal = has('totalUnits') ? parsedTotalUnits : (stage.totalUnits ?? 0)
      const nextStatus = deriveStageStatus(stage)
      if (kind === 'checklist' && nextStatus === 'done') {
        const items = stage.items || []
        const pendingItems = items.filter(it => it.status !== 'done')
        if (pendingItems.length > 0)
          return res.status(400).json({ error: `Cannot mark done — ${pendingItems.length} of ${items.length} checklist item(s) still pending` })
      }
      stage.kind = kind
      stage.status = nextStatus
      if (kind !== 'quantity') stage.unitsDone = mirroredUnits(nextStatus, effectiveTotal)
      stage.actualEnd = deriveActualEnd(nextStatus, stage.actualEnd)
    }

    await project.save()
    await AuditLog.create({ byUser: req.user.id, action: 'Mfr Project Stage Dates Adjusted', detail: `${project._id}: Stage ${stageIndex + 1} (${stage.name})` })
    res.json(mapProject(project.toObject()))
  } catch (err) {
    console.error('[mfrProjectStages]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/mfr-projects/:id/stages/:stageIndex/delete
router.post('/mfr-projects/:id/stages/:stageIndex/delete', requireAuth, updateLimiter, async (req, res) => {
  try {
    const project = await loadOwnProject(req, res)
    if (!project) return
    const stageIndex = parseInt(req.params.stageIndex, 10)
    const stage = stageAt(project, stageIndex, res)
    if (!stage) return
    const removedName = stage.name
    project.stages = project.stages.filter((_, i) => i !== stageIndex)
    await project.save()
    await AuditLog.create({ byUser: req.user.id, action: 'Mfr Project Stage Deleted', detail: `${project._id}: removed "${removedName}"` })
    res.json(mapProject(project.toObject()))
  } catch (err) {
    console.error('[mfrProjectStages]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/mfr-projects/:id/stages/:stageIndex/updates — comment thread.
router.post('/mfr-projects/:id/stages/:stageIndex/updates', requireAuth, updateLimiter, async (req, res) => {
  try {
    const project = await loadOwnProject(req, res)
    if (!project) return
    const stageIndex = parseInt(req.params.stageIndex, 10)
    const stage = stageAt(project, stageIndex, res)
    if (!stage) return
    const { text } = req.body
    if (!text?.trim()) return res.status(400).json({ error: 'Update text is required' })
    if (text.trim().length > 1000) return res.status(400).json({ error: 'Update too long (max 1000 characters)' })

    stage.updates.push({ text: text.trim(), byUser: req.user.id, at: new Date() })
    await project.save()
    await AuditLog.create({ byUser: req.user.id, action: 'Mfr Project Stage Update Added', detail: `${project._id}: ${stage.name} — ${text.trim().slice(0, 100)}` })
    res.json(mapProject(project.toObject()))
  } catch (err) {
    console.error('[mfrProjectStages]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── Checklist items ─────────────────────────────────────────────────────────

router.post('/mfr-projects/:id/stages/:stageIndex/items', requireAuth, updateLimiter, async (req, res) => {
  try {
    const project = await loadOwnProject(req, res)
    if (!project) return
    const stageIndex = parseInt(req.params.stageIndex, 10)
    const stage = stageAt(project, stageIndex, res)
    if (!stage) return
    const { name, colourway, dueDate, note, fromColourways } = req.body

    let lines = []
    if (fromColourways) {
      const colours = project.colourways || []
      if (colours.length === 0) return res.status(400).json({ error: 'This project has no colourways yet — add them to the project first' })
      const prefix = (name || stage.name || 'Item').trim().slice(0, 150)
      lines = colours.map(c => ({ name: `${prefix} — ${c.name}`, colourway: c.name, status: 'pending', dueDate: dueDate || null, doneDate: null, note: '' }))
    } else {
      if (!name?.trim()) return res.status(400).json({ error: 'Item name is required' })
      lines = [{ name: name.trim().slice(0, 200), colourway: (colourway || '').trim(), status: 'pending', dueDate: dueDate || null, doneDate: null, note: (note || '').trim() }]
    }

    if ((stage.items || []).length + lines.length > 60)
      return res.status(400).json({ error: 'Too many checklist items on this stage (max 60)' })

    stage.items.push(...lines)
    await project.save()
    await AuditLog.create({ byUser: req.user.id, action: 'Mfr Project Stage Item Added', detail: `${project._id}: ${stage.name} — added ${lines.length} item(s)` })
    res.json(mapProject(project.toObject()))
  } catch (err) {
    console.error('[mfrProjectStages]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

router.post('/mfr-projects/:id/stages/:stageIndex/items/:lineIndex', requireAuth, updateLimiter, async (req, res) => {
  try {
    const project = await loadOwnProject(req, res)
    if (!project) return
    const stageIndex = parseInt(req.params.stageIndex, 10)
    const stage = stageAt(project, stageIndex, res)
    if (!stage) return
    const lineIndex = parseInt(req.params.lineIndex, 10)
    const items = stage.items || []
    if (isNaN(lineIndex) || lineIndex < 0 || lineIndex >= items.length)
      return res.status(400).json({ error: `Invalid item index (0–${items.length - 1})` })

    const has = k => Object.prototype.hasOwnProperty.call(req.body, k)
    const { status, name, colourway, dueDate, doneDate, note } = req.body
    const item = items[lineIndex]
    let touched = false

    if (has('status')) {
      if (!['pending', 'done'].includes(status)) return res.status(400).json({ error: 'Item status must be pending or done' })
      item.status = status
      if (status === 'done' && !has('doneDate')) item.doneDate = new Date().toISOString().slice(0, 10)
      if (status === 'pending') item.doneDate = null
      touched = true
    }
    if (has('name')) {
      if (!name?.trim()) return res.status(400).json({ error: 'Item name cannot be blank' })
      item.name = name.trim().slice(0, 200); touched = true
    }
    if (has('colourway')) { item.colourway = String(colourway || '').trim(); touched = true }
    if (has('dueDate')) {
      if (dueDate !== item.dueDate && !item.plannedDate) item.plannedDate = item.dueDate ?? dueDate
      item.dueDate = dueDate || null; touched = true
    }
    if (has('doneDate')) { item.doneDate = doneDate || null; touched = true }
    if (has('note')) { item.note = String(note || '').trim().slice(0, 500); touched = true }
    if (!touched) return res.status(400).json({ error: 'Nothing to update' })

    await project.save()
    await AuditLog.create({ byUser: req.user.id, action: 'Mfr Project Stage Item Updated', detail: `${project._id}: ${stage.name} — "${item.name}"${has('status') ? ` → ${status}` : ''}` })
    res.json(mapProject(project.toObject()))
  } catch (err) {
    console.error('[mfrProjectStages]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

router.post('/mfr-projects/:id/stages/:stageIndex/items/:lineIndex/delete', requireAuth, updateLimiter, async (req, res) => {
  try {
    const project = await loadOwnProject(req, res)
    if (!project) return
    const stageIndex = parseInt(req.params.stageIndex, 10)
    const stage = stageAt(project, stageIndex, res)
    if (!stage) return
    const lineIndex = parseInt(req.params.lineIndex, 10)
    const items = stage.items || []
    if (isNaN(lineIndex) || lineIndex < 0 || lineIndex >= items.length)
      return res.status(400).json({ error: `Invalid item index (0–${items.length - 1})` })
    const removedName = items[lineIndex].name
    stage.items = items.filter((_, i) => i !== lineIndex)
    await project.save()
    await AuditLog.create({ byUser: req.user.id, action: 'Mfr Project Stage Item Removed', detail: `${project._id}: ${stage.name} — removed "${removedName}"` })
    res.json(mapProject(project.toObject()))
  } catch (err) {
    console.error('[mfrProjectStages]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── Materials/PO checklist ──────────────────────────────────────────────────

router.post('/mfr-projects/:id/stages/:stageIndex/materials', requireAuth, updateLimiter, async (req, res) => {
  try {
    const project = await loadOwnProject(req, res)
    if (!project) return
    const stageIndex = parseInt(req.params.stageIndex, 10)
    const stage = stageAt(project, stageIndex, res)
    if (!stage) return
    const { name, category, colourway, requiredQty, unit, supplier, poNumber, expectedDate } = req.body

    if (!name?.trim()) return res.status(400).json({ error: 'Material name is required' })
    const reqQty = parseFloat(requiredQty)
    if (isNaN(reqQty) || reqQty < 0) return res.status(400).json({ error: 'Required quantity must be a non-negative number' })
    if (category !== undefined && !['fabric', 'trim', 'accessory', 'other'].includes(category))
      return res.status(400).json({ error: 'Invalid category' })

    const line = {
      name: name.trim().slice(0, 200), category: category || 'other', colourway: colourway || '',
      requiredQty: reqQty, unit: unit || '', supplier: supplier || '', poNumber: poNumber || '',
      expectedDate: expectedDate || null, status: 'pending', orderedQty: 0, receivedQty: 0, note: '',
    }
    stage.materials.push(line)
    await project.save()
    await AuditLog.create({ byUser: req.user.id, action: 'Mfr Project Stage Material Added', detail: `${project._id}: ${stage.name} — added "${line.name}" (${line.requiredQty} ${line.unit})` })
    res.json(mapProject(project.toObject()))
  } catch (err) {
    console.error('[mfrProjectStages]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

router.post('/mfr-projects/:id/stages/:stageIndex/materials/:lineIndex', requireAuth, updateLimiter, async (req, res) => {
  try {
    const project = await loadOwnProject(req, res)
    if (!project) return
    const stageIndex = parseInt(req.params.stageIndex, 10)
    const stage = stageAt(project, stageIndex, res)
    if (!stage) return
    const lineIndex = parseInt(req.params.lineIndex, 10)
    const lineCount = stage.materials?.length || 0
    if (isNaN(lineIndex) || lineIndex < 0 || lineIndex >= lineCount)
      return res.status(400).json({ error: `Invalid material line index (0–${lineCount - 1})` })

    const { name, category, colourway, requiredQty, unit, supplier, poNumber, expectedDate, status, orderedQty, receivedQty, note } = req.body
    if (status !== undefined && !['pending', 'ordered', 'received'].includes(status))
      return res.status(400).json({ error: 'Invalid status' })
    if (category !== undefined && !['fabric', 'trim', 'accessory', 'other'].includes(category))
      return res.status(400).json({ error: 'Invalid category' })

    const line = stage.materials[lineIndex]
    let touched = false
    if (name !== undefined) { if (!name.trim()) return res.status(400).json({ error: 'Material name is required' }); line.name = name.trim().slice(0, 200); touched = true }
    if (category !== undefined) { line.category = category; touched = true }
    if (colourway !== undefined) { line.colourway = colourway; touched = true }
    if (requiredQty !== undefined) {
      const q = parseFloat(requiredQty)
      if (isNaN(q) || q < 0) return res.status(400).json({ error: 'Required quantity must be a non-negative number' })
      line.requiredQty = q; touched = true
    }
    if (unit !== undefined) { line.unit = unit; touched = true }
    if (supplier !== undefined) { line.supplier = supplier; touched = true }
    if (poNumber !== undefined) { line.poNumber = poNumber; touched = true }
    if (expectedDate !== undefined) { line.expectedDate = expectedDate; touched = true }
    if (status !== undefined) { line.status = status; touched = true }
    let receivedDelta = 0
    if (orderedQty !== undefined) {
      const q = parseFloat(orderedQty)
      if (isNaN(q) || q < 0) return res.status(400).json({ error: 'Ordered quantity must be a non-negative number' })
      line.orderedQty = q; touched = true
    }
    if (receivedQty !== undefined) {
      const q = parseFloat(receivedQty)
      if (isNaN(q) || q < 0) return res.status(400).json({ error: 'Received quantity must be a non-negative number' })
      receivedDelta = q - (line.receivedQty || 0)
      line.receivedQty = q; touched = true
    }
    if (note !== undefined) { line.note = note; touched = true }
    if (!touched) return res.status(400).json({ error: 'No fields to update' })

    const lineName = line.name
    const lineUnit = line.unit
    const lineId = line._id
    await project.save()
    await AuditLog.create({ byUser: req.user.id, action: 'Mfr Project Stage Material Updated', detail: `${project._id}: ${stage.name} — "${lineName}"${status ? ` → ${status}` : ''}` })

    // Finance-module data seam (§1g) — same InventoryMovement 'in' hook as
    // orders.js's materials-update route. Delta only, never the running total.
    if (receivedDelta > 0) {
      try {
        await InventoryMovement.create({
          mfrId: req.user.id, materialName: lineName, direction: 'in',
          qty: receivedDelta, unit: lineUnit || '',
          scopeType: 'mfr_project', mfrProjectId: project._id,
          sourceType: 'material_receipt',
          sourceRef: { stageIndex, materialLineId: lineId },
        })
      } catch (err) { console.error('[inventoryMovement]', err) }
    }

    res.json(mapProject(project.toObject()))
  } catch (err) {
    console.error('[mfrProjectStages]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

router.post('/mfr-projects/:id/stages/:stageIndex/materials/:lineIndex/delete', requireAuth, updateLimiter, async (req, res) => {
  try {
    const project = await loadOwnProject(req, res)
    if (!project) return
    const stageIndex = parseInt(req.params.stageIndex, 10)
    const stage = stageAt(project, stageIndex, res)
    if (!stage) return
    const lineIndex = parseInt(req.params.lineIndex, 10)
    const lineCount = stage.materials?.length || 0
    if (isNaN(lineIndex) || lineIndex < 0 || lineIndex >= lineCount)
      return res.status(400).json({ error: `Invalid material line index (0–${lineCount - 1})` })
    const removedName = stage.materials[lineIndex].name
    stage.materials = stage.materials.filter((_, i) => i !== lineIndex)
    await project.save()
    await AuditLog.create({ byUser: req.user.id, action: 'Mfr Project Stage Material Deleted', detail: `${project._id}: ${stage.name} — removed "${removedName}"` })
    res.json(mapProject(project.toObject()))
  } catch (err) {
    console.error('[mfrProjectStages]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

export default router
