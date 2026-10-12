// Stock and goods received, as the screens work with them: labels, and the state of the receiving form.
//
// What a person types stays a string (so "1." can be half-typed) and is turned into numbers only when it is
// sent. The server decides every balance and every number on a note; this file only shapes what is typed and
// says, as it is typed, whether a quantity matches the order.
import { decimal, newKey } from './bomUi.js'

export { decimal }

export const CATEGORIES = [
  { id: 'fabric', label: 'Fabric' },
  { id: 'yarn', label: 'Yarn' },
  { id: 'trims', label: 'Trims' },
  { id: 'packaging', label: 'Packaging' },
  { id: 'other', label: 'Other' },
]
export const categoryLabel = id => CATEGORIES.find(c => c.id === id)?.label || 'Other'

/** What a ledger row is called in a movement history, and whether it adds to or takes from the store. */
export const LEDGER_TYPES = {
  receipt: 'Received',
  issue: 'Issued to an order',
  return: 'Returned from an order',
  adjustment: 'Count correction',
  jobwork_out: 'Sent to a job worker',
  jobwork_in: 'Back from a job worker',
}
export const ledgerLabel = type => LEDGER_TYPES[type] || type

const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
export const round3 = n => Math.round((num(n) + Number.EPSILON) * 1000) / 1000
const str = v => (v === null || v === undefined ? '' : String(v))

/** "+100 kg" or "-30 kg": a movement with its sign. */
export const signedQty = (qty, unit, fmt = String) => `${qty > 0 ? '+' : qty < 0 ? '-' : ''}${fmt(Math.abs(qty))}${unit ? ` ${unit}` : ''}`

export const GRN_STATE = { draft: { label: 'Draft', tone: 'warn' }, posting: { label: 'Posting', tone: 'warn' }, posted: { label: 'Posted', tone: 'good' } }
export const grnStateLabel = s => GRN_STATE[s]?.label || s
export const SOURCE_LABEL = { web: 'Typed in', whatsapp: 'From WhatsApp', kriyaa: 'By Kriyaa', ai_review: 'Read from a photo' }

/** Pieces that went into stock from one line: what arrived less what was turned away. */
export const acceptedOf = l => round3(Math.max(0, num(l.qty) - num(l.rejectedQty)))

export function blankLine(over = {}) {
  return { key: newKey(), lineId: '', poLineId: '', description: '', itemId: '', unit: 'pcs', orderedQty: null, qty: '', rejectedQty: '', rejectReason: '', rate: '', lot: '', note: '', ...over }
}

/** A server GRN as the form the person edits. */
export function formFromGrn(g) {
  return {
    poId: g.poId || '', supplierId: g.supplierId || '', supplierName: g.supplierName || '',
    challanNo: g.challanNo || '', challanDate: g.challanDate || '', vehicleNo: g.vehicleNo || '', receivedOn: g.receivedOn || '', note: g.note || '',
    lines: (g.lines || []).map(l => blankLine({
      lineId: l.lineId, poLineId: l.poLineId || '', description: l.description, itemId: l.itemId || '', unit: l.unit || 'pcs', orderedQty: l.orderedQty ?? null,
      qty: l.qty ? str(l.qty) : '', rejectedQty: l.rejectedQty ? str(l.rejectedQty) : '', rejectReason: l.rejectReason || '', rate: l.rate ? str(l.rate) : '', lot: l.lot || '', note: l.note || '',
    })),
  }
}

/** A line nobody has filled in (no words, no quantity) is a blank row and is not sent. */
export const isBlankLine = l => !l.description.trim() && !str(l.qty).trim()

/** The body the server's update route takes. The purchase order is fixed when the note starts, so it is not sent. */
export function payloadFromForm(f) {
  return {
    supplierName: f.supplierName.trim(), ...(f.poId ? {} : { supplierId: f.supplierId || null }), challanNo: f.challanNo.trim(), challanDate: f.challanDate || null, vehicleNo: f.vehicleNo.trim(),
    receivedOn: f.receivedOn || null, note: f.note.trim(),
    lines: f.lines.filter(l => !isBlankLine(l)).map(l => ({
      ...(l.lineId ? { lineId: l.lineId } : {}), ...(l.poLineId ? { poLineId: l.poLineId } : {}), description: l.description.trim(),
      ...(l.itemId ? { itemId: l.itemId } : {}), unit: l.unit.trim() || 'pcs', qty: num(l.qty), rejectedQty: num(l.rejectedQty),
      rejectReason: l.rejectReason.trim(), rate: num(l.rate), lot: l.lot.trim(), note: l.note.trim(),
    })),
  }
}

/** A string that changes exactly when something worth saving did. */
export const formKey = f => JSON.stringify(payloadFromForm(f))

/** Can this note be posted as it stands? */
export function readiness(f) {
  const arrived = f.lines.filter(l => num(l.qty) > 0)
  if (arrived.length === 0) return { ok: false, reason: 'Type how much arrived on at least one line' }
  const unnamed = arrived.find(l => !l.description.trim())
  if (unnamed) return { ok: false, reason: 'Say what the goods are on every line that has a quantity' }
  const more = arrived.find(l => num(l.rejectedQty) > num(l.qty))
  if (more) return { ok: false, reason: `${more.description}: more was turned away than arrived` }
  return { ok: true, count: arrived.length }
}

/**
 * What a typed quantity means against the purchase order, as a short plain sentence and a tone, so a typo is
 * seen before posting: short, matching, a little over (cloth is measured), or too far over.
 * `po` is the order's own line: { ordered, received, outstanding }.
 */
export function lineHint(line, po) {
  const arrived = num(line.qty)
  if (!po || arrived <= 0) return null
  const accepted = acceptedOf(line)
  const left = round3(po.outstanding - accepted)
  const unit = line.unit || po.unit || ''
  if (left > 0) return { tone: 'warn', text: `${left} ${unit} still to come after this` }
  if (left === 0) return { tone: 'good', text: 'Completes this line of the order' }
  const over = -left
  if (po.outstanding > 0 && accepted > po.ordered * 1.1 - po.received) return { tone: 'bad', text: `${over} ${unit} over the order: more than 10% over, so it will be refused` }
  return { tone: 'info', text: `${over} ${unit} more than ordered` }
}

/** Stock items whose name holds what was typed, best (starts with it) first. */
export function suggestItems(items, text, limit = 6) {
  const q = text.trim().toLowerCase()
  if (!q) return []
  return items
    .filter(i => i.isActive !== false && i.name.toLowerCase().includes(q))
    .sort((a, b) => Number(b.name.toLowerCase().startsWith(q)) - Number(a.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name))
    .slice(0, limit)
}

/**
 * The problems with a stock issue before it is sent: a line with no item, no quantity, or more than the store holds.
 * `lines` are { itemId, qty (string) }; `items` the stock list (with onHand).
 * @returns {Array<string|null>} one message (or null) for each line
 */
export function issueProblems(lines, items, type = 'issue') {
  const byId = new Map(items.map(i => [i.id, i]))
  return lines.map(l => {
    const item = byId.get(l.itemId)
    if (!item) return null
    const q = num(l.qty)
    if (str(l.qty).trim() === '') return null
    if (q <= 0) return 'The quantity must be more than zero'
    if (type === 'issue' && q > item.onHand) return `Only ${item.onHand} ${item.unit} in the store`
    return null
  })
}

/**
 * After the server has saved a draft, take the ids it gave the lines (and the unit an item set) onto the lines it
 * was sent, matched by position among the non-blank ones, so the next save names them and they keep their identity.
 */
export function adoptIds(form, serverLines) {
  let i = 0
  return {
    ...form,
    lines: form.lines.map(l => {
      if (isBlankLine(l)) return l
      const s = serverLines[i++]
      return s ? { ...l, lineId: s.lineId, itemId: s.itemId || '', unit: s.unit || l.unit } : l
    }),
  }
}

const norm = v => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ')

/** How the server finds a received line's item: its name and unit, ignoring case and spacing (the same rule). */
export const itemKey = (name, unit) => `${norm(name)}|${norm(unit)}`

/**
 * Which stock item a line will go into. `exact` is the item the line's own name and unit find (what the server
 * does when no item is chosen); when there is none, `near` lists items in the same unit whose name starts the line's
 * description or is started by it ("Brushed fleece 280 GSM" for "Brushed fleece 280 GSM, 72 in"), for the person to
 * confirm with one tap. Nothing is chosen for them: two colours of one cloth are two items.
 */
export function stockMatch(items, description, unit) {
  const live = items.filter(i => i.isActive !== false)
  const key = itemKey(description, unit)
  const exact = live.find(i => itemKey(i.name, i.unit) === key) || null
  if (exact) return { exact, near: [] }
  const d = norm(description)
  if (d.length < 3) return { exact: null, near: [] }
  const near = live.filter(i => {
    const n = norm(i.name)
    return norm(i.unit) === norm(unit) && n.length >= 5 && n !== d && (d.startsWith(n) || n.startsWith(d))
  }).slice(0, 3)
  return { exact: null, near }
}
