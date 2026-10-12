// Reading a tech pack (the brand's design pack for a style) so a bill of materials and a measurement spec
// can be drafted from it instead of typed in.
//
// The model is asked for facts the pack states and nothing else: it never estimates a consumption, and
// every material comes back with a confidence and where in the pack it was seen. Whatever comes back is
// only a DRAFT: lines from here start flagged "needs a look", and a bill of materials with flagged lines
// cannot be frozen until a person has checked them (routes/boms.js). Nothing here touches the database.
import { z } from 'zod'
import { callJsonDetailed, mediaBlock } from './extract.js'
import { BOM_SECTIONS } from '../../models/Bom.js'
import { newLineId } from '../bom.js'

export const techPackModel = () => process.env.ANTHROPIC_TECHPACK_MODEL || 'claude-sonnet-5-5'
const MAX_TOKENS = 8000

const conf = z.number().min(0).max(1)
const str = z.union([z.string(), z.number()]).nullish().transform(v => (v === null || v === undefined ? null : String(v).trim() || null))
// A number the model may have written as text ("±1", "2 pcs", "1.0"): the first number in it, else null.
const num = z.union([z.number(), z.string()]).nullish().transform(v => {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const m = /-?\d+(?:\.\d+)?/.exec(v)
  return m ? Number(m[0]) : null
})

export const techPackSchema = z.object({
  header: z.object({
    brand: str, styleNo: str, description: str, category: str, gender: str, fabricComposition: str,
    gsm: str, sizeRange: str, collection: str, designer: str, season: str,
  }).partial().default({}),
  sizes: z.array(str).default([]).transform(a => a.filter(Boolean)),
  colourways: z.array(str).default([]).transform(a => a.filter(Boolean)),
  bomCandidates: z.array(z.object({
    section: z.string(), item: str, spec: str, unit: str, perPiece: num, perColour: z.boolean().nullish(),
    evidence: str, confidence: conf.catch(0.5),
  })).default([]),
  specPoints: z.array(z.object({
    code: str, name: str, tolPlus: num, tolMinus: num, values: z.array(num).default([]),
  })).default([]),
  notes: z.array(str).default([]).transform(a => a.filter(Boolean)),
  confidence: conf.catch(0.5),
})

export const TECHPACK_PROMPT = `You are a garment technologist reading a tech pack (the brand's design pack for one style) for a factory that must cost it and buy for it. The pack may have a style sheet, construction and finishing callouts, logo and print details, stitch details, a measurement (spec) sheet and colourways.

Extract only what the pack states. Return JSON only, no commentary, in exactly this shape:
{
  "header": { "brand": "", "styleNo": "", "description": "", "category": "", "gender": "", "fabricComposition": "", "gsm": "", "sizeRange": "", "collection": "", "designer": "", "season": "" },
  "sizes": ["S", "M", "L"],
  "colourways": ["Black"],
  "bomCandidates": [
    { "section": "fabric", "item": "", "spec": "", "unit": "", "perPiece": null, "perColour": true, "evidence": "", "confidence": 0.0 }
  ],
  "specPoints": [
    { "code": "A", "name": "", "tolPlus": 1.0, "tolMinus": null, "values": [52, 54, 56] }
  ],
  "notes": [""],
  "confidence": 0.0
}

Rules:
- header: as printed. Use null for anything the pack does not say.
- sizes: the size columns of the measurement table, in order, exactly as written (for example S, M, L, XL, XXL). Empty if there is no measurement table.
- bomCandidates: one entry for each distinct material or component the pack calls out, in these sections:
    fabric: cloth (main fabric with its composition and GSM, mesh or contrast panels, rib or binding fabric)
    process: work done on the garment (heat-transfer or HD prints, reflective prints, embroidery, laser cutting, washes)
    trims: zips (note brand such as YKK, the size, and DTM meaning dyed to match), toggles, stoppers, elastics (note width), drawcords, buttons, reflective tape, mesh inserts sold as trims
    labels_packaging: main label, care label, size label, hang tag, polybag, carton, stickers
    other: anything that is none of those
  Do NOT list stitch types, measurements or construction methods as materials. Do not repeat an item.
- item is a short name (for example "YKK zipper"), spec carries the detail (size, colour rule, width, GSM, composition).
- unit is how it is bought if the pack makes that clear (a zip is pcs, elastic is m, cloth is kg or m only if the pack says), otherwise null.
- perPiece is the quantity per garment ONLY if the pack states it (for example "2 toggles"). Otherwise null. NEVER estimate a consumption.
- perColour is true for things made in the garment's colours (self fabric, dyed-to-match trims), false for fixed items such as labels, otherwise null.
- evidence is the sheet name and a short quote or description of where you saw it.
- confidence (0 to 1) is how sure you are that it is a real material of this style: lower it when you inferred it from a diagram or an unclear callout.
- specPoints: every row of the measurement table: its code, point name, tolerance and one value per size, in the same order as "sizes". A tolerance printed as "±1" or "1.0" is symmetric: put it in tolPlus and leave tolMinus null. A blank cell is null.
- notes: gaps or doubts the factory should know about (for example "no fabric consumption is given", "colourways are images only").
- confidence at the end is your overall confidence in the extraction.`

const STANDARD_SIZES = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL']
const DEFAULT_UNIT = { fabric: 'm', process: 'pcs', trims: 'pcs', labels_packaging: 'pcs', other: 'pcs' }

/**
 * Read a tech pack file.
 * @param {Buffer} buffer
 * @param {string} mimeType  application/pdf or an image type
 * @returns {Promise<{ data: object | null, error: string | null }>}
 */
export function extractTechPack(buffer, mimeType, opts = {}) {
  return callJsonDetailed({
    content: [mediaBlock(buffer, mimeType), { type: 'text', text: TECHPACK_PROMPT }],
    schema: techPackSchema, model: techPackModel(), maxTokens: MAX_TOKENS, ...opts,
  })
}

// Tests swap the reader for a fake so no test calls the model.
let reader = extractTechPack
export const setTechPackReaderForTests = fn => { reader = fn || extractTechPack }
export const readTechPack = (buffer, mimeType) => reader(buffer, mimeType)

/** "S-XXL" or "XS - L" as a list of sizes, or null when it is not a range of the usual ladder. */
export function sizesFromRange(range) {
  const m = /^\s*([A-Za-z0-9]+)\s*(?:-|to|–)\s*([A-Za-z0-9]+)\s*$/i.exec(String(range || ''))
  if (!m) return null
  const a = STANDARD_SIZES.indexOf(m[1].toUpperCase()), b = STANDARD_SIZES.indexOf(m[2].toUpperCase())
  return a >= 0 && b > a ? STANDARD_SIZES.slice(a, b + 1) : null
}

/** The sizes the pack works in: its measurement table's columns, else its stated range, else nothing. */
export function sizesOf(data) {
  const fromTable = [...new Set((data.sizes || []).map(s => s.trim()).filter(Boolean))].slice(0, 12)
  return fromTable.length ? fromTable : sizesFromRange(data.header?.sizeRange) || []
}

const normName = v => String(v || '').trim().toLowerCase().replace(/\s+/g, ' ')

/**
 * The bill of materials lines a pack suggests, ready to store: every one marked as from the AI and needing
 * a look. Candidates already on the BOM (same section and name) are left out, as are ones that are not a
 * real section or have no name.
 * @param {object} data  the extraction
 * @param {Array<{ section, item }>} existing  lines already on the BOM
 */
export function linesFromTechPack(data, existing = []) {
  const seen = new Set(existing.map(l => `${l.section}|${normName(l.item)}`))
  const lines = []
  for (const c of data.bomCandidates || []) {
    const section = BOM_SECTIONS.includes(c.section) ? c.section : null
    const item = c.item?.slice(0, 200)
    if (!section || !item) continue
    const key = `${section}|${normName(item)}`
    if (seen.has(key)) continue
    seen.add(key)
    lines.push({
      lineId: newLineId(), section, item, spec: (c.spec || '').slice(0, 300), unit: (c.unit || DEFAULT_UNIT[section]).slice(0, 20),
      consumption: c.perPiece !== null && c.perPiece >= 0 && c.perPiece <= 1e6 ? c.perPiece : 0, perSize: [], wastagePct: 0,
      perColour: typeof c.perColour === 'boolean' ? c.perColour : section === 'fabric',
      supplierId: null, itemId: null, rate: 0, note: '',
      source: 'ai', confidence: c.confidence, needsReview: true, evidence: (c.evidence || '').slice(0, 120),
    })
  }
  return lines
}

/**
 * The measurement spec the pack gives, shaped for the SpecSheet model: a value for each of `sizes` (null
 * where blank), and a point that has no name or no values at all is dropped.
 */
export function specFromTechPack(data) {
  const sizes = sizesOf(data)
  const points = []
  for (const p of data.specPoints || []) {
    const name = p.name?.slice(0, 200)
    if (!name) continue
    const values = sizes.map((_, i) => (p.values?.[i] !== undefined && p.values[i] !== null && p.values[i] >= 0 ? p.values[i] : null))
    if (sizes.length && values.every(v => v === null)) continue
    points.push({
      code: (p.code || '').slice(0, 10), name, tolPlus: p.tolPlus !== null && p.tolPlus >= 0 ? p.tolPlus : null,
      tolMinus: p.tolMinus !== null && p.tolMinus >= 0 ? p.tolMinus : null, values, confidence: null, needsReview: false,
    })
  }
  return { header: data.header || {}, sizes, points }
}
