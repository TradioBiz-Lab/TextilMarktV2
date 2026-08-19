import { Router } from 'express'
import { WikiPage, AuditLog } from '../db/index.js'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import { canAccessWikiScope, resolveAssignedBuyerIds, validateWikiScopeShape } from '../lib/wikiAccess.js'

const router = Router()

// Matches WikiPage.js's schema maxlength — images are embedded as base64 data
// URIs directly in the markdown, so this needs real headroom, not a text-only cap.
const MAX_BODY_MARKDOWN = 8_000_000

// Lightweight — no bodyMarkdown, mirrors the list_orders/get_order split so the
// list payload stays small even as pages grow.
const mapPageSummary = p => ({
  id: p._id.toString(), title: p.title, category: p.category,
  wikiScope: p.wikiScope, buyerId: p.buyerId ? p.buyerId.toString() : null,
  updatedAt: p.updatedAt,
})

const mapPageFull = p => ({
  ...mapPageSummary(p),
  bodyMarkdown: p.bodyMarkdown,
  createdBy: p.createdBy ? p.createdBy.toString() : null,
  updatedBy: p.updatedBy ? p.updatedBy.toString() : null,
  createdAt: p.createdAt,
})

// GET /api/wiki-pages
router.get('/', requireAuth, async (req, res) => {
  try {
    const pages = await WikiPage.find({ isActive: true }).sort({ updatedAt: -1 }).lean()
    const assignedBuyerIds = req.user.role === 'manufacturer'
      ? await resolveAssignedBuyerIds(req.user.id)
      : []
    const visible = pages.filter(p => canAccessWikiScope(req.user, p, assignedBuyerIds))
    res.json(visible.map(mapPageSummary))
  } catch (err) {
    console.error('[wikiPages]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// GET /api/wiki-pages/:id
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const page = await WikiPage.findById(req.params.id).lean()
    if (!page || !page.isActive) return res.status(404).json({ error: 'Wiki page not found' })
    const assignedBuyerIds = req.user.role === 'manufacturer'
      ? await resolveAssignedBuyerIds(req.user.id)
      : []
    if (!canAccessWikiScope(req.user, page, assignedBuyerIds))
      return res.status(403).json({ error: 'Access denied' })
    res.json(mapPageFull(page))
  } catch (err) {
    console.error('[wikiPages]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/wiki-pages
router.post('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { title, category, bodyMarkdown, wikiScope, buyerId } = req.body
    if (!title || typeof title !== 'string' || !title.trim() || title.length > 200)
      return res.status(400).json({ error: 'Invalid title' })
    if (!['tech_pack', 'sop'].includes(category))
      return res.status(400).json({ error: 'Invalid category' })
    if (!bodyMarkdown || typeof bodyMarkdown !== 'string' || !bodyMarkdown.trim())
      return res.status(400).json({ error: 'bodyMarkdown required' })
    if (bodyMarkdown.length > MAX_BODY_MARKDOWN)
      return res.status(400).json({ error: `Content too long (max ${MAX_BODY_MARKDOWN.toLocaleString()} chars)` })

    try {
      await validateWikiScopeShape(req.body.wikiScope, req.body.buyerId)
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message })
    }

    const page = await WikiPage.create({
      title: title.trim(), category, bodyMarkdown,
      wikiScope, buyerId: wikiScope === 'buyer' ? buyerId : null,
      createdBy: req.user.id, isActive: true,
    })

    await AuditLog.create({ byUser: req.user.id, action: 'Wiki Page Created', detail: `${page.title} (${page.category})` })

    res.status(201).json(mapPageFull(page.toObject()))
  } catch (err) {
    console.error('[wikiPages]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/wiki-pages/:id  (edit)
router.post('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const page = await WikiPage.findById(req.params.id)
    if (!page || !page.isActive) return res.status(404).json({ error: 'Wiki page not found' })

    const { title, category, bodyMarkdown, wikiScope, buyerId } = req.body
    if (title !== undefined) {
      if (!title || typeof title !== 'string' || !title.trim() || title.length > 200)
        return res.status(400).json({ error: 'Invalid title' })
      page.title = title.trim()
    }
    if (category !== undefined) {
      if (!['tech_pack', 'sop'].includes(category)) return res.status(400).json({ error: 'Invalid category' })
      page.category = category
    }
    if (bodyMarkdown !== undefined) {
      if (typeof bodyMarkdown !== 'string' || !bodyMarkdown.trim() || bodyMarkdown.length > MAX_BODY_MARKDOWN)
        return res.status(400).json({ error: 'Invalid bodyMarkdown' })
      page.bodyMarkdown = bodyMarkdown
    }
    if (wikiScope !== undefined) {
      try {
        await validateWikiScopeShape(req.body.wikiScope, req.body.buyerId)
      } catch (e) {
        return res.status(e.status || 400).json({ error: e.message })
      }
      page.wikiScope = wikiScope
      page.buyerId = wikiScope === 'buyer' ? buyerId : null
    }

    page.updatedBy = req.user.id
    await page.save()

    await AuditLog.create({ byUser: req.user.id, action: 'Wiki Page Updated', detail: `${page.title} (${page.category})` })

    res.json(mapPageFull(page.toObject()))
  } catch (err) {
    console.error('[wikiPages]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/wiki-pages/:id/delete  (soft delete — no destructive delete route exists here)
router.post('/:id/delete', requireAuth, requireAdmin, async (req, res) => {
  try {
    const page = await WikiPage.findById(req.params.id)
    if (!page || !page.isActive) return res.status(404).json({ error: 'Wiki page not found' })
    page.isActive = false
    page.updatedBy = req.user.id
    await page.save()
    await AuditLog.create({ byUser: req.user.id, action: 'Wiki Page Deleted', detail: `${page.title} (${page.category})` })
    res.json({ ok: true })
  } catch (err) {
    console.error('[wikiPages]', err)
    res.status(500).json({ error: 'Server error' })
  }
})

export default router
