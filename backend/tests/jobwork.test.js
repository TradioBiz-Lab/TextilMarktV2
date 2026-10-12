// Goods sent to a job worker and what comes back: that stock really moves to the job worker and back, that what is
// still out is always the ledger's own figure, that two people cannot account for the same goods twice, and that
// nobody but the company reaches any of it.
import test, { before, after, beforeEach, afterEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as, req } from './helpers/client.js'
import { makeAdmin, makeBuyer, makeMfr, makeOrder, setOrg, link } from './helpers/factories.js'
import { Supplier } from '../src/models/Supplier.js'
import { InventoryItem } from '../src/models/InventoryItem.js'
import { StockLedger } from '../src/models/StockLedger.js'
import { Grn } from '../src/models/Grn.js'
import { JobWork } from '../src/models/JobWork.js'
import { Document } from '../src/models/Document.js'
import { Attachment } from '../src/models/Attachment.js'
import { gstinCheckChar } from '../src/lib/gst.js'
import { fiscalYearCode } from '../src/lib/fiscalYear.js'
import { setMailerForTests } from '../src/lib/email.js'

before(async () => { await startTestDb(); await startServer(); for (const m of [Supplier, InventoryItem, StockLedger, Grn, JobWork]) await m.init() })
after(async () => { delete process.env.PLATFORM_MODE; setMailerForTests(null); await stopServer(); await stopTestDb() })
beforeEach(async () => { await clearDb(); process.env.PLATFORM_MODE = 'standalone'; setMailerForTests({ emails: { send: async () => ({ data: { id: 'em_1' }, error: null }) } }) })
afterEach(() => setMailerForTests(null))

const FY = () => fiscalYearCode()
const gstinFor = (state, pan = 'AAPFU0939F') => { const f = `${state}${pan}1Z`; return f + gstinCheckChar(f) }
const PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2Q=='

async function factory({ code = 'TPR' } = {}) {
  const mfr = await makeMfr({ code, company: `${code} Textiles`, email: `${code.toLowerCase()}@mfr.test` })
  await setOrg(mfr, { profile: { legalName: `${code} Textiles Pvt Ltd`, gstin: gstinFor('33'), stateCode: '33', address: 'Plot 22', city: 'Tiruppur', pincode: '641604' } })
  return mfr
}
const dyer = async (u, body = {}) => (await as(u).post('/api/suppliers', { name: 'Salem Dyeing Works', type: 'dyer', email: 'orders@salemdye.test', gstin: gstinFor('33', 'AAHCS5678E'), city: 'Salem', ...body })).body

/** A factory with 100 kg of grey jersey in the store and a dyer to send it to. */
async function setup() {
  const mfr = await factory(), brand = await makeBuyer()
  await link(brand, mfr)
  await makeOrder({ id: 'FIT-5117', buyer: brand, mfrs: [mfr] })
  const d = await dyer(mfr)
  const g = (await as(mfr).post('/api/grns', { supplierName: 'Mill', lines: [{ description: 'Single jersey 180 GSM - GREY', unit: 'kg', qty: 100, rate: 200 }] })).body
  assert.equal((await as(mfr).post(`/api/grns/${g.id}/post`)).status, 200)
  const grey = (await as(mfr).get('/api/inventory/items')).body[0]
  return { mfr, brand, d, grey }
}
const send = (u, body) => as(u).post('/api/jobwork', body)
const item = async (u, name) => (await as(u).get('/api/inventory/items')).body.find(i => i.name.includes(name))
const atWorker = async (u, supplier, itemId) => (await as(u).get(`/api/inventory/items/${itemId}`)).body.locations.find(l => l.location === `jw:${supplier.id}`)?.qty || 0

describe('who can use job work', () => {
  test('the Tradio portal does not have it; brands, Tradio staff and visitors are refused', async () => {
    const { mfr, brand } = await setup()
    for (const u of [brand, await makeAdmin()]) { assert.equal((await as(u).get('/api/jobwork')).status, 403, u.role); assert.equal((await send(u, {})).status, 403) }
    assert.equal((await req('GET', '/api/jobwork')).status, 401)
    delete process.env.PLATFORM_MODE
    assert.equal((await as(mfr).get('/api/jobwork')).status, 404)
  })
})

describe('sending goods to a job worker', () => {
  test('moves the stock to the job worker, numbers the challan and keeps its PDF', async () => {
    const { mfr, d, grey } = await setup()
    const r = await send(mfr, { supplierId: d.id, process: 'Dyeing', orderId: 'FIT-5117', expectedBack: '2026-10-25', vehicleNo: 'tn30 x 1', note: 'Navy, shade card attached', lines: [{ itemId: grey.id, qty: 100, rate: 200 }] })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.deepEqual([r.body.number, r.body.status, r.body.process, r.body.orderId, r.body.vehicleNo], [`JWC-TPR-${FY()}-0001`, 'open', 'Dyeing', 'FIT-5117', 'TN30 X 1'])
    assert.deepEqual([r.body.lines[0].qty, r.body.lines[0].outstanding, r.body.supplierName], [100, 100, 'Salem Dyeing Works'])
    const after = await item(mfr, 'GREY')
    assert.deepEqual([after.onHand, after.atJobWork], [0, 100])                              // still the factory's, now at the dyer
    assert.equal(await atWorker(mfr, d, grey.id), 100)
    const rows = await StockLedger.find({ refType: 'jobwork' }).lean()
    assert.deepEqual(rows.map(x => [x.type, x.location === 'store' ? 'store' : 'worker', x.qty, x.orderId]).sort(), [['jobwork_out', 'store', -100, 'FIT-5117'], ['jobwork_out', 'worker', 100, 'FIT-5117']])
    const doc = await Document.findOne({ jobworkId: r.body.id }).lean()
    assert.equal(doc.type, 'job_challan')
    const pdf = (await as(mfr).get(`/api/jobwork/${r.body.id}/pdf`)).body
    assert.equal(Buffer.from(pdf.dataUrl.split(',')[1], 'base64').subarray(0, 5).toString(), '%PDF-')
    assert.equal((await send(mfr, { supplierId: d.id, process: 'Dyeing', lines: [{ itemId: (await item(mfr, 'GREY')).id, qty: 0.001 }] })).status, 400)   // nothing left to send
  })

  test('cannot send more than the store holds, and says how much there is', async () => {
    const { mfr, d, grey } = await setup()
    const r = await send(mfr, { supplierId: d.id, process: 'Dyeing', lines: [{ itemId: grey.id, qty: 101 }] })
    assert.equal(r.status, 400)
    assert.match(r.body.error, /Only 100 kg of "Single jersey 180 GSM - GREY" in the store/)
    assert.equal(await JobWork.countDocuments({}), 0)
    assert.equal(await StockLedger.countDocuments({ refType: 'jobwork' }), 0)
  })

  test('two sends at the same moment cannot both take the last of it', async () => {
    const { mfr, d, grey } = await setup()
    const one = () => send(mfr, { supplierId: d.id, process: 'Dyeing', lines: [{ itemId: grey.id, qty: 70 }] })
    const both = await Promise.all([one(), one()])
    assert.deepEqual(both.map(r => r.status).sort(), [201, 400])
    assert.equal((await item(mfr, 'GREY')).onHand, 30)
    assert.equal(await JobWork.countDocuments({}), 1)
  })

  test('what a send must say: a job worker of the company\'s own, the work, items from its stock, sensible quantities and dates', async () => {
    const { mfr, d, grey } = await setup()
    const bad = async (body, re) => { const r = await send(mfr, { supplierId: d.id, process: 'Dyeing', lines: [{ itemId: grey.id, qty: 10 }], ...body }); assert.equal(r.status, 400, JSON.stringify(r.body)); assert.match(r.body.error, re) }
    await bad({ supplierId: undefined }, /Choose the job worker/)
    await bad({ supplierId: '64b000000000000000000000' }, /your suppliers/)
    await bad({ process: '' }, /what work/)
    await bad({ orderId: 'NOT-MINE' }, /your orders/)
    await bad({ lines: [] }, /what is being sent/)
    await bad({ lines: [{ itemId: grey.id, qty: 0 }] }, /more than zero/)
    await bad({ lines: [{ itemId: '64b000000000000000000000', qty: 1 }] }, /stock list/)
    await bad({ lines: [{ itemId: grey.id, qty: 1, rate: -5 }] }, /rate/)
    await bad({ sentOn: '2026-10-12', expectedBack: '2026-10-01' }, /before it is sent/)
    await bad({ sentOn: 'soon' }, /date/)
    assert.equal(await JobWork.countDocuments({}), 0)
  })
})

describe('goods coming back', () => {
  async function sent() {
    const s = await setup()
    const job = (await send(s.mfr, { supplierId: s.d.id, process: 'Dyeing', expectedBack: '2026-10-25', lines: [{ itemId: s.grey.id, qty: 100, rate: 200 }] })).body
    return { ...s, job }
  }
  const back = (u, job, body) => as(u).post(`/api/jobwork/${job.id}/return`, body)

  test('dyed cloth comes back for grey: the job worker\'s balance goes down, the store gets the new item, the loss is plain to see', async () => {
    const { mfr, d, grey, job } = await sent()
    const lineId = job.lines[0].lineId
    const first = await back(mfr, job, { lines: [{ lineId, inputQty: 60, outputs: [{ description: 'Single jersey 180 GSM - NAVY', unit: 'kg', qty: 55 }] }], note: 'Lorry 1' })
    assert.equal(first.status, 200, JSON.stringify(first.body))
    assert.deepEqual([first.body.status, first.body.lines[0].returnedQty, first.body.lines[0].outstanding], ['partially_returned', 60, 40])
    assert.equal(await atWorker(mfr, d, grey.id), 40)
    const navy = await item(mfr, 'NAVY')
    assert.deepEqual([navy.onHand, navy.category, navy.unit], [55, 'fabric', 'kg'])
    const last = await back(mfr, job, { lines: [{ lineId, inputQty: 40, outputs: [{ itemId: navy.id, qty: 37 }] }] })
    assert.deepEqual([last.body.status, last.body.lines[0].outstanding], ['closed', 0])
    assert.equal(await atWorker(mfr, d, grey.id), 0)
    assert.equal((await item(mfr, 'NAVY')).onHand, 92)                                        // 100 kg of grey became 92 kg of dyed cloth
    assert.equal(last.body.returns.length, 2)
    assert.deepEqual(last.body.returns[0].lines[0].outputs.map(o => [o.name, o.qty]), [['Single jersey 180 GSM - NAVY', 55]])
    assert.equal((await as(mfr).get('/api/jobwork?open=1')).body.length, 0)
  })

  test('cannot account for more than is out, nor for a line twice in one delivery, nor with nothing back', async () => {
    const { mfr, job } = await sent()
    const lineId = job.lines[0].lineId
    const bad = async (lines, re) => { const r = await back(mfr, job, { lines }); assert.equal(r.status, 400, JSON.stringify(r.body)); assert.match(r.body.error, re) }
    const out = [{ description: 'Navy', qty: 10 }]
    await bad([{ lineId, inputQty: 101, outputs: out }], /only 100 kg is still with the job worker/)
    await bad([{ lineId: 'nope', inputQty: 1, outputs: out }], /not on this challan/)
    await bad([{ lineId, inputQty: 1, outputs: out }, { lineId, inputQty: 1, outputs: out }], /each line once/)
    await bad([{ lineId, inputQty: 0, outputs: out }], /how much/)
    await bad([{ lineId, inputQty: 5, outputs: [] }], /what came back/)
    await bad([{ lineId, inputQty: 5, outputs: [{ description: 'Navy', qty: 0 }] }], /more than zero/)
    await bad([{ lineId, inputQty: 5, outputs: [{ qty: 5 }] }], /say what came back/i)
    await bad([{ lineId, inputQty: 5, outputs: [{ itemId: '64b000000000000000000000', qty: 5 }] }], /stock list/)
    assert.equal((await JobWork.findById(job.id).lean()).returns.length, 0)
  })

  test('two people recording the same delivery at once record it once', async () => {
    const { mfr, d, grey, job } = await sent()
    const lineId = job.lines[0].lineId
    const one = () => back(mfr, job, { lines: [{ lineId, inputQty: 100, outputs: [{ description: 'Single jersey 180 GSM - NAVY', unit: 'kg', qty: 90 }] }] })
    const both = await Promise.all([one(), one()])
    assert.equal(both.filter(r => r.status === 200).length, 1, JSON.stringify(both.map(r => [r.status, r.body.error])))
    assert.ok(both.some(r => r.status === 400 || r.status === 409))
    assert.equal(await atWorker(mfr, d, grey.id), 0)
    assert.equal((await item(mfr, 'NAVY')).onHand, 90)                                         // not 180
    assert.equal((await JobWork.findById(job.id).lean()).returns.length, 1)
  })

  test('a finished challan expects nothing more', async () => {
    const { mfr, job } = await sent()
    await back(mfr, job, { lines: [{ lineId: job.lines[0].lineId, inputQty: 100, outputs: [{ description: 'Navy', unit: 'kg', qty: 95 }] }] })
    assert.equal((await back(mfr, job, { lines: [{ lineId: job.lines[0].lineId, inputQty: 1, outputs: [{ description: 'Navy', qty: 1 }] }] })).status, 409)
  })
})

describe('writing off and cancelling', () => {
  async function sent() {
    const s = await setup()
    const job = (await send(s.mfr, { supplierId: s.d.id, process: 'Dyeing', lines: [{ itemId: s.grey.id, qty: 100 }] })).body
    return { ...s, job }
  }

  test('what is still out can be written off with a reason, and the challan closes', async () => {
    const { mfr, d, grey, job } = await sent()
    await as(mfr).post(`/api/jobwork/${job.id}/return`, { lines: [{ lineId: job.lines[0].lineId, inputQty: 60, outputs: [{ description: 'Navy', unit: 'kg', qty: 55 }] }] })
    assert.equal((await as(mfr).post(`/api/jobwork/${job.id}/close`, {})).status, 400)         // a reason is needed
    const r = await as(mfr).post(`/api/jobwork/${job.id}/close`, { reason: 'Dyer lost 40 kg in a fire; agreed to credit' })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual([r.body.status, r.body.lines[0].writtenOffQty, r.body.lines[0].outstanding, r.body.closedReason], ['closed', 40, 0, 'Dyer lost 40 kg in a fire; agreed to credit'])
    assert.equal(await atWorker(mfr, d, grey.id), 0)
    const adj = await StockLedger.find({ refType: 'jobwork', type: 'adjustment' }).lean()
    assert.deepEqual(adj.map(x => [x.qty, x.location]), [[-40, `jw:${d.id}`]])
    assert.equal((await as(mfr).post(`/api/jobwork/${job.id}/close`, { reason: 'again' })).status, 409)
  })

  test('sent in error: before anything has come back it can be cancelled and the goods go back to the store', async () => {
    const { mfr, d, grey, job } = await sent()
    assert.equal((await as(mfr).post(`/api/jobwork/${job.id}/cancel`, {})).status, 400)
    const r = await as(mfr).post(`/api/jobwork/${job.id}/cancel`, { reason: 'Wrong dyer' })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual([r.body.status, r.body.cancelReason], ['cancelled', 'Wrong dyer'])
    assert.deepEqual([(await item(mfr, 'GREY')).onHand, await atWorker(mfr, d, grey.id)], [100, 0])
    const pdf = (await as(mfr).get(`/api/jobwork/${job.id}/pdf`)).body                         // drawn again, marked cancelled
    assert.equal(Buffer.from(pdf.dataUrl.split(',')[1], 'base64').subarray(0, 5).toString(), '%PDF-')
    assert.equal((await as(mfr).post(`/api/jobwork/${job.id}/cancel`, { reason: 'again' })).status, 409)
  })

  test('once goods have come back it can only be closed, not cancelled', async () => {
    const { mfr, job } = await sent()
    await as(mfr).post(`/api/jobwork/${job.id}/return`, { lines: [{ lineId: job.lines[0].lineId, inputQty: 10, outputs: [{ description: 'Navy', unit: 'kg', qty: 9 }] }] })
    assert.equal((await as(mfr).post(`/api/jobwork/${job.id}/cancel`, { reason: 'x' })).status, 409)
  })
})

describe('who holds what', () => {
  test('lists every job worker with goods still out, what, and which challans are overdue', async () => {
    const { mfr, d, grey } = await setup()
    const other = await dyer(mfr, { name: 'Erode Prints', email: 'p@erode.test' })
    await send(mfr, { supplierId: d.id, process: 'Dyeing', sentOn: '2026-09-01', expectedBack: '2026-09-10', lines: [{ itemId: grey.id, qty: 30 }] })
    await send(mfr, { supplierId: d.id, process: 'Dyeing', sentOn: '2026-10-12', expectedBack: '2999-01-01', lines: [{ itemId: grey.id, qty: 20 }] })
    await send(mfr, { supplierId: other.id, process: 'Printing', lines: [{ itemId: grey.id, qty: 10 }] })
    const out = (await as(mfr).get('/api/jobwork/outstanding')).body
    assert.deepEqual(out.map(o => [o.supplierName, o.jobs, o.overdue, o.items.map(i => [i.name, i.qty])]), [
      ['Salem Dyeing Works', 2, 1, [['Single jersey 180 GSM - GREY', 50]]],                      // first the one with something overdue
      ['Erode Prints', 1, 0, [['Single jersey 180 GSM - GREY', 10]]],
    ])
    const list = (await as(mfr).get('/api/jobwork?open=1')).body
    assert.equal(list.filter(j => j.overdue).length, 1)
    assert.equal((await as(mfr).get(`/api/inventory/items/${grey.id}`)).body.locations.length, 3)       // the store and two job workers
  })
})

describe('photos, documents and the live feed', () => {
  test('photos of the goods are kept while nothing has come back; the PDF is a system document the brand never receives', async () => {
    const { mfr, brand, d, grey } = await setup()
    const job = (await send(mfr, { supplierId: d.id, process: 'Dyeing', orderId: 'FIT-5117', lines: [{ itemId: grey.id, qty: 10 }] })).body
    const photo = await as(mfr).post(`/api/jobwork/${job.id}/photos`, { dataUrl: PHOTO, kind: 'goods' })
    assert.equal(photo.status, 201, JSON.stringify(photo.body))
    assert.equal((await as(mfr).get(`/api/jobwork/${job.id}/photos`)).body.length, 1)
    assert.equal((await as(mfr).get(`/api/jobwork/${job.id}/photos/${photo.body.id}`)).body.dataUrl, PHOTO)
    assert.equal((await as(mfr).post(`/api/jobwork/${job.id}/photos/${photo.body.id}/delete`)).status, 200)
    const again = (await as(mfr).post(`/api/jobwork/${job.id}/photos`, { dataUrl: PHOTO })).body
    await as(mfr).post(`/api/jobwork/${job.id}/return`, { lines: [{ lineId: job.lines[0].lineId, inputQty: 5, outputs: [{ description: 'Navy', unit: 'kg', qty: 4 }] }] })
    assert.equal((await as(mfr).post(`/api/jobwork/${job.id}/photos/${again.id}/delete`)).status, 409)
    assert.equal(await Attachment.countDocuments({ refType: 'jobwork' }), 1)

    const doc = await Document.findOne({ jobworkId: job.id })
    await Document.updateOne({ _id: doc._id }, { $set: { orderId: 'FIT-5117' } })
    assert.equal((await as(mfr).post('/api/documents', { type: 'job_challan', name: 'x', orderId: 'FIT-5117', externalUrl: 'https://example.com/x' })).status, 400)
    assert.equal((await as(mfr).post(`/api/documents/${doc._id}`, { name: 'renamed' })).status, 409)
    assert.equal((await as(mfr).post(`/api/documents/${doc._id}/delete`)).status, 409)
    assert.equal((await as(brand).get('/api/documents')).body.some(x => x.type === 'job_challan'), false)
    assert.equal((await as(brand).get(`/api/documents/${doc._id}/data`)).status, 404)
  })

  test('the live feed\'s job work version moves only for the company that sent something', async () => {
    const a = await factory({ code: 'AAA' }), b = await factory({ code: 'BBB' })
    const v = async u => (await as(u).get('/api/floor/feed')).body.versions.jobwork
    const [a0, b0] = [await v(a), await v(b)]
    const da = await dyer(a)
    const g = (await as(a).post('/api/grns', { supplierName: 'M', lines: [{ description: 'Grey', unit: 'kg', qty: 10 }] })).body
    await as(a).post(`/api/grns/${g.id}/post`)
    await send(a, { supplierId: da.id, process: 'Dyeing', lines: [{ itemId: (await as(a).get('/api/inventory/items')).body[0].id, qty: 5 }] })
    assert.notEqual(await v(a), a0)
    assert.equal(await v(b), b0)
  })
})
