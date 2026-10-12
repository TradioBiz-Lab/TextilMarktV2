// Matching what a goods document says to what the factory already has: which purchase order it is for, which
// supplier sent it, and which line is which. Pure functions (no database): the ingest service loads the
// company's own purchase orders and suppliers and hands them in.
//
// Nothing here decides anything for the person: a match is a suggestion that lands in a draft note they read
// before posting, and an unsure match is left out rather than guessed.

const STOP = new Set(['the', 'and', 'of', 'in', 'for', 'to', 'with', 'a', 'cm', 'inch', 'in.', 'pcs', 'nos', 'no'])

const tokens = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9.%/]+/g, ' ').split(' ').map(t => t.replace(/^\.+|\.+$/g, '')).filter(t => t && !STOP.has(t))

/** How alike two descriptions are, 0 to 1 (Dice on word sets; a number such as 280 counts like any word, so 280 and 300 GSM differ). */
export function similarity(a, b) {
  const x = new Set(tokens(a)), y = new Set(tokens(b))
  if (!x.size || !y.size) return 0
  let hit = 0
  for (const t of x) if (y.has(t)) hit += 1
  return (2 * hit) / (x.size + y.size)
}

const UNIT_ALIASES = {
  kg: 'kg', kgs: 'kg', kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilograms: 'kg',
  m: 'm', mtr: 'm', mtrs: 'm', meter: 'm', meters: 'm', metre: 'm', metres: 'm',
  yd: 'yds', yds: 'yds', yard: 'yds', yards: 'yds',
  pcs: 'pcs', pc: 'pcs', nos: 'pcs', no: 'pcs', piece: 'pcs', pieces: 'pcs', each: 'pcs',
  roll: 'roll', rolls: 'roll', cone: 'cone', cones: 'cone', box: 'box', boxes: 'box', carton: 'carton', cartons: 'carton', ctn: 'carton', set: 'set', sets: 'set',
}
/** A unit as the factory writes it: KGS and MTR become kg and m; an unknown unit is kept as printed (lower case). */
export const normaliseUnit = u => {
  const k = String(u ?? '').trim().toLowerCase().replace(/\./g, '')
  return UNIT_ALIASES[k] || k
}

const PO_ID = /PO-[A-Z0-9]{1,5}-\d{4}-\d{4,}/i

/**
 * The open purchase order a document is for. Tried in order: the PO number it quotes (the full number, or its
 * last digits when only one open PO ends in them), then the supplier (by GSTIN, else by name) when that
 * supplier has one open PO, or when its lines read like the document's.
 * @param {{ poNumber, supplierName, supplierGstin, lines }} doc
 * @param {Array<{ _id, supplierId, lines: Array<{ lineId, description, unit }> }>} openPos
 * @param {Array<{ _id, name, gstin }>} suppliers
 * @returns {{ po: object | null, supplier: object | null, reason: string | null }}
 */
export function matchPo(doc, openPos, suppliers) {
  const byGstin = doc.supplierGstin ? suppliers.find(s => s.gstin && s.gstin.toUpperCase() === doc.supplierGstin.toUpperCase()) : null
  let supplier = byGstin || null
  if (!supplier && doc.supplierName) {
    const scored = suppliers.map(s => ({ s, score: similarity(s.name, doc.supplierName) })).filter(x => x.score >= 0.6).sort((a, b) => b.score - a.score)
    if (scored.length && (scored.length === 1 || scored[0].score - scored[1].score >= 0.15)) supplier = scored[0].s
  }

  const quoted = String(doc.poNumber || '')
  const full = PO_ID.exec(quoted)
  if (full) {
    const po = openPos.find(p => p._id.toUpperCase() === full[0].toUpperCase())
    if (po) return { po, supplier: supplier || suppliers.find(s => String(s._id) === String(po.supplierId)) || null, reason: 'It quotes the purchase order number' }
  }
  const digits = (quoted.match(/\d+/g) || []).pop()
  if (digits && digits.length >= 1) {
    const tail = digits.replace(/^0+/, '') || '0'
    const ends = openPos.filter(p => String(parseInt(p._id.slice(p._id.lastIndexOf('-') + 1), 10)) === tail && (!supplier || String(p.supplierId) === String(supplier._id)))
    if (ends.length === 1) return { po: ends[0], supplier: supplier || suppliers.find(s => String(s._id) === String(ends[0].supplierId)) || null, reason: 'It quotes the number of the purchase order' }
  }

  if (supplier) {
    const mine = openPos.filter(p => String(p.supplierId) === String(supplier._id))
    if (mine.length === 1) return { po: mine[0], supplier, reason: `${supplier.name} has one purchase order waiting for goods` }
    if (mine.length > 1) {
      const scored = mine.map(p => ({ p, score: (doc.lines || []).reduce((t, l) => t + Math.max(0, ...p.lines.map(pl => similarity(pl.description, l.description))), 0) })).sort((a, b) => b.score - a.score)
      if (scored[0].score > 0 && (scored.length === 1 || scored[0].score >= scored[1].score * 1.5)) return { po: scored[0].p, supplier, reason: `Its goods read like ${scored[0].p._id}` }
    }
  }
  return { po: null, supplier, reason: null }
}

/**
 * Which purchase order line each line of the document is, one document line to one PO line, best matches first.
 * A pair needs the same unit (or none printed) and words alike enough to be the same goods.
 * @returns {Map<number, string>} document line index -> PO line id
 */
export function matchLines(docLines, poLines, threshold = 0.5) {
  const pairs = []
  docLines.forEach((d, i) => {
    poLines.forEach(p => {
      const du = normaliseUnit(d.unit), pu = normaliseUnit(p.unit)
      if (du && pu && du !== pu) return
      const score = similarity(d.description, p.description)
      if (score >= threshold) pairs.push({ i, lineId: p.lineId, score })
    })
  })
  pairs.sort((a, b) => b.score - a.score)
  const out = new Map(), taken = new Set()
  for (const x of pairs) {
    if (out.has(x.i) || taken.has(x.lineId)) continue
    out.set(x.i, x.lineId); taken.add(x.lineId)
  }
  return out
}

/** The sums on a document that do not add up: quantity times rate against the amount, line by line. */
export function crossCheck(doc) {
  const warnings = []
  ;(doc.lines || []).forEach((l, i) => {
    if (l.qty != null && l.rate != null && l.amount != null) {
      const expected = l.qty * l.rate
      if (Math.abs(expected - l.amount) > Math.max(1, Math.abs(l.amount) * 0.005)) warnings.push(`Line ${i + 1}: ${l.qty} x ${l.rate} is ${Math.round(expected * 100) / 100}, but the document says ${l.amount}. Check the quantity`)
    }
    if (l.qty == null) warnings.push(`Line ${i + 1}: the quantity could not be read`)
  })
  return warnings
}
