// Reading a supplier's challan or invoice into a draft goods received note: what is matched, what is warned about,
// that nothing is ever posted from a document, and that only the company's own orders and suppliers are matched.
import test, { before, after, beforeEach, afterEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as, req } from './helpers/client.js'
import { makeBuyer, makeMfr, setOrg } from './helpers/factories.js'
import { Supplier } from '../src/models/Supplier.js'
import { SupplierItem } from '../src/models/SupplierItem.js'
import { InventoryItem } from '../src/models/InventoryItem.js'
import { StockLedger } from '../src/models/StockLedger.js'
import { Grn } from '../src/models/Grn.js'
import { Attachment } from '../src/models/Attachment.js'
import { gstinCheckChar } from '../src/lib/gst.js'
import { setMailerForTests } from '../src/lib/email.js'
import { setGoodsDocReaderForTests, goodsDocSchema } from '../src/lib/ai/goodsdoc.js'
import { similarity, normaliseUnit, matchPo, matchLines, crossCheck } from '../src/lib/inventory/match.js'

before(async () => { await startTestDb(); await startServer(); for (const m of [Supplier, SupplierItem, InventoryItem, StockLedger, Grn]) await m.init() })
after(async () => { delete process.env.PLATFORM_MODE; setMailerForTests(null); setGoodsDocReaderForTests(null); await stopServer(); await stopTestDb() })
beforeEach(async () => {
  await clearDb(); process.env.PLATFORM_MODE = 'standalone'; delete process.env.ENABLE_VIEW_AS
  setMailerForTests({ emails: { send: async () => ({ data: { id: 'em_1' }, error: null }) } })
})
afterEach(() => { setGoodsDocReaderForTests(null) })

const gstinFor = (state, pan = 'AAPFU0939F') => { const f = `${state}${pan}1Z`; return f + gstinCheckChar(f) }
const PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2Q=='

async function factory({ code = 'TPR' } = {}) {
  const mfr = await makeMfr({ code, company: `${code} Textiles`, email: `${code.toLowerCase()}@mfr.test` })
  await setOrg(mfr, { profile: { legalName: `${code} Textiles Pvt Ltd`, gstin: gstinFor('33'), stateCode: '33', address: 'Plot 22', city: 'Tiruppur', pincode: '641604' } })
  return mfr
}
const supplier = async (u, body = {}) => (await as(u).post('/api/suppliers', { name: 'Coimbatore Knit Fabrics', type: 'fabric_supplier', email: 'sales@cknit.test', gstin: gstinFor('33', 'AABCC1234D'), ...body })).body
const sentPo = async (u, s, lines) => {
  const d = (await as(u).post('/api/purchase-orders', { supplierId: s.id, lines })).body
  assert.equal((await as(u).post(`/api/purchase-orders/${d.id}/send`, {})).status, 200)
  return (await as(u).get(`/api/purchase-orders/${d.id}`)).body
}
const L = (description, qty, unit = 'kg', rate = 410) => ({ description, qty, unit, rate, taxPct: 5 })

/** A reader that returns what the model would have read (run through the real schema, as the real one is). */
const reading = (over = {}) => {
  const data = goodsDocSchema.parse({
    docType: 'delivery_challan', docNumber: 'CH-4471', docDate: '2026-10-11', supplierName: 'Coimbatore Knit Fabrics', supplierGstin: null, poNumber: null, vehicleNo: 'TN 39 AB 1234',
    lines: [{ description: 'Polar fleece 300 GSM, 150 cm - BLACK', qty: '60 KGS', unit: 'KGS' }], total: null, notes: [], confidence: 0.9, ...over,
  })
  setGoodsDocReaderForTests(async () => ({ data, error: null }))
  return data
}
const scan = (u, dataUrl = PHOTO) => as(u).post('/api/grns/scan', { dataUrl })

describe('matching the words of a document to the company\'s own records', () => {
  test('descriptions are alike by their words, and a number is a word: 280 GSM is not 300 GSM', () => {
    assert.ok(similarity('Polar fleece 300 GSM, 150 cm - BLACK', 'POLAR FLEECE 300GSM 150cm BLACK') > 0.5)
    assert.ok(similarity('Brushed fleece 280 GSM', 'Brushed fleece 300 GSM') < 0.8)
    assert.ok(similarity('Single jersey 180 GSM', 'YKK zip 5') === 0)
    assert.equal(similarity('', 'x'), 0)
  })

  test('units are written the factory\'s way', () => {
    assert.deepEqual(['KGS', 'Mtr.', 'NOS', 'yards', 'ROLLS', 'unknown'].map(normaliseUnit), ['kg', 'm', 'pcs', 'yds', 'roll', 'unknown'])
  })

  const sup = [{ _id: 's1', name: 'Coimbatore Knit Fabrics', gstin: '33AABCC1234D1ZP' }, { _id: 's2', name: 'Erode Rib and Collar', gstin: '' }]
  const pos = [
    { _id: 'PO-TPR-2627-0007', supplierId: 's1', lines: [{ lineId: 'a', description: 'Polar fleece 300 GSM - BLACK', unit: 'kg' }] },
    { _id: 'PO-TPR-2627-0008', supplierId: 's2', lines: [{ lineId: 'b', description: 'Rib 2x2 collar and cuff', unit: 'kg' }] },
    { _id: 'PO-TPR-2627-0009', supplierId: 's2', lines: [{ lineId: 'c', description: 'Lycra rib 1x1', unit: 'kg' }] },
  ]
  test('the PO a document quotes: the full number, or its last digits when only one open PO ends in them', () => {
    assert.equal(matchPo({ poNumber: 'PO-TPR-2627-0007' }, pos, sup).po._id, 'PO-TPR-2627-0007')
    assert.equal(matchPo({ poNumber: 'po-tpr-2627-0008 dt 10.10' }, pos, sup).po._id, 'PO-TPR-2627-0008')
    assert.equal(matchPo({ poNumber: 'PO 7' }, pos, sup).po._id, 'PO-TPR-2627-0007')
    assert.equal(matchPo({ poNumber: 'PO 0009' }, pos, sup).po._id, 'PO-TPR-2627-0009')
    assert.equal(matchPo({ poNumber: 'PO 77' }, pos, sup).po, null)
  })

  test('otherwise by supplier: one open PO is it, several are told apart by their goods, unsure is no match', () => {
    const one = matchPo({ supplierName: 'COIMBATORE KNIT FABRICS', lines: [] }, pos, sup)
    assert.equal(one.po._id, 'PO-TPR-2627-0007')
    assert.match(one.reason, /one purchase order/)
    assert.equal(matchPo({ supplierGstin: '33aabcc1234d1zp', lines: [] }, pos, sup).po._id, 'PO-TPR-2627-0007')           // by GSTIN, whatever the name says
    const two = matchPo({ supplierName: 'Erode Rib & Collar', lines: [{ description: 'RIB 2x2 collar and cuff, matching' }] }, pos, sup)
    assert.equal(two.po._id, 'PO-TPR-2627-0008')
    assert.equal(matchPo({ supplierName: 'Erode Rib and Collar', lines: [{ description: 'something else' }] }, pos, sup).po, null)
    assert.equal(matchPo({ supplierName: 'A completely different mill', lines: [] }, pos, sup).supplier, null)
  })

  test('lines pair one to one, in the same unit, best matches first', () => {
    const po = [{ lineId: 'a', description: 'Polar fleece 300 GSM - BLACK', unit: 'kg' }, { lineId: 'b', description: 'Polar fleece 300 GSM - NAVY', unit: 'kg' }, { lineId: 'c', description: 'Polar fleece 300 GSM - BLACK', unit: 'm' }]
    const pairs = matchLines([{ description: 'POLAR FLEECE 300 GSM NAVY', unit: 'KGS' }, { description: 'polar fleece 300 gsm black', unit: 'kg' }, { description: 'Zip', unit: 'pcs' }], po)
    assert.deepEqual([...pairs], [[0, 'b'], [1, 'a']])
  })

  test('sums that do not add up, and a quantity that could not be read, are pointed out', () => {
    assert.deepEqual(crossCheck({ lines: [{ qty: 10, rate: 5, amount: 50 }, { qty: 10, rate: 5, amount: 500 }, { qty: null, rate: null, amount: null }] }).map(w => w.slice(0, 7)), ['Line 2:', 'Line 3:'])
    assert.deepEqual(crossCheck({ lines: [{ qty: 3, rate: 1.333, amount: 4 }] }), [])        // within a rupee
  })
})

describe('what the model sends back is checked like any other input', () => {
  test('text numbers are read, an unknown document type becomes "other", and a bad confidence is not trusted', () => {
    const d = goodsDocSchema.parse({ docType: 'weird', lines: [{ description: 'A', qty: '1,200.5 kg', rate: 'Rs 410' }], confidence: 7 })
    assert.deepEqual([d.docType, d.lines[0].qty, d.lines[0].rate, d.confidence], ['other', 1200.5, 410, 0.5])
    assert.equal(goodsDocSchema.parse({ lines: [{ qty: 'many' }] }).lines[0].qty, null)
  })
})

describe('a document becomes a draft note', () => {
  test('quoting the PO: its lines are filled from the document, the challan details come across, the photo is kept, nothing is posted', async () => {
    const mfr = await factory(), s = await supplier(mfr)
    const po = await sentPo(mfr, s, [L('Polar fleece 300 GSM, 150 cm - BLACK', 100), L('Polar fleece 300 GSM, 150 cm - NAVY', 100)])
    reading({ poNumber: `${po.id} dated 8 Oct` })
    const r = await scan(mfr)
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.deepEqual([r.body.status, r.body.source, r.body.poId, r.body.challanNo, r.body.challanDate, r.body.vehicleNo], ['draft', 'ai_review', po.id, 'CH-4471', '2026-10-11', 'TN 39 AB 1234'])
    assert.deepEqual(r.body.lines.map(l => [l.description, l.qty]), [['Polar fleece 300 GSM, 150 cm - BLACK', 60], ['Polar fleece 300 GSM, 150 cm - NAVY', 0]])
    assert.equal(r.body.read.confidence, 0.9)
    assert.match(r.body.read.matchReason, /quotes the purchase order/)
    assert.ok(r.body.warnings.some(w => /not on this document/.test(w)))                    // the NAVY line is not on the challan
    assert.equal(r.body.photos.length, 1)
    assert.equal(r.body.photos[0].kind, 'challan')
    // Nothing moved: it is a draft the factory checks and posts.
    assert.equal(await StockLedger.countDocuments({}), 0)
    assert.equal((await Grn.findById(r.body.id).lean()).status, 'draft')
    assert.equal((await as(mfr).get(`/api/purchase-orders/${po.id}`)).body.lines[0].receivedQty, 0)
    // And it posts like any other note.
    assert.equal((await as(mfr).post(`/api/grns/${r.body.id}/post`)).status, 200)
    assert.equal((await as(mfr).get('/api/inventory/items')).body.find(i => i.name.includes('BLACK')).onHand, 60)
  })

  test('quoting nothing, a supplier with one open PO is enough; goods that are not on the PO are added as extra lines', async () => {
    const mfr = await factory(), s = await supplier(mfr)
    const po = await sentPo(mfr, s, [L('Polar fleece 300 GSM, 150 cm - BLACK', 100)])
    reading({ lines: [{ description: 'Polar fleece 300 GSM 150 cm black', qty: 50, unit: 'KGS' }, { description: 'Drawcord 140 cm', qty: 2000, unit: 'PCS', rate: 3, amount: 6000 }] })
    const r = await scan(mfr)
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.equal(r.body.poId, po.id)
    assert.deepEqual(r.body.lines.map(l => [l.description, l.qty, l.unit, l.poLineId ? 'on PO' : 'extra']), [['Polar fleece 300 GSM, 150 cm - BLACK', 50, 'kg', 'on PO'], ['Drawcord 140 cm', 2000, 'pcs', 'extra']])
    assert.ok(r.body.warnings.some(w => /did not match a line of/.test(w)))
  })

  test('with no PO to match it is a note without one, with the supplier as printed', async () => {
    const mfr = await factory()
    reading({ supplierName: 'Sri Murugan Trims', supplierGstin: '33ABCDE1234F1Z5', poNumber: 'PO-ZZZ-2627-0001' })
    const r = await scan(mfr)
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.deepEqual([r.body.poId, r.body.supplierName, r.body.supplierGstin], [null, 'Sri Murugan Trims', '33ABCDE1234F1Z5'])
    assert.ok(r.body.warnings.some(w => /not one of your purchase orders/.test(w)))
  })

  test('a printed sum that does not add up, and a photo that was hard to read, are warned about', async () => {
    const mfr = await factory()
    reading({ confidence: 0.4, lines: [{ description: 'Single jersey 180 GSM', qty: 100, unit: 'kg', rate: 200, amount: 2000 }] })
    const r = await scan(mfr)
    assert.ok(r.body.warnings.some(w => /Line 1: 100 x 200 is 20000/.test(w)))
    assert.ok(r.body.warnings.some(w => /hard to read/.test(w)))
  })

  test('a document that cannot be read, or has no goods on it, makes no note', async () => {
    const mfr = await factory()
    setGoodsDocReaderForTests(async () => ({ data: null, error: 'timeout' }))
    assert.equal((await scan(mfr)).status, 502)
    reading({ lines: [] })
    const none = await scan(mfr)
    assert.equal(none.status, 422)
    assert.match(none.body.error, /No goods could be found/)
    assert.equal(await Grn.countDocuments({}), 0)
  })

  test('only a photo or a PDF of sensible size is read', async () => {
    const mfr = await factory()
    reading()
    for (const dataUrl of ['data:text/html;base64,PGI+', 'not a data url', 12, 'data:image/jpeg;base64,PHNjcmlwdD4=', `data:image/png;base64,${'A'.repeat(12 * 1024 * 1024)}`, 'data:application/pdf;base64,PGI+'])
      assert.equal((await scan(mfr, dataUrl)).status, 400, String(dataUrl).slice(0, 30))
    assert.equal((await scan(mfr, 'data:application/pdf;base64,JVBERi0xLjQK')).status, 201)          // a real PDF header is accepted (and has no photo to keep)
    assert.equal(await Attachment.countDocuments({}), 0)
  })

  test('brands and Tradio staff cannot use it, and the Tradio portal has none', async () => {
    const brand = await makeBuyer(), mfr = await factory()
    reading()
    assert.equal((await scan(brand)).status, 403)
    assert.equal((await req('POST', '/api/grns/scan', { body: { dataUrl: PHOTO } })).status, 401)
    delete process.env.PLATFORM_MODE
    assert.equal((await scan(mfr)).status, 404)
  })

  test('only the company\'s own orders and suppliers are matched: another factory\'s PO number finds nothing', async () => {
    const a = await factory({ code: 'AAA' }), b = await factory({ code: 'BBB' })
    const sa = await supplier(a), sb = await supplier(b)
    const poA = await sentPo(a, sa, [L('Polar fleece 300 GSM, 150 cm - BLACK', 100)])
    await sentPo(b, sb, [L('Polar fleece 300 GSM, 150 cm - BLACK', 100)])
    reading({ poNumber: poA.id })
    const r = await scan(b)
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.notEqual(r.body.poId, poA.id)                                                    // B's own single open PO from the same supplier name may match, never A's
    assert.equal((await as(b).get('/api/grns')).body.length, 1)
    assert.equal((await as(a).get('/api/grns')).body.length, 0)
  })
})
