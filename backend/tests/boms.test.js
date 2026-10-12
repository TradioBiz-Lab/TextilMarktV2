// Bills of materials end to end: starting one from an order, editing, freezing and revising, the shopping
// list across a master order, the draft purchase orders it makes, and that nobody else can reach any of it.
import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as, req } from './helpers/client.js'
import { makeAdmin, makeMaster, makeBuyer, makeMfr, makeMember, makeOrder, makeMasterOrder, setOrg, link } from './helpers/factories.js'
import { Supplier } from '../src/models/Supplier.js'
import { SupplierItem } from '../src/models/SupplierItem.js'
import { Bom } from '../src/models/Bom.js'
import { Order } from '../src/models/Order.js'
import { PurchaseOrder } from '../src/models/PurchaseOrder.js'
import { gstinCheckChar } from '../src/lib/gst.js'

before(async () => { await startTestDb(); await startServer(); await Supplier.init(); await SupplierItem.init(); await Bom.init() })
after(async () => { delete process.env.PLATFORM_MODE; await stopServer(); await stopTestDb() })
beforeEach(async () => { await clearDb(); process.env.PLATFORM_MODE = 'standalone'; delete process.env.ENABLE_VIEW_AS })

const gstinFor = (state, pan = 'AAPFU0939F') => { const f = `${state}${pan}1Z`; return f + gstinCheckChar(f) }

/** A factory in Tamil Nadu with its business details filled in, and a brand it works with. */
async function world() {
  const mfr = await makeMfr({ code: 'TPR', company: 'TPR Textiles' })
  await setOrg(mfr, { profile: { legalName: 'TPR Textiles Pvt Ltd', gstin: gstinFor('33'), stateCode: '33', address: 'Plot 22', city: 'Tiruppur', pincode: '641604' } })
  const brand = await makeBuyer({ code: 'FIT', company: 'Fitleasure' })
  await link(brand, mfr)
  return { mfr, brand }
}
const supplier = async (u, body = {}) => (await as(u).post('/api/suppliers', { name: 'Coimbatore Knit Fabrics', type: 'fabric_supplier', email: 'sales@cknit.test', gstin: gstinFor('33'), ...body })).body
const item = async (u, s, body = {}) => (await as(u).post(`/api/suppliers/${s.id}/items`, { name: 'Polar fleece 300 GSM', unit: 'kg', defaultRate: 410, moq: 300, taxPct: 5, hsnCode: '600610', ...body })).body

/** An order the factory makes: 10,800 pieces in three colours. */
async function styleOrder(mfr, brand, { id = 'FIT-5117', masterOrderId = null, totalQty = 10800, colours = ['BLACK', 'NAVY', 'CHARCOAL GREY'] } = {}) {
  await makeOrder({ id, buyer: brand, mfrs: [mfr], product: 'Polaire full zip', totalQty, masterOrderId })
  await Order.updateOne({ _id: id }, { $set: { colourways: colours.map(name => ({ name })), styleNumber: id } })
  return id
}
const FLEECE = [0.63, 0.675, 0.72, 0.765, 0.8325]
const fleeceLine = (extra = {}) => ({ section: 'fabric', item: 'Polar fleece 300 GSM', unit: 'kg', consumption: 0.72, perSize: FLEECE, wastagePct: 7, perColour: true, rate: 410, ...extra })
const zipLine = (extra = {}) => ({ section: 'trims', item: 'YKK zip 5', unit: 'pcs', consumption: 1, wastagePct: 2, rate: 45, ...extra })

const start = async (u, orderId) => (await as(u).post('/api/boms', { orderId })).body
const save = (u, id, body) => as(u).post(`/api/boms/${id}`, body)
const frozenBom = async (u, orderId, lines) => {
  const b = await start(u, orderId)
  const s = await save(u, b.id, { lines })
  assert.equal(s.status, 200, JSON.stringify(s.body))
  const f = await as(u).post(`/api/boms/${b.id}/freeze`)
  assert.equal(f.status, 200, JSON.stringify(f.body))
  return f.body
}

describe('who can use bills of materials', () => {
  test('the Tradio portal does not have them', async () => {
    delete process.env.PLATFORM_MODE
    const { mfr } = await world()
    assert.equal((await as(mfr).get('/api/boms?orderId=X')).status, 404)
  })

  test('brands and Tradio staff are refused, and so is someone not signed in', async () => {
    const { brand } = await world()
    for (const u of [brand, await makeAdmin(), await makeMaster()]) assert.equal((await as(u).get('/api/boms?orderId=X')).status, 403, u.role)
    assert.equal((await req('GET', '/api/boms?orderId=X')).status, 401)
  })

  test('everyone on the factory\'s team shares its bills of materials', async () => {
    const { mfr, brand } = await world()
    const mate = await makeMember(mfr)
    const orderId = await styleOrder(mfr, brand)
    const b = await start(mfr, orderId)
    assert.equal((await as(mate).get(`/api/boms/${b.id}`)).status, 200)
  })
})

describe('starting one', () => {
  test('begins from the order: the standard sizes, the colours sharing the pieces, the split\'s quantity', async () => {
    const { mfr, brand } = await world()
    const orderId = await styleOrder(mfr, brand)
    const r = await as(mfr).post('/api/boms', { orderId })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.deepEqual(r.body.plan.sizes, ['S', 'M', 'L', 'XL', 'XXL'])
    assert.deepEqual(r.body.plan.ratio, [1, 2, 3, 2, 1])
    assert.deepEqual(r.body.plan.colours, [{ name: 'BLACK', qty: 3600 }, { name: 'NAVY', qty: 3600 }, { name: 'CHARCOAL GREY', qty: 3600 }])
    assert.equal(r.body.plan.totalQty, 10800)
    assert.equal(r.body.status, 'draft')
    assert.equal(r.body.version, 1)
  })

  test('a quantity that does not divide evenly gives the remainder to the first colour', async () => {
    const { mfr, brand } = await world()
    const orderId = await styleOrder(mfr, brand, { totalQty: 1000 })
    const b = await start(mfr, orderId)
    assert.deepEqual(b.plan.colours.map(c => c.qty), [334, 333, 333])
  })

  test('an order with no colours is one colour of everything', async () => {
    const { mfr, brand } = await world()
    const orderId = await styleOrder(mfr, brand, { colours: [] })
    assert.deepEqual((await start(mfr, orderId)).plan.colours, [{ name: 'All', qty: 10800 }])
  })

  test('an order has one, and starting a second is refused', async () => {
    const { mfr, brand } = await world()
    const orderId = await styleOrder(mfr, brand)
    await start(mfr, orderId)
    assert.equal((await as(mfr).post('/api/boms', { orderId })).status, 409)
  })

  test('only an order the factory is on', async () => {
    const { mfr, brand } = await world()
    const other = await makeMfr({ code: 'OTH' })
    await makeOrder({ id: 'NOT-MINE', buyer: brand, mfrs: [other] })
    assert.equal((await as(mfr).post('/api/boms', { orderId: 'NOT-MINE' })).status, 404)
    assert.equal((await as(mfr).post('/api/boms', { orderId: 'nope' })).status, 404)
    assert.equal((await as(mfr).post('/api/boms', {})).status, 404)
  })

  test('the order\'s page reads the versions, the working one in full, and what a new one would be', async () => {
    const { mfr, brand } = await world()
    const orderId = await styleOrder(mfr, brand)
    const empty = (await as(mfr).get(`/api/boms?orderId=${orderId}`)).body
    assert.equal(empty.current, null)
    assert.equal(empty.seed.totalQty, 10800)
    assert.equal(empty.order.quantity, 10800)
    await start(mfr, orderId)
    const after = (await as(mfr).get(`/api/boms?orderId=${orderId}`)).body
    assert.equal(after.versions.length, 1)
    assert.equal(after.current.version, 1)
  })
})

describe('editing a draft', () => {
  test('the server works the quantities: the real 5117 fleece plan comes to 2,783 kg a colour and 8,349 kg', async () => {
    const { mfr, brand } = await world()
    const b = await start(mfr, await styleOrder(mfr, brand))
    const r = await save(mfr, b.id, { lines: [fleeceLine(), zipLine()] })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const fleece = r.body.lines[0]
    assert.equal(fleece.computed.orderQty, 8349)
    assert.deepEqual(fleece.computed.perColour.map(c => c.orderQty), [2783, 2783, 2783])
    assert.equal(fleece.computed.perColour[0].net, 2601)
    assert.equal(fleece.computed.perColour[0].buffer, 182.1)
    assert.equal(r.body.lines[1].computed.orderQty, 11016)     // zips by the piece, 10,800 + 2%
    assert.deepEqual(r.body.warnings, [])
  })

  test('a total sent by the browser is ignored', async () => {
    const { mfr, brand } = await world()
    const b = await start(mfr, await styleOrder(mfr, brand))
    const r = await save(mfr, b.id, { lines: [{ ...zipLine(), computed: { orderQty: 1 }, orderQty: 1 }] })
    assert.equal(r.body.lines[0].computed.orderQty, 11016)
  })

  test('the plan can be changed: sizes, ratio, colours and quantity', async () => {
    const { mfr, brand } = await world()
    const b = await start(mfr, await styleOrder(mfr, brand))
    const r = await save(mfr, b.id, { plan: { sizes: ['M', 'L'], ratio: [1, 1], colours: [{ name: 'RED', qty: 600 }, { name: 'BLUE', qty: 400 }], totalQty: 1000 }, lines: [zipLine({ perSize: [1, 2] })] })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual(r.body.plan.sizes, ['M', 'L'])
    assert.equal(r.body.lines[0].perSize.length, 2)
    assert.equal(r.body.lines[0].computed.orderQty, Math.ceil((500 * 1 + 500 * 2) * 1.02))
  })

  test('says so when the sizes or colours do not add up', async () => {
    const { mfr, brand } = await world()
    const b = await start(mfr, await styleOrder(mfr, brand))
    const r = await save(mfr, b.id, { plan: { sizes: ['M', 'L'], ratio: [1, 1], colours: [{ name: 'RED', qty: 1000 }, { name: 'BLUE', qty: 501 }], totalQty: 1600 }, lines: [fleeceLine({ perSize: [] })] })
    assert.deepEqual(r.body.warnings.map(w => w.code).sort(), ['colour_total', 'size_rounding'])
  })

  test('refuses what cannot be a plan or a line', async () => {
    const { mfr, brand } = await world()
    const b = await start(mfr, await styleOrder(mfr, brand))
    const bad = async body => (await save(mfr, b.id, body)).status
    assert.equal(await bad({ plan: { sizes: [] } }), 400)
    assert.equal(await bad({ plan: { sizes: ['S', 's'] } }), 400)
    assert.equal(await bad({ plan: { sizes: ['S', 'M'], ratio: [1] } }), 400)
    assert.equal(await bad({ plan: { sizes: ['S', 'M'], ratio: [0, 0] } }), 400)
    assert.equal(await bad({ plan: { colours: [{ name: '', qty: 5 }] } }), 400)
    assert.equal(await bad({ plan: { colours: [{ name: 'A', qty: 1 }, { name: 'a', qty: 1 }] } }), 400)
    assert.equal(await bad({ plan: { totalQty: -1 } }), 400)
    assert.equal(await bad({ lines: [{ item: 'x' }] }), 400)                                    // no section
    assert.equal(await bad({ lines: [{ section: 'trims' }] }), 400)                             // no name
    assert.equal(await bad({ lines: [zipLine({ wastagePct: 120 })] }), 400)
    assert.equal(await bad({ lines: [zipLine({ rate: -1 })] }), 400)
    assert.equal(await bad({ lines: [zipLine({ consumption: 'many' })] }), 400)
    assert.equal(await bad({ lines: [zipLine({ supplierId: 'not-an-id' })] }), 400)
    assert.equal(await bad({ lines: 'nope' }), 400)
    assert.equal(await bad({ lines: Array.from({ length: 201 }, () => zipLine()) }), 400)
  })

  test('a fabric line is per colour unless it says otherwise, a trim is not', async () => {
    const { mfr, brand } = await world()
    const b = await start(mfr, await styleOrder(mfr, brand))
    const r = await save(mfr, b.id, { lines: [{ section: 'fabric', item: 'Jersey', consumption: 1 }, { section: 'trims', item: 'Zip', consumption: 1 }, { section: 'trims', item: 'Dyed zip', consumption: 1, perColour: true }] })
    assert.deepEqual(r.body.lines.map(l => l.perColour), [true, false, true])
  })

  test('line ids stay put through an edit, and a repeated one is made new', async () => {
    const { mfr, brand } = await world()
    const b = await start(mfr, await styleOrder(mfr, brand))
    const first = (await save(mfr, b.id, { lines: [zipLine()] })).body
    const id = first.lines[0].lineId
    const again = (await save(mfr, b.id, { lines: [{ ...first.lines[0], rate: 50 }, { ...zipLine(), lineId: id }] })).body
    assert.equal(again.lines[0].lineId, id)
    assert.notEqual(again.lines[1].lineId, id)
  })

  test('two people editing at once: the second to save is told to reload', async () => {
    const { mfr, brand } = await world()
    const b = await start(mfr, await styleOrder(mfr, brand))
    const mine = (await save(mfr, b.id, { lines: [zipLine()] })).body
    const theirs = await save(mfr, b.id, { updatedAt: b.updatedAt, lines: [zipLine({ item: 'Other' })] })
    assert.equal(theirs.status, 409)
    assert.equal(theirs.body.code, 'STALE')
    assert.equal((await save(mfr, b.id, { updatedAt: mine.updatedAt, lines: [zipLine({ item: 'Mine again' })] })).status, 200)
  })
})

describe('a size and colour grid', () => {
  const GRID = { sizes: ['S', 'M', 'L', 'XL', 'XXL'], ratio: [1, 2, 3, 2, 1], colours: [{ name: 'BLACK', sizes: [100, 300, 500, 300, 100] }, { name: 'NAVY', sizes: [50, 150, 250, 150, 50] }], totalQty: 1950 }

  test('is kept as the person gave it, each colour\'s pieces are its sizes added up, and the lines are worked from it', async () => {
    const { mfr, brand } = await world()
    const b = await start(mfr, await styleOrder(mfr, brand))
    const r = await save(mfr, b.id, { plan: { ...GRID, colours: GRID.colours.map(c => ({ ...c, qty: 1 })) }, lines: [fleeceLine()] })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual(r.body.plan.colours, [{ name: 'BLACK', qty: 1300, sizes: [100, 300, 500, 300, 100] }, { name: 'NAVY', qty: 650, sizes: [50, 150, 250, 150, 50] }])
    assert.deepEqual(r.body.lines[0].computed.perColour.map(c => c.orderQty), [1004, 502])
    assert.deepEqual(r.body.warnings, [])
    const again = (await as(mfr).get(`/api/boms/${b.id}`)).body
    assert.deepEqual(again.plan.colours[0].sizes, [100, 300, 500, 300, 100])
  })

  test('has to give every size, and whole numbers from zero up', async () => {
    const { mfr, brand } = await world()
    const b = await start(mfr, await styleOrder(mfr, brand))
    const short = await save(mfr, b.id, { plan: { ...GRID, colours: [{ name: 'BLACK', sizes: [100, 300] }] } })
    assert.equal(short.status, 400)
    assert.match(short.body.error, /BLACK: give the pieces for each of the 5 sizes/)
    const negative = await save(mfr, b.id, { plan: { ...GRID, colours: [{ name: 'BLACK', sizes: [100, -1, 5, 5, 5] }] } })
    assert.equal(negative.status, 400)
    assert.match(negative.body.error, /pieces of a size must be numbers from 0 up/)
    const text = await save(mfr, b.id, { plan: { ...GRID, colours: [{ name: 'BLACK', sizes: [100, 'many', 5, 5, 5] }] } })
    assert.equal(text.status, 400)
  })

  test('a colour can still be given as a total, beside one given as a grid', async () => {
    const { mfr, brand } = await world()
    const b = await start(mfr, await styleOrder(mfr, brand))
    const r = await save(mfr, b.id, { plan: { ...GRID, colours: [GRID.colours[0], { name: 'NAVY', qty: 630 }], totalQty: 1930 }, lines: [fleeceLine()] })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.plan.colours[1].sizes, undefined)
    assert.deepEqual(r.body.lines[0].computed.perColour[1].sizePcs, [70, 140, 210, 140, 70])    // split by the ratio
    assert.deepEqual(r.body.warnings, [])
  })

  test('changing the sizes without sending the colours again drops a grid that no longer lines up, and keeps the totals', async () => {
    const { mfr, brand } = await world()
    const b = await start(mfr, await styleOrder(mfr, brand))
    await save(mfr, b.id, { plan: GRID })
    const r = await save(mfr, b.id, { plan: { sizes: ['M', 'L'], ratio: [1, 1] } })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual(r.body.plan.colours.map(c => [c.name, c.qty, c.sizes]), [['BLACK', 1300, undefined], ['NAVY', 650, undefined]])
  })

  test('a new version keeps it, and the shopping list buys from it', async () => {
    const { mfr, brand } = await world()
    const mill = await supplier(mfr)
    const orderId = await styleOrder(mfr, brand)
    const b = await start(mfr, orderId)
    assert.equal((await save(mfr, b.id, { plan: GRID, lines: [fleeceLine({ supplierId: mill.id })] })).status, 200)
    const frozen = (await as(mfr).post(`/api/boms/${b.id}/freeze`)).body
    assert.deepEqual(frozen.plan.colours[0].sizes, [100, 300, 500, 300, 100])
    const aggregate = (await as(mfr).get('/api/boms/aggregate')).body
    assert.deepEqual(aggregate.rows.filter(r => r.item.includes('Polar fleece')).map(r => [r.colour, r.required]).sort(), [['BLACK', 1004], ['NAVY', 502]])
    const revised = (await as(mfr).post(`/api/boms/${frozen.id}/revise`)).body
    assert.deepEqual(revised.plan.colours.map(c => c.sizes), [[100, 300, 500, 300, 100], [50, 150, 250, 150, 50]])
  })
})

describe('suppliers on the lines', () => {
  test('only the company\'s own suppliers and catalog items', async () => {
    const { mfr, brand } = await world()
    const b = await start(mfr, await styleOrder(mfr, brand))
    const other = await makeMfr({ code: 'OTH' })
    await setOrg(other, { profile: { stateCode: '33' } })
    const theirs = await supplier(other)
    const theirItem = await item(other, theirs)
    assert.equal((await save(mfr, b.id, { lines: [zipLine({ supplierId: theirs.id })] })).status, 400)
    assert.equal((await save(mfr, b.id, { lines: [zipLine({ itemId: theirItem.id })] })).status, 400)
  })

  test('choosing a catalog item chooses its supplier, and the two must agree', async () => {
    const { mfr, brand } = await world()
    const b = await start(mfr, await styleOrder(mfr, brand))
    const mill = await supplier(mfr), rib = await supplier(mfr, { name: 'Erode Rib', email: 'rib@erode.test' })
    const fleece = await item(mfr, mill)
    const r = await save(mfr, b.id, { lines: [fleeceLine({ itemId: fleece.id })] })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.lines[0].supplierId, mill.id)
    assert.equal(r.body.lines[0].supplierName, 'Coimbatore Knit Fabrics')
    assert.equal((await save(mfr, b.id, { lines: [fleeceLine({ itemId: fleece.id, supplierId: rib.id })] })).status, 400)
  })
})

describe('AI lines that need a look', () => {
  async function withAiLine(mfr, brand) {
    const b = await start(mfr, await styleOrder(mfr, brand))
    const saved = (await save(mfr, b.id, { lines: [zipLine()] })).body
    await Bom.updateOne({ _id: b.id }, { $set: { 'lines.0.source': 'ai', 'lines.0.needsReview': true, 'lines.0.confidence': 0.6 } })
    return { id: b.id, lineId: saved.lines[0].lineId }
  }

  test('stay flagged when saved unchanged, and are cleared by an edit', async () => {
    const { mfr, brand } = await world()
    const { id } = await withAiLine(mfr, brand)
    const flagged = (await as(mfr).get(`/api/boms/${id}`)).body
    assert.equal(flagged.lines[0].needsReview, true)
    assert.equal((await save(mfr, id, { lines: flagged.lines })).body.lines[0].needsReview, true)
    const edited = (await save(mfr, id, { lines: [{ ...flagged.lines[0], consumption: 2 }] })).body
    assert.equal(edited.lines[0].needsReview, false)
    assert.equal(edited.lines[0].source, 'ai')
  })

  test('cannot be claimed or cleared from the browser by saying so', async () => {
    const { mfr, brand } = await world()
    const { id } = await withAiLine(mfr, brand)
    const flagged = (await as(mfr).get(`/api/boms/${id}`)).body
    const r = (await save(mfr, id, { lines: [{ ...flagged.lines[0], needsReview: false, source: 'manual', confidence: 1 }] })).body
    assert.equal(r.lines[0].needsReview, true)
    assert.equal(r.lines[0].source, 'ai')
  })

  test('one line can be confirmed as it is ("looks right"), the others stay flagged', async () => {
    const { mfr, brand } = await world()
    const b = await start(mfr, await styleOrder(mfr, brand))
    await save(mfr, b.id, { lines: [zipLine(), zipLine({ item: 'Toggle' })] })
    await Bom.updateOne({ _id: b.id }, { $set: { 'lines.0.source': 'ai', 'lines.0.needsReview': true, 'lines.1.source': 'ai', 'lines.1.needsReview': true } })
    const flagged = (await as(mfr).get(`/api/boms/${b.id}`)).body
    const r = await save(mfr, b.id, { lines: [{ ...flagged.lines[0], confirmed: true }, flagged.lines[1]] })
    assert.deepEqual(r.body.lines.map(l => l.needsReview), [false, true])
  })

  test('block freezing until confirmed, and "confirm all" clears them', async () => {
    const { mfr, brand } = await world()
    const { id } = await withAiLine(mfr, brand)
    const blocked = await as(mfr).post(`/api/boms/${id}/freeze`)
    assert.equal(blocked.status, 409)
    assert.equal(blocked.body.code, 'NEEDS_REVIEW')
    const flagged = (await as(mfr).get(`/api/boms/${id}`)).body
    assert.equal((await save(mfr, id, { lines: flagged.lines, confirmAll: true })).body.lines[0].needsReview, false)
    assert.equal((await as(mfr).post(`/api/boms/${id}/freeze`)).status, 200)
  })
})

describe('freezing and revising', () => {
  test('an empty one cannot be frozen', async () => {
    const { mfr, brand } = await world()
    const b = await start(mfr, await styleOrder(mfr, brand))
    assert.equal((await as(mfr).post(`/api/boms/${b.id}/freeze`)).status, 409)
  })

  test('a frozen one is the record: not editable, not deletable, not frozen twice', async () => {
    const { mfr, brand } = await world()
    const f = await frozenBom(mfr, await styleOrder(mfr, brand), [fleeceLine()])
    assert.equal(f.status, 'frozen')
    assert.ok(f.frozenAt)
    assert.equal((await save(mfr, f.id, { lines: [zipLine()] })).status, 409)
    assert.equal((await as(mfr).post(`/api/boms/${f.id}/delete`)).status, 409)
    assert.equal((await as(mfr).post(`/api/boms/${f.id}/freeze`)).status, 409)
  })

  test('revising makes version 2 as a draft with the same line ids; only one draft at a time', async () => {
    const { mfr, brand } = await world()
    const f = await frozenBom(mfr, await styleOrder(mfr, brand), [fleeceLine(), zipLine()])
    const r = await as(mfr).post(`/api/boms/${f.id}/revise`)
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.equal(r.body.version, 2)
    assert.equal(r.body.status, 'draft')
    assert.deepEqual(r.body.lines.map(l => l.lineId), f.lines.map(l => l.lineId))
    assert.equal((await as(mfr).post(`/api/boms/${f.id}/revise`)).status, 409)
    assert.equal((await save(mfr, r.body.id, { lines: [fleeceLine({ rate: 450 })] })).status, 200)
  })

  test('a draft can be thrown away, and the order can start again', async () => {
    const { mfr, brand } = await world()
    const orderId = await styleOrder(mfr, brand)
    const b = await start(mfr, orderId)
    assert.equal((await as(mfr).post(`/api/boms/${b.id}/delete`)).status, 200)
    assert.equal((await as(mfr).get(`/api/boms/${b.id}`)).status, 404)
    assert.equal((await as(mfr).post('/api/boms', { orderId })).status, 201)
  })
})

describe('the shopping list across orders', () => {
  /** Two styles of one master order, both frozen, buying the same fleece from one mill. */
  async function twoStyles() {
    const { mfr, brand } = await world()
    const mo = await makeMasterOrder({ buyerId: brand._id, createdBy: brand._id, id: 'MO-FIT-FW26-001' })
    const mill = await supplier(mfr), zips = await supplier(mfr, { name: 'YKK India', email: 'ykk@test.in' })
    const fleece = await item(mfr, mill), zip = await item(mfr, zips, { name: 'YKK zip 5', unit: 'pcs', defaultRate: 45, moq: 1000, hsnCode: '960719', taxPct: 18 })
    const a = await styleOrder(mfr, brand, { id: 'FIT-5117', masterOrderId: mo._id })
    const b = await styleOrder(mfr, brand, { id: 'FIT-5118', masterOrderId: mo._id, totalQty: 18000 })
    const fa = await frozenBom(mfr, a, [fleeceLine({ itemId: fleece.id, supplierId: mill.id }), zipLine({ itemId: zip.id, supplierId: zips.id }), { section: 'labels_packaging', item: 'Main label', consumption: 1, rate: 1.5 }])
    const fb = await frozenBom(mfr, b, [fleeceLine({ itemId: fleece.id, supplierId: mill.id }), zipLine({ itemId: zip.id, supplierId: zips.id })])
    return { mfr, brand, mo, mill, zips, fa, fb }
  }
  const rowOf = (rows, text, colour = '') => rows.find(r => r.item.includes(text) && r.colour === colour)

  test('adds the same thing across styles, per colour for cloth, and says who is short of a supplier', async () => {
    const { mfr, mo } = await twoStyles()
    const r = await as(mfr).get(`/api/boms/aggregate?masterOrderId=${mo._id}`)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.orders, 2)
    const black = rowOf(r.body.rows, 'Polar fleece', 'BLACK')
    assert.equal(black.required, 2783 + 4639)                          // 5117 and 5118 sheets
    assert.equal(black.sources.length, 2)
    assert.equal(rowOf(r.body.rows, 'Polar fleece', 'NAVY').required, 7422)
    const zip = rowOf(r.body.rows, 'YKK zip')
    assert.equal(zip.required, 11016 + 18360)                          // each style's pieces plus 2%
    assert.equal(zip.supplierName, 'YKK India')
    assert.equal(zip.moq, 1000)
    assert.equal(r.body.unsupplied, 1)                                  // the label has no supplier
    assert.equal(rowOf(r.body.rows, 'Main label').supplierId, null)
  })

  test('uses only frozen BOMs, the latest version of each, and only the factory\'s own orders', async () => {
    const { mfr, brand, fa } = await twoStyles()
    const draftOnly = await styleOrder(mfr, brand, { id: 'FIT-DRAFT' })
    await save(mfr, (await start(mfr, draftOnly)).id, { lines: [zipLine({ item: 'Draft only zip' })] })
    const rev = (await as(mfr).post(`/api/boms/${fa.id}/revise`)).body
    await save(mfr, rev.id, { lines: [zipLine({ item: 'Revised zip' })] })
    await as(mfr).post(`/api/boms/${rev.id}/freeze`)
    const stranger = await makeMfr({ code: 'OTH' })
    await makeOrder({ id: 'THEIRS', buyer: brand, mfrs: [stranger] })
    const rows = (await as(mfr).get('/api/boms/aggregate')).body.rows
    assert.ok(rows.find(r => r.item === 'Revised zip'), 'the newer frozen version is used')
    assert.ok(!rows.find(r => r.item === 'Draft only zip'), 'a draft is not a shopping list')
    assert.ok(!rows.find(r => r.sources.some(s => s.orderId === 'THEIRS')))
  })

  test('turns into one draft PO per supplier, with the rates and tax from the catalog', async () => {
    const { mfr, mo, mill, zips } = await twoStyles()
    const r = await as(mfr).post('/api/boms/generate-pos', { masterOrderId: mo._id })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.equal(r.body.created.length, 2)
    assert.deepEqual(r.body.created.map(c => c.supplierName).sort(), ['Coimbatore Knit Fabrics', 'YKK India'])
    assert.equal(r.body.skipped.length, 1)
    assert.match(r.body.skipped[0].reason, /No supplier/)
    const fleecePo = await PurchaseOrder.findById(r.body.created.find(c => c.supplierName === 'Coimbatore Knit Fabrics').id).lean()
    assert.equal(fleecePo.status, 'draft')
    assert.equal(fleecePo.lines.length, 3)                              // one per colour
    const black = fleecePo.lines.find(l => l.description.endsWith('- BLACK'))
    assert.equal(black.qty, 7422)
    assert.equal(black.rate, 410)
    assert.equal(black.hsnCode, '600610')
    assert.deepEqual(black.bomRefs.map(x => [x.orderId, x.qty]).sort(), [['FIT-5117', 2783], ['FIT-5118', 4639]])
    const zipPo = await PurchaseOrder.findById(r.body.created.find(c => c.supplierName === 'YKK India').id).lean()
    assert.equal(zipPo.lines[0].taxPct, 18)
    assert.equal(String(zipPo.supplierId), zips.id)
    assert.notEqual(String(zipPo.supplierId), mill.id)
  })

  test('the same shopping list is not ordered twice, and cancelling a PO gives the need back', async () => {
    const { mfr, mo } = await twoStyles()
    const first = await as(mfr).post('/api/boms/generate-pos', { masterOrderId: mo._id })
    const again = await as(mfr).post('/api/boms/generate-pos', { masterOrderId: mo._id })
    assert.equal(again.status, 200)
    assert.equal(again.body.created.length, 0)
    assert.ok(again.body.skipped.some(s => /Already on a purchase order/.test(s.reason)))
    const list = (await as(mfr).get(`/api/boms/aggregate?masterOrderId=${mo._id}`)).body
    assert.equal(rowOf(list.rows, 'Polar fleece', 'BLACK').remaining, 0)
    assert.equal(rowOf(list.rows, 'Polar fleece', 'BLACK').onPo, 7422)
    const cancel = await as(mfr).post(`/api/purchase-orders/${first.body.created[0].id}/cancel`, { reason: 'wrong mill' })
    assert.equal(cancel.status, 200, JSON.stringify(cancel.body))
    const back = await as(mfr).post('/api/boms/generate-pos', { masterOrderId: mo._id })
    assert.equal(back.body.created.length, 1)
  })

  test('a line with a supplier but no catalog tie is matched by name, so the rate, HSN, GST and minimum still apply', async () => {
    const { mfr, brand } = await world()
    const zips = await supplier(mfr, { name: 'YKK India', email: 'ykk@test.in' })
    await item(mfr, zips, { name: 'YKK zip 5', unit: 'pcs', defaultRate: 45, moq: 50000, hsnCode: '960719', taxPct: 18 })
    const orderId = await styleOrder(mfr, brand)
    await frozenBom(mfr, orderId, [{ section: 'trims', item: ' ykk ZIP 5 ', unit: 'pcs', consumption: 1, supplierId: zips.id }])
    const row = (await as(mfr).get('/api/boms/aggregate')).body.rows[0]
    assert.equal(row.rate, 45)                                   // the BOM had no rate: the catalog's
    assert.equal(row.moq, 50000)
    assert.equal(row.belowMoq, true)
    const made = await as(mfr).post('/api/boms/generate-pos', {})
    const po = await PurchaseOrder.findById(made.body.created[0].id).lean()
    assert.deepEqual([po.lines[0].taxPct, po.lines[0].hsnCode, po.lines[0].rate], [18, '960719', 45])
    assert.ok(po.lines[0].itemId)
    assert.equal(made.body.created[0].warnings[0].code, 'BELOW_MOQ')
  })

  test('only the rows asked for are ordered', async () => {
    const { mfr, mo } = await twoStyles()
    const list = (await as(mfr).get(`/api/boms/aggregate?masterOrderId=${mo._id}`)).body
    const zip = rowOf(list.rows, 'YKK zip')
    const r = await as(mfr).post('/api/boms/generate-pos', { masterOrderId: mo._id, keys: [zip.key] })
    assert.equal(r.body.created.length, 1)
    assert.equal(r.body.created[0].supplierName, 'YKK India')
  })

  test('a browser cannot put bill of materials links on a PO, but an edit keeps the ones it has', async () => {
    const { mfr, mo, mill } = await twoStyles()
    const made = await as(mfr).post('/api/boms/generate-pos', { masterOrderId: mo._id })
    const poId = made.body.created.find(c => c.supplierName === 'Coimbatore Knit Fabrics').id
    const po = (await as(mfr).get(`/api/purchase-orders/${poId}`)).body
    assert.ok(po.lines[0].bomRefs.length > 0)
    const edited = await as(mfr).post(`/api/purchase-orders/${poId}`, { lines: po.lines.map(l => ({ ...l, qty: l.qty + 1 })) })
    assert.equal(edited.status, 200, JSON.stringify(edited.body))
    assert.equal(edited.body.lines[0].bomRefs.length, po.lines[0].bomRefs.length)
    const fresh = await as(mfr).post('/api/purchase-orders', {
      supplierId: mill.id, lines: [{ description: 'Sneaky', qty: 10, rate: 1, unit: 'kg', bomRefs: [{ bomId: '0123456789abcdef01234567', orderId: 'FIT-5117', lineId: 'abc', colour: '', qty: 10 }] }],
    })
    assert.equal(fresh.status, 201, JSON.stringify(fresh.body))
    assert.deepEqual(fresh.body.lines[0].bomRefs, [])
  })
})

describe('the shopping list and the store', () => {
  /** Receive `qty` of something into the factory's store, as a posted goods received note. */
  async function receive(u, description, unit, qty) {
    const g = (await as(u).post('/api/grns', { supplierName: 'Local', lines: [{ description, unit, qty }] })).body
    assert.equal((await as(u).post(`/api/grns/${g.id}/post`)).status, 200)
  }
  async function frozenFleece(mfr, brand, { id = 'FIT-5117', totalQty = 10800, supplierId = null } = {}) {
    const orderId = await styleOrder(mfr, brand, { id, totalQty })
    return frozenBom(mfr, orderId, [fleeceLine({ ...(supplierId ? { supplierId } : {}) })])
  }
  const rowOf = (rows, colour) => rows.find(r => r.item.includes('Polar fleece') && r.colour === colour)

  test('each row says how much of it is already in the store, and what is left to buy', async () => {
    const { mfr, brand } = await world()
    await frozenFleece(mfr, brand)
    await receive(mfr, 'Polar fleece 300 GSM - BLACK', 'kg', 1000)
    const rows = (await as(mfr).get('/api/boms/aggregate')).body.rows
    const black = rowOf(rows, 'BLACK')
    assert.deepEqual([black.remaining, black.inStock, black.fromStock, black.toBuy], [2783, 1000, 1000, 1783])
    assert.ok(black.stockItemId)
    const navy = rowOf(rows, 'NAVY')                                                  // nothing of it in the store
    assert.deepEqual([navy.inStock, navy.fromStock, navy.toBuy, navy.stockItemId], [0, 0, 2783, null])
  })

  test('a stock item is counted once, however many rows are that item', async () => {
    const { mfr, brand } = await world()
    const a = await supplier(mfr), b = await supplier(mfr, { name: 'Salem Knits', email: 'sales@salem.test' })
    await frozenFleece(mfr, brand, { id: 'FIT-5117', supplierId: a.id })
    await frozenFleece(mfr, brand, { id: 'FIT-5118', totalQty: 18000, supplierId: b.id })        // the same cloth from another mill: a second row
    await receive(mfr, 'Polar fleece 300 GSM - BLACK', 'kg', 3000)
    const rows = (await as(mfr).get('/api/boms/aggregate')).body.rows.filter(r => r.colour === 'BLACK')
    assert.equal(rows.length, 2)
    assert.equal(rows.reduce((t, r) => t + r.fromStock, 0), 3000)                          // not 6000
    assert.ok(rows.every(r => r.inStock === 3000))
    assert.equal(rows.reduce((t, r) => t + r.toBuy, 0), rows.reduce((t, r) => t + r.remaining, 0) - 3000)
  })

  test('only the company\'s own store is counted', async () => {
    const { mfr, brand } = await world()
    await frozenFleece(mfr, brand)
    const rival = await makeMfr({ code: 'RVL' })
    await receive(rival, 'Polar fleece 300 GSM - BLACK', 'kg', 9999)
    assert.equal(rowOf((await as(mfr).get('/api/boms/aggregate')).body.rows, 'BLACK').inStock, 0)
  })

  test('draft POs buy the full quantity unless the person chooses to take the store\'s stock off', async () => {
    const { mfr, brand } = await world()
    const mill = await supplier(mfr)
    await frozenFleece(mfr, brand, { supplierId: mill.id })
    await receive(mfr, 'Polar fleece 300 GSM - BLACK', 'kg', 1000)
    const full = await as(mfr).post('/api/boms/generate-pos', { keys: [rowOf((await as(mfr).get('/api/boms/aggregate')).body.rows, 'BLACK').key] })
    assert.equal(full.status, 201, JSON.stringify(full.body))
    const poFull = (await as(mfr).get(`/api/purchase-orders/${full.body.created[0].id}`)).body
    assert.equal(poFull.lines[0].qty, 2783)
    await as(mfr).post(`/api/purchase-orders/${poFull.id}/cancel`, { reason: 'try again' })

    const keys = (await as(mfr).get('/api/boms/aggregate')).body.rows.map(r => r.key)
    const net = await as(mfr).post('/api/boms/generate-pos', { keys, netOfStock: true })
    assert.equal(net.status, 201, JSON.stringify(net.body))
    const po = (await as(mfr).get(`/api/purchase-orders/${net.body.created[0].id}`)).body
    assert.deepEqual(po.lines.map(l => [l.description, l.qty]).sort(), [['Polar fleece 300 GSM - BLACK', 1783], ['Polar fleece 300 GSM - CHARCOAL GREY', 2783], ['Polar fleece 300 GSM - NAVY', 2783]])
    // The need still counts as handled: the PO and the stock are what it asked for.
    assert.equal(po.lines.find(l => l.description.includes('BLACK')).bomRefs[0].qty, 2783)
  })

  test('a row the store covers completely is left out, and says why', async () => {
    const { mfr, brand } = await world()
    const mill = await supplier(mfr)
    await frozenFleece(mfr, brand, { supplierId: mill.id })
    await receive(mfr, 'Polar fleece 300 GSM - BLACK', 'kg', 5000)
    const r = await as(mfr).post('/api/boms/generate-pos', { keys: [rowOf((await as(mfr).get('/api/boms/aggregate')).body.rows, 'BLACK').key], netOfStock: true })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual(r.body.created, [])
    assert.deepEqual(r.body.skipped.map(x => x.reason), ['Covered by what is in your store'])
    assert.equal(await PurchaseOrder.countDocuments({}), 0)
  })
})

describe('no company can reach another\'s bills of materials', () => {
  test('every route says "not found" to another factory, and changes nothing', async () => {
    const { mfr, brand } = await world()
    const orderId = await styleOrder(mfr, brand)
    const mine = await start(mfr, orderId)
    await save(mfr, mine.id, { lines: [fleeceLine()] })
    const other = await makeMfr({ code: 'OTH' })
    await setOrg(other, { profile: { stateCode: '33' } })
    const o = as(other)
    assert.equal((await o.get(`/api/boms?orderId=${orderId}`)).status, 404)
    assert.equal((await o.post('/api/boms', { orderId })).status, 404)
    assert.equal((await o.get(`/api/boms/${mine.id}`)).status, 404)
    assert.equal((await o.post(`/api/boms/${mine.id}`, { lines: [] })).status, 404)
    assert.equal((await o.post(`/api/boms/${mine.id}/freeze`)).status, 404)
    assert.equal((await o.post(`/api/boms/${mine.id}/revise`)).status, 404)
    assert.equal((await o.post(`/api/boms/${mine.id}/delete`)).status, 404)
    assert.equal((await o.get('/api/boms/aggregate')).body.rows.length, 0)
    assert.equal((await o.post('/api/boms/generate-pos', {})).body.created.length, 0)
    assert.equal((await Bom.findById(mine.id).lean()).lines.length, 1)
  })

  test('a malformed id is just not found', async () => {
    const { mfr } = await world()
    assert.equal((await as(mfr).get('/api/boms/not-an-id')).status, 404)
    assert.equal((await as(mfr).post('/api/boms/not-an-id/freeze')).status, 404)
  })
})
