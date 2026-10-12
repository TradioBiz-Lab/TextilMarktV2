// Kriyaa and purchasing: looking up suppliers and purchase orders, drafting one, and sending one.
// Every call goes through the caller's own session (so another company's data stays out of reach),
// inputs from the model are strictly shaped, and sending needs a human confirmation the server can see.
import test, { before, after, beforeEach, afterEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, tokenFor, as } from './helpers/client.js'
import { makeAdmin, makeBuyer, makeMfr } from './helpers/factories.js'
import { Supplier } from '../src/models/Supplier.js'
import { PurchaseOrder } from '../src/models/PurchaseOrder.js'
import { setMailerForTests } from '../src/lib/email.js'
import { TOOL_HANDLERS, toolsFor } from '../src/routes/assistant.js'

before(async () => {
  await startTestDb()
  process.env.PORT = new URL(await startServer()).port
  await Supplier.init()
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
  { role: 'user', content: 'Send the Coimbatore PO' },
  { role: 'assistant', content: 'I will email PO-1 for Rs 21,000 to sales@cknit.test. Please confirm.' },
  { role: 'user', content: 'yes, confirm' },
]
const ctx = (user, conversation = CONFIRMED) => ({ cookie: `tradio_token=${tokenFor(user)}`, user: { id: String(user._id), role: user.role }, conversation })

async function stock(mfr) {
  const s = (await as(mfr).post('/api/suppliers', { name: 'Coimbatore Knit Fabrics', email: 'sales@cknit.test', city: 'Coimbatore' })).body
  return s
}
const draftInput = (s, o = {}) => ({ supplierId: s.id, expectedDate: '2026-11-05', lines: [{ description: 'Single jersey', qty: 100, unit: 'kg', rate: 200, taxPct: 5 }], ...o })

describe('who is offered the purchasing tools', () => {
  const names = u => toolsFor(u).map(t => t.name)
  const tools = ['list_suppliers', 'list_purchase_orders', 'get_purchase_order', 'create_draft_po', 'send_purchase_order']

  test('only a manufacturer in the standalone product', () => {
    for (const t of tools) assert.ok(names({ role: 'manufacturer' }).includes(t), t)
    for (const role of ['buyer', 'admin']) for (const t of tools) assert.ok(!names({ role }).includes(t), `${role} must not get ${t}`)
    delete process.env.PLATFORM_MODE
    for (const t of tools) assert.ok(!names({ role: 'manufacturer' }).includes(t), `the Tradio portal must not offer ${t}`)
  })
})

describe('looking things up', () => {
  test('lists the factory\'s suppliers and purchase orders, compactly', async () => {
    const mfr = await makeMfr(), s = await stock(mfr)
    const created = await TOOL_HANDLERS.create_draft_po(draftInput(s), ctx(mfr))
    assert.equal(created.ok, true, JSON.stringify(created))
    const suppliers = await TOOL_HANDLERS.list_suppliers({}, ctx(mfr))
    assert.deepEqual(suppliers.data.map(x => [x.name, x.city]), [['Coimbatore Knit Fabrics', 'Coimbatore']])
    assert.ok(suppliers.data[0].supplierId)
    const pos = await TOOL_HANDLERS.list_purchase_orders({}, ctx(mfr))
    assert.equal(pos.data.length, 1)
    assert.deepEqual([pos.data[0].supplier, pos.data[0].status, pos.data[0].total], ['Coimbatore Knit Fabrics', 'draft', 21000])
    assert.equal((await TOOL_HANDLERS.list_purchase_orders({ status: 'sent' }, ctx(mfr))).data.length, 0)
    const one = await TOOL_HANDLERS.get_purchase_order({ poNumber: pos.data[0].poNumber }, ctx(mfr))
    assert.deepEqual([one.data.lines[0].description, one.data.lines[0].amount, one.data.totals.grandTotal], ['Single jersey', 20000, 21000])
  })

  test('another factory\'s purchase order is not found, never shown', async () => {
    const a = await makeMfr(), b = await makeMfr(), s = await stock(a)
    const made = await TOOL_HANDLERS.create_draft_po(draftInput(s), ctx(a))
    const r = await TOOL_HANDLERS.get_purchase_order({ poNumber: made.data.id }, ctx(b))
    assert.equal(r.ok, false)
    assert.equal(r.status, 404)
    assert.equal((await TOOL_HANDLERS.list_purchase_orders({}, ctx(b))).data.length, 0)
  })

  test('a brand\'s session cannot use them even if the tool were called', async () => {
    const mfr = await makeMfr(), brand = await makeBuyer(), s = await stock(mfr)
    assert.equal((await TOOL_HANDLERS.list_suppliers({}, ctx(brand))).status, 403)
    assert.equal((await TOOL_HANDLERS.create_draft_po(draftInput(s), ctx(brand))).status, 403)
    void (await makeAdmin())
  })
})

describe('what the model is allowed to send', () => {
  test('a PO number that is not shaped like one never reaches a URL', async () => {
    const mfr = await makeMfr()
    for (const poNumber of ['../orders', 'PO-1', 'PO-TPR-2627-1', 'PO-TPR-2627-0001/send', 'PO-TPR-2627-0001?x=1', '', 5, undefined]) {
      for (const tool of ['get_purchase_order', 'send_purchase_order']) {
        const r = await TOOL_HANDLERS[tool]({ poNumber }, ctx(mfr))
        assert.equal(r.status, 400, `${tool} ${JSON.stringify(poNumber)}`)
        assert.match(r.data.error, /Invalid poNumber/)
      }
    }
  })

  test('a draft is built only from allowed line fields, and the server does the sums', async () => {
    const mfr = await makeMfr(), s = await stock(mfr)
    const r = await TOOL_HANDLERS.create_draft_po(draftInput(s, { lines: [{ description: 'Zip', qty: 10, rate: 5, amount: 99999, lineTotal: 99999, materialRef: { orderId: 'X' }, itemId: 'nope' }] }), ctx(mfr))
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.data.lines[0].amount, 50)
    assert.equal(r.data.lines[0].materialRef, null)
    assert.equal(r.data.lines[0].itemId, null)
  })

  test('refuses nonsense before calling anything', async () => {
    const mfr = await makeMfr(), s = await stock(mfr)
    const bad = async (input, field) => { const r = await TOOL_HANDLERS.create_draft_po(input, ctx(mfr)); assert.equal(r.status, 400, field); assert.match(r.data.error, new RegExp(field)) }
    await bad({ lines: [{ description: 'x', qty: 1 }] }, 'supplierId')
    await bad({ supplierId: 'not-an-id', lines: [{ description: 'x', qty: 1 }] }, 'supplierId')
    await bad(draftInput(s, { lines: [] }), 'lines')
    await bad(draftInput(s, { lines: Array.from({ length: 51 }, () => ({ description: 'x', qty: 1 })) }), 'lines')
    await bad(draftInput(s, { lines: ['x'] }), 'lines')
    await bad(draftInput(s, { expectedDate: 'tomorrow' }), 'expectedDate')
    assert.equal(await PurchaseOrder.countDocuments(), 0)
  })
})

describe('sending needs a confirmation the server can see', () => {
  test('without one, nothing is emailed and the model is told what to do', async () => {
    const mfr = await makeMfr(), s = await stock(mfr)
    const po = (await TOOL_HANDLERS.create_draft_po(draftInput(s), ctx(mfr))).data
    for (const conv of [
      [{ role: 'user', content: 'send it' }],
      [{ role: 'user', content: 'send it' }, { role: 'assistant', content: 'Shall I send it? Please confirm.' }, { role: 'user', content: 'no, wait' }],
    ]) {
      const r = await TOOL_HANDLERS.send_purchase_order({ poNumber: po.id }, ctx(mfr, conv))
      assert.equal(r.status, 409)
      assert.match(r.data.error, /CONFIRMATION REQUIRED/)
    }
    assert.equal(sent.length, 0)
    assert.equal((await PurchaseOrder.findById(po.id).lean()).status, 'draft')
  })

  test('once the person confirms, the supplier is emailed and the PO is sent', async () => {
    const mfr = await makeMfr(), s = await stock(mfr)
    const po = (await TOOL_HANDLERS.create_draft_po(draftInput(s), ctx(mfr))).data
    const r = await TOOL_HANDLERS.send_purchase_order({ poNumber: po.id, message: 'Please confirm the date' }, ctx(mfr))
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.data.status, 'sent')
    assert.equal(sent.length, 1)
    assert.deepEqual(sent[0].to, ['sales@cknit.test'])
    assert.match(sent[0].html, /Please confirm the date/)
  })

  test('another factory cannot send it, even with a confirmation', async () => {
    const a = await makeMfr(), b = await makeMfr(), s = await stock(a)
    const po = (await TOOL_HANDLERS.create_draft_po(draftInput(s), ctx(a))).data
    const r = await TOOL_HANDLERS.send_purchase_order({ poNumber: po.id }, ctx(b))
    assert.equal(r.ok, false)
    assert.equal(r.status, 404)
    assert.equal(sent.length, 0)
  })
})
