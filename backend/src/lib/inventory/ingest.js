// Turning a photo or PDF of a supplier's challan or invoice into a DRAFT goods received note.
//
// The one place documents become receipts, whether they come from a person on the web or from a message
// (lib/inbound/pipeline.js). The model reads the document (lib/ai/goodsdoc.js), this matches it to the
// company's own open purchase orders and suppliers (lib/inventory/match.js), and the result is a draft the
// factory reads before posting: quantities are NEVER posted from here, and an unsure match is left out rather
// than guessed. Everything is scoped by the organization of `req.user`.
import { PurchaseOrder, Supplier, Attachment } from '../../db/index.js'
import { readGoodsDoc, goodsDocModel } from '../ai/goodsdoc.js'
import { matchPo, matchLines, crossCheck, normaliseUnit } from './match.js'
import { createGrn, linesFromPo, RECEIVABLE } from './grn.js'
import { checkPhoto } from '../imageUpload.js'

const DATE = /^\d{4}-\d{2}-\d{2}$/
const realDate = v => (v && DATE.test(v) && !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime()) ? v : null)
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/**
 * @param {object} req  { user } of the company the document is for
 * @param {{ buffer: Buffer, mimeType: string, source?: string, inboundMessageId?: any, photoDataUrl?: string }} input
 * @returns {Promise<{ok: true, grn: object, po: object|null, warnings: string[], confidence: number, matchReason: string|null} | {ok: false, status: number, error: string}>}
 */
export async function draftFromDocument(req, { buffer, mimeType, source = 'ai_review', inboundMessageId = null, photoDataUrl = null }) {
  const read = await readGoodsDoc(buffer, mimeType)
  if (!read.data) return { ok: false, status: 502, error: 'The document could not be read just now. Try again, or a clearer photo, or type the goods in' }
  const doc = read.data
  if (doc.lines.length === 0) return { ok: false, status: 422, error: 'No goods could be found on this document. Is it a delivery challan or an invoice?' }

  const mine = { ownerOrgId: req.user.orgId }
  const [pos, suppliers] = await Promise.all([
    PurchaseOrder.find({ ...mine, status: { $in: RECEIVABLE } }, 'supplierId lines.lineId lines.description lines.unit lines.qty lines.receivedQty lines.rate lines.discountPct').lean(),
    Supplier.find({ ...mine, isActive: true }, 'name gstin').lean(),
  ])
  const found = matchPo(doc, pos, suppliers)
  const warnings = crossCheck(doc)
  const lines = []

  if (found.po) {
    const pairs = matchLines(doc.lines, found.po.lines)
    const byPoLine = new Map([...pairs].map(([i, lineId]) => [lineId, doc.lines[i]]))
    for (const l of linesFromPo(found.po)) {
      const d = byPoLine.get(l.poLineId)
      lines.push({ ...l, qty: d?.qty ?? 0, ...(d?.lot ? { lot: d.lot } : {}), ...(d?.rate != null ? { rate: d.rate } : {}) })
    }
    const extra = doc.lines.map((d, i) => ({ d, i })).filter(x => !pairs.has(x.i))
    for (const { d } of extra) lines.push({ description: d.description || 'Goods', unit: normaliseUnit(d.unit) || 'pcs', qty: d.qty ?? 0, rate: d.rate ?? 0, lot: d.lot || '', note: 'Not on the purchase order' })
    if (extra.length) warnings.push(`${plural(extra.length, 'line')} on the document did not match a line of ${found.po._id}, so ${extra.length === 1 ? 'it is' : 'they are'} added as extra. Check ${extra.length === 1 ? 'it' : 'them'}`)
    const missing = lines.filter(l => l.poLineId && !(l.qty > 0)).length
    if (missing) warnings.push(`${plural(missing, 'line')} of the purchase order ${missing === 1 ? 'is' : 'are'} not on this document: the quantity is left empty`)
  } else {
    for (const d of doc.lines) lines.push({ description: d.description || 'Goods', unit: normaliseUnit(d.unit) || 'pcs', qty: d.qty ?? 0, rate: d.rate ?? 0, lot: d.lot || '' })
    if (doc.poNumber) warnings.push(`It quotes "${doc.poNumber}", which is not one of your purchase orders waiting for goods`)
  }
  if (doc.confidence < 0.7) warnings.push('The photo was hard to read. Check every quantity against the paper')
  for (const n of doc.notes) warnings.push(n)

  const made = await createGrn(req, {
    ...(found.po ? { poId: found.po._id } : {}),
    ...(found.supplier ? { supplierId: found.supplier._id } : { supplierName: doc.supplierName || '', supplierGstin: doc.supplierGstin || '' }),
    challanNo: doc.docNumber || '', challanDate: realDate(doc.docDate), vehicleNo: doc.vehicleNo || '', lines,
  }, {
    source,
    extra: {
      inboundMessageId,
      extraction: { at: new Date(), model: goodsDocModel(), confidence: doc.confidence, docType: doc.docType, matchReason: found.reason, warnings, printed: doc },
    },
  })
  if (!made.ok) return made

  // The scan itself is the evidence: kept with the note as its challan photo.
  const photo = photoDataUrl ? checkPhoto(photoDataUrl) : null
  if (photo?.ok) {
    await Attachment.create({ ownerOrgId: req.user.orgId, refType: 'grn', refId: String(made.grn._id), kind: 'challan', name: 'challan-scan', mimeType: photo.mimeType, size: photo.size, dataUrl: photoDataUrl, uploadedBy: req.user.actorId })
  }
  return { ok: true, grn: made.grn, po: made.po, warnings, confidence: doc.confidence, matchReason: found.reason }
}
