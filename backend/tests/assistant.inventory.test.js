// Kriyaa and the store: stock, goods received, job work and what an order used. Every call goes through the caller's own
// session (another company's stock stays out of reach), model input is strictly shaped, a draft note adds nothing to
// stock, and the two writes that change stock (posting a note, issuing to an order) need a human confirmation the
// server can see.
import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, tokenFor, as } from './helpers/client.js'
import { makeAdmin, makeBuyer, makeMfr, makeOrder, setOrg, link } from './helpers/factories.js'
import { Supplier } from '../src/models/Supplier.js'
import { InventoryItem } from '../src/models/InventoryItem.js'
import { StockLedger } from '../src/models/StockLedger.js'
import { Grn } from '../src/models/Grn.js'
import { StockIssue } from '../src/models/StockIssue.js'
import { JobWork } from '../src/models/JobWork.js'
import { TOOL_HANDLERS, toolsFor } from '../src/routes/assistant.js'

before(async () => {
  await startTestDb()
  process.env.PORT = new URL(await startServer()).port
  for (const m of [Supplier, InventoryItem, StockLedger, Grn, StockIssue, JobWork]) await m.init()
})
after(async () => { delete process.env.PLATFORM_MODE; await stopServer(); await stopTestDb() })
beforeEach(async () => { await clearDb(); process.env.PLATFORM_MODE = 'standalone' })

const CONFIRMED = [{ role: 'user', content: 'Post it' }, { role: 'assistant', content: 'I will add 100 kg of black fleece to the store. Please confirm.' }, { role: 'user', content: 'yes, confirm' }]
const ASKED = [{ role: 'user', content: 'Post it' }]
const ctx = (user, conversation = CONFIRMED) => ({ cookie: `tradio_token=${tokenFor(user)}`, user: { id: String(user._id), role: user.role }, conversation })

async function world() {
  const mfr = await makeMfr({ code: 'TPR', company: 'TPR Textiles' })
  await setOrg(mfr, { profile: { legalName: 'TPR Pvt Ltd', stateCode: '33' } })
  const brand = await makeBuyer({ code: 'FIT', company: 'Fitleasure' })
  await link(brand, mfr)
  await makeOrder({ id: 'FIT-HOOD', buyer: brand, mfrs: [mfr], product: 'Zip hoodie', totalQty: 900 })
  return { mfr, brand }
}
async function stocked(mfr) {
  const g = (await as(mfr).post('/api/grns', { supplierName: 'Mill', lines: [{ description: 'Black fleece', unit: 'kg', qty: 100 }, { description: 'Zip', unit: 'pcs', qty: 3 }] })).body
  assert.equal((await as(mfr).post(`/api/grns/${g.id}/post`)).status, 200)
  const items = (await as(mfr).get('/api/inventory/items')).body
  return { fleece: items.find(i => i.name === 'Black fleece'), zip: items.find(i => i.name === 'Zip') }
}

describe('who is offered these tools', () => {
  const names = u => toolsFor(u).map(t => t.name)
  const stockTools = ['stock_balance', 'list_goods_received', 'job_work_status', 'order_usage', 'create_goods_received_draft', 'post_goods_received', 'issue_stock']
  test('a factory gets all of them; brands, Tradio staff and the Tradio portal get none', () => {
    for (const t of stockTools) assert.ok(names({ role: 'manufacturer' }).includes(t), t)
    for (const role of ['buyer', 'admin']) for (const t of stockTools) assert.ok(!names({ role }).includes(t), `${role} must not get ${t}`)
    delete process.env.PLATFORM_MODE
    for (const t of stockTools) assert.ok(!names({ role: 'manufacturer' }).includes(t), `the Tradio portal must not offer ${t}`)
  })
})

describe('reading the store', () => {
  test('stock_balance lists items with where they are, can search and show only what is low', async () => {
    const { mfr } = await world()
    const { fleece } = await stocked(mfr)
    await as(mfr).post(`/api/inventory/items/${fleece.id}`, { reorderLevel: 500 })
    const all = await TOOL_HANDLERS.stock_balance({}, ctx(mfr))
    assert.equal(all.status, 200)
    assert.deepEqual(all.data.items.map(i => [i.name, i.inTheStore, i.belowTheLevelToKeep]), [['Black fleece', 100, true], ['Zip', 3, undefined]])
    assert.ok(all.data.items[0].itemId)
    assert.deepEqual((await TOOL_HANDLERS.stock_balance({ search: 'zip' }, ctx(mfr))).data.items.map(i => i.name), ['Zip'])
    assert.deepEqual((await TOOL_HANDLERS.stock_balance({ lowOnly: true }, ctx(mfr))).data.items.map(i => i.name), ['Black fleece'])
  })

  test('list_goods_received, job_work_status and order_usage give compact answers', async () => {
    const { mfr } = await world()
    const { fleece } = await stocked(mfr)
    await as(mfr).post('/api/grns', { supplierName: 'Another mill', lines: [{ description: 'Rib', unit: 'kg', qty: 5 }] })
    const notes = await TOOL_HANDLERS.list_goods_received({}, ctx(mfr))
    assert.deepEqual(notes.data.map(n => [n.status, n.from]).sort(), [['draft', 'Another mill'], ['posted', 'Mill']])
    assert.deepEqual((await TOOL_HANDLERS.list_goods_received({ status: 'draft' }, ctx(mfr))).data.map(n => n.status), ['draft'])
    assert.equal((await TOOL_HANDLERS.list_goods_received({ status: 'nonsense' }, ctx(mfr))).status, 400)

    const dyer = (await as(mfr).post('/api/suppliers', { name: 'Salem Dyers', type: 'dyer', email: 'd@x.test' })).body
    assert.equal((await as(mfr).post('/api/jobwork', { supplierId: dyer.id, process: 'Dyeing', sentOn: '2026-08-01', expectedBack: '2026-09-01', lines: [{ itemId: fleece.id, qty: 40 }] })).status, 201)
    const jw = await TOOL_HANDLERS.job_work_status({}, ctx(mfr))
    assert.deepEqual(jw.data.withJobWorkers.map(w => [w.jobWorker, w.overdue, w.goods]), [['Salem Dyers', 1, ['40 kg Black fleece']]])
    assert.equal(jw.data.challans[0].overdue, true)

    await as(mfr).post('/api/inventory/issues', { orderId: 'FIT-HOOD', lines: [{ itemId: fleece.id, qty: 10 }] })
    const usage = await TOOL_HANDLERS.order_usage({ orderId: 'FIT-HOOD' }, ctx(mfr))
    assert.deepEqual([usage.status, usage.data.hasFrozenBillOfMaterials, usage.data.issuedButNotOnTheBill], [200, false, ['10 kg Black fleece']])
    assert.equal((await TOOL_HANDLERS.order_usage({ orderId: '../x' }, ctx(mfr))).status, 400)
  })
})

describe('a draft note, then posting it', () => {
  test('a draft needs no confirmation and adds nothing to stock; the model\'s input is cut down to the note\'s own fields', async () => {
    const { mfr } = await world()
    const r = await TOOL_HANDLERS.create_goods_received_draft({
      supplierName: 'Sri Murugan Trims', challanNo: 'SM-1', lines: [{ description: 'Zip 5', qty: 200, unit: 'pcs', hacked: true, itemId: '64b000000000000000000000' }], status: 'posted', number: 'GRN-FAKE-1', ownerOrgId: 'x',
    }, ctx(mfr, ASKED))
    assert.equal(r.status, 201, JSON.stringify(r.data))
    assert.deepEqual([r.data.status, r.data.number, r.data.supplierName, r.data.lines[0].description], ['draft', null, 'Sri Murugan Trims', 'Zip 5'])
    assert.equal(await StockLedger.countDocuments({}), 0)
    assert.equal((await TOOL_HANDLERS.create_goods_received_draft({ poNumber: 'nope' }, ctx(mfr))).status, 400)
    assert.equal((await TOOL_HANDLERS.create_goods_received_draft({ lines: 'many' }, ctx(mfr))).status, 400)
  })

  test('posting needs the person\'s own confirmation, and then adds the goods to stock', async () => {
    const { mfr } = await world()
    const draft = (await TOOL_HANDLERS.create_goods_received_draft({ supplierName: 'Mill', lines: [{ description: 'Black fleece', qty: 100, unit: 'kg' }] }, ctx(mfr))).data
    const refused = await TOOL_HANDLERS.post_goods_received({ grnId: draft.id }, ctx(mfr, ASKED))
    assert.equal(refused.status, 409)
    assert.match(refused.data.error, /CONFIRMATION REQUIRED/)
    assert.equal(await StockLedger.countDocuments({}), 0)
    const done = await TOOL_HANDLERS.post_goods_received({ grnId: draft.id }, ctx(mfr))
    assert.equal(done.status, 200, JSON.stringify(done.data))
    assert.match(done.data.number, /^GRN-TPR-/)
    assert.equal((await as(mfr).get('/api/inventory/items')).body[0].onHand, 100)
    assert.equal((await TOOL_HANDLERS.post_goods_received({ grnId: '../x' }, ctx(mfr))).status, 400)
  })
})

describe('issuing stock to an order', () => {
  test('needs the person\'s confirmation, refuses more than the store holds, and records the order', async () => {
    const { mfr } = await world()
    const { fleece } = await stocked(mfr)
    const line = qty => ({ orderId: 'FIT-HOOD', lines: [{ itemId: fleece.id, qty, injected: 'x' }], note: 'For cutting' })
    const refused = await TOOL_HANDLERS.issue_stock(line(30), ctx(mfr, ASKED))
    assert.equal(refused.status, 409)
    assert.match(refused.data.error, /CONFIRMATION REQUIRED/)
    assert.equal(await StockIssue.countDocuments({}), 0)
    const tooMuch = await TOOL_HANDLERS.issue_stock(line(500), ctx(mfr))
    assert.equal(tooMuch.status, 400)
    assert.match(tooMuch.data.error, /Only 100 kg/)
    const ok = await TOOL_HANDLERS.issue_stock(line(30), ctx(mfr))
    assert.equal(ok.status, 201, JSON.stringify(ok.data))
    assert.deepEqual([ok.data.orderId, ok.data.lines[0].qty, ok.data.note], ['FIT-HOOD', 30, 'For cutting'])
    assert.equal((await as(mfr).get('/api/inventory/items')).body.find(i => i.name === 'Black fleece').onHand, 70)
    for (const bad of [{ orderId: '../x', lines: [{ itemId: fleece.id, qty: 1 }] }, { orderId: 'FIT-HOOD', lines: [] }, { orderId: 'FIT-HOOD', lines: [{ itemId: 'not-an-id', qty: 1 }] }])
      assert.equal((await TOOL_HANDLERS.issue_stock(bad, ctx(mfr))).status, 400)
  })
})

describe('one company\'s tools never reach another\'s store', () => {
  test('another factory sees none of it, and cannot post its note or issue its stock', async () => {
    const { mfr } = await world()
    const { fleece } = await stocked(mfr)
    const draft = (await as(mfr).post('/api/grns', { supplierName: 'Mill', lines: [{ description: 'Black fleece', unit: 'kg', qty: 5 }] })).body
    const rival = await makeMfr({ code: 'RVL' })
    await setOrg(rival, { profile: { legalName: 'RVL', stateCode: '33' } })
    assert.deepEqual((await TOOL_HANDLERS.stock_balance({}, ctx(rival))).data.items, [])
    assert.deepEqual((await TOOL_HANDLERS.list_goods_received({}, ctx(rival))).data, [])
    assert.equal((await TOOL_HANDLERS.post_goods_received({ grnId: draft.id }, ctx(rival))).status, 404)
    assert.equal((await TOOL_HANDLERS.issue_stock({ orderId: 'FIT-HOOD', lines: [{ itemId: fleece.id, qty: 1 }] }, ctx(rival))).status, 400)
    assert.equal((await TOOL_HANDLERS.order_usage({ orderId: 'FIT-HOOD' }, ctx(rival))).status, 404)
    assert.equal(await StockIssue.countDocuments({}), 0)
    assert.ok(makeAdmin)
  })
})
