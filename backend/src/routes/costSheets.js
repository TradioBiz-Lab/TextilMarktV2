// Open cost sheets: the factory builds the price of a style line by line, shares a version with its
// customer, and the customer comments and approves it.
//
// A factory prepares a sheet as a draft that only it sees (optionally seeded from a bill of materials).
// Sharing freezes that version, emails the brand's team the PDF and a link, and makes it readable to the
// brand; a change after that is a new version (revise), and sharing it supersedes the older ones. The brand
// comments (a comment on a shared version marks it "commented") and approves; approval is the brand's alone.
// Every figure is worked on the server (lib/costing.js): the browser's totals are never trusted or stored.
//
// Scoping: a factory reaches the sheets its own organization owns; a brand reaches only versions that were
// shared with it. Anything else is a 404. Tradio's fee line is zero unless the factory is managed by Tradio.
import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { CostSheet, Organization, Partnership, Order, Bom, User, AuditLog } from '../db/index.js'
import { requireAuth } from '../middleware/auth.js'
import { userKey } from '../lib/limiterKey.js'
import { requireCosting, isId } from '../lib/procurement.js'
import { allocateCostSheetRef } from '../lib/counters.js'
import { cleanSheet, computeFor, factoryView, brandView, summaryView, labelOf } from '../lib/costSheet.js'
import { linesFromBom, DEFAULT_PERCENTS } from '../lib/costing.js'
import { weightedConsumption } from '../lib/bomMath.js'
import { renderCostSheetPdf } from '../lib/pdf/costSheet.js'
import { sendEmailDetailed, emailCostSheetShared, emailCostSheetApproved } from '../lib/email.js'
import { notify } from '../lib/notify.js'

const router = Router()
router.use(requireAuth, requireCosting)

const skipInTest = () => process.env.NODE_ENV === 'test'
const limiter = (max, message) => rateLimit({
  windowMs: 60 * 60 * 1000, max, keyGenerator: userKey, skip: skipInTest, message: { error: message },
  standardHeaders: true, legacyHeaders: false, validate: false,
})
const writeLimiter = limiter(300, 'Too many changes. Please wait.')
const shareLimiter = limiter(60, 'Too many cost sheets shared. Please wait.')

// What a new version starts with: everything the factory entered, none of the sharing, comments or approval.
const CARRIED = ['ownerOrgId', 'mfrId', 'brandOrgId', 'brandId', 'chainId', 'styleName', 'styleCode', 'orderId', 'bomId', 'qty',
  'fabric', 'process', 'trims', 'labelsPackaging', 'labour', 'overheadPct', 'rejectionPct', 'marginPct', 'tradioPct', 'discountPct', 'internalNote']

const FRONTEND_URL = () => process.env.FRONTEND_URL || 'http://localhost:5173'
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const isFactory = req => req.user.role === 'manufacturer'
const fail = (res, status, error, extra = {}) => res.status(status).json({ error, ...extra })
const link = sheet => `${FRONTEND_URL()}/#cost=${sheet._id}`

/** The sheets this caller may reach: a factory its own, a brand only what was shared with it. */
const scope = req => (isFactory(req) ? { ownerOrgId: req.user.orgId } : { brandOrgId: req.user.orgId, sharedAt: { $ne: null } })
const load = (req, id) => (isId(id) ? CostSheet.findOne({ _id: id, ...scope(req) }).lean() : null)
const factoryOnly = (req, res) => { if (isFactory(req)) return true; fail(res, 403, 'Only the factory can do that'); return false }

const orgNames = async ids => {
  const orgs = await Organization.find({ _id: { $in: [...new Set(ids.map(String))] } }, 'name profile code tradioEnabled').lean()
  return new Map(orgs.map(o => [String(o._id), o]))
}
/** The people in a company who should hear about a sheet, with the addresses the server (never the other side) holds. */
const teamOf = orgId => User.find({ orgId, isActive: true }, 'name email').lean()

/** A version with the names and the other versions of its sheet, shaped for whoever is asking. */
async function present(req, sheet) {
  const names = await orgNames([sheet.ownerOrgId, sheet.brandOrgId])
  const versions = await CostSheet.find({ ownerOrgId: sheet.ownerOrgId, chainId: sheet.chainId, ...(isFactory(req) ? {} : { sharedAt: { $ne: null } }) }, 'version status sharedAt approvedAt').sort({ version: -1 }).lean()
  const extra = {
    factoryName: names.get(String(sheet.ownerOrgId))?.name || '', brandName: names.get(String(sheet.brandOrgId))?.name || '',
    versions: versions.map(v => ({ id: String(v._id), version: v.version, status: v.status, sharedAt: v.sharedAt || null, approvedAt: v.approvedAt || null })),
  }
  return isFactory(req) ? factoryView(sheet, extra) : brandView(sheet, extra)
}

// ── Routes ───────────────────────────────────────────────────────────────────

// GET /api/cost-sheets - one row per sheet: for a factory its own (latest version), for a brand what has been shared with it
router.get('/', async (req, res) => {
  try {
    const all = await CostSheet.find(scope(req), '-fabric -process -trims -labelsPackaging').sort({ updatedAt: -1 }).limit(500).lean()
    const latest = new Map()
    const counts = new Map()
    for (const s of all) {
      const key = `${s.ownerOrgId}|${s.chainId}`
      counts.set(key, (counts.get(key) || 0) + 1)
      const cur = latest.get(key)
      if (!cur || s.version > cur.version) latest.set(key, s)
    }
    const names = await orgNames([...latest.values()].flatMap(s => [s.ownerOrgId, s.brandOrgId]))
    const rows = [...latest.values()].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)).map(s => ({
      ...summaryView(s), versions: counts.get(`${s.ownerOrgId}|${s.chainId}`),
      factoryName: names.get(String(s.ownerOrgId))?.name || '', brandName: names.get(String(s.brandOrgId))?.name || '',
      ...(isFactory(req) ? { brandId: String(s.brandId) } : {}),
    }))
    res.json(rows)
  } catch (err) { console.error('[cost]', err); fail(res, 500, 'Server error') }
})

// POST /api/cost-sheets - start a sheet for one of the factory's customers, optionally seeded from a bill of materials
router.post('/', writeLimiter, async (req, res) => {
  try {
    if (!factoryOnly(req, res)) return
    const body = req.body || {}
    const brandOrg = isId(body.brandId) ? await Organization.findOne({ ownerUserId: body.brandId, type: 'brand', isActive: true }).lean() : null
    if (!brandOrg || !(await Partnership.exists({ brandOrgId: brandOrg._id, mfrOrgId: req.user.orgId, status: 'active' })))
      return fail(res, 400, 'Choose one of your customers')

    let order = null
    if (body.orderId) {
      order = typeof body.orderId === 'string' && body.orderId.length <= 100 ? await Order.findOne({ _id: body.orderId, 'assignments.mfrId': req.user.id }).lean() : null
      if (!order || String(order.buyerId) !== String(body.brandId)) return fail(res, 400, 'Choose one of your orders for this customer')
    }

    let seed = {}
    let bomId = null
    if (body.bomId) {
      const bom = isId(body.bomId) ? await Bom.findOne({ _id: body.bomId, ownerOrgId: req.user.orgId }).lean() : null
      if (!bom) return fail(res, 400, 'Choose one of your bills of materials')
      bomId = bom._id
      const plan = { sizes: bom.sizes, ratio: bom.sizeRatio }
      seed = { ...linesFromBom(bom.lines, l => weightedConsumption(plan, l)), qty: bom.totalQty }
      if (!order && bom.orderId) order = await Order.findOne({ _id: bom.orderId, 'assignments.mfrId': req.user.id, buyerId: body.brandId }, 'product styleNumber').lean()
    }

    const org = await Organization.findById(req.user.orgId).lean()
    const tradioEnabled = !!org?.tradioEnabled
    const start = {
      styleName: order?.product || '', styleCode: order?.styleNumber || '', ...DEFAULT_PERCENTS, tradioPct: tradioEnabled ? DEFAULT_PERCENTS.tradioPct : 0,
      ...seed,
    }
    const clean = cleanSheet({ ...start, ...body }, {}, { tradioEnabled })
    if (!clean.ok) return fail(res, 400, clean.error)

    const chainId = await allocateCostSheetRef({ orgId: String(req.user.orgId), orgCode: org.code })
    const sheet = await CostSheet.create({
      ownerOrgId: req.user.orgId, mfrId: req.user.id, brandOrgId: brandOrg._id, brandId: body.brandId,
      chainId, version: 1, status: 'draft', orderId: order?._id || null, bomId, ...clean.data,
      computed: computeFor(clean.data), createdBy: req.user.actorId, updatedBy: req.user.actorId,
    })
    await AuditLog.create({ byUser: req.user.id, action: 'Cost Sheet Started', detail: `${chainId} for ${brandOrg.name} (${clean.data.styleName}) started by ${req.user.name}` })
    res.status(201).json(await present(req, sheet.toObject()))
  } catch (err) { console.error('[cost]', err); fail(res, 500, 'Server error') }
})

// GET /api/cost-sheets/:id
router.get('/:id', async (req, res) => {
  try {
    const sheet = await load(req, req.params.id)
    if (!sheet) return fail(res, 404, 'Cost sheet not found')
    res.json(await present(req, sheet))
  } catch (err) { console.error('[cost]', err); fail(res, 500, 'Server error') }
})

// POST /api/cost-sheets/:id - save a draft (the fields sent replace what is there). Body may carry updatedAt: the version being edited.
router.post('/:id', writeLimiter, async (req, res) => {
  try {
    if (!factoryOnly(req, res)) return
    const sheet = await load(req, req.params.id)
    if (!sheet) return fail(res, 404, 'Cost sheet not found')
    if (sheet.status !== 'draft') return fail(res, 409, 'A shared cost sheet cannot be edited. Start a new version to change it')
    const body = req.body || {}
    if (body.updatedAt && new Date(body.updatedAt).getTime() !== new Date(sheet.updatedAt).getTime())
      return fail(res, 409, 'Someone else changed this cost sheet while you were editing. Reload it to see their changes', { code: 'STALE' })
    const org = await Organization.findById(req.user.orgId, 'tradioEnabled').lean()
    const clean = cleanSheet(body, sheet, { tradioEnabled: !!org?.tradioEnabled })
    if (!clean.ok) return fail(res, 400, clean.error)
    const saved = await CostSheet.findOneAndUpdate(
      { _id: sheet._id, ownerOrgId: req.user.orgId, status: 'draft', updatedAt: sheet.updatedAt },
      { $set: { ...clean.data, computed: computeFor(clean.data), updatedBy: req.user.actorId } }, { new: true },
    ).lean()
    if (!saved) return fail(res, 409, 'Someone else changed this cost sheet while you were editing. Reload it to see their changes', { code: 'STALE' })
    res.json(await present(req, saved))
  } catch (err) { console.error('[cost]', err); fail(res, 500, 'Server error') }
})

// POST /api/cost-sheets/:id/delete - throw a draft away (a shared version stays as the record)
router.post('/:id/delete', writeLimiter, async (req, res) => {
  try {
    if (!factoryOnly(req, res)) return
    const sheet = await load(req, req.params.id)
    if (!sheet) return fail(res, 404, 'Cost sheet not found')
    if (sheet.status !== 'draft') return fail(res, 409, 'Only a draft can be deleted')
    const r = await CostSheet.deleteOne({ _id: sheet._id, ownerOrgId: req.user.orgId, status: 'draft' })
    if (r.deletedCount === 0) return fail(res, 409, 'This cost sheet changed. Reload it and try again')
    await AuditLog.create({ byUser: req.user.id, action: 'Cost Sheet Draft Deleted', detail: `${labelOf(sheet)} deleted by ${req.user.name}` })
    res.json({ ok: true })
  } catch (err) { console.error('[cost]', err); fail(res, 500, 'Server error') }
})

// POST /api/cost-sheets/:id/share { message?, extraEmails? } - freeze this version, tell the brand's team, email them the PDF
router.post('/:id/share', shareLimiter, async (req, res) => {
  try {
    if (!factoryOnly(req, res)) return
    const sheet = await load(req, req.params.id)
    if (!sheet) return fail(res, 404, 'Cost sheet not found')
    if (sheet.status !== 'draft') return fail(res, 409, 'This version has already been shared')
    const figures = computeFor(sheet)
    if (!(figures.price > 0)) return fail(res, 409, 'Add some costs before sharing: the price is zero')
    if (!(await Partnership.exists({ brandOrgId: sheet.brandOrgId, mfrOrgId: req.user.orgId, status: 'active' })))
      return fail(res, 409, 'You are no longer connected with this customer')

    const body = req.body || {}
    const message = typeof body.message === 'string' ? body.message.trim().slice(0, 1000) : ''
    const extra = (Array.isArray(body.extraEmails) ? body.extraEmails : []).map(e => String(e || '').trim().toLowerCase())
    if (extra.length > 5 || extra.some(e => !EMAIL_RE.test(e))) return fail(res, 400, 'Give up to 5 valid email addresses')

    const shared = await CostSheet.findOneAndUpdate(
      { _id: sheet._id, ownerOrgId: req.user.orgId, status: 'draft' },
      { $set: { status: 'shared', sharedAt: new Date(), sharedBy: req.user.actorId, sharedMessage: message, computed: figures, updatedBy: req.user.actorId } }, { new: true },
    ).lean()
    if (!shared) return fail(res, 409, 'This cost sheet changed while you were sharing it. Reload it and try again')
    // The version it replaces stays on record, no longer the live one.
    await CostSheet.updateMany({ ownerOrgId: req.user.orgId, chainId: sheet.chainId, _id: { $ne: sheet._id }, status: { $in: ['shared', 'commented', 'approved'] } }, { $set: { status: 'superseded' } })

    const names = await orgNames([shared.ownerOrgId, shared.brandOrgId])
    const factory = names.get(String(shared.ownerOrgId)), brand = names.get(String(shared.brandOrgId))
    const team = await teamOf(shared.brandOrgId)
    await notify(team.map(u => u._id), { type: 'costing', msg: `${factory?.name} shared cost sheet ${labelOf(shared)} for ${shared.styleName}`, link: `#cost=${shared._id}` })

    const recipients = [...new Set([...team.map(u => u.email).filter(Boolean).map(e => e.toLowerCase()), ...extra])]
    let mail = { skipped: false, sent: [], failed: [] }
    if (recipients.length) {
      const pdf = await renderCostSheetPdf(shared, { factoryName: factory?.profile?.legalName || factory?.name || '', brandName: brand?.name || '', address: [factory?.profile?.address, factory?.profile?.city].filter(Boolean).join(', ') })
      const mailBody = emailCostSheetShared({
        to: recipients, factoryName: factory?.name || '', brandName: brand?.name || '', styleName: shared.styleName, label: labelOf(shared),
        price: figures.price, negotiated: figures.negotiated, message, link: link(shared), senderName: req.user.name,
      })
      mail = await sendEmailDetailed({ ...mailBody, attachments: [{ filename: `${shared.chainId}-v${shared.version}.pdf`, content: pdf }], replyTo: req.user.email, fromName: factory?.name })
    }
    await AuditLog.create({ byUser: req.user.id, action: 'Cost Sheet Shared', detail: `${labelOf(shared)} (${shared.styleName}) shared with ${brand?.name} by ${req.user.name}` }).catch(err => console.error('[cost share] audit failed', err))
    res.json({ sheet: await present(req, shared), emailed: mail.sent, emailSkipped: !!mail.skipped, emailFailed: mail.failed })
  } catch (err) { console.error('[cost]', err); fail(res, 500, 'Server error') }
})

// POST /api/cost-sheets/:id/revise - a new draft version of a shared sheet, to answer comments or change prices
router.post('/:id/revise', writeLimiter, async (req, res) => {
  try {
    if (!factoryOnly(req, res)) return
    const sheet = await load(req, req.params.id)
    if (!sheet) return fail(res, 404, 'Cost sheet not found')
    if (!['shared', 'commented', 'approved'].includes(sheet.status)) return fail(res, 409, 'Only the latest shared version can be revised')
    const newest = await CostSheet.findOne({ ownerOrgId: sheet.ownerOrgId, chainId: sheet.chainId }, 'version status').sort({ version: -1 }).lean()
    if (newest && newest.version !== sheet.version) return fail(res, 409, newest.status === 'draft' ? 'There is already a draft of the next version' : 'A newer version already exists')
    const inputs = Object.fromEntries(CARRIED.map(k => [k, sheet[k]]))
    let next
    try {
      next = await CostSheet.create({ ...inputs, version: sheet.version + 1, status: 'draft', computed: computeFor(sheet), comments: [], createdBy: req.user.actorId, updatedBy: req.user.actorId })
    } catch (err) { if (err?.code === 11000) return fail(res, 409, 'A newer version already exists'); throw err }
    await AuditLog.create({ byUser: req.user.id, action: 'Cost Sheet Revised', detail: `${labelOf(next)} started from version ${sheet.version} by ${req.user.name}` })
    res.status(201).json(await present(req, next.toObject()))
  } catch (err) { console.error('[cost]', err); fail(res, 500, 'Server error') }
})

// POST /api/cost-sheets/:id/comments { text, kind? } - either side talks about a shared version; a brand's comment marks it "commented"
router.post('/:id/comments', writeLimiter, async (req, res) => {
  try {
    const sheet = await load(req, req.params.id)
    if (!sheet) return fail(res, 404, 'Cost sheet not found')
    if (!['shared', 'commented', 'approved'].includes(sheet.status)) return fail(res, 409, 'Comments are for the current shared version')
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : ''
    if (!text) return fail(res, 400, 'Write a comment first')
    if (text.length > 2000) return fail(res, 400, 'That comment is too long (most 2000 characters)')
    if ((sheet.comments || []).length >= 200) return fail(res, 409, 'This cost sheet has too many comments. Start a new version')
    const kind = !isFactory(req) && req.body?.kind === 'changes' ? 'changes' : 'comment'
    const comment = { at: new Date(), byUser: req.user.actorId, byName: req.user.name, byRole: isFactory(req) ? 'manufacturer' : 'buyer', kind, text }
    const flip = !isFactory(req) && sheet.status === 'shared'
    const saved = await CostSheet.findOneAndUpdate(
      { _id: sheet._id, ...scope(req), status: { $in: ['shared', 'commented', 'approved'] } },
      { $push: { comments: comment }, ...(flip ? { $set: { status: 'commented' } } : {}) }, { new: true },
    ).lean()
    if (!saved) return fail(res, 409, 'This cost sheet changed. Reload it and try again')
    const toOrg = isFactory(req) ? saved.brandOrgId : saved.ownerOrgId
    const names = await orgNames([req.user.orgId])
    await notify((await teamOf(toOrg)).map(u => u._id), {
      type: 'costing', link: `#cost=${saved._id}`,
      msg: `${names.get(String(req.user.orgId))?.name || req.user.name} ${kind === 'changes' ? 'asked for changes on' : 'commented on'} cost sheet ${labelOf(saved)} (${saved.styleName})`,
    })
    res.json(await present(req, saved))
  } catch (err) { console.error('[cost]', err); fail(res, 500, 'Server error') }
})

// POST /api/cost-sheets/:id/approve - the brand approves a shared version. Never done on a brand's behalf.
router.post('/:id/approve', shareLimiter, async (req, res) => {
  try {
    if (isFactory(req)) return fail(res, 403, 'Only the customer can approve a cost sheet')
    const sheet = await load(req, req.params.id)
    if (!sheet) return fail(res, 404, 'Cost sheet not found')
    if (!['shared', 'commented'].includes(sheet.status)) return fail(res, 409, sheet.status === 'approved' ? 'This cost sheet is already approved' : 'Only the current shared version can be approved')
    const approved = await CostSheet.findOneAndUpdate(
      { _id: sheet._id, ...scope(req), status: { $in: ['shared', 'commented'] } },
      { $set: { status: 'approved', approvedAt: new Date(), approvedBy: req.user.actorId, approvedByName: req.user.name, approvedPrice: sheet.computed?.negotiated ?? sheet.computed?.price ?? null } }, { new: true },
    ).lean()
    if (!approved) return fail(res, 409, 'This cost sheet changed. Reload it and try again')
    const names = await orgNames([approved.ownerOrgId, approved.brandOrgId])
    const factoryTeam = await teamOf(approved.ownerOrgId)
    const brandName = names.get(String(approved.brandOrgId))?.name || ''
    await notify(factoryTeam.map(u => u._id), { type: 'costing', link: `#cost=${approved._id}`, msg: `${brandName} approved cost sheet ${labelOf(approved)} for ${approved.styleName}` })
    await sendEmailDetailed({
      ...emailCostSheetApproved({ to: factoryTeam.map(u => u.email).filter(Boolean), brandName, styleName: approved.styleName, label: labelOf(approved), price: approved.approvedPrice, approvedBy: req.user.name, link: link(approved) }),
      replyTo: req.user.email, fromName: brandName,
    }).catch(err => console.error('[cost approve] email failed', err))
    await AuditLog.create({ byUser: req.user.id, action: 'Cost Sheet Approved', detail: `${labelOf(approved)} (${approved.styleName}) approved by ${req.user.name} for ${brandName} at ${approved.approvedPrice}` }).catch(err => console.error('[cost approve] audit failed', err))
    res.json(await present(req, approved))
  } catch (err) { console.error('[cost]', err); fail(res, 500, 'Server error') }
})

// GET /api/cost-sheets/:id/pdf - { fileName, mimeType, dataUrl }: the sheet as a PDF (a draft is watermarked)
router.get('/:id/pdf', async (req, res) => {
  try {
    const sheet = await load(req, req.params.id)
    if (!sheet) return fail(res, 404, 'Cost sheet not found')
    const names = await orgNames([sheet.ownerOrgId, sheet.brandOrgId])
    const factory = names.get(String(sheet.ownerOrgId)), brand = names.get(String(sheet.brandOrgId))
    const buf = await renderCostSheetPdf(sheet, { factoryName: factory?.profile?.legalName || factory?.name || '', brandName: brand?.name || '', address: [factory?.profile?.address, factory?.profile?.city].filter(Boolean).join(', ') })
    res.json({ fileName: `${sheet.chainId}-v${sheet.version}.pdf`, mimeType: 'application/pdf', dataUrl: `data:application/pdf;base64,${buf.toString('base64')}` })
  } catch (err) { console.error('[cost]', err); fail(res, 500, 'Server error') }
})

export default router
