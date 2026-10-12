// What an order was planned to use against what the store actually issued to it, line by line.
//
// The plan is the factory's frozen bill of materials (quantities worked by lib/bomMath.js, wastage included); what was used is
// the net of the stock issued to the order (issues less returns) in the ledger. A line is found in the store the way goods
// received find their item: by the name a purchase order line would carry and the unit. Pieces made so far (the order's cutting
// step) give a figure per piece to set beside the plan's, which is how a factory learns what a style really takes: the
// consumption actuals a later costing can be checked against. Pure except for the loader at the bottom.
import mongoose from 'mongoose'
import { Bom, Order, InventoryItem, StockLedger } from '../../db/index.js'
import { computeBom, weightedConsumption, roundTo } from '../bomMath.js'
import { poDescription } from '../bomAggregate.js'
import { itemKey } from './stock.js'

const round3 = n => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000

/** The pieces made so far: the cutting step's units done, else the latest step that counts pieces and has some. */
export function producedOf(stages) {
  const counted = (stages || []).filter(s => (s.kind === 'quantity' || s.kind === undefined) && Number(s.unitsDone) > 0)
  const cutting = counted.find(s => /^cutting/i.test(s.name || ''))
  const s = cutting || counted[counted.length - 1]
  return s ? { stage: s.name, pieces: Number(s.unitsDone), of: Number(s.totalUnits) || null } : null
}

/**
 * @param {{ plan: object, lines: object[], totalQty: number } | null} bom  the frozen bill of materials (stored shape)
 * @param {Array<{ itemId: string, name: string, unit: string, key: string, aliases?: string[], issued: number }>} used  net issued per stock item
 * @param {{ stage: string, pieces: number, of: number | null } | null} produced
 */
export function reconcile(bom, used, produced) {
  const byKey = new Map()
  for (const u of used) { byKey.set(u.key, u); for (const a of u.aliases || []) byKey.set(a, u) }
  const claimed = new Set()
  const rows = []

  if (bom) {
    const worked = computeBom({ sizes: bom.sizes, ratio: bom.sizeRatio, colours: bom.colours }, bom.lines || [])
    const plan = { sizes: bom.sizes, ratio: bom.sizeRatio, colours: bom.colours }
    for (const line of worked.lines) {
      const parts = line.computed.perColour.length ? line.computed.perColour.map(c => ({ colour: c.colour, planned: c.orderQty, net: c.net })) : [{ colour: '', planned: line.computed.orderQty, net: line.computed.net }]
      const colours = []
      let planned = 0, issued = 0, net = 0
      for (const p of parts) {
        const hit = byKey.get(itemKey(poDescription({ item: line.item, spec: line.spec, colour: p.colour }), line.unit))
        const got = hit ? hit.issued : 0
        if (hit) claimed.add(hit.itemId)
        colours.push({ colour: p.colour, planned: p.planned, issued: round3(got), itemId: hit?.itemId || null })
        planned += p.planned; issued += got; net += p.net
      }
      // A store that keeps one item for the cloth whatever its colour still used it up: what was issued of it counts toward the
      // line, shown apart because nothing says which colour it went to.
      let anyColour = 0
      if (parts.some(p => p.colour)) {
        const plain = byKey.get(itemKey(poDescription({ item: line.item, spec: line.spec, colour: '' }), line.unit))
        if (plain && !claimed.has(plain.itemId)) { claimed.add(plain.itemId); anyColour = plain.issued; issued += anyColour }
      }
      if (!(planned > 0) && !(issued > 0)) continue
      const bomPerPiece = weightedConsumption(plan, line)
      const pieces = produced?.pieces || 0
      const actualPerPiece = pieces > 0 && issued > 0 ? roundTo(issued / pieces, 4) : null
      rows.push({
        lineId: line.lineId, section: line.section, item: line.item, spec: line.spec || '', unit: line.unit, colours: colours.length > 1 || colours[0]?.colour ? colours : [],
        planned: round3(planned), issued: round3(issued), anyColour: round3(anyColour), difference: round3(issued - planned),
        // Used so far against what the pieces made so far were planned to take (wastage allowance included).
        bomPerPiece, wastagePct: line.wastagePct || 0, actualPerPiece,
        perPieceVariancePct: actualPerPiece !== null && bomPerPiece > 0 ? roundTo(((actualPerPiece - bomPerPiece * (1 + (line.wastagePct || 0) / 100)) / (bomPerPiece * (1 + (line.wastagePct || 0) / 100))) * 100, 1) : null,
      })
    }
  }
  const extra = used.filter(u => !claimed.has(u.itemId) && u.issued !== 0).map(u => ({ itemId: u.itemId, name: u.name, unit: u.unit, issued: round3(u.issued) }))
  return { produced, hasBom: !!bom, lines: rows, extra }
}

/** Load what an order was planned to use and what was issued to it, for the caller's own company. */
export async function usageForOrder(req, orderId) {
  const mine = { ownerOrgId: req.user.orgId }
  const order = typeof orderId === 'string' && orderId.length <= 100 ? await Order.findOne({ _id: orderId, 'assignments.mfrId': req.user.id }).lean() : null
  if (!order) return null
  const asgn = (order.assignments || []).find(a => String(a.mfrId) === String(req.user.id))
  const bom = await Bom.findOne({ ...mine, orderId: order._id, status: 'frozen' }).sort({ version: -1 }).lean()

  const rows = await StockLedger.aggregate([
    { $match: { ownerOrgId: new mongoose.Types.ObjectId(String(req.user.orgId)), orderId: order._id, refType: 'issue' } },
    { $group: { _id: '$itemId', net: { $sum: '$qty' } } },
  ])
  const items = rows.length ? await InventoryItem.find({ _id: { $in: rows.map(r => r._id) }, ...mine }, 'name unit key aliases').lean() : []
  const byId = new Map(items.map(i => [String(i._id), i]))
  const used = rows.map(r => {
    const i = byId.get(String(r._id))
    return i ? { itemId: String(i._id), name: i.name, unit: i.unit, key: i.key, aliases: i.aliases || [], issued: -r.net } : null
  }).filter(Boolean)

  const result = reconcile(bom, used, producedOf(asgn?.stages))
  return {
    order: { id: order._id, product: order.product, styleNumber: order.styleNumber || '', quantity: asgn?.qty || 0 },
    bomVersion: bom?.version || null,
    ...result,
  }
}
