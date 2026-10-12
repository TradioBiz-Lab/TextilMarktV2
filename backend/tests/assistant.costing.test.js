// Kriyaa and the bill of materials, the shopping list and cost sheets. Every call goes through the caller's own
// session (so another company's data stays out of reach), model input is strictly shaped, and the two writes
// (draft POs from the shopping list, sharing a cost sheet) need a human confirmation the server can see.
import test, { before, after, beforeEach, afterEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, tokenFor, as } from './helpers/client.js'
import { makeAdmin, makeBuyer, makeMfr, makeOrder, makeMasterOrder, setOrg, link } from './helpers/factories.js'
import { Supplier } from '../src/models/Supplier.js'
import { PurchaseOrder } from '../src/models/PurchaseOrder.js'
import { CostSheet } from '../src/models/CostSheet.js'
import { Bom } from '../src/models/Bom.js'
import { Order } from '../src/models/Order.js'
import { setMailerForTests } from '../src/lib/email.js'
import { TOOL_HANDLERS, toolsFor } from '../src/routes/assistant.js'

before(async () => {
  await startTestDb()
  process.env.PORT = new URL(await startServer()).port
  await Supplier.init(); await Bom.init(); await CostSheet.init()
})
after(async () => { delete process.env.PLATFORM_MODE; setMailerForTests(null); await stopServer(); await stopTestDb() })

let sent
beforeEach(async () => {
  await clearDb(); process.env.PLATFORM_MODE = 'standalone'
  sent = []
  setMailerForTests({ emails: { send: async p => { sent.push(p); return { data: { id: 'x' }, error: null } } } })
})
afterEach(() => setMailerForTests(null))

const CONFIRMED = [
  { role: 'user', content: 'Raise the POs' },
  { role: 'assistant', content: 'I will create draft POs for the mill and the zip shop. Please confirm.' },
  { role: 'user', content: 'yes, confirm' },
]
const ASKED = [{ role: 'user', content: 'Raise the POs' }]
const ctx = (user, conversation = CONFIRMED) => ({ cookie: `tradio_token=${tokenFor(user)}`, user: { id: String(user._id), role: user.role }, conversation })

/** A factory with a frozen BOM on a master order, a supplier for the cloth, and a customer. */
async function world() {
  const mfr = await makeMfr({ code: 'TPR', company: 'TPR Textiles' })
  await setOrg(mfr, { tradioEnabled: true, profile: { legalName: 'TPR Pvt Ltd', stateCode: '33' } })
  const brand = await makeBuyer({ code: 'FIT', company: 'Fitleasure' })
  await link(brand, mfr)
  const mo = await makeMasterOrder({ buyerId: brand._id, createdBy: brand._id, id: 'MO-FIT-FW26-001' })
  await makeOrder({ id: 'FIT-HOOD', buyer: brand, mfrs: [mfr], product: 'Zip hoodie', totalQty: 900, masterOrderId: mo._id })
  await Order.updateOne({ _id: 'FIT-HOOD' }, { $set: { colourways: [{ name: 'BLACK' }, { name: 'NAVY' }, { name: 'GREY' }] } })
  const mill = (await as(mfr).post('/api/suppliers', { name: 'Coimbatore Knit Fabrics', email: 'sales@cknit.test' })).body
  const b = (await as(mfr).post('/api/boms', { orderId: 'FIT-HOOD' })).body
  await as(mfr).post(`/api/boms/${b.id}`, { lines: [
    { section: 'fabric', item: 'Brushed fleece', unit: 'kg', consumption: 0.7, wastagePct: 5, rate: 400, supplierId: mill.id },
    { section: 'trims', item: 'Drawcord', unit: 'pcs', consumption: 1, rate: 7 },
  ] })
  assert.equal((await as(mfr).post(`/api/boms/${b.id}/freeze`)).status, 200)
  return { mfr, brand, mo, mill }
}
const sheetBody = (brand, extra = {}) => ({ brandId: String(brand._id), styleName: 'Zip hoodie', qty: 900, fabric: [{ name: 'Brushed fleece', consumption: 0.7, rate: 400 }], labour: { making: 80 }, ...extra })

describe('who is offered these tools', () => {
  const names = u => toolsFor(u).map(t => t.name)
  const factoryTools = ['get_bom', 'shopping_list', 'generate_draft_pos', 'share_cost_sheet', 'list_cost_sheets', 'get_cost_sheet']

  test('a factory gets all of them; a brand only reads cost sheets; Tradio staff and the Tradio portal get none', () => {
    for (const t of factoryTools) assert.ok(names({ role: 'manufacturer' }).includes(t), t)
    assert.deepEqual(names({ role: 'buyer' }).filter(n => factoryTools.includes(n)).sort(), ['get_cost_sheet', 'list_cost_sheets'])
    for (const t of factoryTools) assert.ok(!names({ role: 'admin' }).includes(t), `admin must not get ${t}`)
    delete process.env.PLATFORM_MODE
    for (const role of ['manufacturer', 'buyer']) for (const t of factoryTools) assert.ok(!names({ role }).includes(t), `the Tradio portal must not offer ${t} to a ${role}`)
  })

  test('nothing in the model\'s tool list can approve a cost sheet', () => {
    for (const role of ['manufacturer', 'buyer', 'admin']) assert.ok(!names({ role }).some(n => /approve/.test(n)), role)
  })
})

describe('reading the bill of materials and the shopping list', () => {
  test('get_bom gives the plan and every line worked, compactly', async () => {
    const { mfr } = await world()
    const r = await TOOL_HANDLERS.get_bom({ orderId: 'FIT-HOOD' }, ctx(mfr))
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.deepEqual([r.data.status, r.data.pieces, r.data.sizes], ['frozen', 900, ['S', 'M', 'L', 'XL', 'XXL']])
    const fleece = r.data.lines.find(l => l.item === 'Brushed fleece')
    assert.equal(fleece.supplier, 'Coimbatore Knit Fabrics')
    assert.equal(fleece.byColour.length, 3)
    assert.ok(fleece.toOrder > 0)
  })

  test('an order with no BOM says so, and another factory\'s order is not found', async () => {
    const { mfr, brand } = await world()
    await makeOrder({ id: 'FIT-TEE', buyer: brand, mfrs: [mfr] })
    assert.equal((await TOOL_HANDLERS.get_bom({ orderId: 'FIT-TEE' }, ctx(mfr))).data.hasBom, false)
    const rival = await makeMfr({ code: 'RVL' })
    assert.equal((await TOOL_HANDLERS.get_bom({ orderId: 'FIT-HOOD' }, ctx(rival))).status, 404)
  })

  test('shopping_list adds up what is still to order and flags what has no supplier', async () => {
    const { mfr } = await world()
    const r = await TOOL_HANDLERS.shopping_list({}, ctx(mfr))
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.data.itemsWithNoSupplier, 1)                  // the drawcord
    const black = r.data.rows.find(x => x.item === 'Brushed fleece' && x.colour === 'BLACK')
    assert.deepEqual([black.supplier, black.alreadyOnPurchaseOrders], ['Coimbatore Knit Fabrics', 0])
    assert.ok(black.stillToOrder > 0)
  })

  test('inputs from the model are strictly shaped', async () => {
    const { mfr } = await world()
    for (const bad of [{ orderId: '../x' }, { orderId: 42 }, {}]) assert.equal((await TOOL_HANDLERS.get_bom(bad, ctx(mfr))).ok, false)
    assert.equal((await TOOL_HANDLERS.shopping_list({ masterOrderId: '../../etc' }, ctx(mfr))).ok, false)
    assert.equal((await TOOL_HANDLERS.generate_draft_pos({ masterOrderId: 'a b' }, ctx(mfr))).ok, false)
  })
})

describe('raising draft purchase orders', () => {
  test('needs the user\'s own yes, and raises nothing without it', async () => {
    const { mfr } = await world()
    const asked = await TOOL_HANDLERS.generate_draft_pos({}, ctx(mfr, ASKED))
    assert.equal(asked.ok, false)
    assert.equal(asked.status, 409)
    assert.match(asked.data.error, /CONFIRMATION REQUIRED/)
    assert.equal(await PurchaseOrder.countDocuments({}), 0)
  })

  test('once confirmed, makes one draft per supplier and nothing is emailed', async () => {
    const { mfr, mo } = await world()
    const r = await TOOL_HANDLERS.generate_draft_pos({ masterOrderId: mo._id }, ctx(mfr))
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.data.created.length, 1)
    assert.equal(r.data.created[0].supplierName, 'Coimbatore Knit Fabrics')
    assert.equal(r.data.skipped.length, 1)                       // the drawcord has no supplier
    assert.equal((await PurchaseOrder.findById(r.data.created[0].id).lean()).status, 'draft')
    assert.equal(sent.length, 0)
  })

  test('a text in the user\'s message that only looks like a yes (a no) does not count', async () => {
    const { mfr } = await world()
    const r = await TOOL_HANDLERS.generate_draft_pos({}, ctx(mfr, [{ role: 'assistant', content: 'Please confirm.' }, { role: 'user', content: 'no, do not' }]))
    assert.equal(r.status, 409)
  })
})

describe('cost sheets', () => {
  async function withSheets() {
    const w = await world()
    const mine = (await as(w.mfr).post('/api/cost-sheets', sheetBody(w.brand))).body
    const sharedOne = (await as(w.mfr).post('/api/cost-sheets', sheetBody(w.brand, { styleName: 'Joggers' }))).body
    assert.equal((await as(w.mfr).post(`/api/cost-sheets/${sharedOne.id}/share`, {})).status, 200)
    await as(w.brand).post(`/api/cost-sheets/${sharedOne.id}/comments`, { text: 'Please lower the labour', kind: 'changes' })
    return { ...w, draft: mine, shared: sharedOne }
  }

  test('a factory lists all its own, a brand only what was shared with it', async () => {
    const { mfr, brand } = await withSheets()
    const own = await TOOL_HANDLERS.list_cost_sheets({}, ctx(mfr))
    assert.deepEqual(own.data.map(c => [c.style, c.status]).sort(), [['Joggers', 'commented'], ['Zip hoodie', 'draft']])
    const theirs = await TOOL_HANDLERS.list_cost_sheets({}, ctx(brand))
    assert.deepEqual(theirs.data.map(c => [c.style, c.status]), [['Joggers', 'commented']])
  })

  test('get_cost_sheet gives the build-up and the comments; a brand cannot read a draft; the factory\'s note stays out', async () => {
    const { mfr, brand, draft, shared } = await withSheets()
    await CostSheet.updateOne({ _id: shared.id }, { $set: { internalNote: 'our real margin' } })
    const r = await TOOL_HANDLERS.get_cost_sheet({ costSheetId: shared.id }, ctx(brand))
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.data.perPiece.price, shared.computed.price)
    assert.deepEqual(r.data.comments.map(c => [c.from, c.askedForChanges]), [['customer', true]])
    assert.ok(!JSON.stringify(r.data).includes('our real margin'))
    assert.equal((await TOOL_HANDLERS.get_cost_sheet({ costSheetId: draft.id }, ctx(brand))).status, 404)
    assert.equal((await TOOL_HANDLERS.get_cost_sheet({ costSheetId: draft.id }, ctx(mfr))).ok, true)
  })

  test('another company\'s sheets are not found, and ids are strictly shaped', async () => {
    const { shared } = await withSheets()
    const rival = await makeMfr({ code: 'RVL' }), other = await makeBuyer({ code: 'OTH' })
    for (const u of [rival, other]) {
      assert.equal((await TOOL_HANDLERS.get_cost_sheet({ costSheetId: shared.id }, ctx(u))).status, 404)
      assert.equal((await TOOL_HANDLERS.list_cost_sheets({}, ctx(u))).data.length, 0)
    }
    assert.equal((await TOOL_HANDLERS.get_cost_sheet({ costSheetId: '../x' }, ctx(rival))).ok, false)
    assert.equal((await TOOL_HANDLERS.share_cost_sheet({ costSheetId: 'nope' }, ctx(rival))).ok, false)
  })

  test('sharing needs the user\'s own yes, then tells the customer', async () => {
    const { mfr, brand, draft } = await withSheets()
    const asked = await TOOL_HANDLERS.share_cost_sheet({ costSheetId: draft.id }, ctx(mfr, ASKED))
    assert.equal(asked.status, 409)
    assert.match(asked.data.error, /CONFIRMATION REQUIRED/)
    assert.equal((await CostSheet.findById(draft.id).lean()).status, 'draft')
    const done = await TOOL_HANDLERS.share_cost_sheet({ costSheetId: draft.id, message: 'Prices valid till the 30th' }, ctx(mfr))
    assert.equal(done.ok, true, JSON.stringify(done))
    assert.equal(done.data.sheet.status, 'shared')
    assert.ok(sent.length > 0)
    assert.equal((await TOOL_HANDLERS.list_cost_sheets({}, ctx(brand))).data.length, 2)
  })

  test('a brand\'s session cannot share even if the tool were called, and Tradio staff cannot use any of it', async () => {
    const { brand, draft } = await withSheets()
    assert.equal((await TOOL_HANDLERS.share_cost_sheet({ costSheetId: draft.id }, ctx(brand))).ok, false)
    const admin = await makeAdmin()
    assert.equal((await TOOL_HANDLERS.list_cost_sheets({}, ctx(admin))).status, 403)
    assert.equal((await TOOL_HANDLERS.shopping_list({}, ctx(admin))).status, 403)
  })
})
