// Adding up what a factory has to buy across its orders: every frozen bill of materials, line by line,
// grouped by what is bought and from whom, less what already sits on a purchase order. Pure: the route
// loads the data (the company's own, always) and this works it out.
import { computeBom, roundTo } from './bomMath.js'

const norm = v => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ')

/** What identifies one thing to buy: the item, its spec, its unit, who supplies it, and the colour when it is bought per colour. */
export const rowKey = ({ item, spec, unit, supplierId, colour }) => [norm(item), norm(spec), norm(unit), supplierId ? String(supplierId) : '', norm(colour)].join('|')

/** The key a purchase order line's link to a BOM line uses. */
export const refKey = ({ orderId, lineId, colour }) => `${orderId}|${lineId}|${norm(colour)}`

/**
 * @param {Array<{ bom: object, order: { id, product, styleNumber } }>} frozen  the latest frozen BOM of each order
 * @param {Map<string, number>} onPo  quantity already on a PO, by refKey
 * @param {{ suppliers: Map<string, object>, items: Map<string, object> }} lookups  the company's own suppliers and catalog items
 *   (items by id). A line with a supplier but no catalog tie is matched by name to that supplier's items, so the
 *   shopping list still carries the catalog's rate, HSN, GST and minimum order.
 * @returns {{ rows: object[], unsupplied: number, orders: number }}
 */
export function aggregate(frozen, onPo = new Map(), { suppliers = new Map(), items = new Map() } = {}) {
  const bySupplierAndName = new Map()
  for (const it of items.values()) bySupplierAndName.set(`${it.supplierId}|${norm(it.name)}`, it)
  const rows = new Map()
  for (const { bom, order } of frozen) {
    const worked = computeBom({ sizes: bom.sizes, ratio: bom.sizeRatio, colours: bom.colours }, bom.lines || [])
    for (const line of worked.lines) {
      const parts = line.computed.perColour.length
        ? line.computed.perColour.map(c => ({ colour: c.colour, qty: c.orderQty }))
        : [{ colour: '', qty: line.computed.orderQty }]
      for (const part of parts) {
        if (!(part.qty > 0)) continue
        const supplierId = line.supplierId ? String(line.supplierId) : ''
        const itemId = line.itemId ? String(line.itemId) : (supplierId && bySupplierAndName.get(`${supplierId}|${norm(line.item)}`)?._id?.toString()) || null
        const key = rowKey({ item: line.item, spec: line.spec, unit: line.unit, supplierId, colour: part.colour })
        const row = rows.get(key) || {
          key, section: line.section, item: line.item, spec: line.spec || '', unit: line.unit || '', colour: part.colour,
          supplierId: supplierId || null, supplierName: supplierId ? suppliers.get(supplierId)?.name || '' : '',
          itemId, required: 0, onPo: 0, rateTotal: 0, rated: 0, sources: [],
        }
        const already = onPo.get(refKey({ orderId: bom.orderId, lineId: line.lineId, colour: part.colour })) || 0
        row.required += part.qty
        row.onPo += Math.min(already, part.qty)
        if (line.rate > 0) { row.rateTotal += line.rate * part.qty; row.rated += part.qty }
        if (!row.itemId && itemId) row.itemId = itemId
        row.sources.push({
          bomId: String(bom._id), orderId: bom.orderId, product: order?.product || '', styleNumber: order?.styleNumber || '',
          lineId: line.lineId, colour: part.colour, qty: part.qty, onPo: Math.min(already, part.qty),
        })
        rows.set(key, row)
      }
    }
  }
  const out = [...rows.values()].map(r => {
    const item = r.itemId ? items.get(r.itemId) : null
    const rate = r.rated > 0 ? roundTo(r.rateTotal / r.rated, 4) : (item?.defaultRate || 0)
    const required = roundTo(r.required, 3), onPoQty = roundTo(r.onPo, 3)
    const remaining = roundTo(Math.max(0, required - onPoQty), 3)
    const { rateTotal, rated, ...rest } = r
    return {
      ...rest, required, onPo: onPoQty, remaining, rate, moq: item?.moq || 0,
      belowMoq: !!(item?.moq > 0 && remaining > 0 && remaining < item.moq),
    }
  }).sort((a, b) => (a.supplierName || '￿').localeCompare(b.supplierName || '￿') || a.section.localeCompare(b.section) || a.item.localeCompare(b.item) || a.colour.localeCompare(b.colour))
  return { rows: out, unsupplied: out.filter(r => !r.supplierId && r.remaining > 0).length, orders: new Set(frozen.map(f => f.bom.orderId)).size }
}

/** What a purchase order line for a shopping list row is called: also how the stock list names the same thing. */
export const poDescription = r => `${r.item}${r.spec ? `, ${r.spec}` : ''}${r.colour ? ` - ${r.colour}` : ''}`.slice(0, 300)

/**
 * Say, row by row, how much of what is left to order is already in the store. `find(description, unit)` returns the
 * stock item a row is ({ itemId, onHand }) or null. A stock item is counted once however many rows are that item:
 * the first rows take it, later ones see what is left. Stock is not reserved for an order, so this is advice on what
 * to buy now, not a promise that the stock stays there.
 * @returns the rows with `stockItemId`, `inStock` (all there is), `fromStock` (what covers this row) and `toBuy`
 */
export function applyStock(rows, find) {
  const pool = new Map()
  return rows.map(r => {
    const hit = find(poDescription(r), r.unit)
    if (!hit) return { ...r, stockItemId: null, inStock: 0, fromStock: 0, toBuy: r.remaining }
    if (!pool.has(hit.itemId)) pool.set(hit.itemId, Math.max(0, hit.onHand))
    const covered = roundTo(Math.min(pool.get(hit.itemId), r.remaining), 3)
    pool.set(hit.itemId, roundTo(pool.get(hit.itemId) - covered, 3))
    return { ...r, stockItemId: hit.itemId, inStock: Math.max(0, hit.onHand), fromStock: covered, toBuy: roundTo(r.remaining - covered, 3) }
  })
}
