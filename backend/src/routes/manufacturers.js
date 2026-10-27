import { Router } from 'express'
import mongoose from 'mongoose'
import rateLimit from 'express-rate-limit'
import { Manufacturer, AuditLog } from '../db/index.js'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import {
  cleanPartnerInput, cleanPartnerImage, cleanLink, parsePartnerQuery, findPartners, toPartner,
} from '../lib/partners.js'
import {
  parsePartnerCsv, suggestPartnerMapping, runPartnerImport, PARTNER_CSV_FIELDS, MAX_IMPORT_ROWS,
} from '../lib/partnerImport.js'
import { PARTNER_TYPES } from '../models/Manufacturer.js'

// The Partner Directory API (docs/SCHEMA.md "manufacturers"). Strategically sensitive sourcing data: admins only,
// enforced here on the server for EVERY endpoint (the router-level guard below leaves no route out), never just by
// hiding the nav item. Like the rest of the API it uses GET and POST only (see frontend/src/api.js).
const router = Router()
router.use(requireAuth, requireAdmin)

// Directory edits are by hand and low-volume; the cap stops a runaway script or a stuck retry loop.
const writeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 600,
  keyGenerator: req => req.user?.id || req.ip,
  message: { error: 'Too many partner changes. Please wait.' },
  standardHeaders: true, legacyHeaders: false, validate: false,
  skip: () => process.env.NODE_ENV === 'test',
})

const serverError = (res, err) => {
  console.error('[manufacturers]', err)
  res.status(500).json({ error: 'Server error' })
}

const eq = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
const show = v => (v === undefined || v === null || v === '' ? 'empty' : String(v))
// What the audit entry says about a field: its values for the small pipeline fields, just its name for the rest.
const VALUE_FIELDS = new Set(['status', 'priority', 'type', 'cluster', 'isActive'])

const tally = (rows, key) => {
  const m = new Map()
  for (const r of rows) for (const v of [].concat(r[key] ?? [])) if (v) m.set(v, (m.get(v) || 0) + 1)
  return [...m].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
}

// GET /api/manufacturers/facets - counts and the tags in use, for the filter rail, the tab counts and tag suggestions.
router.get('/facets', async (req, res) => {
  try {
    const rows = await Manufacturer.find({}, 'type cluster status priority categories products fabrics fabricTypes trimCategories keywords isActive linkedUserId').lean()
    const active = rows.filter(r => r.isActive !== false)
    res.json({
      total: active.length, inactive: rows.length - active.length,
      byType: Object.fromEntries(tally(active, 'type').map(x => [x.value, x.count])),
      byCluster: Object.fromEntries(tally(active, 'cluster').map(x => [x.value, x.count])),
      byStatus: Object.fromEntries(tally(active, 'status').map(x => [x.value, x.count])),
      byCategory: Object.fromEntries(tally(active, 'categories').map(x => [x.value, x.count])),
      onPlatform: active.filter(r => r.linkedUserId).length,
      products: tally(active, 'products'),
      fabrics: tally(active.map(r => ({ f: [...(r.fabrics || []), ...(r.fabricTypes || [])] })), 'f'),
      trimCategories: tally(active, 'trimCategories'),
      keywords: tally(rows, 'keywords'),
    })
  } catch (err) { serverError(res, err) }
})

// GET /api/manufacturers?search=&type=&cluster=&status=&product=&minScore=&sort= (see parsePartnerQuery for the rest)
router.get('/', async (req, res) => {
  try {
    const parsed = parsePartnerQuery(req.query)
    if (parsed.error) return res.status(400).json({ error: parsed.error })
    const { items, total, mode } = await findPartners(Manufacturer, parsed.filters)
    res.json({ items: items.map(toPartner), total, mode })
  } catch (err) { serverError(res, err) }
})

// POST /api/manufacturers/csv/preview { csv } - parses an uploaded CSV and suggests which column fills which field.
// The client keeps the parsed rows, lets the admin adjust the mapping, then sends them to /import.
router.post('/csv/preview', writeLimiter, async (req, res) => {
  try {
    const parsed = parsePartnerCsv(req.body?.csv)
    if (parsed.error) return res.status(400).json({ error: parsed.error })
    res.json({
      headers: parsed.headers,
      rowCount: parsed.rows.length,
      preview: parsed.rows.slice(0, 5),
      rows: parsed.rows,
      suggestedMapping: suggestPartnerMapping(parsed.headers),
      fields: PARTNER_CSV_FIELDS.map(({ key, label }) => ({ key, label })),
    })
  } catch (err) { serverError(res, err) }
})

// POST /api/manufacturers/import { rows, mapping?, dryRun?, defaultType? } - bulk create, de-duplicated on name
// (case-insensitive) against the directory and within the file. With `mapping` the rows are CSV records keyed by
// header; without it they are partner bodies in this API's shape. `dryRun` reports without writing.
router.post('/import', writeLimiter, async (req, res) => {
  try {
    const { rows, mapping, dryRun, defaultType } = req.body || {}
    if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'rows must be a non-empty list' })
    if (rows.length > MAX_IMPORT_ROWS) return res.status(400).json({ error: `Too many rows (max ${MAX_IMPORT_ROWS} per import)` })
    if (defaultType !== undefined && !PARTNER_TYPES.includes(defaultType)) return res.status(400).json({ error: 'Invalid defaultType' })
    let map = null
    if (mapping !== undefined && mapping !== null) {
      if (typeof mapping !== 'object' || Array.isArray(mapping)) return res.status(400).json({ error: 'mapping must be an object' })
      const keys = new Set(PARTNER_CSV_FIELDS.map(f => f.key))
      map = {}
      for (const [h, field] of Object.entries(mapping)) {
        if (field && !keys.has(field)) return res.status(400).json({ error: `Unknown field "${field}" in mapping` })
        map[h] = field || null
      }
      if (!Object.values(map).includes('name')) return res.status(400).json({ error: 'Map one column to Name' })
    }
    const report = await runPartnerImport({ rows, mapping: map, dryRun: dryRun === true, defaultType: defaultType || 'unknown', userId: req.user.id })
    if (!report.dryRun && (report.created > 0 || report.errors.length > 0)) {
      await AuditLog.create({
        byUser: req.user.id, action: 'Partners Imported',
        detail: `${report.created} partner${report.created === 1 ? '' : 's'} created, ${report.skipped.length} skipped as duplicates, ${report.errors.length} rejected, by ${req.user.name}`,
      })
    }
    res.json(report)
  } catch (err) { serverError(res, err) }
})

// POST /api/manufacturers - add a partner
router.post('/', writeLimiter, async (req, res) => {
  try {
    const cleaned = cleanPartnerInput(req.body)
    if (cleaned.errors) return res.status(400).json({ error: cleaned.errors.join('. ') })
    // A new partner has no platform account, so it cannot start Live.
    if (cleaned.data.status === 'live') return res.status(400).json({ error: 'Only a partner with a manufacturer account on the platform can be Live. Create its account in User Setup first.' })
    const doc = await Manufacturer.create({ ...cleaned.data, createdBy: req.user.id, updatedBy: req.user.id })
    await AuditLog.create({ byUser: req.user.id, action: 'Partner Created', detail: `${doc.name} (${doc.type}${doc.city ? `, ${doc.city}` : ''}) added by ${req.user.name}` })
    res.status(201).json(toPartner(doc.toObject()))
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: `A partner named "${req.body?.name}" already exists` })
    serverError(res, err)
  }
})

// GET /api/manufacturers/thumbs?ids=a,b,c&v=<version> - the small tiles of many partners in one request, as { thumbs: { id: dataUrl } }.
// `v` only changes the URL when a tile changes, so the browser can keep the answer (a page of 40 tiles was 40 requests of
// 125KB each). A partner with an upload but no thumbnail yet gets its full picture, so nothing is missing.
router.get('/thumbs', async (req, res) => {
  try {
    const ids = String(req.query.ids || '').split(',').map(x => x.trim()).filter(Boolean)
    if (ids.length === 0 || ids.length > 60 || !ids.every(id => mongoose.Types.ObjectId.isValid(id))) return res.status(400).json({ error: 'ids must be 1 to 60 partner ids' })
    const rows = await Manufacturer.find({ _id: { $in: ids }, imageUploadedAt: { $ne: null } }, 'thumbData imageData').select('+thumbData +imageData').lean()
    res.set('Cache-Control', 'private, max-age=86400')
    res.json({ thumbs: Object.fromEntries(rows.map(r => [String(r._id), r.thumbData || r.imageData])) })
  } catch (err) { serverError(res, err) }
})

const findOne = async (req, res, select) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) { res.status(404).json({ error: 'Partner not found' }); return null }
  const doc = await Manufacturer.findById(req.params.id, select)
  if (!doc) { res.status(404).json({ error: 'Partner not found' }); return null }
  return doc
}

// GET /api/manufacturers/:id/image - the uploaded tile (or the image link) as { image }, fetched by the page itself
// because an <img> cannot carry the session. Lists never carry image bytes.
router.get('/:id/image', async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ error: 'Partner not found' })
    const p = await Manufacturer.findById(req.params.id, 'imageUrl imageData').select('+imageData').lean()
    if (!p) return res.status(404).json({ error: 'Partner not found' })
    res.json({ image: p.imageData || p.imageUrl || null })
  } catch (err) { serverError(res, err) }
})

// POST /api/manufacturers/:id/image { image } - set the tile: an uploaded picture (JPEG/PNG/WebP data URL, under
// 600KB, resized by the browser first) or an http(s) link; null or '' removes it. Kept inline on the document under
// a size cap, the same approach as style photos, since the app has no separate file store for images.
router.post('/:id/image', writeLimiter, async (req, res) => {
  try {
    const doc = await findOne(req, res, null)
    if (!doc) return
    const value = req.body?.image
    if (value === null || value === '') {
      doc.imageData = ''; doc.thumbData = ''; doc.imageUploadedAt = null; doc.imageUrl = ''
    } else if (typeof value === 'string' && value.startsWith('data:')) {
      const r = cleanPartnerImage(value)
      if (r.error) return res.status(400).json({ error: r.error })
      // The small copy for the grid is optional (older clients send none); it has its own, tighter cap.
      let thumb = ''
      if (req.body?.thumb !== undefined && req.body.thumb !== null && req.body.thumb !== '') {
        const t = cleanPartnerImage(req.body.thumb, { maxBytes: 100 * 1024 })
        if (t.error) return res.status(400).json({ error: `Thumbnail: ${t.error}` })
        thumb = t.image
      }
      doc.imageData = r.image; doc.thumbData = thumb; doc.imageUploadedAt = new Date(); doc.imageUrl = ''
    } else {
      const link = typeof value === 'string' ? cleanLink(value, { max: 2000 }) : null
      if (!link) return res.status(400).json({ error: 'Image must be an uploaded picture or an http or https link' })
      doc.imageUrl = link; doc.imageData = ''; doc.thumbData = ''; doc.imageUploadedAt = null
    }
    doc.updatedBy = req.user.id
    await doc.save()
    await AuditLog.create({ byUser: req.user.id, action: 'Partner Image Updated', detail: `${doc.name}: image ${value ? 'set' : 'removed'} by ${req.user.name}` })
    res.json(toPartner(doc.toObject()))
  } catch (err) { serverError(res, err) }
})

// GET /api/manufacturers/:id
router.get('/:id', async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ error: 'Partner not found' })
    const p = await Manufacturer.findById(req.params.id).lean()
    if (!p) return res.status(404).json({ error: 'Partner not found' })
    res.json(toPartner(p))
  } catch (err) { serverError(res, err) }
})

// POST /api/manufacturers/:id - edit a partner (only the fields sent). Every change is audited, verification
// changes under their own entry, and a verification change stamps lastCheckedAt on the server.
router.post('/:id', writeLimiter, async (req, res) => {
  try {
    const doc = await findOne(req, res, null)
    if (!doc) return
    const cleaned = cleanPartnerInput(req.body, { partial: true })
    if (cleaned.errors) return res.status(400).json({ error: cleaned.errors.join('. ') })
    // Live is a status, and it needs a manufacturer account on the platform: that is what lets Tradio give it orders.
    if (cleaned.data.status === 'live' && !doc.linkedUserId) {
      return res.status(400).json({ error: 'Only a partner with a manufacturer account on the platform can be Live. Create its account in User Setup first.' })
    }
    const before = doc.toObject()
    const changes = []       // [field, from, to] outside verification
    const vChanges = []      // [flag, from, to]
    for (const [k, v] of Object.entries(cleaned.data)) {
      if (k === 'machines' || k === 'verification') {
        for (const [sk, sv] of Object.entries(v)) {
          if (eq(before[k]?.[sk], sv)) continue
          doc.set(`${k}.${sk}`, sv)
          ;(k === 'verification' ? vChanges : changes).push([k === 'verification' ? sk : `machines.${sk}`, before[k]?.[sk], sv])
        }
      } else if (!eq(before[k], v)) {
        doc.set(k, v)
        changes.push([k, before[k], v])
      }
    }
    if (changes.length === 0 && vChanges.length === 0) return res.json(toPartner(before))
    if (vChanges.length) doc.set('verification.lastCheckedAt', new Date())
    doc.updatedBy = req.user.id
    await doc.save()
    if (changes.length) {
      const what = changes.map(([f, a, b]) => (VALUE_FIELDS.has(f) ? `${f} ${show(a)} -> ${show(b)}` : f)).join(', ')
      await AuditLog.create({ byUser: req.user.id, action: 'Partner Updated', detail: `${doc.name}: ${what} (by ${req.user.name})`.slice(0, 1000) })
    }
    if (vChanges.length) {
      const what = vChanges.map(([f, a, b]) => `${f} ${show(a)} -> ${show(b)}`).join(', ')
      await AuditLog.create({ byUser: req.user.id, action: 'Partner Verification Updated', detail: `${doc.name}: ${what} (by ${req.user.name})` })
    }
    res.json(toPartner(doc.toObject()))
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: `A partner named "${req.body?.name}" already exists` })
    serverError(res, err)
  }
})

// POST /api/manufacturers/:id/delete - remove a partner for good (archive it with isActive: false to keep it)
router.post('/:id/delete', writeLimiter, async (req, res) => {
  try {
    const doc = await findOne(req, res, 'name type city')
    if (!doc) return
    await Manufacturer.deleteOne({ _id: doc._id })
    await AuditLog.create({ byUser: req.user.id, action: 'Partner Deleted', detail: `${doc.name} (${doc.type}${doc.city ? `, ${doc.city}` : ''}) deleted by ${req.user.name}` })
    res.json({ ok: true })
  } catch (err) { serverError(res, err) }
})

export default router
