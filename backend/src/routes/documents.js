import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { Document, Order, User, Notification, AuditLog } from '../db/index.js'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import { sendEmail, emailCertExpiry, emailBuyerDocumentReceived } from '../lib/email.js'

// Max 20 document uploads per user per hour — prevents storage abuse
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 20,
  keyGenerator: req => req.user?.id || req.ip,
  message: { error: 'Too many document uploads. Please wait before uploading again.' },
  standardHeaders: true, legacyHeaders: false, validate: false,
})

const CERT_TYPES = ['compliance_cert', 'factory_audit', 'chemical_cert', 'environmental_cert', 'insurance']

async function assertDocAccess(user, { orderId, mfrId, type }) {
  if (user.role === 'buyer') {
    // Buyers may not set mfrId — that would let them attach docs to a manufacturer they chose
    if (mfrId)
      throw Object.assign(new Error('Buyers cannot upload documents on behalf of a manufacturer'), { status: 403 })
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
    if (mfrId && String(mfrId) !== String(user.id))
      throw Object.assign(new Error('You can only upload documents for yourself'), { status: 403 })
  }
}

const router = Router()

const mapDoc = (d, includeData = false) => {
  // uploadedBy may be a populated object (after .populate()) or a raw ObjectId
  const uploaderObj = d.uploadedBy && typeof d.uploadedBy === 'object' && d.uploadedBy.name
    ? d.uploadedBy
    : null
  return {
    id: d._id, type: d.type, name: d.name,
    mfrId: d.mfrId ? d.mfrId.toString() : null,
    orderId: d.orderId ? d.orderId.toString() : null,
    stageIndex: d.stageIndex != null ? d.stageIndex : null,
    issueDate: d.issueDate, expiryDate: d.expiryDate,
    uploadedBy: uploaderObj ? uploaderObj._id.toString() : (d.uploadedBy ? d.uploadedBy.toString() : null),
    uploadedByName: uploaderObj ? uploaderObj.name : null,
    uploadedByRole: uploaderObj ? uploaderObj.role : null,
    uploadedByCompany: uploaderObj ? uploaderObj.company : null,
    uploadedAt: d.createdAt, issuer: d.issuer, version: d.version, isActive: d.isActive,
    fileName: d.fileName, fileSize: d.fileSize, mimeType: d.mimeType,
    externalUrl: d.externalUrl || null,
    notes: d.notes || null,
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

      // mfrId match only for docs without an orderId (standalone compliance certs),
      // not docs that belong to a different buyer's order
      docs = await populateUploader(Document.find({
        isActive: true,
        $or: [
          { orderId: { $in: orderIds } },
          { mfrId: { $in: mfrIds }, orderId: null },
          { uploadedBy: req.user.id },
        ],
      }).sort({ createdAt: -1 })).lean()

    } else {
      const mfrOrders = await Order.find({ 'assignments.mfrId': req.user.id }, { _id: 1 }).lean()
      const orderIds  = mfrOrders.map(o => o._id)

      docs = await populateUploader(Document.find({
        isActive: true,
        $or: [{ mfrId: req.user.id }, { orderId: { $in: orderIds } }],
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

// GET /api/documents/:id/data  (includes the actual file payload)
router.get('/:id/data', requireAuth, async (req, res) => {
  try {
    const doc = await Document.findById(req.params.id).lean()
    if (!doc || !doc.isActive) return res.status(404).json({ error: 'Document not found' })

    if (req.user.role === 'buyer') {
      // Allow access to docs they uploaded themselves (e.g. via Submit Requirement)
      if (doc.uploadedBy && doc.uploadedBy.toString() === req.user.id) {
        // permitted
      } else {
        const buyerOrders = await Order.find({ buyerId: req.user.id }, { _id: 1, 'assignments.mfrId': 1 }).lean()
        const orderIds = buyerOrders.map(o => o._id.toString())
        const mfrIds   = [...new Set(buyerOrders.flatMap(o => (o.assignments || []).map(a => a.mfrId?.toString()).filter(Boolean)))]
        const allowed  = (doc.orderId && orderIds.includes(doc.orderId.toString())) ||
                         // mfrId match only for standalone compliance certs (no orderId)
                         (!doc.orderId && doc.mfrId && mfrIds.includes(doc.mfrId.toString()))
        if (!allowed) return res.status(403).json({ error: 'Access denied' })
      }
    }

    if (req.user.role === 'manufacturer') {
      // Manufacturer can access: (A) docs they own (mfrId === their ID)
      // or (B) general order docs (no mfrId) on orders they're assigned to
      // NOT docs uploaded by a competing manufacturer on the same split order
      const ownDoc = doc.mfrId && doc.mfrId.toString() === req.user.id
      if (!ownDoc) {
        if (doc.mfrId) {
          // Doc belongs to a different manufacturer — deny
          return res.status(403).json({ error: 'Access denied' })
        }
        // No mfrId — general order doc: check if mfr is assigned to that order
        const mfrOrders = await Order.find({ 'assignments.mfrId': req.user.id }, { _id: 1 }).lean()
        const orderIds  = mfrOrders.map(o => o._id.toString())
        const allowed   = doc.orderId && orderIds.includes(doc.orderId.toString())
        if (!allowed) return res.status(403).json({ error: 'Access denied' })
      }
    }

    res.json(mapDoc(doc, true))
  } catch (err) {
    console.error('[documents]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/documents
router.post('/', requireAuth, uploadLimiter, async (req, res) => {
  try {
    const { type, name, mfrId, orderId, stageIndex, issueDate, expiryDate, issuer, dataUrl, externalUrl, fileName, fileSize, mimeType, notes } = req.body
    if (!type || !name || !name.trim()) return res.status(400).json({ error: 'type and name required' })
    if (typeof type !== 'string' || typeof name !== 'string') return res.status(400).json({ error: 'Invalid input types' })
    if (name.length > 300 || type.length > 50) return res.status(400).json({ error: 'Input too long' })
    if (issuer && typeof issuer === 'string' && issuer.length > 200)
      return res.status(400).json({ error: 'Issuer name too long (max 200 chars)' })
    if (fileName && typeof fileName === 'string' && fileName.length > 500)
      return res.status(400).json({ error: 'File name too long (max 500 chars)' })

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
      if (typeof externalUrl !== 'string') return res.status(400).json({ error: 'Invalid link' })
      const trimmed = externalUrl.trim()
      if (trimmed.length > 2000) return res.status(400).json({ error: 'Link too long (max 2000 chars)' })
      try {
        const u = new URL(trimmed)
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          return res.status(400).json({ error: 'Link must be an http:// or https:// URL' })
        }
        normalizedUrl = u.toString()
      } catch {
        return res.status(400).json({ error: 'Invalid link — must be a valid URL' })
      }
    }

    // Inline-file checks (skipped when uploading via link)
    if (hasFile) {
      const ALLOWED_MIME = ['application/pdf', 'image/jpeg', 'image/png', 'image/jpg']
      const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB
      if (typeof dataUrl !== 'string')
        return res.status(400).json({ error: 'Invalid file payload' })
      // Validate the data URL itself — prevents storing arbitrary `data:text/html,...`
      // strings that would later render as XSS in the document viewer.
      const dataUrlMatch = /^data:([^;,]+);base64,/i.exec(dataUrl)
      if (!dataUrlMatch)
        return res.status(400).json({ error: 'Invalid file payload — must be a base64 data URL' })
      const embeddedMime = dataUrlMatch[1].toLowerCase()
      if (!ALLOWED_MIME.includes(embeddedMime))
        return res.status(400).json({ error: 'Only PDF, JPG, PNG files are allowed' })
      if (mimeType && !ALLOWED_MIME.includes(mimeType))
        return res.status(400).json({ error: 'Only PDF, JPG, PNG files are allowed' })
      if (mimeType && mimeType.toLowerCase() !== embeddedMime)
        return res.status(400).json({ error: 'File payload does not match declared mime type' })
      if (fileSize && fileSize > MAX_FILE_SIZE)
        return res.status(400).json({ error: 'File exceeds 10MB limit' })
      if (Buffer.byteLength(dataUrl, 'utf8') > MAX_FILE_SIZE * 1.4)
        return res.status(400).json({ error: 'File payload too large' })
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
      stageIndex: stageIndex != null && stageIndex !== '' ? stageIndex : null,
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
      detail: `${name} (${type})${orderId ? ' — order ' + orderId : ''}`,
    })

    res.status(201).json(mapDoc(doc.toObject(), false))
  } catch (err) {
    console.error('[documents]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

export default router
