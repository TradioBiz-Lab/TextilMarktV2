import { Router } from 'express'
import mongoose from 'mongoose'
import { CustomerSop } from '../models/CustomerSop.js'
import { Order } from '../models/Order.js'
import { User } from '../models/User.js'
import { AuditLog } from '../models/AuditLog.js'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import { COORDINATOR_ROLE } from '../lib/coordinator.js'
import { readSopText } from '../lib/ai/extract.js'

// A customer's SOP (see models/CustomerSop.js). Read by Tradio, by a factory that makes one of the customer's styles
// and by a coordinator allocated to such a factory; never by the customer. Tradio admins save it.
const router = Router()
const MAX_PDF_BYTES = 8 * 1024 * 1024
const MAX_TEXT = 120000
const isId = v => typeof v === 'string' && mongoose.Types.ObjectId.isValid(v)
const serverError = (res, err) => { console.error('[sops]', err); res.status(500).json({ error: 'Server error' }) }

// Tests swap the reader in; a server with no AI key keeps the file and says its words are not available to Kriyaa.
let reader = null
export function setSopReader(fn) { reader = fn }
const canRead = () => !!reader || (!!process.env.ANTHROPIC_API_KEY && process.env.NODE_ENV !== 'test')

async function maySee(user, buyerId) {
  if (user.role === 'admin') return true
  const factories = user.role === 'manufacturer' ? [user.id] : user.role === COORDINATOR_ROLE ? (user.factoryIds || []) : []
  if (!factories.length) return false
  return !!(await Order.exists({ buyerId, 'assignments.mfrId': { $in: factories.map(id => new mongoose.Types.ObjectId(String(id))) } }))
}

const meta = s => (s ? { exists: true, name: s.name, fileName: s.fileName || '', updatedAt: s.updatedAt, uploadedByName: s.uploadedByName || '', hasText: !!s.text }
  : { exists: false })

// The customer a request is about: ?buyerId=, or the customer of ?orderId=.
async function buyerOf(q) {
  if (isId(q.buyerId)) return q.buyerId
  if (typeof q.orderId === 'string' && q.orderId) {
    const o = await Order.findById(q.orderId, 'buyerId').lean()
    return o ? String(o.buyerId) : null
  }
  return null
}

// GET /api/sops?buyerId= | ?orderId= - is there an SOP for this customer, and what is it called.
router.get('/', requireAuth, async (req, res) => {
  try {
    const buyerId = await buyerOf(req.query)
    if (!buyerId) return res.status(404).json({ error: 'Customer not found' })
    if (!(await maySee(req.user, buyerId))) return res.status(403).json({ error: 'Forbidden' })
    res.json({ buyerId, ...meta(await CustomerSop.findOne({ buyerId }, '-dataUrl').lean()) })
  } catch (err) { serverError(res, err) }
})

// GET /api/sops/file?buyerId= | ?orderId= - the PDF, to open on screen.
router.get('/file', requireAuth, async (req, res) => {
  try {
    const buyerId = await buyerOf(req.query)
    if (!buyerId) return res.status(404).json({ error: 'Customer not found' })
    if (!(await maySee(req.user, buyerId))) return res.status(403).json({ error: 'Forbidden' })
    const s = await CustomerSop.findOne({ buyerId }, 'name fileName dataUrl').lean()
    if (!s) return res.status(404).json({ error: 'No SOP is saved for this customer yet' })
    res.json({ name: s.name, fileName: s.fileName || '', dataUrl: s.dataUrl })
  } catch (err) { serverError(res, err) }
})

// GET /api/sops/text?buyerId= | ?orderId= - the SOP in words (what Kriyaa answers from).
router.get('/text', requireAuth, async (req, res) => {
  try {
    const buyerId = await buyerOf(req.query)
    if (!buyerId) return res.status(404).json({ error: 'Customer not found' })
    if (!(await maySee(req.user, buyerId))) return res.status(403).json({ error: 'Forbidden' })
    const s = await CustomerSop.findOne({ buyerId }, 'name text updatedAt').lean()
    if (!s) return res.status(404).json({ error: 'No SOP is saved for this customer yet' })
    if (!s.text) return res.status(404).json({ error: 'The SOP is saved as a file, but its words could not be read. Open the file instead.' })
    const customer = await User.findById(buyerId, 'company').lean()
    res.json({ customer: customer?.company || '', name: s.name, savedOn: s.updatedAt, text: s.text })
  } catch (err) { serverError(res, err) }
})

// POST /api/sops/:buyerId { name, fileName, dataUrl, text? } - save the customer's SOP (replaces the one before).
// `text` is the document in words when the sender has it; otherwise the PDF is read once here.
router.post('/:buyerId', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { buyerId } = req.params
    if (!isId(buyerId)) return res.status(400).json({ error: 'Invalid customer ID' })
    const customer = await User.findOne({ _id: buyerId, role: 'buyer' }, 'company').lean()
    if (!customer) return res.status(404).json({ error: 'Customer not found' })
    const { name, fileName, dataUrl, text } = req.body || {}
    if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'Give the SOP a name' })
    const m = /^data:application\/pdf;base64,([A-Za-z0-9+/=]+)$/.exec(typeof dataUrl === 'string' ? dataUrl : '')
    if (!m) return res.status(400).json({ error: 'The SOP must be a PDF file' })
    if (m[1].length * 0.75 > MAX_PDF_BYTES) return res.status(400).json({ error: 'That PDF is too large (8 MB at most)' })
    if (text !== undefined && typeof text !== 'string') return res.status(400).json({ error: 'text must be words' })

    let words = (text || '').trim()
    if (!words && canRead()) {
      try { words = String(await (reader || readSopText)(Buffer.from(m[1], 'base64')) || '').trim() }
      catch (err) { console.error('[sops] could not read the PDF', err.message) }
    }
    const saved = await CustomerSop.findOneAndUpdate({ buyerId },
      { $set: { name: name.trim().slice(0, 200), fileName: typeof fileName === 'string' ? fileName.slice(0, 300) : '', dataUrl, text: words.slice(0, MAX_TEXT), uploadedBy: req.user.id, uploadedByName: req.user.name || '' } },
      { new: true, upsert: true, setDefaultsOnInsert: true, projection: '-dataUrl' }).lean()
    await AuditLog.create({ byUser: req.user.id, action: 'SOP Saved', detail: `${customer.company}: "${saved.name}" saved by ${req.user.name}${words ? '' : ' (its words could not be read, so Kriyaa cannot answer from it)'}` })
    res.json({ buyerId, ...meta(saved) })
  } catch (err) { serverError(res, err) }
})

export default router
