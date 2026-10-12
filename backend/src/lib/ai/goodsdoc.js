// Reading a goods document (a supplier's delivery challan, tax invoice or packing list) from a photo or PDF,
// so a goods received note can be drafted from it instead of typed in.
//
// The model is asked for what is printed and nothing else. What comes back is only ever a DRAFT for a person to
// check: nothing here writes stock, and the note it leads to is posted by a person (lib/inventory/ingest.js).
import { z } from 'zod'
import { callJsonDetailed, mediaBlock } from './extract.js'

export const goodsDocModel = () => process.env.ANTHROPIC_GOODSDOC_MODEL || process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5'
const MAX_TOKENS = 3000

const conf = z.number().min(0).max(1)
const str = z.union([z.string(), z.number()]).nullish().transform(v => (v === null || v === undefined ? null : String(v).trim() || null))
// A number the model may have written as text ("1,200.50", "12 kg"): the first number in it, else null.
const num = z.union([z.number(), z.string()]).nullish().transform(v => {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const m = /-?\d[\d,]*(?:\.\d+)?/.exec(v)
  return m ? Number(m[0].replace(/,/g, '')) : null
})

export const DOC_TYPES = ['delivery_challan', 'tax_invoice', 'packing_list', 'other']

export const goodsDocSchema = z.object({
  docType: z.string().nullish().transform(v => (DOC_TYPES.includes(v) ? v : 'other')),
  docNumber: str, docDate: str,
  supplierName: str, supplierGstin: str, buyerName: str,
  poNumber: str, vehicleNo: str,
  lines: z.array(z.object({ description: str, hsn: str, qty: num, unit: str, rate: num, amount: num, lot: str })).default([]),
  total: num,
  notes: z.array(str).default([]).transform(a => a.filter(Boolean)),
  confidence: conf.catch(0.5),
})

export const GOODSDOC_PROMPT = `You are reading a document that came with goods delivered to an Indian garment factory: a supplier's delivery challan, tax invoice, e-way bill copy or packing list. It may be a photograph taken on a phone (slightly tilted, in shadow), in English, sometimes with Hindi or Tamil words.

Extract only what is printed. Never guess a number you cannot read: use null. Return JSON only, no commentary, in exactly this shape:
{
  "docType": "delivery_challan | tax_invoice | packing_list | other",
  "docNumber": "the challan or invoice number as printed",
  "docDate": "YYYY-MM-DD",
  "supplierName": "who sent the goods (the seller, not the buyer)",
  "supplierGstin": "15 characters if printed",
  "buyerName": "who the goods are for",
  "poNumber": "the buyer's purchase order number if the document quotes one (for example PO-TPR-2627-0007 or just 7)",
  "vehicleNo": "the lorry or vehicle number if printed",
  "lines": [
    { "description": "the goods exactly as printed, with colour, GSM, width and composition", "hsn": "", "qty": 0, "unit": "kg | m | pcs | ...", "rate": null, "amount": null, "lot": "lot, batch, roll or shade number if printed" }
  ],
  "total": null,
  "notes": ["anything the factory should know, for example a quantity that is hard to read"],
  "confidence": 0.0
}

Rules:
- One entry in lines for each distinct item delivered, in the order printed. Do not list taxes, freight, packing charges or totals as items.
- qty is the quantity delivered as a plain number (no units, no commas). unit is as printed (KGS, MTR, PCS, NOS, ROLLS): copy it.
- rate and amount only when printed; amount is for the line before tax if the document shows both.
- total is the document's grand total if printed.
- If there are several rolls or cartons listed under one item, give the item's total quantity once, and mention the roll count in "lot" or in notes.
- confidence (0 to 1) is how sure you are that the quantities are right. Lower it when the photo is blurred, cut off or in shadow.`

/**
 * Read a goods document.
 * @param {Buffer} buffer
 * @param {string} mimeType  image/jpeg, image/png, image/webp or application/pdf
 * @returns {Promise<{ data: object | null, error: string | null }>}
 */
export function extractGoodsDoc(buffer, mimeType, opts = {}) {
  return callJsonDetailed({
    content: [mediaBlock(buffer, mimeType), { type: 'text', text: GOODSDOC_PROMPT }],
    schema: goodsDocSchema, model: goodsDocModel(), maxTokens: MAX_TOKENS, ...opts,
  })
}

// Tests swap the reader for a fake so no test calls the model.
let reader = extractGoodsDoc
export const setGoodsDocReaderForTests = fn => { reader = fn || extractGoodsDoc }

// `npm run dev:local` sets GOODSDOC_SAMPLE so the whole scan-a-challan flow can be walked without an API key: any
// document "reads" as the same sample challan from the seeded mill. Never honoured in production.
const sampleReading = () => ({
  data: goodsDocSchema.parse({
    docType: 'delivery_challan', docNumber: 'CH-4471', docDate: new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10), supplierName: 'Coimbatore Knit Fabrics',
    vehicleNo: 'TN 39 AB 1234', lines: [{ description: 'Brushed fleece 280 GSM, 72 in, 80/20 CVC', qty: 1180, unit: 'KGS' }],
    notes: ['This is a sample reading: no document was actually read.'], confidence: 0.86,
  }),
  error: null,
})
export const readGoodsDoc = (buffer, mimeType) => (process.env.GOODSDOC_SAMPLE === '1' && process.env.NODE_ENV !== 'production' ? sampleReading() : reader(buffer, mimeType))
