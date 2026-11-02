import { Router } from 'express'
import crypto from 'node:crypto'
import rateLimit from 'express-rate-limit'
import { requireAuth } from '../middleware/auth.js'
import { Order, MasterOrder, User, AuditLog } from '../db/index.js'
import { StyleImportUpload } from '../models/StyleImportUpload.js'
import { validateAndCreateOrder } from './orders.js'
import { nextStyleId } from '../lib/ids.js'
import { notify, masterAdminIds } from '../lib/notify.js'
import { StyleRequest } from '../models/StyleRequest.js'
import { getToday } from '../lib/stageMath.js'
import { readTable, analyseTable, ImportError } from '../lib/styleImport.js'

// Creating many styles from a spreadsheet (Excel or CSV): upload the file, preview it row by row, then create. Tradio
// creates them at once, for any customer's master order. A customer (brand) can do it for its own master orders, but its
// "create" only SENDS the sheet for review: a master admin approves it (routes/styleRequests.js) and only then do the
// styles exist. Either way they come out as NPD or Replen with no manufacturer and no plan. Kriyaa uses these same routes
// over loopback (admins only), so its writes run under the admin's own session and these checks.
const router = Router()
router.use(requireAuth, (req, res, next) => (req.user.role === 'admin' || req.user.role === 'buyer') ? next() : res.status(403).json({ error: 'Not allowed' }))

const skipInTest = () => process.env.NODE_ENV === 'test'
const limiter = (max, message) => rateLimit({
  windowMs: 60 * 60 * 1000, max, keyGenerator: req => req.user?.id || req.ip,
  message: { error: message }, standardHeaders: true, legacyHeaders: false, validate: false, skip: skipInTest,
})
const uploadLimiter = limiter(30, 'Too many uploads. Please wait.')
const readLimiter = limiter(120, 'Too many previews. Please wait.')
const createLimiter = limiter(20, 'Too many style imports. Please wait.')

const MAX_FILE_BYTES = 8 * 1024 * 1024
const UPLOAD_ID_RE = /^imp_[a-f0-9]{16}$/
const MASTER_ORDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

const fail = (res, status, error, extra) => res.status(status).json({ error, ...extra })

async function loadUpload(req, res) {
  if (!UPLOAD_ID_RE.test(req.params.id)) { fail(res, 404, 'Upload not found. It may have expired (uploads are kept for an hour): upload the file again.'); return null }
  const upload = await StyleImportUpload.findOne({ _id: req.params.id, userId: req.user.id })
  if (!upload) { fail(res, 404, 'Upload not found. It may have expired (uploads are kept for an hour): upload the file again.'); return null }
  return upload
}

async function loadMasterOrder(masterOrderId, res, user) {
  // A customer does not choose a master order: the master admin does when approving. Its sheet is checked on its own.
  if (user.role === 'buyer' && (masterOrderId == null || masterOrderId === '')) {
    const buyer = await User.findById(user.id, 'code company role isActive').lean()
    return { mo: null, buyer }
  }
  if (typeof masterOrderId !== 'string' || !MASTER_ORDER_ID_RE.test(masterOrderId)) { fail(res, 400, 'Choose the master order the styles go under.'); return null }
  const mo = await MasterOrder.findById(masterOrderId).lean()
  // A customer can only use its own master orders; another's reads as not found.
  if (!mo || (user.role === 'buyer' && String(mo.buyerId) !== String(user.id))) { fail(res, 404, 'Master order not found.'); return null }
  const buyer = await User.findById(mo.buyerId, 'code company role isActive').lean()
  if (!buyer || buyer.role !== 'buyer') { fail(res, 400, 'The master order\'s customer was not found.'); return null }
  if (!buyer.isActive) { fail(res, 400, 'The master order\'s customer account is inactive.'); return null }
  return { mo, buyer }
}

/** The file's rows, checked against the styles already in the master order. */
export async function analyse(upload, mo) {
  const styles = mo ? await Order.find({ masterOrderId: mo._id, styleNumber: { $nin: ['', null] } }, { _id: 1, styleNumber: 1 }).lean() : []
  const existing = new Map(styles.map(o => [String(o.styleNumber).trim().toLowerCase(), o._id]))
  return analyseTable(await readTable(upload.data, upload.filename), { existing })
}

/**
 * Create every ok row of an analysed sheet under a master order. Returns { created, failed }; a row that cannot be made
 * is reported in `failed` and does not stop the others. Writes no audit entry and sends no notification (the caller does).
 */
export async function createRows(analysis, { mo, buyer }) {
  const created = [], failed = []
  for (const row of analysis.rows.filter(r => r.status === 'ok')) {
    try {
      let result
      // The server numbers each style, retrying if a number was just taken (the same as the Create Style form).
      for (let attempt = 0; attempt < 4; attempt++) {
        const id = await nextStyleId(buyer.code, row.payload.category, mo.season)
        result = await validateAndCreateOrder({ ...row.payload, id, buyerId: String(mo.buyerId), season: mo.season || undefined, masterOrderId: mo._id, createdAt: getToday() })
        if (result.ok || result.error !== 'Order ID already exists') break
      }
      if (result.ok) created.push({ row: row.row, id: result.order._id, styleNumber: row.styleNumber, product: row.product })
      else failed.push({ row: row.row, styleNumber: row.styleNumber, error: result.error })
    } catch (err) {
      console.error('[style import row]', err)
      failed.push({ row: row.row, styleNumber: row.styleNumber, error: 'Server error creating this row' })
    }
  }
  return { created, failed }
}

const importFailure = (res, err) => {
  if (err instanceof ImportError) return fail(res, 400, err.message)
  console.error('[style import]', err)
  return fail(res, 500, 'Could not read that file.')
}

// POST /api/style-imports  { filename, data: base64 }
router.post('/', uploadLimiter, async (req, res) => {
  try {
    const { filename, data } = req.body || {}
    const name = typeof filename === 'string' ? filename.split(/[\\/]/).pop().trim().slice(0, 150) : ''
    if (!/\.(xlsx|csv)$/i.test(name)) return fail(res, 400, 'Upload an Excel (.xlsx) or CSV (.csv) file.')
    if (typeof data !== 'string' || !data) return fail(res, 400, 'The file is empty.')
    const bytes = Buffer.from(data.replace(/^data:[^,]*,/, ''), 'base64')
    if (!bytes.length) return fail(res, 400, 'The file is empty.')
    if (bytes.length > MAX_FILE_BYTES) return fail(res, 400, 'That file is over 8MB.')
    if (/\.xlsx$/i.test(name) ? bytes.subarray(0, 2).toString('latin1') !== 'PK' : bytes.includes(0))
      return fail(res, 400, /\.xlsx$/i.test(name) ? 'That file is not a valid Excel workbook (.xlsx).' : 'That file is not a CSV text file.')
    const id = `imp_${crypto.randomBytes(8).toString('hex')}`
    await StyleImportUpload.create({ _id: id, userId: req.user.id, filename: name, data: bytes })
    res.status(201).json({ id, filename: name, size: bytes.length })
  } catch (err) { importFailure(res, err) }
})

// POST /api/style-imports/:id/preview  { masterOrderId }  -> a verdict for every row; nothing is created
router.post('/:id/preview', readLimiter, async (req, res) => {
  try {
    const upload = await loadUpload(req, res); if (!upload) return
    const target = await loadMasterOrder(req.body?.masterOrderId, res, req.user); if (!target) return
    const analysis = await analyse(upload, target.mo)
    res.json({
      uploadId: upload._id, filename: upload.filename,
      masterOrder: target.mo ? { id: target.mo._id, orderName: target.mo.orderName, season: target.mo.season || '', buyerCompany: target.buyer.company } : null,
      ...analysis,
      rows: analysis.rows.map(({ payload, ...row }) => row),
    })
  } catch (err) { importFailure(res, err) }
})

// POST /api/style-imports/:id/commit  { masterOrderId, skipInvalid? }  -> creates every row that is ok
// Rows that already exist in the master order are always skipped. Rows with problems stop the whole import unless
// skipInvalid says to create the rest.
router.post('/:id/commit', createLimiter, async (req, res) => {
  let upload, holdsLock = false
  try {
    upload = await loadUpload(req, res); if (!upload) return
    const target = await loadMasterOrder(req.body?.masterOrderId, res, req.user); if (!target) return
    const { mo, buyer } = target
    const analysis = await analyse(upload, mo)
    const { ok, errors, exists } = analysis.summary
    if (errors && req.body?.skipInvalid !== true)
      return fail(res, 409, `${errors} row${errors !== 1 ? 's have' : ' has'} problems, so nothing was created. Fix the sheet, or create only the ${ok} valid row${ok !== 1 ? 's' : ''}.`, { summary: analysis.summary })
    if (!ok) return fail(res, 400, exists ? 'Every style in the file is already in this master order. Nothing to create.' : 'There are no valid rows to create.', { summary: analysis.summary })

    // A customer's sheet is sent for review instead of being created.
    if (req.user.role === 'buyer') {
      if (await StyleRequest.exists({ kind: 'import', uploadId: upload._id })) return fail(res, 409, 'This sheet was already sent for review.')
      const skipInvalid = req.body?.skipInvalid === true
      const request = await StyleRequest.create({
        kind: 'import', buyerId: mo ? mo.buyerId : req.user.id, requestedBy: req.user.id, masterOrderId: mo?._id || null, filename: upload.filename, data: upload.data, uploadId: upload._id,
        skipInvalid, summary: analysis.summary,
      })
      await AuditLog.create({ byUser: req.user.id, action: 'Style Request Sent', detail: `${ok} style${ok !== 1 ? 's' : ''} from ${upload.filename}${mo ? ` under ${mo._id}` : ''}, by the customer, waiting for review` })
      await notify(await masterAdminIds(), { type: 'order', msg: `${buyer.company || 'A customer'} sent ${ok} style${ok !== 1 ? 's' : ''} for review${mo ? ` under ${mo.orderName}` : ''}. They are waiting for your approval.` })
      return res.status(202).json({ pending: true, requestId: request._id, masterOrderId: mo?._id || null, summary: analysis.summary })
    }

    // One create at a time per upload: a double click or a repeated call must not make the styles twice.
    const locked = await StyleImportUpload.findOneAndUpdate({ _id: upload._id, committing: { $ne: true } }, { $set: { committing: true } })
    if (!locked) return fail(res, 409, 'This import is already running.')
    holdsLock = true

    const { created, failed } = await createRows(analysis, { mo, buyer })

    if (created.length) {
      await AuditLog.create({ byUser: req.user.id, action: 'Style Import', detail: `${created.length} style${created.length !== 1 ? 's' : ''} created from ${upload.filename} under ${mo._id}${failed.length ? `, ${failed.length} failed` : ''}` })
      await notify([mo.buyerId], { type: 'order', msg: `${created.length} new style${created.length !== 1 ? 's' : ''} added under ${mo.orderName}` }, { exceptUserId: req.user.id })
    }
    res.status(created.length ? 201 : 400).json({
      masterOrderId: mo._id, created, failed,
      skipped: { exists, invalid: errors },
      ...(created.length ? {} : { error: 'No style could be created.' }),
    })
  } catch (err) { importFailure(res, err) }
  finally { if (holdsLock) await StyleImportUpload.updateOne({ _id: upload._id }, { $set: { committing: false } }).catch(() => {}) }
})

export default router
