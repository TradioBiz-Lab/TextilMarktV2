import { Order, deriveStageStatus } from '../../models/Order.js'
import { User } from '../../models/User.js'
import { Organization } from '../../models/Organization.js'
import { partyIdOfUser } from '../orgs.js'
import { InboundMessage } from '../../models/InboundMessage.js'
import { AuditLog } from '../../models/AuditLog.js'
import { extractPhoto, extractDocument, extractText } from '../ai/extract.js'
import { transcribeAudio } from '../sarvam.js'
import { matchOrder, mapStageIndex, gateChange } from './matching.js'
import { applyStageChange } from './applyStage.js'
import { outbound } from './adapters.js'
import { createEvidence } from './evidence.js'
import { isStandalone } from '../platform.js'
import { draftFromDocument } from '../inventory/ingest.js'

const IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp']
const DOC_MIME = [...IMAGE_MIME, 'application/pdf']
const AUDIO_MIME = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/wav', 'audio/mpeg']
const MAX_MEDIA_BYTES = 8 * 1024 * 1024

// Words in a caption that say "this is the delivery paper".
const GOODS_HINT = /\b(challan|chalan|invoice|bill|grn|delivery note|goods|received|mal aaya)\b/i

/**
 * In the standalone product a photo or PDF of a supplier's challan or invoice becomes a DRAFT goods received note
 * (lib/inventory/ingest.js): the factory checks it in the app and posts it, nothing is added to stock from here.
 * Returns the message when it was one, or null when the document is something else (the usual handling carries on).
 */
async function tryGoodsDocument({ msg, factory, buffer, mimeType }) {
  const made = await draftFromDocument(
    { user: { id: factory._id, actorId: factory._id, orgId: factory.orgId, name: factory.name || factory.company || '' } },
    { buffer, mimeType, source: 'whatsapp', inboundMessageId: msg._id, photoDataUrl: mimeType.startsWith('image/') ? msg.dataUrl : null },
  ).catch(err => { console.error('[inbound] goods document failed', err.message); return null })
  if (!made?.ok) return null
  const n = made.grn.lines.filter(l => l.qty > 0).length
  msg.grnId = made.grn._id
  msg.confidence = made.confidence
  msg.parsed = { kind: 'goods_document', description: `Draft goods received note from a delivery document${made.grn.poId ? ` against ${made.grn.poId}` : ''}`, lines: made.grn.lines.length, poId: made.grn.poId || null, warnings: made.warnings }
  msg.state = 'auto_applied'
  msg.reviewReason = 'A draft goods received note was made. The factory checks it and posts it'
  await msg.save()
  if (msg.channel === 'whatsapp') {
    outbound.sendText(msg.senderNumber, `Challan mil gaya ✓ ${n} item${n === 1 ? '' : 's'}${made.grn.poId ? ` (${made.grn.poId})` : ''}. Please check it in the app and post it: Stock > Goods received.`).catch(() => {})
  }
  return msg
}

export const digits = n => String(n || '').replace(/\D/g, '')

export async function findFactoryByNumber(number) {
  const d = digits(number)
  if (d.length < 8) return null
  const tail = d.slice(-10)
  const mfrs = await User.find({ role: 'manufacturer', isActive: true, whatsappNumber: { $ne: null } }, 'name company whatsappNumber language orgId orgRole').lean()
  const hit = mfrs.find(m => digits(m.whatsappNumber).slice(-10) === tail)
  if (!hit) return null
  // A deactivated company hears nothing, whoever on its team writes.
  if (hit.orgId && (await Organization.findById(hit.orgId, 'isActive').lean())?.isActive === false) return null
  // Orders and assignments reference the company's primary account, so a teammate's number identifies
  // the company; the language and number stay the sender's own, for the reply.
  const partyId = await partyIdOfUser(hit)
  return partyId === String(hit._id) ? hit : { ...hit, _id: partyId }
}

/** The factory's live orders, in the shape matching/AI prompts need. */
export async function loadActiveOrders(factoryId) {
  const orders = await Order.find({ 'assignments.mfrId': factoryId }).lean()
  return orders
    .filter(o => o.assignments.some(a => String(a.mfrId) === String(factoryId) && a.status !== 'Delivered'))
    .map(o => ({
      id: o._id, styleNumber: o.styleNumber, product: o.product,
      stages: (o.assignments.find(a => String(a.mfrId) === String(factoryId)).stages || [])
        .map(s => ({ ...s, status: deriveStageStatus(s) })),
    }))
}

/**
 * Creates the message row (raw input stored first, always) and runs it through
 * the pipeline. `deps` lets tests swap the AI and speech calls.
 *
 * input: {factoryId?, senderNumber?, channel, type, buffer?, mimeType?, text?, receivedAt?}
 */
// Test seam: lets route-level tests stub the AI/speech calls without HTTP plumbing.
let defaultDeps = {}
export const setPipelineDeps = deps => { defaultDeps = deps || {} }

export async function ingestMessage(input, deps = {}) {
  deps = { ...defaultDeps, ...deps }
  const d = { extractPhoto, extractDocument, extractText, transcribeAudio, ...deps }
  const { type, buffer, mimeType } = input

  let factory = null
  if (input.factoryId) factory = await User.findOne({ _id: input.factoryId, role: 'manufacturer', isActive: true }, 'name company language whatsappNumber orgId').lean()
  else if (input.senderNumber) factory = await findFactoryByNumber(input.senderNumber)

  let msg
  try {
    msg = await InboundMessage.create({
      externalId: input.externalId || null,
      factoryId: factory?._id || null,
      senderNumber: input.senderNumber || factory?.whatsappNumber || null,
      channel: input.channel, type, mimeType: mimeType || null,
      dataUrl: buffer ? `data:${mimeType};base64,${buffer.toString('base64')}` : null,
      rawText: input.text || '',
      receivedAt: input.receivedAt || new Date(),
    })
  } catch (err) {
    // The provider delivered the same message twice at once: the first is the one being worked on.
    if (err?.code === 11000 && input.externalId) return InboundMessage.findOne({ externalId: input.externalId })
    throw err
  }

  const toReview = async reason => {
    msg.state = 'needs_review'; msg.reviewReason = reason
    await msg.save()
    return msg
  }

  if (!factory) return toReview('Unknown sender, not a registered factory number')

  // A delivery paper sent to a standalone factory goes to goods received. A PDF, or a photo whose caption says so, is read
  // as one straight away; any other photo is read as a production photo first, and only an unrecognised one is tried as a challan.
  const goodsEligible = isStandalone() && !!factory.orgId && !!buffer && (type === 'document' || type === 'image')
  const hinted = goodsEligible && (type === 'document' || GOODS_HINT.test(input.text || ''))
  if (hinted) {
    const handled = await tryGoodsDocument({ msg, factory, buffer, mimeType })
    if (handled) return handled
  }

  try {
    const orders = await loadActiveOrders(factory._id)
    let parsed = null
    let updates = []   // [{hint, canonical, status, issue, note, confidence}]
    let confidence = null

    if (type === 'image') {
      parsed = await d.extractPhoto(buffer, mimeType)
      if (goodsEligible && !hinted && (!parsed || parsed.stage === 'unknown' || parsed.confidence < 0.6)) {
        const handled = await tryGoodsDocument({ msg, factory, buffer, mimeType })
        if (handled) return handled
      }
      if (parsed) {
        confidence = parsed.confidence
        const issues = parsed.issues || []
        updates = [{ hint: parsed.style_hint, canonical: parsed.stage, status: 'done', issue: issues.length ? issues.join('; ') : null, note: parsed.description }]
      }
    } else if (type === 'document') {
      parsed = await d.extractDocument(buffer, mimeType)
      if (parsed) {
        confidence = parsed.confidence
        if (parsed.implied_stage) updates = [{ hint: (parsed.style_codes || [])[0], hints: parsed.style_codes, canonical: parsed.implied_stage, status: 'done', note: `${parsed.doc_type || 'Document'}${parsed.date ? ' dated ' + parsed.date : ''}` }]
      }
    } else {
      let text = input.text || ''
      if (type === 'audio') {
        if (!process.env.SARVAM_API_KEY && !deps.transcribeAudio) return toReview('Voice is not configured on this server')
        const t = await d.transcribeAudio(buffer, mimeType)
        text = t.transcript
        msg.rawText = text
      }
      if (text.trim()) {
        parsed = await d.extractText(text, orders)
        if (parsed) {
          confidence = parsed.confidence
          updates = parsed.updates.map(u => ({ hint: u.style_hint, canonical: u.stage, status: u.status === 'issue' ? 'in_progress' : u.status, issue: u.status === 'issue' ? (u.note || 'Issue reported') : null, note: u.note }))
        }
      }
    }

    msg.parsed = parsed
    msg.confidence = confidence
    if (!parsed) return toReview('AI could not read this message')
    if (!updates.length) return toReview('No production update found in this message')

    // Resolve every update to (order, stage) and gate it. All must pass, else
    // nothing is written and the whole message goes to review.
    const plan = []
    let reason = null
    for (const u of updates) {
      const hints = (u.hints?.length ? u.hints : [u.hint]).filter(Boolean)
      const m = matchOrder(hints, orders)
      if (!m.orderId) { reason = 'Could not tell which order this is about'; break }
      const order = orders.find(o => o.id === m.orderId)
      const stageIndex = mapStageIndex(u.canonical, order.stages)
      const g = gateChange({ confidence, stageIndex, status: u.status, stages: order.stages, defect: !!u.issue })
      // A defect is flagged on the order immediately (when we're sure which
      // order/stage it is) but the message always stays in review.
      if (!g.ok && !(u.issue && stageIndex >= 0 && confidence >= 0.8 && g.reason?.startsWith('Defect'))) { reason = g.reason; break }
      plan.push({ u, orderId: m.orderId, stageIndex, noop: g.noop })
    }
    if (reason) return toReview(reason)

    for (const p of plan) {
      msg.orderId = p.orderId
      msg.stageApplied = orders.find(o => o.id === p.orderId).stages[p.stageIndex].name
      if (p.u.issue) msg.hasDefect = true
      if (p.noop && !p.u.issue) {
        await createEvidence({ msg, factory, orderId: p.orderId, stageIndex: p.stageIndex, stageName: msg.stageApplied, note: p.u.note })
        continue
      }
      const r = await applyStageChange({
        orderId: p.orderId, mfrId: factory._id, stageIndex: p.stageIndex,
        status: p.u.status, issue: p.u.issue, note: p.u.note,
      })
      if (r.error) return toReview(r.error)
      msg.changes.push({ orderId: p.orderId, mfrId: factory._id, stageIndex: p.stageIndex, stageName: r.stageName, before: r.before, after: r.after })
      await createEvidence({ msg, factory, orderId: p.orderId, stageIndex: p.stageIndex, stageName: r.stageName, issue: p.u.issue, note: p.u.note })
      await AuditLog.create({ byUser: factory._id, action: 'Stage Updated', detail: `${p.orderId}: ${r.stageName} - ${p.u.status}${p.u.issue ? ' (issue flagged)' : ''} by AI from ${type} message from ${factory.company}` }).catch(() => {})
    }
    msg.state = msg.hasDefect ? 'needs_review' : 'auto_applied'
    if (msg.hasDefect) msg.reviewReason = 'Defect flagged, needs a human decision'
    await msg.save()
    if (input.channel === 'whatsapp' && msg.state === 'auto_applied')
      outbound.sendText(msg.senderNumber, `Mil gaya ✓ ${msg.stageApplied}`).catch(() => {})
    return msg
  } catch (err) {
    console.error('[inbound] pipeline error', err)
    return toReview('Processing error, needs a human')
  }
}

export { IMAGE_MIME, DOC_MIME, AUDIO_MIME, MAX_MEDIA_BYTES }
