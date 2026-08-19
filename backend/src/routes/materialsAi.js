import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { Document, MfrProject, MaterialRequirement } from '../db/index.js'
import { Order } from '../models/Order.js'
import { REQUIREMENT_CATEGORIES } from '../models/MaterialRequirement.js'
import { requireAuth } from '../middleware/auth.js'
import { assertScopeShape } from '../lib/scopeAccess.js'
import { getClient, ANTHROPIC_MODEL } from '../lib/anthropicClient.js'

// AI BOM draft — a from-scratch capability, kept in its own file rather than
// folded into assistant.js: this is a single one-shot structured-extraction
// call, not an open-ended chat/tool loop, and has nothing in common with that
// route beyond "uses Anthropic" (see anthropicClient.js for the shared bit).
//
// The one non-negotiable design constraint: this route NEVER writes to
// MaterialRequirement. It returns a draft; a human reviews and edits it, then
// the ordinary addLine route (already exists, already permission-checked)
// persists whatever they accept. This is the direct implementation of
// TRADIO.md's own documented lesson — a real historical loss at Tradio from
// an over-optimistic AI/estimated fabric-consumption figure — applied the same
// way "pull from requirement" already treats a copied value as a starting
// point a human must confirm, never an authoritative write.

const router = Router()
const skipInTest = () => process.env.NODE_ENV === 'test'

// Tighter than assistant.js's assistantLimiter (30/hr) — this call sends full
// document bytes to the API, a materially higher per-call cost than a chat turn.
const bomDraftLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 15,
  keyGenerator: req => req.user?.id || req.ip,
  message: { error: 'Too many AI drafting requests. Please wait before trying again.' },
  standardHeaders: true, legacyHeaders: false, validate: false, skip: skipInTest,
})

const DRAFT_TOOL = {
  name: 'draft_bom',
  description: 'Record the draft Bill of Materials extracted from the provided tech pack / reference document(s).',
  input_schema: {
    type: 'object',
    properties: {
      lines: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            category: { type: 'string', enum: REQUIREMENT_CATEGORIES.filter(c => c !== 'fabric'), description: 'Primary/secondary fabric, trim, accessory, or other' },
            name: { type: 'string', description: 'Material name, e.g. "180 GSM Cotton Poplin" or "YKK Zipper 20cm"' },
            unit: { type: 'string', description: 'e.g. m, kg, pcs' },
            requiredQty: { type: 'number', description: 'Per-garment quantity if statable from the document; omit rather than guess' },
            colourway: { type: 'string', description: 'Leave blank if not colourway-specific' },
            note: { type: 'string', description: 'Any assumption, uncertainty, or page reference worth flagging to the human reviewer' },
          },
          required: ['category', 'name'],
        },
      },
    },
    required: ['lines'],
  },
}

const DRAFT_PROMPT = `You are extracting a draft Bill of Materials (BOM) from a garment tech pack or reference document for a human to review — you are not authoring the final BOM yourself.

Extract only what the document actually states or clearly implies. For quantities: if the document gives a real consumption/requirement figure, use it; if it doesn't, omit requiredQty rather than inventing a plausible-sounding number — a wrong estimate here has real financial consequences for the person reviewing it, and an honest "not stated" is far more useful than a confident guess. Use the note field to flag anything you're unsure about (e.g. "consumption not stated on this page" or "inferred from the size chart, verify").

Categorise each line as fabric_primary, fabric_secondary, trim, accessory, or other. A garment typically has one primary fabric (the main body) and, if applicable, one or more secondary fabrics (contrast panels, lining, ribbing). Trims are things like zippers, buttons, elastic, drawcords. Accessories are things like labels, tags, and packaging.

Call the draft_bom tool with your findings. If the document has no extractable BOM information at all, call it with an empty lines array.`

async function loadScopeAndAssert(scopeType, orderId, mfrProjectId, user) {
  try {
    await assertScopeShape(scopeType, orderId, mfrProjectId, user)
  } catch (e) {
    throw e
  }
  if (user.role === 'buyer') throw Object.assign(new Error('Buyers cannot draft material requirements'), { status: 403 })
  if (scopeType === 'tradio_order' && user.role !== 'admin')
    throw Object.assign(new Error('Only an admin can draft material requirements on a Tradio order'), { status: 403 })
  // mfr_project: assertScopeShape already confirmed ownership.
}

router.post('/material-requirements/ai-draft', requireAuth, bomDraftLimiter, async (req, res) => {
  try {
    const { scopeType, orderId, mfrProjectId, documentIds } = req.body
    // Permission/scope checks come before the API-key gate, deliberately —
    // a buyer or an unrelated caller must always get 403, regardless of
    // whether this server happens to have AI drafting configured.
    try {
      await loadScopeAndAssert(scopeType, orderId, mfrProjectId, req.user)
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message })
    }
    if (!Array.isArray(documentIds) || documentIds.length === 0)
      return res.status(400).json({ error: 'documentIds is required' })
    if (documentIds.length > 5)
      return res.status(400).json({ error: 'Draft from at most 5 documents at a time' })

    // Resolve which documents are actually in scope for this draft — either
    // attached directly to the order/project, or to its parent master
    // order/project (the wizard's Documents step uploads there, before any
    // line-item order/project exists yet to hang orderId/mfrProjectId off of).
    let masterOrderId = null, mfrMasterProjectId = null
    if (scopeType === 'tradio_order') {
      const order = await Order.findById(orderId, 'masterOrderId').lean()
      masterOrderId = order?.masterOrderId || null
    } else {
      const project = await MfrProject.findById(mfrProjectId, 'mfrMasterProjectId').lean()
      mfrMasterProjectId = project?.mfrMasterProjectId || null
    }

    const docs = await Document.find({ _id: { $in: documentIds }, isActive: true }).lean()
    if (docs.length !== documentIds.length)
      return res.status(400).json({ error: 'One or more documents were not found' })

    const inScope = docs.every(d =>
      scopeType === 'tradio_order'
        ? (d.orderId === orderId || (masterOrderId && d.masterOrderId === masterOrderId))
        : (String(d.mfrProjectId) === String(mfrProjectId) || (mfrMasterProjectId && String(d.mfrMasterProjectId) === String(mfrMasterProjectId)))
    )
    if (!inScope) return res.status(403).json({ error: 'One or more documents are not in scope for this order/project' })

    // Link-only documents are excluded — fetching an arbitrary externally-
    // hosted URL server-side to feed a third-party API is a real SSRF surface
    // this codebase has no existing pattern for handling safely. PDF/JPEG/PNG
    // only, matching ALLOWED_MIME at upload time (documents.js).
    const linkOnly = docs.filter(d => !d.dataUrl)
    if (linkOnly.length > 0)
      return res.status(400).json({ error: `"${linkOnly[0].name}" is a link, not an uploaded file — AI drafting needs an uploaded PDF/JPG/PNG` })

    // All validation above is independent of whether AI drafting is actually
    // configured — only the real Anthropic call below needs a key.
    if (!process.env.ANTHROPIC_API_KEY)
      return res.status(503).json({ error: 'AI drafting is not configured on this server.' })

    const content = [{ type: 'text', text: DRAFT_PROMPT }]
    for (const doc of docs) {
      const match = /^data:([^;,]+);base64,(.+)$/i.exec(doc.dataUrl)
      if (!match) continue
      const mime = match[1].toLowerCase()
      const data = match[2]
      if (mime === 'application/pdf') {
        content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } })
      } else if (['image/jpeg', 'image/jpg', 'image/png'].includes(mime)) {
        content.push({ type: 'image', source: { type: 'base64', media_type: mime === 'image/jpg' ? 'image/jpeg' : mime, data } })
      }
      content.push({ type: 'text', text: `(The above is "${doc.name}", type: ${doc.type})` })
    }

    const response = await getClient().messages.create({
      model: ANTHROPIC_MODEL, max_tokens: 4096,
      tools: [DRAFT_TOOL], tool_choice: { type: 'tool', name: 'draft_bom' },
      messages: [{ role: 'user', content }],
    })

    const toolUse = response.content.find(b => b.type === 'tool_use' && b.name === 'draft_bom')
    const rawLines = Array.isArray(toolUse?.input?.lines) ? toolUse.input.lines : []
    const draftLines = rawLines
      .filter(l => l && typeof l.name === 'string' && l.name.trim())
      .map(l => ({
        category: REQUIREMENT_CATEGORIES.includes(l.category) ? l.category : 'other',
        name: String(l.name).slice(0, 200),
        unit: typeof l.unit === 'string' ? l.unit.slice(0, 30) : '',
        requiredQty: typeof l.requiredQty === 'number' && l.requiredQty >= 0 ? l.requiredQty : null,
        colourway: typeof l.colourway === 'string' ? l.colourway.slice(0, 60) : '',
        note: typeof l.note === 'string' ? l.note.slice(0, 500) : '',
      }))

    res.json({
      draftLines, sourceDocumentIds: documentIds,
      model: ANTHROPIC_MODEL, generatedAt: new Date().toISOString(),
    })
  } catch (err) {
    console.error('[materialsAi]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

export default router
