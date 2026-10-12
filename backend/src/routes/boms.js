// Bills of materials a manufacturer keeps for the styles it is making.
//
// A BOM belongs to one order and the factory's own split of it: the sizes and colours the quantity is
// divided over, and a line for every fabric, process, trim and label with its consumption, wastage,
// supplier and rate. Drafts are edited freely; freezing makes it the master list of what to order (and
// what a cost sheet is seeded from); a change after that starts a new version. Quantities are worked on
// the server (lib/bomMath.js). Frozen BOMs of many orders add up into one shopping list per supplier
// (/aggregate), which turns into draft purchase orders (/generate-pos).
//
// Private to the company: rates and suppliers are the factory's own business, so every query is scoped by
// the caller's organization, brands and Tradio staff cannot use these routes (requireProcurement), and a
// BOM that is not yours is a 404.
import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { Bom, Order, Supplier, SupplierItem, PurchaseOrder, Document, SpecSheet, AuditLog } from '../db/index.js'
import { requireAuth } from '../middleware/auth.js'
import { userKey } from '../lib/limiterKey.js'
import { requireProcurement, isId } from '../lib/procurement.js'
import { cleanPlan, cleanBomLine, seedPlan, bomView, bomSummary, BOM_LIMITS, newLineId } from '../lib/bom.js'
import { aggregate } from '../lib/bomAggregate.js'
import { roundTo } from '../lib/bomMath.js'
import { createDraft } from '../lib/poDraft.js'
import { readTechPack, linesFromTechPack, specFromTechPack, sizesOf, techPackModel } from '../lib/ai/techpack.js'
import { specView } from '../lib/specSheet.js'

const router = Router()
router.use(requireAuth, requireProcurement)

const skipInTest = () => process.env.NODE_ENV === 'test'
const limiter = (max, message) => rateLimit({
  windowMs: 60 * 60 * 1000, max, keyGenerator: userKey, skip: skipInTest, message: { error: message },
  standardHeaders: true, legacyHeaders: false, validate: false,
})
const writeLimiter = limiter(300, 'Too many changes. Please wait.')
const generateLimiter = limiter(60, 'Too many purchase orders generated. Please wait.')
const extractLimiter = limiter(20, 'Too many tech packs read. Please wait.')
const MAX_TECHPACK_BYTES = 10 * 1024 * 1024
const READABLE = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp']

const mine = req => ({ ownerOrgId: req.user.orgId })
const fail = (res, status, error, extra = {}) => res.status(status).json({ error, ...extra })

/** The order, if this factory has a split of it. */
const ownOrder = (req, orderId) => (typeof orderId === 'string' && orderId && orderId.length <= 100
  ? Order.findOne({ _id: orderId, 'assignments.mfrId': req.user.id }).lean() : null)
const ownSplit = (req, order) => (order?.assignments || []).find(a => String(a.mfrId) === String(req.user.id))

const supplierNames = async (req, bom) => {
  const ids = [...new Set((bom.lines || []).map(l => l.supplierId).filter(Boolean).map(String))]
  if (!ids.length) return new Map()
  const rows = await Supplier.find({ _id: { $in: ids }, ...mine(req) }, 'name').lean()
  return new Map(rows.map(s => [String(s._id), s.name]))
}
const present = async (req, bom) => bomView(bom, { supplierNames: await supplierNames(req, bom) })

/** Suppliers and catalog items on the lines must be the company's own, and an item must be its supplier's. */
async function checkLinks(req, lines) {
  const sids = [...new Set(lines.map(l => l.supplierId).filter(Boolean))]
  if (sids.length && (await Supplier.countDocuments({ _id: { $in: sids }, ...mine(req) })) !== sids.length)
    return 'A line names a supplier that is not in your supplier book'
  const iids = [...new Set(lines.map(l => l.itemId).filter(Boolean))]
  if (!iids.length) return null
  const items = await SupplierItem.find({ _id: { $in: iids }, ...mine(req) }, 'supplierId').lean()
  if (items.length !== iids.length) return 'A line names a catalog item that is not in your supplier book'
  const byId = new Map(items.map(i => [String(i._id), String(i.supplierId)]))
  for (const l of lines) {
    if (!l.itemId) continue
    if (!l.supplierId) l.supplierId = byId.get(l.itemId)           // choosing a catalog item chooses its supplier
    else if (byId.get(l.itemId) !== l.supplierId) return `${l.item}: that catalog item belongs to another supplier`
  }
  return null
}

/** The latest frozen BOM of each of the factory's orders (optionally limited), with the orders. */
async function loadFrozen(req, { masterOrderId = '', orderIds = [] } = {}) {
  const filter = { 'assignments.mfrId': req.user.id }
  if (masterOrderId) filter.masterOrderId = String(masterOrderId)
  if (orderIds.length) filter._id = { $in: orderIds }
  const orders = await Order.find(filter, 'product styleNumber').limit(300).lean()
  const ids = orders.map(o => o._id)
  const boms = ids.length ? await Bom.find({ ...mine(req), orderId: { $in: ids }, status: 'frozen' }).sort({ version: -1 }).lean() : []
  const latest = new Map()
  for (const b of boms) if (!latest.has(b.orderId)) latest.set(b.orderId, b)
  const byOrder = new Map(orders.map(o => [o._id, o]))
  return { frozen: [...latest.values()].map(bom => ({ bom, order: byOrder.get(bom.orderId) })), orderIds: ids }
}

/** The aggregate for the factory's orders: rows to buy, with what already sits on a purchase order taken off. */
async function buildAggregate(req, scope) {
  const { frozen, orderIds } = await loadFrozen(req, scope)
  const onPo = new Map()
  if (frozen.length) {
    const pos = await PurchaseOrder.find({ ...mine(req), status: { $ne: 'cancelled' }, 'lines.bomRefs.orderId': { $in: orderIds } }, 'lines.bomRefs').lean()
    for (const po of pos) for (const l of po.lines) for (const r of l.bomRefs || []) {
      const key = `${r.orderId}|${r.lineId}|${String(r.colour || '').trim().toLowerCase().replace(/\s+/g, ' ')}`
      onPo.set(key, (onPo.get(key) || 0) + r.qty)
    }
  }
  const supplierIds = [...new Set(frozen.flatMap(f => f.bom.lines.map(l => l.supplierId)).filter(Boolean).map(String))]
  const itemIds = [...new Set(frozen.flatMap(f => f.bom.lines.map(l => l.itemId)).filter(Boolean).map(String))]
  const [suppliers, items] = await Promise.all([
    supplierIds.length ? Supplier.find({ _id: { $in: supplierIds }, ...mine(req) }).lean() : [],
    itemIds.length ? SupplierItem.find({ _id: { $in: itemIds }, ...mine(req) }).lean() : [],
  ])
  return aggregate(frozen, onPo, {
    suppliers: new Map(suppliers.map(s => [String(s._id), s])), items: new Map(items.map(i => [String(i._id), i])),
  })
}

const scopeOf = source => ({
  masterOrderId: typeof source.masterOrderId === 'string' ? source.masterOrderId.slice(0, 100) : '',
  orderIds: (typeof source.orderIds === 'string' ? source.orderIds.split(',') : Array.isArray(source.orderIds) ? source.orderIds : [])
    .filter(v => typeof v === 'string' && v.trim() && v.length <= 100).map(v => v.trim()).slice(0, 200),
})

// ── Routes ───────────────────────────────────────────────────────────────────

// GET /api/boms?orderId= - the BOM versions of one of the factory's orders, the working one in full, and what a new one would start as
router.get('/', async (req, res) => {
  try {
    const order = await ownOrder(req, req.query.orderId)
    if (!order) return fail(res, 404, 'Order not found')
    const asgn = ownSplit(req, order)
    const boms = await Bom.find({ ...mine(req), orderId: order._id }).sort({ version: -1 }).lean()
    res.json({
      order: { id: order._id, product: order.product, styleNumber: order.styleNumber || '', quantity: asgn?.qty || 0 },
      versions: boms.map(bomSummary),
      current: boms[0] ? await present(req, boms[0]) : null,
      seed: seedPlan(order, asgn),
    })
  } catch (err) { console.error('[bom]', err); fail(res, 500, 'Server error') }
})

// GET /api/boms/aggregate - what to buy across frozen BOMs: ?masterOrderId= or ?orderIds=a,b (default: all the factory's orders)
router.get('/aggregate', async (req, res) => {
  try {
    const scope = scopeOf(req.query)
    const result = await buildAggregate(req, scope)
    res.json({ ...result, masterOrderId: scope.masterOrderId || null })
  } catch (err) { console.error('[bom]', err); fail(res, 500, 'Server error') }
})

// POST /api/boms/generate-pos - one draft PO per supplier for what is left to order. Body: { masterOrderId?, orderIds?, keys?, expectedDate? }
router.post('/generate-pos', generateLimiter, async (req, res) => {
  try {
    const body = req.body || {}
    const { rows } = await buildAggregate(req, scopeOf(body))
    const wanted = Array.isArray(body.keys) ? new Set(body.keys.filter(k => typeof k === 'string')) : null
    const chosen = rows.filter(r => !wanted || wanted.has(r.key))
    const skipped = []
    const bySupplier = new Map()
    for (const r of chosen) {
      if (r.remaining <= 0) { skipped.push({ item: r.item, colour: r.colour, reason: 'Already on a purchase order' }); continue }
      if (!r.supplierId) { skipped.push({ item: r.item, colour: r.colour, reason: 'No supplier chosen on the BOM' }); continue }
      if (!bySupplier.has(r.supplierId)) bySupplier.set(r.supplierId, [])
      bySupplier.get(r.supplierId).push(r)
    }
    const itemIds = [...new Set(chosen.map(r => r.itemId).filter(Boolean))]
    const items = new Map((itemIds.length ? await SupplierItem.find({ _id: { $in: itemIds }, ...mine(req) }).lean() : []).map(i => [String(i._id), i]))

    const created = []
    const failed = []
    for (const [supplierId, list] of bySupplier) {
      const lines = list.map(r => {
        const item = r.itemId ? items.get(r.itemId) : null
        const usable = item && String(item.supplierId) === supplierId ? item : null
        return {
          description: `${r.item}${r.spec ? `, ${r.spec}` : ''}${r.colour ? ` - ${r.colour}` : ''}`.slice(0, 300),
          itemId: usable ? String(usable._id) : null, unit: r.unit || 'pcs', qty: r.remaining, rate: r.rate || usable?.defaultRate || 0,
          taxPct: usable?.taxPct ?? 5, hsnCode: usable?.hsnCode || '',
          bomRefs: r.sources.filter(s => s.qty - s.onPo > 0).map(s => ({ bomId: s.bomId, orderId: s.orderId, lineId: s.lineId, colour: s.colour, qty: roundTo(s.qty - s.onPo, 3) })),
        }
      })
      const made = await createDraft(req, { supplierId, lines, expectedDate: body.expectedDate || null }, { trustBomRefs: true })
      if (!made.ok) { failed.push({ supplierName: list[0].supplierName, error: made.error }); continue }
      await AuditLog.create({ byUser: req.user.id, action: 'Purchase Order Drafted', detail: `${made.po._id} to ${made.supplier.name} drafted from the bill of materials by ${req.user.name}` })
      created.push({ id: made.po._id, supplierName: made.supplier.name, lineCount: made.po.lines.length, grandTotal: made.po.totals?.grandTotal || 0, warnings: made.warnings })
    }
    res.status(created.length ? 201 : 200).json({ created, skipped, failed })
  } catch (err) { console.error('[bom]', err); fail(res, 500, 'Server error') }
})

// POST /api/boms/extract { orderId, documentId } - read a tech pack on the order into a draft BOM (and keep its measurement spec).
// Everything it finds is a suggestion: lines come back marked as needing a look, and the BOM cannot be frozen until they are checked.
router.post('/extract', extractLimiter, async (req, res) => {
  try {
    const order = await ownOrder(req, req.body?.orderId)
    if (!order) return fail(res, 404, 'Order not found')
    const docId = req.body?.documentId
    const doc = isId(docId) ? await Document.findOne({ _id: docId, orderId: order._id, type: 'tech_pack', isActive: { $ne: false } }, 'dataUrl mimeType name').lean() : null
    if (!doc) return fail(res, 404, 'Tech pack not found on this order')
    if (!doc.dataUrl) return fail(res, 400, 'This tech pack is a link, not a file. Upload the PDF to have it read')
    const mime = doc.mimeType || /^data:([^;,]+)/.exec(doc.dataUrl)?.[1]
    if (!READABLE.includes(mime)) return fail(res, 400, 'Only a PDF or an image can be read')
    const buffer = Buffer.from(doc.dataUrl.split(',')[1] || '', 'base64')
    if (!buffer.length) return fail(res, 400, 'This tech pack file is empty')
    if (buffer.length > MAX_TECHPACK_BYTES) return fail(res, 400, 'This tech pack is too large to read (most 10 MB)')

    const latest = await Bom.findOne({ ...mine(req), orderId: order._id }).sort({ version: -1 }).lean()
    if (latest && latest.status !== 'draft') return fail(res, 409, 'This order\'s bill of materials is frozen. Start a new version before reading a tech pack into it')

    const { data, error } = await readTechPack(buffer, mime)
    if (!data) return fail(res, 502, 'The tech pack could not be read automatically. You can still enter the bill of materials by hand', { reason: error || null })

    const asgn = ownSplit(req, order)
    const lines = linesFromTechPack(data, latest?.lines || [])
    if ((latest?.lines.length || 0) + lines.length > BOM_LIMITS.lines) return fail(res, 409, `That would take the bill of materials past ${BOM_LIMITS.lines} lines`)
    const extraction = { at: new Date(), model: techPackModel(), confidence: data.confidence, notes: data.notes.slice(0, 20).map(n => n.slice(0, 300)) }

    let bom
    if (latest) {
      bom = await Bom.findOneAndUpdate(
        { _id: latest._id, ...mine(req), status: 'draft' },
        { $push: { lines: { $each: lines } }, $set: { techPackDocumentId: doc._id, extraction, updatedBy: req.user.actorId } }, { new: true },
      ).lean()
      if (!bom) return fail(res, 409, 'This bill of materials changed while the tech pack was being read. Reload it and try again')
    } else {
      const seeded = seedPlan(!order.colourways?.length && data.colourways.length ? { ...order, colourways: data.colourways.map(name => ({ name })) } : order, asgn)
      const pl = cleanPlan({ sizes: sizesOf(data).length ? sizesOf(data) : undefined }, seeded)
      const plan = pl.ok ? pl.plan : { ...seeded, sizes: seeded.sizes, sizeRatio: seeded.sizeRatio }
      bom = (await Bom.create({
        ...mine(req), mfrId: req.user.id, orderId: order._id, version: 1, status: 'draft',
        sizes: plan.sizes, sizeRatio: plan.sizeRatio, colours: seeded.colours, totalQty: seeded.totalQty, lines,
        techPackDocumentId: doc._id, extraction, createdBy: req.user.actorId, updatedBy: req.user.actorId,
      })).toObject()
    }

    // The measurement spec is kept, so it is read once and QC later measures against the same numbers.
    let spec = null
    const sp = specFromTechPack(data)
    if (sp.points.length) {
      const saved = await SpecSheet.findOneAndUpdate(
        { orderId: order._id, ownerOrgId: req.user.orgId },
        { $set: { mfrId: req.user.id, sourceDocumentId: doc._id, header: sp.header, sizes: sp.sizes, points: sp.points, extractedAt: new Date(), model: extraction.model, updatedBy: req.user.actorId } },
        { upsert: true, new: true },
      ).lean()
      spec = specView(saved, { editable: true })
    }
    await AuditLog.create({ byUser: req.user.id, action: 'BOM Drafted From Tech Pack', detail: `${order._id}: ${lines.length} line(s) and ${sp.points.length} measurement point(s) read from "${doc.name}" by ${req.user.name}` })
    res.json({
      bom: await present(req, bom), spec,
      extraction: { confidence: data.confidence, notes: extraction.notes, lines: lines.length, specPoints: sp.points.length, skipped: (data.bomCandidates || []).length - lines.length },
    })
  } catch (err) { console.error('[bom]', err); fail(res, 500, 'Server error') }
})

// POST /api/boms - start the BOM of an order, from the order's colours and the standard sizes
router.post('/', writeLimiter, async (req, res) => {
  try {
    const order = await ownOrder(req, req.body?.orderId)
    if (!order) return fail(res, 404, 'Order not found')
    if (await Bom.exists({ ...mine(req), orderId: order._id })) return fail(res, 409, 'This order already has a bill of materials')
    const plan = seedPlan(order, ownSplit(req, order))
    const bom = await Bom.create({
      ...mine(req), mfrId: req.user.id, orderId: order._id, version: 1, status: 'draft',
      sizes: plan.sizes, sizeRatio: plan.sizeRatio, colours: plan.colours, totalQty: plan.totalQty, lines: [],
      createdBy: req.user.actorId, updatedBy: req.user.actorId,
    })
    await AuditLog.create({ byUser: req.user.id, action: 'BOM Started', detail: `${order._id}: bill of materials started by ${req.user.name}` })
    res.status(201).json(await present(req, bom.toObject()))
  } catch (err) { console.error('[bom]', err); fail(res, 500, 'Server error') }
})

// GET /api/boms/:id
router.get('/:id', async (req, res) => {
  try {
    const bom = isId(req.params.id) ? await Bom.findOne({ _id: req.params.id, ...mine(req) }).lean() : null
    if (!bom) return fail(res, 404, 'Bill of materials not found')
    res.json(await present(req, bom))
  } catch (err) { console.error('[bom]', err); fail(res, 500, 'Server error') }
})

// POST /api/boms/:id - save a draft: the plan and/or the lines sent replace what is there. Body may carry updatedAt (the version being edited).
router.post('/:id', writeLimiter, async (req, res) => {
  try {
    const bom = isId(req.params.id) ? await Bom.findOne({ _id: req.params.id, ...mine(req) }).lean() : null
    if (!bom) return fail(res, 404, 'Bill of materials not found')
    if (bom.status !== 'draft') return fail(res, 409, 'A frozen bill of materials cannot be edited. Start a new version to change it')
    const body = req.body || {}
    if (body.updatedAt && new Date(body.updatedAt).getTime() !== new Date(bom.updatedAt).getTime())
      return fail(res, 409, 'Someone else changed this bill of materials while you were editing. Reload it to see their changes', { code: 'STALE' })

    const pl = cleanPlan(body.plan, { sizes: bom.sizes, sizeRatio: bom.sizeRatio, colours: bom.colours, totalQty: bom.totalQty })
    if (!pl.ok) return fail(res, 400, pl.error)

    const raw = body.lines === undefined ? bom.lines : body.lines
    if (!Array.isArray(raw) || raw.length > BOM_LIMITS.lines) return fail(res, 400, `A bill of materials can have at most ${BOM_LIMITS.lines} lines`)
    const previous = new Map(bom.lines.map(l => [l.lineId, l]))
    const seen = new Set()
    const lines = []
    for (const [i, r] of raw.entries()) {
      const c = cleanBomLine(r, i + 1, pl.plan.sizes.length, previous.get(r?.lineId) || null)
      if (!c.ok) return fail(res, 400, c.error)
      if (seen.has(c.line.lineId)) c.line.lineId = newLineId()
      seen.add(c.line.lineId)
      if (body.confirmAll === true) c.line.needsReview = false
      lines.push(c.line)
    }
    const linkProblem = await checkLinks(req, lines)
    if (linkProblem) return fail(res, 400, linkProblem)

    const saved = await Bom.findOneAndUpdate(
      { _id: bom._id, ...mine(req), status: 'draft', updatedAt: bom.updatedAt },
      { $set: { sizes: pl.plan.sizes, sizeRatio: pl.plan.sizeRatio, colours: pl.plan.colours, totalQty: pl.plan.totalQty, lines, updatedBy: req.user.actorId } },
      { new: true },
    ).lean()
    if (!saved) return fail(res, 409, 'Someone else changed this bill of materials while you were editing. Reload it to see their changes', { code: 'STALE' })
    res.json(await present(req, saved))
  } catch (err) { console.error('[bom]', err); fail(res, 500, 'Server error') }
})

// POST /api/boms/:id/freeze - make it the master list to order from
router.post('/:id/freeze', writeLimiter, async (req, res) => {
  try {
    const bom = isId(req.params.id) ? await Bom.findOne({ _id: req.params.id, ...mine(req) }).lean() : null
    if (!bom) return fail(res, 404, 'Bill of materials not found')
    if (bom.status !== 'draft') return fail(res, 409, 'This bill of materials is already frozen')
    if (!bom.lines.length) return fail(res, 409, 'Add at least one line before freezing')
    const unreviewed = bom.lines.filter(l => l.needsReview).length
    if (unreviewed) return fail(res, 409, `${unreviewed} line${unreviewed === 1 ? '' : 's'} from the AI still need a look. Check them, or confirm them all, before freezing`, { code: 'NEEDS_REVIEW', unreviewed })
    const frozen = await Bom.findOneAndUpdate(
      { _id: bom._id, ...mine(req), status: 'draft', updatedAt: bom.updatedAt },
      { $set: { status: 'frozen', frozenAt: new Date(), frozenBy: req.user.actorId } }, { new: true },
    ).lean()
    if (!frozen) return fail(res, 409, 'This bill of materials changed while you were freezing it. Reload it and try again', { code: 'STALE' })
    await AuditLog.create({ byUser: req.user.id, action: 'BOM Frozen', detail: `${bom.orderId}: bill of materials version ${bom.version} frozen by ${req.user.name} (${bom.lines.length} lines)` })
    res.json(await present(req, frozen))
  } catch (err) { console.error('[bom]', err); fail(res, 500, 'Server error') }
})

// POST /api/boms/:id/revise - a new draft version of a frozen BOM (the same lines, the same line ids)
router.post('/:id/revise', writeLimiter, async (req, res) => {
  try {
    const bom = isId(req.params.id) ? await Bom.findOne({ _id: req.params.id, ...mine(req) }).lean() : null
    if (!bom) return fail(res, 404, 'Bill of materials not found')
    if (bom.status !== 'frozen') return fail(res, 409, 'Only a frozen bill of materials can be revised')
    const newest = await Bom.findOne({ ...mine(req), orderId: bom.orderId }, 'version status').sort({ version: -1 }).lean()
    if (newest && newest.version !== bom.version) return fail(res, 409, 'A newer version already exists')
    let next
    try {
      next = await Bom.create({
        ...mine(req), mfrId: bom.mfrId, orderId: bom.orderId, version: bom.version + 1, status: 'draft',
        sizes: bom.sizes, sizeRatio: bom.sizeRatio, colours: bom.colours, totalQty: bom.totalQty,
        lines: bom.lines.map(l => ({ ...l, needsReview: false })), techPackDocumentId: bom.techPackDocumentId,
        createdBy: req.user.actorId, updatedBy: req.user.actorId,
      })
    } catch (err) { if (err?.code === 11000) return fail(res, 409, 'A newer version already exists'); throw err }
    await AuditLog.create({ byUser: req.user.id, action: 'BOM Revised', detail: `${bom.orderId}: version ${next.version} started from version ${bom.version} by ${req.user.name}` })
    res.status(201).json(await present(req, next.toObject()))
  } catch (err) { console.error('[bom]', err); fail(res, 500, 'Server error') }
})

// POST /api/boms/:id/delete - throw a draft away (a frozen BOM stays as the record)
router.post('/:id/delete', writeLimiter, async (req, res) => {
  try {
    const bom = isId(req.params.id) ? await Bom.findOne({ _id: req.params.id, ...mine(req) }, 'status orderId version').lean() : null
    if (!bom) return fail(res, 404, 'Bill of materials not found')
    if (bom.status !== 'draft') return fail(res, 409, 'A frozen bill of materials cannot be deleted')
    const r = await Bom.deleteOne({ _id: bom._id, ...mine(req), status: 'draft' })
    if (r.deletedCount === 0) return fail(res, 409, 'This bill of materials changed. Reload it and try again')
    await AuditLog.create({ byUser: req.user.id, action: 'BOM Draft Deleted', detail: `${bom.orderId}: draft version ${bom.version} deleted by ${req.user.name}` })
    res.json({ ok: true })
  } catch (err) { console.error('[bom]', err); fail(res, 500, 'Server error') }
})

export default router
