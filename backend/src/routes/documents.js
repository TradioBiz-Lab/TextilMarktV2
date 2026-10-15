import { Router } from 'express'
import mongoose from 'mongoose'
import rateLimit from 'express-rate-limit'
import { Document, Order, User, Notification, AuditLog, MasterOrder } from '../db/index.js'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import { sendEmail, emailCertExpiry, emailBuyerDocumentReceived } from '../lib/email.js'
import { notify, adminIds } from '../lib/notify.js'

// Max 20 document uploads per user per hour — prevents storage abuse
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 20,
  keyGenerator: req => req.user?.id || req.ip,
  message: { error: 'Too many document uploads. Please wait before uploading again.' },
  standardHeaders: true, legacyHeaders: false, validate: false,
})

const CERT_TYPES = ['compliance_cert', 'factory_audit', 'chemical_cert', 'environmental_cert', 'insurance']
// What the customer pays Tradio, and what Tradio charges, is not a factory's business: in the Tradio portal a factory
// never lists, opens or uploads a customer's purchase order, Tradio's invoice, the cost sheet or the terms and conditions.
const HIDDEN_FROM_FACTORIES = ['PO', 'buyer_order', 'invoice', 'cost_sheet', 'terms']
const ALLOWED_MIME = [
  'application/pdf', 'image/jpeg', 'image/png', 'image/jpg',
  // Pattern files (DXF) — there is no registered MIME type for DXF, so
  // browsers report all of these, or nothing, depending on OS/browser.
  // 'application/octet-stream' is only accepted when the filename ends in
  // .dxf (see EXT_FALLBACK_ALLOWED below) — it's too generic to allow for
  // every upload without that check.
  'application/dxf', 'image/vnd.dxf', 'application/octet-stream',
  // Measurement sheets
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.ms-excel', // .xls
  'text/csv',
]
// Extensions allowed to fall back to a blank/generic mime type in the checks
// below — only DXF needs this; xlsx/xls/csv are reliably typed by every
// major browser.
const EXT_FALLBACK_ALLOWED = ['.dxf']
const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB

// Shared by create (POST /) and edit (POST /:id) — validates an inline base64
// data URL the same way in both places, since this is the XSS-relevant check
// (rejects arbitrary `data:text/html,...` payloads that would render in the
// document viewer). Returns an error string, or null if valid.
function validateFilePayload(dataUrl, mimeType, fileSize, fileName) {
  if (typeof dataUrl !== 'string') return 'Invalid file payload'
  const dataUrlMatch = /^data:([^;,]*);base64,/i.exec(dataUrl)
  if (!dataUrlMatch) return 'Invalid file payload - must be a base64 data URL'
  const embeddedMime = dataUrlMatch[1].toLowerCase()
  const extFallbackOk = EXT_FALLBACK_ALLOWED.some(ext => (fileName || '').toLowerCase().endsWith(ext))
  const mimeOk = m => !!m && (ALLOWED_MIME.includes(m) || (extFallbackOk && (m === '' || m === 'application/octet-stream')))
  if (!mimeOk(embeddedMime) && !(extFallbackOk && embeddedMime === '')) return 'Only PDF, JPG, PNG, DXF, XLS/XLSX, or CSV files are allowed'
  if (mimeType && !mimeOk(mimeType)) return 'Only PDF, JPG, PNG, DXF, XLS/XLSX, or CSV files are allowed'
  if (mimeType && embeddedMime && mimeType.toLowerCase() !== embeddedMime) return 'File payload does not match declared mime type'
  if (fileSize && fileSize > MAX_FILE_SIZE) return 'File exceeds 10MB limit'
  if (Buffer.byteLength(dataUrl, 'utf8') > MAX_FILE_SIZE * 1.4) return 'File payload too large'
  const sniff = contentMismatch(dataUrl, embeddedMime || (mimeType || '').toLowerCase())
  if (sniff) return sniff
  return null
}

// The declared type comes from the client, so check the first bytes of the files we actually render
// (PDF and the image types). Anything else, such as DXF or spreadsheets, is not sniffed.
const SIGNATURES = {
  'application/pdf': b => b.subarray(0, 4).toString('latin1') === '%PDF',
  'image/png': b => b.length >= 4 && b[0] === 0x89 && b.subarray(1, 4).toString('latin1') === 'PNG',
  'image/jpeg': b => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/jpg': b => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': b => b.subarray(0, 4).toString('latin1') === 'GIF8',
  'image/webp': b => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
}
function contentMismatch(dataUrl, mime) {
  const check = SIGNATURES[mime]
  if (!check) return null
  const start = dataUrl.indexOf(',') + 1
  const head = Buffer.from(dataUrl.slice(start, start + 24), 'base64')
  return check(head) ? null : 'The file contents do not match its declared type'
}

// Returns { url } on success or { error } on failure.
function validateExternalUrl(externalUrl) {
  if (typeof externalUrl !== 'string') return { error: 'Invalid link' }
  const trimmed = externalUrl.trim()
  if (trimmed.length > 2000) return { error: 'Link too long (max 2000 chars)' }
  try {
    const u = new URL(trimmed)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { error: 'Link must be an http:// or https:// URL' }
    }
    return { url: u.toString() }
  } catch {
    return { error: 'Invalid link - must be a valid URL' }
  }
}

async function assertDocAccess(user, { orderId, mfrId, type }) {
  if (user.role === 'buyer') {
    // Buyers may not set mfrId — that would let them attach docs to a manufacturer they chose
    if (mfrId)
      throw Object.assign(new Error('Buyers cannot upload documents on behalf of a manufacturer'), { status: 403 })
    // An invoice is Tradio's to issue
    if (type === 'invoice')
      throw Object.assign(new Error('Only Tradio can upload invoices'), { status: 403 })
    // Buyers may not upload compliance certificates — those belong to manufacturers
    if (CERT_TYPES.includes(type))
      throw Object.assign(new Error('Buyers cannot upload compliance certificates'), { status: 403 })
    if (orderId) {
      const order = await Order.findById(orderId, { buyerId: 1 }).lean()
      if (!order || order.buyerId.toString() !== user.id)
        throw Object.assign(new Error('You can only upload documents to your own orders'), { status: 403 })
    }
  }
  if (user.role === 'manufacturer') {
    if (HIDDEN_FROM_FACTORIES.includes(type))
      throw Object.assign(new Error('Only Tradio and the customer handle purchase orders, invoices, cost sheets and terms'), { status: 403 })
    if (mfrId && String(mfrId) !== String(user.id))
      throw Object.assign(new Error('You can only upload documents for yourself'), { status: 403 })
    // An order document may only go on an order this manufacturer is assigned to.
    if (orderId) {
      const assigned = await Order.exists({ _id: orderId, 'assignments.mfrId': user.id })
      if (!assigned)
        throw Object.assign(new Error('You can only upload documents to orders you are assigned to'), { status: 403 })
    }
  }
}

const router = Router()

const mapDoc = (d, includeData = false) => {
  // uploadedBy may be a populated object (after .populate()) or a raw ObjectId
  const uploaderObj = d.uploadedBy && typeof d.uploadedBy === 'object' && d.uploadedBy.name
    ? d.uploadedBy
    : null
  return {
    id: d._id, type: d.type === 'buyer_order' ? 'PO' : d.type, name: d.name,
    mfrId: d.mfrId ? d.mfrId.toString() : null,
    orderId: d.orderId ? d.orderId.toString() : null,
    masterOrderId: d.masterOrderId || null,
    stageIndex: d.stageIndex != null ? d.stageIndex : null,
    materialLineIndex: d.materialLineIndex != null ? d.materialLineIndex : null,
    issueDate: d.issueDate, expiryDate: d.expiryDate,
    uploadedBy: uploaderObj ? uploaderObj._id.toString() : (d.uploadedBy ? d.uploadedBy.toString() : null),
    uploadedByName: uploaderObj ? uploaderObj.name : null,
    uploadedByRole: uploaderObj ? uploaderObj.role : null,
    uploadedByCompany: uploaderObj ? uploaderObj.company : null,
    uploadedAt: d.createdAt, issuer: d.issuer, version: d.version, isActive: d.isActive,
    fileName: d.fileName, fileSize: d.fileSize, mimeType: d.mimeType,
    externalUrl: d.externalUrl || null,
    notes: d.notes || null,
    versionOf: d.versionOf ? d.versionOf.toString() : null,
    replacedAt: d.replacedAt || null,
    filedAt: d.filedAt || null,
    ...(includeData ? { dataUrl: d.dataUrl } : {}),
  }
}

// GET /api/documents
router.get('/', requireAuth, async (req, res) => {
  try {
    let docs

    // Exclude dataUrl from list — it's a multi-MB base64 payload per doc, only needed by /:id/data
    const LIST_FIELDS = '-dataUrl'
    const populateUploader = q => q.select(LIST_FIELDS).populate('uploadedBy', 'name role adminType company')

    if (req.user.role === 'admin') {
      docs = await populateUploader(Document.find({ isActive: true }).sort({ createdAt: -1 })).lean()

    } else if (req.user.role === 'buyer') {
      const buyerOrders = await Order.find({ buyerId: req.user.id }, { _id: 1, 'assignments.mfrId': 1 }).lean()
      const orderIds = buyerOrders.map(o => o._id)
      const mfrIds   = [...new Set(buyerOrders.flatMap(o => (o.assignments || []).map(a => a.mfrId?.toString()).filter(Boolean)))]
      const masterIds = (await MasterOrder.find({ buyerId: req.user.id }, { _id: 1 }).lean()).map(m => m._id)

      // mfrId match only for docs without an orderId (standalone compliance certs),
      // not docs that belong to a different buyer's order
      docs = await populateUploader(Document.find({
        isActive: true,
        $or: [
          { orderId: { $in: orderIds } },
          { masterOrderId: { $in: masterIds } },
          { mfrId: { $in: mfrIds }, orderId: null },
          { uploadedBy: req.user.id },
        ],
      }).sort({ createdAt: -1 })).lean()

    } else {
      const mfrOrders = await Order.find({ 'assignments.mfrId': req.user.id }, { _id: 1 }).lean()
      const orderIds  = mfrOrders.map(o => o._id)

      docs = await populateUploader(Document.find({
        isActive: true,
        // Own docs, plus general order docs (no mfrId). Never a competing
        // manufacturer's docs on a shared order: GET /:id/data denies those too.
        // Never a purchase order or an invoice (HIDDEN_FROM_FACTORIES).
        type: { $nin: HIDDEN_FROM_FACTORIES },
        $or: [{ mfrId: req.user.id }, { orderId: { $in: orderIds }, mfrId: null }],
      }).sort({ createdAt: -1 })).lean()
    }

    res.json(docs.map(d => mapDoc(d, false)))
  } catch (err) {
    console.error('[documents]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/documents/cert-expiry-check
// Scans certificates and creates notifications for expiring/expired certs
// Called by admin on login — idempotent (skips if already notified today)
router.post('/cert-expiry-check', requireAuth, requireAdmin, async (req, res) => {
  try {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const in30Days = new Date(today)
    in30Days.setDate(in30Days.getDate() + 30)

    const certs = await Document.find({
      isActive: true,
      type: { $in: CERT_TYPES },
      expiryDate: { $ne: null },
    }).lean()

    const admins = await User.find({ role: 'admin', isActive: true }, { _id: 1, email: 1 }).lean()
    const adminIds = admins.map(a => a._id.toString())

    // Check what was already notified today to avoid duplicates
    const todayNotifs = await Notification.find({
      createdAt: { $gte: today },
      type: 'alert',
      msg: { $regex: /certificate.*expir/i },
    }).lean()
    const notifiedKeys = new Set(todayNotifs.map(n => `${n.toUser.toString()}-${n.msg}`))

    // Batch-fetch all manufacturer users whose certs are expiring (one query, not one per cert)
    const mfrIdsWithCerts = [...new Set(certs.map(c => c.mfrId?.toString()).filter(Boolean))]
    const mfrUsersForEmail = await User.find({ _id: { $in: mfrIdsWithCerts } }, 'email').lean()
    const mfrEmailMap = Object.fromEntries(mfrUsersForEmail.map(u => [u._id.toString(), u]))

    const notifBatch = []
    const emailedKeys = new Set()

    for (const cert of certs) {
      const expiry = new Date(cert.expiryDate)
      expiry.setHours(0, 0, 0, 0)

      let msg = null
      let daysLeft = 0
      let isExpired = false
      if (expiry < today) {
        msg = `Certificate expired: "${cert.name}" (expired ${cert.expiryDate.toISOString().slice(0, 10)})`
        isExpired = true
      } else if (expiry <= in30Days) {
        daysLeft = Math.ceil((expiry - today) / 86400000)
        msg = `Certificate expiring in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}: "${cert.name}" (expires ${cert.expiryDate.toISOString().slice(0, 10)})`
      }

      if (!msg) continue

      const certEmailData = {
        certName: cert.name,
        expiryDate: cert.expiryDate.toISOString().slice(0, 10),
        daysLeft, status: isExpired ? 'expired' : 'expiring',
      }

      for (const adminId of adminIds) {
        const key = `${adminId}-${msg}`
        if (!notifiedKeys.has(key)) {
          notifBatch.push({ toUser: adminId, type: 'alert', msg, isRead: false })
          notifiedKeys.add(key)
        }
      }

      // Admin cert-expiry emails intentionally disabled to conserve email-send credits.
      // Admins still receive in-portal notifications (created above).
      // Manufacturers continue to receive emails so they know to renew.

      // Notify the manufacturer (seller) who owns the cert
      if (cert.mfrId) {
        const mfrIdStr = cert.mfrId.toString()
        const mfrKey = `${mfrIdStr}-${msg}`
        if (!notifiedKeys.has(mfrKey)) {
          notifBatch.push({ toUser: cert.mfrId, type: 'alert', msg, isRead: false })
          notifiedKeys.add(mfrKey)
        }
        // Email the manufacturer — use pre-fetched map instead of per-cert query
        const emailKey = `${mfrIdStr}-${cert._id}`
        if (!emailedKeys.has(emailKey)) {
          const mfrUser = mfrEmailMap[mfrIdStr]
          if (mfrUser?.email) {
            sendEmail(emailCertExpiry({ ...certEmailData, to: mfrUser.email }))
            emailedKeys.add(emailKey)
          }
        }
      }
    }

    // Insert all notifications in one batch operation instead of individual creates
    let created = 0
    if (notifBatch.length > 0) {
      await Notification.insertMany(notifBatch, { ordered: false })
      created = notifBatch.length
    }

    res.json({ ok: true, checked: certs.length, notificationsCreated: created })
  } catch (err) {
    console.error('[documents]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// GET /api/documents/cert-summary
router.get('/cert-summary', requireAuth, requireAdmin, async (req, res) => {
  try {
    const certs = await Document.find({
      isActive: true,
      type: { $in: CERT_TYPES },
    }).sort({ expiryDate: 1 }).lean()

    res.json(certs.map(d => mapDoc(d, false)))
  } catch (err) {
    console.error('[documents]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// Whether `user` may open `doc` (a current document, or an earlier version of one, which carries the same links).
// Returns { status, error } when not, or null.
async function readError(user, doc) {

  if (user.role === 'buyer') {
    // Allow access to docs they uploaded themselves (e.g. via Submit Requirement)
    if (doc.uploadedBy && doc.uploadedBy.toString() === user.id) {
      // permitted
    } else {
      const buyerOrders = await Order.find({ buyerId: user.id }, { _id: 1, 'assignments.mfrId': 1 }).lean()
      const orderIds = buyerOrders.map(o => o._id.toString())
      const mfrIds   = [...new Set(buyerOrders.flatMap(o => (o.assignments || []).map(a => a.mfrId?.toString()).filter(Boolean)))]
      const ownMaster = doc.masterOrderId && await MasterOrder.exists({ _id: doc.masterOrderId, buyerId: user.id })
      const allowed  = (doc.orderId && orderIds.includes(doc.orderId.toString())) || !!ownMaster ||
                       // mfrId match only for standalone compliance certs (no orderId)
                       (!doc.orderId && doc.mfrId && mfrIds.includes(doc.mfrId.toString()))
      if (!allowed) return { status: 403, error: 'Access denied' }
    }
  }

  if (user.role === 'manufacturer') {
    if (HIDDEN_FROM_FACTORIES.includes(doc.type)) return { status: 403, error: 'Access denied' }
    // Manufacturer can access: (A) docs they own (mfrId === their ID)
    // or (B) general order docs (no mfrId) on orders they're assigned to
    // NOT docs uploaded by a competing manufacturer on the same split order
    const ownDoc = doc.mfrId && doc.mfrId.toString() === user.id
    if (!ownDoc) {
      if (doc.mfrId) {
        // Doc belongs to a different manufacturer: deny
        return { status: 403, error: 'Access denied' }
      }
      // No mfrId, so a general order doc: check the mfr is assigned to that order
      const mfrOrders = await Order.find({ 'assignments.mfrId': user.id }, { _id: 1 }).lean()
      const orderIds  = mfrOrders.map(o => o._id.toString())
      const allowed   = doc.orderId && orderIds.includes(doc.orderId.toString())
      if (!allowed) return { status: 403, error: 'Access denied' }
    }
  }

  return null
}

// GET /api/documents/:id/data  (includes the actual file payload)
router.get('/:id/data', requireAuth, async (req, res) => {
  try {
    const doc = await Document.findById(req.params.id).lean()
    // An earlier version is not active itself; it opens while the document it belongs to is still live.
    const live = doc && (doc.isActive || (doc.versionOf && await Document.exists({ _id: doc.versionOf, isActive: true })))
    if (!live) return res.status(404).json({ error: 'Document not found' })
    const denied = await readError(req.user, doc)
    if (denied) return res.status(denied.status).json({ error: denied.error })
    res.json(mapDoc(doc, true))
  } catch (err) {
    console.error('[documents]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// GET /api/documents/:id/versions - the earlier files of a document that was replaced, newest first (no payloads).
router.get('/:id/versions', requireAuth, async (req, res) => {
  try {
    const doc = await Document.findById(req.params.id).lean()
    if (!doc || !doc.isActive) return res.status(404).json({ error: 'Document not found' })
    const denied = await readError(req.user, doc)
    if (denied) return res.status(denied.status).json({ error: denied.error })
    const versions = await Document.find({ versionOf: doc._id }).select('-dataUrl').populate('uploadedBy', 'name role adminType company').sort({ version: -1, replacedAt: -1 }).lean()
    res.json(versions.map(v => mapDoc(v, false)))
  } catch (err) {
    console.error('[documents]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/documents
router.post('/', requireAuth, uploadLimiter, async (req, res) => {
  try {
    const { type: sentType, name, mfrId, orderId, masterOrderId, stageIndex, materialLineIndex, issueDate, expiryDate, issuer, dataUrl, externalUrl, fileName, fileSize, mimeType, notes } = req.body
    // "Buyer Order" was the same paper as the customer's purchase order, filed under a second name: it is a PO now.
    const type = sentType === 'buyer_order' ? 'PO' : sentType
    if (!type || !name || !name.trim()) return res.status(400).json({ error: 'type and name required' })
    if (typeof type !== 'string' || typeof name !== 'string') return res.status(400).json({ error: 'Invalid input types' })
    if (name.length > 300 || type.length > 50) return res.status(400).json({ error: 'Input too long' })
    if (!Document.schema.path('type').enumValues.includes(type)) return res.status(400).json({ error: `Unknown document type "${type}"` })
    // A file on a whole master order (the customer sees it): Tradio attaches any, and the customer its own purchase order
    // for the buy.
    if (masterOrderId != null && masterOrderId !== '') {
      const mo = typeof masterOrderId === 'string' ? await MasterOrder.findById(masterOrderId, 'buyerId').lean() : null
      const ownPo = req.user.role === 'buyer' && type === 'PO' && mo && String(mo.buyerId) === String(req.user.id)
      if (req.user.role !== 'admin' && !ownPo) return res.status(403).json({ error: 'Only Tradio, or the customer with its own purchase order, can attach a file to a master order' })
      if (!mo) return res.status(400).json({ error: 'Master order not found' })
    }
    if (issuer && typeof issuer === 'string' && issuer.length > 200)
      return res.status(400).json({ error: 'Issuer name too long (max 200 chars)' })
    if (fileName && typeof fileName === 'string' && fileName.length > 500)
      return res.status(400).json({ error: 'File name too long (max 500 chars)' })

    // A materials/PO attachment must reference a specific stage
    const hasMaterialLineIndex = materialLineIndex != null && materialLineIndex !== ''
    if (hasMaterialLineIndex) {
      const parsedLineIndex = parseInt(materialLineIndex, 10)
      if (isNaN(parsedLineIndex) || parsedLineIndex < 0)
        return res.status(400).json({ error: 'Invalid material line index' })
      if (stageIndex == null || stageIndex === '')
        return res.status(400).json({ error: 'materialLineIndex requires a stageIndex' })
    }

    // Free-text notes (used for stage-evidence SOP context, or text-only stage entries)
    let normalizedNotes = null
    if (notes != null && notes !== '') {
      if (typeof notes !== 'string') return res.status(400).json({ error: 'Invalid notes' })
      const trimmedNotes = notes.trim()
      if (trimmedNotes.length > 5000)
        return res.status(400).json({ error: 'Notes too long (max 5000 chars)' })
      normalizedNotes = trimmedNotes || null
    }

    // Validate expiry >= issue date
    if (expiryDate && issueDate && new Date(expiryDate) < new Date(issueDate)) {
      return res.status(400).json({ error: 'Expiry date cannot be before issue date' })
    }

    // Document must have exactly one of: an inline file (dataUrl) OR an external link (externalUrl).
    // Exception: stage-evidence docs (stageIndex != null) may be text-only when `notes` is supplied
    // — the buyer/admin/mfr captures SOP context without uploading a file.
    const hasFile  = !!dataUrl
    const hasUrl   = !!externalUrl
    const isStage  = stageIndex != null && stageIndex !== ''
    const hasNotes = !!normalizedNotes
    if (hasFile && hasUrl) {
      return res.status(400).json({ error: 'Provide either a file OR a link, not both' })
    }
    if (!hasFile && !hasUrl) {
      if (!(isStage && hasNotes)) {
        return res.status(400).json({ error: 'Either a file, a drive link, or stage-evidence notes are required' })
      }
    }

    let normalizedUrl = null
    if (hasUrl) {
      const r = validateExternalUrl(externalUrl)
      if (r.error) return res.status(400).json({ error: r.error })
      normalizedUrl = r.url
    }

    // Inline-file checks (skipped when uploading via link)
    if (hasFile) {
      const err = validateFilePayload(dataUrl, mimeType, fileSize, fileName)
      if (err) return res.status(400).json({ error: err })
    }

    try {
      await assertDocAccess(req.user, { orderId, mfrId, type })
    } catch (e) {
      return res.status(e.status || 403).json({ error: e.message })
    }

    const doc = await Document.create({
      type, name,
      mfrId:      mfrId     || null,
      orderId:    orderId   || null,
      masterOrderId: masterOrderId || null,
      stageIndex: stageIndex != null && stageIndex !== '' ? stageIndex : null,
      materialLineIndex: hasMaterialLineIndex ? parseInt(materialLineIndex, 10) : null,
      issueDate:  issueDate ? new Date(issueDate) : new Date(),
      expiryDate: expiryDate ? new Date(expiryDate) : null,
      uploadedBy: req.user.id,
      issuer:     issuer   || null,
      version: 1, isActive: true,
      notes:       normalizedNotes,
      dataUrl:     hasFile ? dataUrl       : null,
      externalUrl: hasUrl  ? normalizedUrl : null,
      fileName:    fileName || null,
      fileSize:    hasFile ? (fileSize || null) : null,
      mimeType:    hasFile ? (mimeType || null) : null,
    })

    // Buyer document upload → notify Tradio (email-only; all other upload events stay as portal notifications)
    if (req.user.role === 'buyer') {
      const buyerUser = await User.findById(req.user.id, 'name company email').lean()
      sendEmail(emailBuyerDocumentReceived({
        docName: name,
        docType: type,
        buyerName: buyerUser?.name || req.user.name,
        buyerCompany: buyerUser?.company || req.user.company,
        buyerEmail: buyerUser?.email || req.user.email,
        orderId: orderId || null,
      }))
    }

    await AuditLog.create({
      byUser: req.user.id,
      action: 'Document Uploaded',
      detail: `${name} (${type})${orderId ? ' - order ' + orderId : ''}`,
    })

    // Document uploaded to an order: tell its buyer and every admin (not the uploader).
    if (orderId) {
      const target = await Order.findById(orderId, { buyerId: 1 }).lean()
      await notify([target?.buyerId, ...await adminIds()], { type: 'order', msg: `New document uploaded to order ${orderId}: ${name}`, orderId }, { exceptUserId: req.user.id })
    }

    res.status(201).json(mapDoc(doc.toObject(), false))
  } catch (err) {
    console.error('[documents]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/documents/:id  (edit — name/notes/issuer/dates, and optionally replace the file/link)
router.post('/:id', requireAuth, uploadLimiter, async (req, res) => {
  try {
    const doc = await Document.findById(req.params.id)
    if (!doc || !doc.isActive) return res.status(404).json({ error: 'Document not found' })

    const isOwner = doc.uploadedBy && doc.uploadedBy.toString() === req.user.id
    if (req.user.role !== 'admin' && !isOwner)
      return res.status(403).json({ error: 'You can only edit your own documents' })

    const { name, notes, issuer, issueDate, expiryDate, dataUrl, externalUrl, fileName, fileSize, mimeType, removeFile } = req.body
    // The file as it was, kept as an earlier version below if this edit replaces it.
    const before = doc.toObject()

    if (name != null) {
      if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'name required' })
      if (name.length > 300) return res.status(400).json({ error: 'Input too long' })
      doc.name = name.trim()
    }
    if (issuer != null) {
      if (typeof issuer !== 'string' || issuer.length > 200)
        return res.status(400).json({ error: 'Issuer name too long (max 200 chars)' })
      doc.issuer = issuer || null
    }
    if (notes != null) {
      if (typeof notes !== 'string') return res.status(400).json({ error: 'Invalid notes' })
      const trimmedNotes = notes.trim()
      if (trimmedNotes.length > 5000) return res.status(400).json({ error: 'Notes too long (max 5000 chars)' })
      doc.notes = trimmedNotes || null
    }
    if (issueDate != null) doc.issueDate = issueDate ? new Date(issueDate) : new Date()
    if (expiryDate !== undefined) doc.expiryDate = expiryDate ? new Date(expiryDate) : null
    if (doc.expiryDate && doc.issueDate && doc.expiryDate < doc.issueDate)
      return res.status(400).json({ error: 'Expiry date cannot be before issue date' })

    const hasFile = !!dataUrl
    const hasUrl  = !!externalUrl
    if (hasFile && hasUrl) return res.status(400).json({ error: 'Provide either a file OR a link, not both' })

    if (hasFile) {
      const err = validateFilePayload(dataUrl, mimeType, fileSize, fileName)
      if (err) return res.status(400).json({ error: err })
      if (fileName && typeof fileName === 'string' && fileName.length > 500)
        return res.status(400).json({ error: 'File name too long (max 500 chars)' })
      doc.dataUrl = dataUrl
      doc.fileName = fileName || null
      doc.fileSize = fileSize || null
      doc.mimeType = mimeType || null
      doc.externalUrl = null
    } else if (hasUrl) {
      const r = validateExternalUrl(externalUrl)
      if (r.error) return res.status(400).json({ error: r.error })
      doc.externalUrl = r.url
      doc.dataUrl = null
      doc.fileName = null
      doc.fileSize = null
      doc.mimeType = null
    } else if (removeFile) {
      const isStage = doc.stageIndex != null
      if (!(isStage && doc.notes))
        return res.status(400).json({ error: 'Cannot remove the file/link - a file, link, or stage-evidence notes are required' })
      doc.dataUrl = null; doc.externalUrl = null; doc.fileName = null; doc.fileSize = null; doc.mimeType = null
    } else {
      // No file/link change requested — the doc must still satisfy the invariant
      // as it stands (guards against e.g. clearing notes on a text-only stage doc).
      const isStage = doc.stageIndex != null
      if (!doc.dataUrl && !doc.externalUrl && !(isStage && doc.notes))
        return res.status(400).json({ error: 'Either a file, a drive link, or stage-evidence notes are required' })
    }

    const fileReplaced = (hasFile || hasUrl || removeFile) && (before.dataUrl || before.externalUrl)
    if (fileReplaced) {
      // Written as stored, without today's checks, so an old record of a since-renamed type still keeps its history.
      const { _id, __v, ...was } = before
      await Document.collection.insertOne({ ...was, isActive: false, versionOf: doc._id, replacedAt: new Date(), replacedByUser: new mongoose.Types.ObjectId(req.user.id) })
    }
    doc.version = (doc.version || 1) + 1
    await doc.save()

    await AuditLog.create({
      byUser: req.user.id,
      action: 'Document Updated',
      detail: `${doc.name} (${doc.type})${doc.orderId ? ' - order ' + doc.orderId : ''}${fileReplaced ? `, new file (version ${doc.version}); the earlier one is kept` : ''}`,
    })

    res.json(mapDoc(doc.toObject(), false))
  } catch (err) {
    console.error('[documents]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/documents/:id/file - Tradio files a requirement the customer sent in (no style yet) into one of that
// customer's styles: the document moves onto the style, and the customer sees where it went. Admin only.
router.post('/:id/file', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { orderId } = req.body || {}
    if (typeof orderId !== 'string' || !orderId.trim() || orderId.length > 100) return res.status(400).json({ error: 'Choose the style to file it into' })
    const doc = await Document.findById(req.params.id).populate('uploadedBy', 'role company').lean()
    if (!doc || !doc.isActive) return res.status(404).json({ error: 'Document not found' })
    if (doc.uploadedBy?.role !== 'buyer') return res.status(400).json({ error: 'Only a file a customer sent in can be filed this way' })
    if (doc.orderId || doc.masterOrderId || doc.stageIndex != null) return res.status(400).json({ error: 'This file is already on a style or master order' })
    const order = await Order.findById(orderId.trim(), 'buyerId product').lean()
    if (!order) return res.status(404).json({ error: 'Style not found' })
    if (String(order.buyerId) !== String(doc.uploadedBy._id)) return res.status(400).json({ error: "That style belongs to another customer" })

    await Document.updateOne({ _id: doc._id }, { $set: { orderId: order._id, filedAt: new Date(), filedBy: req.user.id } })
    await AuditLog.create({ byUser: req.user.id, action: 'Document Filed', detail: `${doc.name} (${doc.type}) from ${doc.uploadedBy.company || 'the customer'} filed into ${order._id}` })
    await notify([order.buyerId], { type: 'order', msg: `Your file "${doc.name}" is now on ${order.product || 'the style'} (${order._id})`, orderId: order._id }, { exceptUserId: req.user.id })
    const saved = await Document.findById(doc._id).select('-dataUrl').populate('uploadedBy', 'name role adminType company').lean()
    res.json(mapDoc(saved, false))
  } catch (err) {
    console.error('[documents]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/documents/:id/delete  (soft delete)
router.post('/:id/delete', requireAuth, async (req, res) => {
  try {
    const doc = await Document.findById(req.params.id)
    if (!doc || !doc.isActive) return res.status(404).json({ error: 'Document not found' })

    const isOwner = doc.uploadedBy && doc.uploadedBy.toString() === req.user.id
    if (req.user.role !== 'admin' && !isOwner)
      return res.status(403).json({ error: 'You can only delete your own documents' })

    // Only the flag changes. A save() would re-check every stored field against today's rules, and an old record
    // (seed data, a type since renamed) that no longer passes them could then never be deleted.
    await Document.updateOne({ _id: doc._id }, { $set: { isActive: false } })

    await AuditLog.create({
      byUser: req.user.id,
      action: 'Document Deleted',
      detail: `${doc.name} (${doc.type})${doc.orderId ? ' - order ' + doc.orderId : ''}`,
    })

    res.json({ ok: true })
  } catch (err) {
    console.error('[documents]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

export default router
