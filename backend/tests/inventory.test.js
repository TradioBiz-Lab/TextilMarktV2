// Stock and goods received notes end to end: items and balances, receiving against a purchase order (and
// without one), what posting does and that it is safe to repeat, photos as evidence, issuing stock to orders
// and correcting it after a count.
import test, { before, after, beforeEach, afterEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as, req } from './helpers/client.js'
import { makeAdmin, makeMaster, makeBuyer, makeMfr, makeOrder, setOrg, link } from './helpers/factories.js'
import { Supplier } from '../src/models/Supplier.js'
import { SupplierItem } from '../src/models/SupplierItem.js'
import { PurchaseOrder } from '../src/models/PurchaseOrder.js'
import { Document } from '../src/models/Document.js'
import { Order } from '../src/models/Order.js'
import { InventoryItem } from '../src/models/InventoryItem.js'
import { StockLedger } from '../src/models/StockLedger.js'
import { Grn } from '../src/models/Grn.js'
import { StockIssue } from '../src/models/StockIssue.js'
import { Attachment } from '../src/models/Attachment.js'
import { gstinCheckChar } from '../src/lib/gst.js'
import { fiscalYearCode } from '../src/lib/fiscalYear.js'
import { setMailerForTests } from '../src/lib/email.js'
import { itemKey, guessCategory, balances, takeStock } from '../src/lib/inventory/stock.js'

before(async () => {
  await startTestDb(); await startServer()
  for (const m of [Supplier, SupplierItem, InventoryItem, StockLedger, Grn, StockIssue]) await m.init()
})
after(async () => { delete process.env.PLATFORM_MODE; setMailerForTests(null); await stopServer(); await stopTestDb() })
beforeEach(async () => {
  await clearDb(); process.env.PLATFORM_MODE = 'standalone'; delete process.env.ENABLE_VIEW_AS
  setMailerForTests({ emails: { send: async () => ({ data: { id: 'em_1' }, error: null }) } })
})
afterEach(() => setMailerForTests(null))

const gstinFor = (state, pan = 'AAPFU0939F') => { const f = `${state}${pan}1Z`; return f + gstinCheckChar(f) }
const FY = () => fiscalYearCode()
// Enough of a JPEG for the type check: the three signature bytes.
const PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2Q=='

async function factory({ code = 'TPR' } = {}) {
  const mfr = await makeMfr({ code, company: `${code} Textiles`, email: `${code.toLowerCase()}@mfr.test` })
  await setOrg(mfr, { profile: { legalName: `${code} Textiles Pvt Ltd`, gstin: gstinFor('33'), stateCode: '33', address: 'Plot 22', city: 'Tiruppur', pincode: '641604' } })
  return mfr
}
const supplier = async (u, body = {}) => (await as(u).post('/api/suppliers', { name: 'Coimbatore Knit Fabrics', type: 'fabric_supplier', email: 'sales@cknit.test', gstin: gstinFor('33'), ...body })).body
const poLine = (extra = {}) => ({ description: 'Polar fleece 300 GSM, 150 cm - BLACK', qty: 100, unit: 'kg', rate: 410, taxPct: 5, hsnCode: '600610', ...extra })
const sentPo = async (u, s, lines = [poLine()]) => {
  const d = (await as(u).post('/api/purchase-orders', { supplierId: s.id, lines })).body
  const r = await as(u).post(`/api/purchase-orders/${d.id}/send`, {})
  assert.equal(r.status, 200, JSON.stringify(r.body))
  return r.body
}
const po = id => PurchaseOrder.findById(id).lean()
const startGrn = (u, body = {}) => as(u).post('/api/grns', body)
const post = (u, id) => as(u).post(`/api/grns/${id}/post`)
const stockOf = async (u, name) => (await as(u).get('/api/inventory/items')).body.find(i => i.name.includes(name))
const ledgerRows = filter => StockLedger.find(filter).lean()

describe('who can use stock and goods received notes', () => {
  test('the Tradio portal does not have them', async () => {
    delete process.env.PLATFORM_MODE
    const mfr = await factory()
    assert.equal((await as(mfr).get('/api/inventory/items')).status, 404)
    assert.equal((await as(mfr).get('/api/grns')).status, 404)
  })

  test('brands and Tradio staff are refused, and so is someone not signed in', async () => {
    const brand = await makeBuyer()
    for (const u of [brand, await makeAdmin(), await makeMaster()]) {
      assert.equal((await as(u).get('/api/inventory/items')).status, 403, u.role)
      assert.equal((await as(u).get('/api/grns')).status, 403, u.role)
      assert.equal((await as(u).post('/api/inventory/issues', {})).status, 403, u.role)
    }
    assert.equal((await req('GET', '/api/grns')).status, 401)
  })
})

describe('the stock list', () => {
  test('items are added, found, changed and archived; the same name and unit is one item', async () => {
    const mfr = await factory()
    const made = await as(mfr).post('/api/inventory/items', { name: 'YKK zip 5, DTM black', unit: 'pcs', category: 'trims', reorderLevel: 500, hsnCode: '960719' })
    assert.equal(made.status, 201, JSON.stringify(made.body))
    assert.deepEqual([made.body.onHand, made.body.low, made.body.isActive], [0, true, true])      // nothing in stock, below the level it must keep
    const again = await as(mfr).post('/api/inventory/items', { name: '  ykk ZIP 5,  dtm black ', unit: 'PCS' })
    assert.equal(again.status, 409)
    assert.equal(again.body.itemId, made.body.id)
    assert.equal((await as(mfr).post('/api/inventory/items', { name: '', unit: 'kg' })).status, 400)
    assert.equal((await as(mfr).post('/api/inventory/items', { name: 'X', category: 'nonsense' })).status, 400)

    const edited = await as(mfr).post(`/api/inventory/items/${made.body.id}`, { reorderLevel: 0, notes: 'DTM = dyed to match' })
    assert.deepEqual([edited.body.reorderLevel, edited.body.low, edited.body.notes], [0, false, 'DTM = dyed to match'])
    assert.equal((await as(mfr).get('/api/inventory/items?q=zip')).body.length, 1)
    assert.equal((await as(mfr).get('/api/inventory/items?category=fabric')).body.length, 0)

    await as(mfr).post(`/api/inventory/items/${made.body.id}/archive`)
    assert.equal((await as(mfr).get('/api/inventory/items')).body.length, 0)
    assert.equal((await as(mfr).get('/api/inventory/items?archived=1')).body.length, 1)
    await as(mfr).post(`/api/inventory/items/${made.body.id}/restore`)
    assert.equal((await as(mfr).get('/api/inventory/items')).body.length, 1)
  })

  test('the key and the category guess work the way a challan is written', () => {
    assert.equal(itemKey('Polar Fleece  300 GSM', ' KG '), itemKey('polar fleece 300 gsm', 'kg'))
    assert.notEqual(itemKey('Polar fleece', 'kg'), itemKey('Polar fleece', 'm'))
    assert.equal(guessCategory('YKK zip 5', 'pcs'), 'trims')
    assert.equal(guessCategory('Single jersey 180 GSM', 'kg'), 'fabric')
    assert.equal(guessCategory('Main label', 'pcs'), 'packaging')
    assert.equal(guessCategory('Cotton yarn 30s', 'kg'), 'yarn')
    assert.equal(guessCategory('Something', 'm'), 'fabric')
    assert.equal(guessCategory('Something', 'pcs'), 'other')
  })
})

describe('receiving against a purchase order', () => {
  test('a note starts with what the PO is still waiting for, and changes nothing until it is posted', async () => {
    const mfr = await factory(), s = await supplier(mfr)
    const p = await sentPo(mfr, s, [poLine(), poLine({ description: 'Brushed fleece 280 GSM - NAVY', qty: 50 })])
    const r = await startGrn(mfr, { poId: p.id })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.deepEqual([r.body.status, r.body.number, r.body.supplierName, r.body.poId], ['draft', null, 'Coimbatore Knit Fabrics', p.id])
    assert.deepEqual(r.body.lines.map(l => [l.description, l.orderedQty, l.qty]), [['Polar fleece 300 GSM, 150 cm - BLACK', 100, 100], ['Brushed fleece 280 GSM - NAVY', 50, 50]])
    assert.deepEqual(r.body.po.lines.map(l => [l.ordered, l.received, l.outstanding]), [[100, 0, 100], [50, 0, 50]])
    assert.equal((await as(mfr).get('/api/inventory/items')).body.length, 0)
    assert.equal((await po(p.id)).receipts.length, 0)
  })

  test('posting adds the goods to stock, advances the PO, files the PDF and numbers the note', async () => {
    const mfr = await factory(), s = await supplier(mfr)
    const p = await sentPo(mfr, s)
    const g = (await startGrn(mfr, { poId: p.id, challanNo: 'CH-4471', challanDate: '2026-10-11', vehicleNo: 'tn39 ab 1234' })).body
    const r = await post(mfr, g.id)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.status, 'posted')
    assert.equal(r.body.number, `GRN-TPR-${FY()}-0001`)
    assert.equal(r.body.vehicleNo, 'TN39 AB 1234')
    assert.equal(r.body.po.status, 'closed')                                        // everything ordered has come in
    const item = await stockOf(mfr, 'Polar fleece')
    assert.deepEqual([item.onHand, item.unit, item.category], [100, 'kg', 'fabric'])
    const rows = await ledgerRows({ itemId: item.id })
    assert.deepEqual(rows.map(x => [x.type, x.qty, x.location, x.refType, x.unitCost]), [['receipt', 100, 'store', 'grn', 410]])
    assert.equal((await po(p.id)).receipts[0].grnId, g.id)
    const doc = await Document.findOne({ grnId: g.id }).lean()
    assert.equal(doc.type, 'goods_receipt')
    assert.equal(doc.dataUrl.slice(0, 34), 'data:application/pdf;base64,JVBERi')
    const pdf = (await as(mfr).get(`/api/grns/${g.id}/pdf`)).body
    assert.equal(Buffer.from(pdf.dataUrl.split(',')[1], 'base64').subarray(0, 5).toString(), '%PDF-')
  })

  test('a part delivery leaves the PO open for the rest, and the second note is numbered after the first', async () => {
    const mfr = await factory(), s = await supplier(mfr)
    const p = await sentPo(mfr, s)
    const first = (await post(mfr, (await startGrn(mfr, { poId: p.id, lines: [{ poLineId: p.lines[0].lineId, qty: 60 }] })).body.id)).body
    assert.equal(first.po.status, 'partially_received')
    const more = (await startGrn(mfr, { poId: p.id })).body
    assert.deepEqual(more.lines.map(l => l.qty), [40])                               // only what is still outstanding
    const second = (await post(mfr, more.id)).body
    assert.equal(second.number, `GRN-TPR-${FY()}-0002`)
    assert.equal(second.po.status, 'closed')
    assert.equal((await stockOf(mfr, 'Polar fleece')).onHand, 100)
  })

  test('what is turned away does not go into stock or count as received', async () => {
    const mfr = await factory(), s = await supplier(mfr)
    const p = await sentPo(mfr, s)
    const g = (await startGrn(mfr, { poId: p.id, lines: [{ poLineId: p.lines[0].lineId, qty: 100, rejectedQty: 10, rejectReason: 'shade band on 2 rolls' }] })).body
    assert.equal(g.lines[0].acceptedQty, 90)
    const r = await post(mfr, g.id)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.po.status, 'partially_received')
    assert.equal(r.body.po.lines[0].receivedQty, 90)
    assert.equal((await stockOf(mfr, 'Polar fleece')).onHand, 90)
  })

  test('the order\'s material line comes in with it', async () => {
    const mfr = await factory(), brand = await makeBuyer(), s = await supplier(mfr)
    await makeOrder({ id: 'MAT-1', buyer: brand, mfrs: [mfr] })
    await Order.updateOne({ _id: 'MAT-1' }, { $set: { 'assignments.0.stages.0.materials': [{ name: 'Polar fleece 300 GSM, 150 cm - BLACK', requiredQty: 100, unit: 'kg', status: 'pending', orderedQty: 0, receivedQty: 0, supplier: '', poNumber: '' }] } })
    const p = await sentPo(mfr, s, [poLine({ materialRef: { orderId: 'MAT-1', stageIndex: 0, materialIndex: 0, name: 'Polar fleece 300 GSM, 150 cm - BLACK' } })])
    await post(mfr, (await startGrn(mfr, { poId: p.id })).body.id)
    const m = (await Order.findById('MAT-1').lean()).assignments[0].stages[0].materials[0]
    assert.deepEqual([m.status, m.receivedQty], ['received', 100])
  })

  test('more than 10% over what was ordered is refused and nothing moves; a little over is accepted', async () => {
    const mfr = await factory(), s = await supplier(mfr)
    const p = await sentPo(mfr, s)
    const over = (await startGrn(mfr, { poId: p.id, lines: [{ poLineId: p.lines[0].lineId, qty: 120 }] })).body
    const refused = await post(mfr, over.id)
    assert.equal(refused.status, 400)
    assert.match(refused.body.error, /10% over/)
    assert.equal((await Grn.findById(over.id).lean()).status, 'draft')
    assert.equal(await StockLedger.countDocuments({}), 0)
    assert.equal((await po(p.id)).receipts.length, 0)
    const fine = await as(mfr).post(`/api/grns/${over.id}`, { lines: [{ lineId: over.lines[0].lineId, poLineId: p.lines[0].lineId, qty: 104 }] })
    assert.equal(fine.status, 200, JSON.stringify(fine.body))
    assert.equal((await post(mfr, over.id)).status, 200)
  })

  test('only a sent purchase order can be received against, and only one of the company\'s own', async () => {
    const mfr = await factory(), s = await supplier(mfr)
    const d = (await as(mfr).post('/api/purchase-orders', { supplierId: s.id, lines: [poLine()] })).body
    assert.equal((await startGrn(mfr, { poId: d.id })).status, 409)                  // still a draft
    const closed = await sentPo(mfr, s)
    await post(mfr, (await startGrn(mfr, { poId: closed.id })).body.id)
    assert.equal((await startGrn(mfr, { poId: closed.id })).status, 409)             // fully received
    assert.equal((await startGrn(mfr, { poId: 'PO-NOPE-2627-0001' })).status, 400)
    const wrongLine = await startGrn(mfr, { poId: (await sentPo(mfr, s)).id, lines: [{ poLineId: 'nope', qty: 1 }] })
    assert.equal(wrongLine.status, 400)
  })
})

describe('receiving without a purchase order', () => {
  test('goods from a supplier with no PO still go into stock under a number', async () => {
    const mfr = await factory()
    const g = (await startGrn(mfr, { supplierName: 'Local trims shop', challanNo: 'B-77', lines: [{ description: 'YKK zip 5, DTM black', unit: 'pcs', qty: 1200, rate: 4.5, lot: 'A12' }, { description: 'Spare line', unit: 'pcs', qty: 0 }] })).body
    assert.deepEqual([g.poId, g.supplierName, g.lines.length], [null, 'Local trims shop', 2])
    const r = await post(mfr, g.id)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.po, null)
    const zips = await stockOf(mfr, 'YKK zip')
    assert.deepEqual([zips.onHand, zips.category], [1200, 'trims'])
    assert.equal(await stockOf(mfr, 'Spare line'), undefined)                         // a line with nothing received books nothing
  })

  test('a note with nothing received, or no lines, cannot be posted', async () => {
    const mfr = await factory()
    const empty = (await startGrn(mfr, { supplierName: 'X' })).body
    assert.equal((await post(mfr, empty.id)).status, 400)
    const zero = (await startGrn(mfr, { lines: [{ description: 'A', unit: 'kg', qty: 0 }] })).body
    assert.match((await post(mfr, zero.id)).body.error, /Nothing has been received/)
  })

  test('the lines a request cannot make are refused', async () => {
    const mfr = await factory()
    const bad = async (body, re) => { const r = await startGrn(mfr, body); assert.equal(r.status, 400, JSON.stringify(r.body)); assert.match(r.body.error, re) }
    await bad({ lines: [{ qty: 5 }] }, /say what was received/)
    await bad({ lines: [{ description: 'A', qty: -1 }] }, /from 0 up/)
    await bad({ lines: [{ description: 'A', qty: 5, rejectedQty: 6 }] }, /more was turned away/)
    await bad({ lines: [{ description: 'A', qty: 5, itemId: '64b000000000000000000000' }] }, /not in your stock list/)
    await bad({ receivedOn: '2999-01-01', lines: [] }, /has not come/)
    await bad({ challanDate: 'yesterday', lines: [] }, /not a valid date/)
    await bad({ supplierId: '64b000000000000000000000', lines: [] }, /your suppliers/)
  })

  test('a line can name an item it books into, and the unit is the item\'s', async () => {
    const mfr = await factory()
    const item = (await as(mfr).post('/api/inventory/items', { name: 'Elastic 25 mm', unit: 'm', category: 'trims' })).body
    const g = (await startGrn(mfr, { lines: [{ description: 'Elastic from the market', unit: 'pcs', qty: 300, itemId: item.id }] })).body
    assert.equal(g.lines[0].unit, 'm')
    await post(mfr, g.id)
    assert.equal((await stockOf(mfr, 'Elastic 25')).onHand, 300)
    assert.equal(await InventoryItem.countDocuments({}), 1)                           // no second item made from the description
  })
})

describe('posting is safe', () => {
  test('a note posts once: the second try is told so and writes nothing', async () => {
    const mfr = await factory(), s = await supplier(mfr)
    const p = await sentPo(mfr, s)
    const g = (await startGrn(mfr, { poId: p.id })).body
    assert.equal((await post(mfr, g.id)).status, 200)
    assert.equal((await post(mfr, g.id)).status, 409)
    assert.equal(await StockLedger.countDocuments({}), 1)
    assert.equal((await po(p.id)).receipts.length, 1)
  })

  test('two people posting at the same moment: one posts, the other is turned away', async () => {
    const mfr = await factory(), s = await supplier(mfr)
    const p = await sentPo(mfr, s)
    const g = (await startGrn(mfr, { poId: p.id })).body
    const both = await Promise.all([post(mfr, g.id), post(mfr, g.id)])
    assert.deepEqual(both.map(r => r.status).sort(), [200, 409])
    assert.equal(await StockLedger.countDocuments({}), 1)
    assert.equal((await po(p.id)).lines[0].receivedQty, 100)
  })

  test('a note left half-posted by a crash is finished by posting again, without receiving twice', async () => {
    const mfr = await factory(), s = await supplier(mfr)
    const p = await sentPo(mfr, s)
    const g = (await startGrn(mfr, { poId: p.id })).body
    const first = await post(mfr, g.id)
    assert.equal(first.status, 200)
    // As if the server died after the stock and the PO were written but before the note was marked posted.
    await Grn.updateOne({ _id: g.id }, { $set: { status: 'posting', postingAt: new Date(0), postedAt: null, documentId: null } })
    await Document.deleteMany({ grnId: g.id })
    const again = await post(mfr, g.id)
    assert.equal(again.status, 200, JSON.stringify(again.body))
    assert.equal(again.body.number, first.body.number)                                // the same number, not a new one
    assert.equal(await StockLedger.countDocuments({}), 1)                             // one row per line, however often it is posted
    const after = await po(p.id)
    assert.equal(after.receipts.length, 1)
    assert.equal(after.lines[0].receivedQty, 100)                                     // not 200
    assert.equal(await Document.countDocuments({ grnId: g.id }), 1)
    assert.equal((await stockOf(mfr, 'Polar fleece')).onHand, 100)
  })

  test('a note that is still being posted is not taken over until its claim has gone stale', async () => {
    const mfr = await factory()
    const g = (await startGrn(mfr, { lines: [{ description: 'A', unit: 'kg', qty: 5 }] })).body
    await Grn.updateOne({ _id: g.id }, { $set: { status: 'posting', postingAt: new Date() } })
    assert.equal((await post(mfr, g.id)).status, 409)
    await Grn.updateOne({ _id: g.id }, { $set: { postingAt: new Date(Date.now() - 5 * 60 * 1000) } })
    assert.equal((await post(mfr, g.id)).status, 200)
  })
})

describe('editing and deleting', () => {
  test('a draft can be changed and thrown away; a posted note is a record', async () => {
    const mfr = await factory()
    const g = (await startGrn(mfr, { lines: [{ description: 'A', unit: 'kg', qty: 5 }] })).body
    const edited = await as(mfr).post(`/api/grns/${g.id}`, { challanNo: 'X-1', lines: [{ lineId: g.lines[0].lineId, description: 'A', unit: 'kg', qty: 8 }] })
    assert.equal(edited.status, 200, JSON.stringify(edited.body))
    assert.deepEqual([edited.body.challanNo, edited.body.lines[0].qty, edited.body.lines[0].lineId], ['X-1', 8, g.lines[0].lineId])
    const gone = (await startGrn(mfr, { lines: [{ description: 'B', unit: 'kg', qty: 1 }] })).body
    assert.equal((await as(mfr).post(`/api/grns/${gone.id}/delete`)).status, 200)
    assert.equal((await as(mfr).get(`/api/grns/${gone.id}`)).status, 404)
    await post(mfr, g.id)
    assert.equal((await as(mfr).post(`/api/grns/${g.id}`, { note: 'late' })).status, 409)
    assert.equal((await as(mfr).post(`/api/grns/${g.id}/delete`)).status, 409)
  })

  test('the list shows each note with its photos counted, and can be narrowed', async () => {
    const mfr = await factory()
    const a = (await startGrn(mfr, { lines: [{ description: 'A', unit: 'kg', qty: 5 }] })).body
    await startGrn(mfr, { lines: [{ description: 'B', unit: 'kg', qty: 5 }] })
    await as(mfr).post(`/api/grns/${a.id}/photos`, { dataUrl: PHOTO, kind: 'challan' })
    await post(mfr, a.id)
    const all = (await as(mfr).get('/api/grns')).body
    assert.equal(all.length, 2)
    assert.deepEqual(all.find(g => g.id === a.id).photoCount, 1)
    assert.deepEqual((await as(mfr).get('/api/grns?status=draft')).body.length, 1)
    assert.deepEqual((await as(mfr).get('/api/grns?status=posted')).body.map(g => g.number), [`GRN-TPR-${FY()}-0001`])
  })
})

describe('photos as evidence', () => {
  test('are kept against the note, listed without their bytes and read one at a time', async () => {
    const mfr = await factory()
    const g = (await startGrn(mfr, { lines: [{ description: 'A', unit: 'kg', qty: 5 }] })).body
    const added = await as(mfr).post(`/api/grns/${g.id}/photos`, { dataUrl: PHOTO, kind: 'damage', caption: 'Torn roll', name: 'IMG_1.jpg' })
    assert.equal(added.status, 201, JSON.stringify(added.body))
    assert.deepEqual([added.body.kind, added.body.caption, added.body.mimeType], ['damage', 'Torn roll', 'image/jpeg'])
    assert.equal(added.body.dataUrl, undefined)
    const listed = (await as(mfr).get(`/api/grns/${g.id}/photos`)).body
    assert.equal(listed.length, 1)
    assert.equal(listed[0].dataUrl, undefined)
    assert.equal((await as(mfr).get(`/api/grns/${g.id}`)).body.photos.length, 1)
    const one = (await as(mfr).get(`/api/grns/${g.id}/photos/${added.body.id}`)).body
    assert.equal(one.dataUrl, PHOTO)
  })

  test('must be real JPG, PNG or WebP photos of a sensible size', async () => {
    const mfr = await factory()
    const g = (await startGrn(mfr, { lines: [{ description: 'A', unit: 'kg', qty: 5 }] })).body
    const url = `/api/grns/${g.id}/photos`
    for (const dataUrl of ['data:text/html;base64,PHNjcmlwdD4=', 'data:image/jpeg;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==', 'not a data url', 12, `data:image/png;base64,${'A'.repeat(6 * 1024 * 1024)}`])
      assert.equal((await as(mfr).post(url, { dataUrl })).status, 400, String(dataUrl).slice(0, 30))
    assert.equal((await as(mfr).post(url, { dataUrl: PHOTO, mimeType: 'image/png' })).status, 400)       // declared type does not match
    assert.equal(await Attachment.countDocuments({}), 0)
  })

  test('at most twelve to a note; they go with a draft that is deleted and stay with a posted note', async () => {
    const mfr = await factory()
    const g = (await startGrn(mfr, { lines: [{ description: 'A', unit: 'kg', qty: 5 }] })).body
    for (let i = 0; i < 12; i++) assert.equal((await as(mfr).post(`/api/grns/${g.id}/photos`, { dataUrl: PHOTO })).status, 201)
    assert.equal((await as(mfr).post(`/api/grns/${g.id}/photos`, { dataUrl: PHOTO })).status, 400)
    const first = (await as(mfr).get(`/api/grns/${g.id}/photos`)).body[0]
    assert.equal((await as(mfr).post(`/api/grns/${g.id}/photos/${first.id}/delete`)).status, 200)
    await post(mfr, g.id)
    assert.equal((await as(mfr).post(`/api/grns/${g.id}/photos/${(await as(mfr).get(`/api/grns/${g.id}/photos`)).body[0].id}/delete`)).status, 409)
    assert.equal((await as(mfr).post(`/api/grns/${g.id}/photos`, { dataUrl: PHOTO })).status, 201)     // late evidence can still be added
    const d = (await startGrn(mfr, { lines: [{ description: 'B', unit: 'kg', qty: 1 }] })).body
    await as(mfr).post(`/api/grns/${d.id}/photos`, { dataUrl: PHOTO })
    await as(mfr).post(`/api/grns/${d.id}/delete`)
    assert.equal(await Attachment.countDocuments({ refId: d.id }), 0)
  })
})

describe('the posted note\'s PDF is a system document', () => {
  test('it cannot be uploaded, edited or deleted by hand, and the brand never receives it', async () => {
    const mfr = await factory(), brand = await makeBuyer()
    await link(brand, mfr)
    await makeOrder({ id: 'FIT-1', buyer: brand, mfrs: [mfr] })
    const g = (await startGrn(mfr, { lines: [{ description: 'A', unit: 'kg', qty: 5 }] })).body
    await post(mfr, g.id)
    const doc = await Document.findOne({ grnId: g.id })
    const made = await as(mfr).post('/api/documents', { type: 'goods_receipt', name: 'x', orderId: 'FIT-1', externalUrl: 'https://example.com/x' })
    assert.equal(made.status, 400)
    assert.equal((await as(mfr).post(`/api/documents/${doc._id}`, { name: 'renamed' })).status, 409)
    assert.equal((await as(mfr).post(`/api/documents/${doc._id}/delete`)).status, 409)
    await Document.updateOne({ _id: doc._id }, { $set: { orderId: 'FIT-1' } })               // even if it hung off the brand's order
    assert.equal((await as(brand).get('/api/documents')).body.some(d => d.type === 'goods_receipt'), false)
    assert.equal((await as(brand).get(`/api/documents/${doc._id}/data`)).status, 404)
    assert.ok((await as(mfr).get('/api/documents')).body.some(d => d.type === 'goods_receipt'))
  })
})

describe('issuing stock to an order', () => {
  /** A factory with 100 kg of fleece in the store and an order to use it on. */
  async function stocked() {
    const mfr = await factory(), brand = await makeBuyer()
    await link(brand, mfr)
    await makeOrder({ id: 'FIT-5117', buyer: brand, mfrs: [mfr] })
    const g = (await startGrn(mfr, { lines: [{ description: 'Polar fleece 300 GSM - BLACK', unit: 'kg', qty: 100, rate: 410 }] })).body
    await post(mfr, g.id)
    const item = await stockOf(mfr, 'Polar fleece')
    return { mfr, item }
  }

  test('takes it out of the store, numbers the slip, and records what the order used', async () => {
    const { mfr, item } = await stocked()
    const r = await as(mfr).post('/api/inventory/issues', { orderId: 'FIT-5117', stageIndex: 6, lines: [{ itemId: item.id, qty: 30 }], note: 'For cutting' })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.equal(r.body.number, `ISS-TPR-${FY()}-0001`)
    assert.deepEqual([r.body.type, r.body.orderId, r.body.stageIndex, r.body.lines[0].qty], ['issue', 'FIT-5117', 6, 30])
    assert.equal((await stockOf(mfr, 'Polar fleece')).onHand, 70)
    const used = (await as(mfr).get('/api/inventory/ledger?orderId=FIT-5117')).body
    assert.deepEqual(used.map(x => [x.type, x.qty, x.itemName]), [['issue', -30, 'Polar fleece 300 GSM - BLACK']])
    assert.equal((await as(mfr).get(`/api/inventory/issues?orderId=FIT-5117`)).body.length, 1)
    assert.equal((await as(mfr).get(`/api/inventory/issues/${r.body.id}`)).body.number, r.body.number)
  })

  test('cannot take more than is in the store, and says how much there is', async () => {
    const { mfr, item } = await stocked()
    const r = await as(mfr).post('/api/inventory/issues', { orderId: 'FIT-5117', lines: [{ itemId: item.id, qty: 101 }] })
    assert.equal(r.status, 400)
    assert.match(r.body.error, /Only 100 kg of "Polar fleece 300 GSM - BLACK" in the store/)
    assert.equal(r.body.available, 100)
    assert.equal((await stockOf(mfr, 'Polar fleece')).onHand, 100)
    assert.equal(await StockIssue.countDocuments({}), 0)
  })

  test('two issues at the same moment cannot both take the last of it', async () => {
    const { mfr, item } = await stocked()
    const take = qty => as(mfr).post('/api/inventory/issues', { orderId: 'FIT-5117', lines: [{ itemId: item.id, qty }] })
    const both = await Promise.all([take(60), take(60)])
    assert.deepEqual(both.map(r => r.status).sort(), [201, 400])
    assert.equal((await stockOf(mfr, 'Polar fleece')).onHand, 40)
  })

  test('only an order the factory is on, only its own items, and sensible quantities', async () => {
    const { mfr, item } = await stocked()
    const bad = async (body, re) => { const r = await as(mfr).post('/api/inventory/issues', body); assert.equal(r.status, 400, JSON.stringify(r.body)); assert.match(r.body.error, re) }
    await bad({ orderId: 'NOT-MINE', lines: [{ itemId: item.id, qty: 1 }] }, /one of your orders/)
    await bad({ lines: [{ itemId: item.id, qty: 1 }] }, /which order|order this is for/i)
    await bad({ orderId: 'FIT-5117', lines: [] }, /what was issued/)
    await bad({ orderId: 'FIT-5117', lines: [{ itemId: item.id, qty: 0 }] }, /more than zero/)
    await bad({ orderId: 'FIT-5117', lines: [{ itemId: '64b000000000000000000000', qty: 1 }] }, /your stock list/)
    await bad({ orderId: 'FIT-5117', stageIndex: -2, lines: [{ itemId: item.id, qty: 1 }] }, /production step/)
  })

  test('unused stock can come back, but only what was issued to that order', async () => {
    const { mfr, item } = await stocked()
    await as(mfr).post('/api/inventory/issues', { orderId: 'FIT-5117', lines: [{ itemId: item.id, qty: 30 }] })
    const tooMuch = await as(mfr).post('/api/inventory/issues', { orderId: 'FIT-5117', type: 'return', lines: [{ itemId: item.id, qty: 31 }] })
    assert.equal(tooMuch.status, 400)
    assert.match(tooMuch.body.error, /Only 30 kg .* has been issued to this order/)
    const back = await as(mfr).post('/api/inventory/issues', { orderId: 'FIT-5117', type: 'return', lines: [{ itemId: item.id, qty: 10 }] })
    assert.equal(back.status, 201, JSON.stringify(back.body))
    assert.equal((await stockOf(mfr, 'Polar fleece')).onHand, 80)
  })
})

describe('correcting stock after a count', () => {
  async function stocked() {
    const mfr = await factory()
    await post(mfr, (await startGrn(mfr, { lines: [{ description: 'Elastic 25 mm', unit: 'm', qty: 500 }] })).body.id)
    return { mfr, item: await stockOf(mfr, 'Elastic') }
  }

  test('a count moves the book to what was counted, and says why', async () => {
    const { mfr, item } = await stocked()
    const r = await as(mfr).post('/api/inventory/adjustments', { itemId: item.id, counted: 460, reason: 'Stock take' })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.deepEqual([r.body.delta, r.body.item.onHand], [-40, 460])
    const up = await as(mfr).post('/api/inventory/adjustments', { itemId: item.id, delta: 15.5, reason: 'Found a carton' })
    assert.equal(up.body.item.onHand, 475.5)
    const history = (await as(mfr).get(`/api/inventory/items/${item.id}`)).body.ledger
    assert.deepEqual(history.map(x => [x.type, x.qty, x.note]), [['adjustment', 15.5, 'Found a carton'], ['adjustment', -40, 'Stock take'], ['receipt', 500, history[2].note]])
  })

  test('has to change something, give a reason, and cannot take stock below zero', async () => {
    const { mfr, item } = await stocked()
    const bad = async (body, re, status = 400) => { const r = await as(mfr).post('/api/inventory/adjustments', { itemId: item.id, reason: 'x', ...body }); assert.equal(r.status, status, JSON.stringify(r.body)); assert.match(r.body.error, re) }
    await bad({ counted: 500 }, /Nothing to adjust/)
    await bad({ reason: '', counted: 400 }, /Say why/)
    await bad({ counted: 400, delta: -100 }, /either the quantity counted or the change/)
    await bad({}, /either the quantity counted or the change/)
    await bad({ counted: -1 }, /from 0 up/)
    await bad({ delta: -501 }, /Only 500 m/)
    assert.equal((await stockOf(mfr, 'Elastic')).onHand, 500)
  })
})

describe('what is in stock comes only from the ledger', () => {
  test('the balance is the sum of the rows at a place, and stock at a job worker is counted apart', async () => {
    const mfr = await factory()
    const orgId = (await Supplier.db.collection('organizations').findOne({}))._id
    const item = await InventoryItem.create({ ownerOrgId: orgId, name: 'Grey jersey', unit: 'kg', key: itemKey('Grey jersey', 'kg') })
    const row = (qty, location, key) => ({ ownerOrgId: orgId, itemId: item._id, location, type: 'adjustment', qty, unit: 'kg', refType: 'adjustment', refId: key, key })
    await StockLedger.insertMany([row(100, 'store', 'a'), row(-30, 'store', 'b'), row(30, 'jw:64b000000000000000000001', 'c')])
    const b = (await balances(orgId)).get(String(item._id))
    assert.deepEqual([b.store, b.atJobWork], [70, 30])
    assert.equal((await as(mfr).get('/api/inventory/items')).body[0].atJobWork, 30)
  })

  test('taking stock is refused when it is not there, and the refused rows are not left behind', async () => {
    const mfr = await factory()
    const orgId = (await Supplier.db.collection('organizations').findOne({}))._id
    const item = await InventoryItem.create({ ownerOrgId: orgId, name: 'Grey jersey', unit: 'kg', key: itemKey('Grey jersey', 'kg') })
    const row = { ownerOrgId: orgId, itemId: item._id, location: 'store', type: 'issue', qty: -5, unit: 'kg', refType: 'issue', refId: 'x', key: 'issue:x:1' }
    const r = await takeStock(orgId, [row], new Map([[String(item._id), item]]))
    assert.equal(r.ok, false)
    assert.match(r.error, /Only 0 kg of "Grey jersey" in the store/)
    assert.equal(await StockLedger.countDocuments({}), 0)
    assert.ok(mfr)
  })

  test('writing the same movement twice records it once', async () => {
    const mfr = await factory()
    const orgId = (await Supplier.db.collection('organizations').findOne({}))._id
    const item = await InventoryItem.create({ ownerOrgId: orgId, name: 'Grey jersey', unit: 'kg', key: itemKey('Grey jersey', 'kg') })
    const { writeLedger } = await import('../src/lib/inventory/stock.js')
    const row = { ownerOrgId: orgId, itemId: item._id, location: 'store', type: 'receipt', qty: 5, unit: 'kg', refType: 'grn', refId: 'g', key: 'grn:g:1' }
    await writeLedger([row]); await writeLedger([row, { ...row, key: 'grn:g:2' }])
    assert.equal(await StockLedger.countDocuments({}), 2)
    assert.ok(mfr)
  })
})

describe('combining two items that are the same thing', () => {
  async function twoItems() {
    const mfr = await factory()
    const a = (await startGrn(mfr, { lines: [{ description: 'Brushed fleece 280 GSM', unit: 'kg', qty: 100 }] })).body
    await post(mfr, a.id)
    const b = (await startGrn(mfr, { lines: [{ description: 'Brushed fleece 280 GSM, 72 in, 80/20 CVC', unit: 'kg', qty: 40 }] })).body
    await post(mfr, b.id)
    const items = (await as(mfr).get('/api/inventory/items')).body
    return { mfr, plain: items.find(i => i.name === 'Brushed fleece 280 GSM'), long: items.find(i => i.name.includes('72 in')) }
  }

  test('moves the stock across as matching corrections, archives the other, and sends later goods to it', async () => {
    const { mfr, plain, long } = await twoItems()
    const r = await as(mfr).post(`/api/inventory/items/${long.id}/merge`, { intoId: plain.id })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual([r.body.id, r.body.onHand], [plain.id, 140])
    const items = (await as(mfr).get('/api/inventory/items')).body
    assert.deepEqual(items.map(i => [i.name, i.onHand]), [['Brushed fleece 280 GSM', 140]])
    assert.equal((await as(mfr).get('/api/inventory/items?archived=1')).body.length, 2)
    const moves = (await as(mfr).get(`/api/inventory/items/${long.id}`)).body.ledger
    assert.deepEqual(moves.map(m => [m.type, m.qty]), [['adjustment', -40], ['receipt', 40]])           // the history is kept; a correction takes the stock out
    // The next delivery under the old name goes into the item it was combined with, and nothing new is made.
    const later = (await startGrn(mfr, { lines: [{ description: 'brushed fleece 280 gsm, 72 in, 80/20 cvc', unit: 'KG', qty: 10 }] })).body
    await post(mfr, later.id)
    assert.equal((await stockOf(mfr, 'Brushed fleece')).onHand, 150)
    assert.equal(await InventoryItem.countDocuments({}), 2)
  })

  test('is refused for different units, itself, another company\'s item, and bringing a combined item back', async () => {
    const { mfr, plain, long } = await twoItems()
    const metres = (await as(mfr).post('/api/inventory/items', { name: 'Brushed fleece in metres', unit: 'm' })).body
    assert.equal((await as(mfr).post(`/api/inventory/items/${long.id}/merge`, { intoId: metres.id })).status, 409)
    assert.equal((await as(mfr).post(`/api/inventory/items/${long.id}/merge`, { intoId: long.id })).status, 400)
    assert.equal((await as(mfr).post(`/api/inventory/items/${long.id}/merge`, {})).status, 400)
    const other = await factory({ code: 'ZZZ' })
    assert.equal((await as(other).post(`/api/inventory/items/${long.id}/merge`, { intoId: plain.id })).status, 404)
    assert.equal((await as(mfr).post(`/api/inventory/items/${long.id}/merge`, { intoId: plain.id })).status, 200)
    assert.equal((await as(mfr).post(`/api/inventory/items/${long.id}/restore`)).status, 409)
    assert.equal((await as(mfr).post(`/api/inventory/items/${long.id}/merge`, { intoId: plain.id })).status, 200)       // doing it again finds nothing left to move
    assert.equal((await stockOf(mfr, 'Brushed fleece')).onHand, 140)
  })

  test('goods arriving for an archived item bring it back', async () => {
    const mfr = await factory()
    const item = (await as(mfr).post('/api/inventory/items', { name: 'Elastic 25 mm', unit: 'm' })).body
    await as(mfr).post(`/api/inventory/items/${item.id}/archive`)
    await post(mfr, (await startGrn(mfr, { lines: [{ description: 'Elastic 25 mm', unit: 'm', qty: 50 }] })).body.id)
    const back = (await as(mfr).get('/api/inventory/items')).body
    assert.deepEqual(back.map(i => [i.id, i.onHand, i.isActive]), [[item.id, 50, true]])
  })
})

