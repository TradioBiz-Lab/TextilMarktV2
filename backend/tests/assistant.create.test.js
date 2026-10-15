// Kriyaa setting up orders: creating a master order or an order by voice or text. Creating a record
// needs a human confirmation the server can see, the model never chooses an ID, and every call goes
// through the caller's own session, so the server's rules (connections, ownership) still decide.
import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, tokenFor } from './helpers/client.js'
import { makeAdmin, makeBuyer, makeMfr, link } from './helpers/factories.js'
import { Order } from '../src/models/Order.js'
import { MasterOrder } from '../src/models/MasterOrder.js'
import { TOOL_HANDLERS, toolsFor } from '../src/routes/assistant.js'

before(async () => {
  await startTestDb()
  process.env.PORT = new URL(await startServer()).port
})
after(async () => { delete process.env.PLATFORM_MODE; await stopServer(); await stopTestDb() })
beforeEach(async () => { await clearDb(); process.env.PLATFORM_MODE = 'standalone' })

const CONFIRMED = [
  { role: 'user', content: 'Create a sweatshirt order for Tiruppur' },
  { role: 'assistant', content: 'I will create 3000 heavy sweatshirts for Tiruppur Textiles, delivery 15 December. Please confirm.' },
  { role: 'user', content: 'yes, confirm' },
]
const ASKED_NOT_ANSWERED = [
  { role: 'user', content: 'Create a sweatshirt order' },
  { role: 'assistant', content: 'Shall I create it? Please confirm.' },
  { role: 'user', content: 'no, wait' },
]
const ctx = (user, conversation = CONFIRMED) => ({ cookie: `tradio_token=${tokenFor(user)}`, user: { id: String(user._id), role: user.role }, conversation })

async function world() {
  const brand = await makeBuyer({ code: 'ZAR' }), mfr = await makeMfr({ code: 'TPR' }), stranger = await makeMfr({ code: 'OUT' })
  await link(brand, mfr)
  return { brand, mfr, stranger }
}
const order = (mfr, o = {}) => ({ product: 'Heavy sweatshirt', totalQty: 3000, delivery: '2026-12-15', category: 'SWTSHT', season: 'FW26', ...(mfr ? { manufacturerId: String(mfr._id) } : {}), ...o })

describe('who is offered the tools', () => {
  const names = u => toolsFor(u).map(t => t.name)
  const create = ['create_master_order', 'create_order']

  test('standalone: brands and manufacturers can create and see their partners; a factory may also move its own dates', () => {
    for (const role of ['buyer', 'manufacturer']) {
      for (const t of [...create, 'list_partners', 'list_master_orders']) assert.ok(names({ role }).includes(t), `${role} should get ${t}`)
    }
    assert.ok(names({ role: 'manufacturer' }).includes('update_stage_dates'))
    assert.ok(!names({ role: 'buyer' }).includes('update_stage_dates'))
    assert.ok(!names({ role: 'buyer' }).includes('list_action_items'))
  })

  test('the Tradio portal: only Tradio staff create, and a factory still cannot move dates', () => {
    delete process.env.PLATFORM_MODE
    for (const role of ['buyer', 'manufacturer']) for (const t of create) assert.ok(!names({ role }).includes(t), `${role} must not get ${t}`)
    assert.ok(!names({ role: 'manufacturer' }).includes('update_stage_dates'))
    assert.ok(names({ role: 'admin' }).includes('create_order'))
  })

  test('Tradio staff have no partner list (they are not a company)', () => {
    assert.ok(!names({ role: 'admin' }).includes('list_partners'))
    assert.ok(names({ role: 'admin' }).includes('list_master_orders'))
  })
})

describe('creating needs a confirmation the server can see', () => {
  test('no confirmation: nothing is created and the model is told exactly what to do', async () => {
    const { brand, mfr } = await world()
    for (const conv of [[{ role: 'user', content: 'create it' }], ASKED_NOT_ANSWERED]) {
      const r = await TOOL_HANDLERS.create_order(order(mfr), ctx(brand, conv))
      assert.equal(r.ok, false)
      assert.equal(r.status, 409)
      assert.match(r.data.error, /CONFIRMATION REQUIRED/)
    }
    assert.equal(await Order.countDocuments(), 0)
    const mo = await TOOL_HANDLERS.create_master_order({ orderName: 'FW26 range' }, ctx(brand, [{ role: 'user', content: 'make it' }]))
    assert.equal(mo.status, 409)
    assert.equal(await MasterOrder.countDocuments(), 0)
  })

  test('confirmed: a brand creates an order assigned to a connected manufacturer', async () => {
    const { brand, mfr } = await world()
    const r = await TOOL_HANDLERS.create_order(order(mfr), ctx(brand))
    assert.equal(r.ok, true, JSON.stringify(r.data))
    assert.equal(r.data.id, 'ZAR-SWTSHT-FW26-001')
    assert.equal(r.data.createdByRole, 'buyer')
    assert.equal(r.data.assignments[0].mid, String(mfr._id))
    assert.equal(r.data.assignments[0].qty, 3000)
  })

  test('confirmed: a manufacturer creates for a customer from its partner list, assigned to itself', async () => {
    const { brand, mfr } = await world()
    const partners = await TOOL_HANDLERS.list_partners({}, ctx(mfr))
    assert.deepEqual(partners.data.map(p => p.id), [String(brand._id)])
    const r = await TOOL_HANDLERS.create_order(order(null, { buyerId: partners.data[0].id }), ctx(mfr))
    assert.equal(r.ok, true, JSON.stringify(r.data))
    assert.equal(r.data.createdByRole, 'manufacturer')
    assert.equal(r.data.assignments[0].mid, String(mfr._id))
  })

  test('a master order, then an order under it', async () => {
    const { brand, mfr } = await world()
    const mo = await TOOL_HANDLERS.create_master_order({ orderName: 'FW26 core range', season: 'FW26' }, ctx(brand))
    assert.equal(mo.ok, true, JSON.stringify(mo.data))
    assert.equal(mo.data.id, 'MO-ZAR-FW26-001')
    const listed = await TOOL_HANDLERS.list_master_orders({}, ctx(brand))
    assert.deepEqual(listed.data.map(m => m.masterOrderId), ['MO-ZAR-FW26-001'])
    const r = await TOOL_HANDLERS.create_order(order(mfr, { masterOrderId: 'MO-ZAR-FW26-001' }), ctx(brand))
    assert.equal(r.ok, true, JSON.stringify(r.data))
    assert.equal(r.data.masterOrderId, 'MO-ZAR-FW26-001')
    // Asked again (a retry after an error, say): the same style in the same master order is refused.
    const again = await TOOL_HANDLERS.create_order(order(mfr, { masterOrderId: 'MO-ZAR-FW26-001', product: 'heavy Sweatshirt' }), ctx(brand))
    assert.equal(again.status, 409)
    assert.match(again.data.error, /ALREADY EXISTS/)
    assert.equal(await Order.countDocuments(), 1)
  })

  test('a confirmation in Hindi script counts, and a no in it does not; a day that does not exist is refused', async () => {
    const { brand, mfr } = await world()
    const ask = { role: 'assistant', content: 'मैं 3000 स्वेटशर्ट का ऑर्डर बनाऊँगी। कृपया पुष्टि करें।' }
    assert.equal((await TOOL_HANDLERS.create_order(order(mfr), ctx(brand, [ask, { role: 'user', content: 'नहीं' }]))).status, 409)
    assert.equal((await TOOL_HANDLERS.create_order(order(mfr, { delivery: '2026-02-30' }), ctx(brand, [ask, { role: 'user', content: 'हाँ' }]))).status, 400)
    const r = await TOOL_HANDLERS.create_order(order(mfr), ctx(brand, [ask, { role: 'user', content: 'हाँ, बना दो' }]))
    assert.equal(r.ok, true, JSON.stringify(r.data))
  })

  test('native-script words count only as whole words; a master order day that does not exist is refused', async () => {
    const { brand } = await world()
    const ask = { role: 'assistant', content: 'कृपया पुष्टि करें (please confirm).' }
    const make = (reply, i) => TOOL_HANDLERS.create_master_order({ orderName: `Range ${i}`, season: 'FW26' }, ctx(brand, [ask, { role: 'user', content: reply }]))
    for (const [i, reply] of ['वहाँ quantity 1500 होनी चाहिए', 'कहां बनेगा?', 'ना, ठीक है, बाद में', 'रद्द कर दो', 'ಸರಿಯಲ್ಲ', 'ಮಾಡಿದ್ರೆ ಏನಾಗುತ್ತೆ?'].entries()) assert.equal((await make(reply, i)).status, 409, reply)
    assert.equal(await MasterOrder.countDocuments(), 0)
    for (const [i, reply] of ['हाँ, मैं सहमत हूँ', 'হ্যাঁ, বানাও', 'ಹೌದು, ಇಲ್ಲಿ ಮಾಡಿ'].entries()) assert.equal((await make(reply, 10 + i)).ok, true, reply)
    assert.equal((await TOOL_HANDLERS.create_master_order({ orderName: 'Bad day', shipBy: '2026-02-30' }, ctx(brand))).status, 400)
  })

  test("the repeat guard never names another company's style", async () => {
    const { brand, mfr } = await world()
    await TOOL_HANDLERS.create_master_order({ orderName: 'FW26 core range', season: 'FW26' }, ctx(brand))
    assert.equal((await TOOL_HANDLERS.create_order(order(mfr, { masterOrderId: 'MO-ZAR-FW26-001' }), ctx(brand))).ok, true)
    const other = await makeBuyer({ code: 'HMX' })
    const r = await TOOL_HANDLERS.create_order(order(null, { masterOrderId: 'MO-ZAR-FW26-001' }), ctx(other))
    assert.doesNotMatch(JSON.stringify(r.data), /ALREADY EXISTS|ZAR-SWTSHT/)
    assert.equal(await Order.countDocuments(), 1)
  })
})

describe('the model cannot go beyond what the person could do', () => {
  test('it never chooses an ID or a creator', async () => {
    const { brand, mfr } = await world()
    const r = await TOOL_HANDLERS.create_order({ ...order(mfr), id: 'HACKED-1', createdBy: String(mfr._id), createdByRole: 'admin' }, ctx(brand))
    assert.equal(r.ok, true, JSON.stringify(r.data))
    assert.equal(r.data.id, 'ZAR-SWTSHT-FW26-001')
    assert.equal(r.data.createdBy, String(brand._id))
    assert.equal(r.data.createdByRole, 'buyer')
  })

  test('the server\'s own rules still decide: an unconnected manufacturer is refused', async () => {
    const { brand, stranger } = await world()
    const r = await TOOL_HANDLERS.create_order(order(stranger), ctx(brand))
    assert.equal(r.ok, false)
    assert.equal(r.status, 403)
    assert.equal(await Order.countDocuments(), 0)
  })

  test('a manufacturer cannot create for a customer it is not connected with', async () => {
    const { stranger, brand } = await world()
    const r = await TOOL_HANDLERS.create_order(order(null, { buyerId: String(brand._id) }), ctx(stranger))
    assert.equal(r.ok, false)
    assert.equal(r.status, 403)
  })

  test('in the Tradio portal the server refuses a brand even if the tool were called', async () => {
    const { brand } = await world()
    delete process.env.PLATFORM_MODE
    const r = await TOOL_HANDLERS.create_order(order(null), ctx(brand))
    assert.equal(r.ok, false)
    assert.equal(r.status, 403)
  })

  test('input is checked before it can reach a URL or a body', async () => {
    const { brand, mfr } = await world()
    for (const bad of [
      { masterOrderId: '../../users' }, { masterOrderId: 'MO-1?x=1' }, { manufacturerId: 'not-an-id' }, { buyerId: '../x' },
      { totalQty: '100' }, { totalQty: 0 }, { delivery: 'next friday' }, { season: 'WINTER' }, { product: '' }, { colourways: [{ name: 'x' }] },
    ]) {
      const r = await TOOL_HANDLERS.create_order(order(mfr, bad), ctx(brand))
      assert.equal(r.ok, false, JSON.stringify(bad))
      assert.equal(r.status, 400, JSON.stringify(bad))
    }
    assert.equal((await TOOL_HANDLERS.create_master_order({ orderName: '' }, ctx(brand))).status, 400)
    assert.equal((await TOOL_HANDLERS.create_master_order({ orderName: 'x', buyerId: '../x' }, ctx(brand))).status, 400)
    assert.equal(await Order.countDocuments(), 0)
  })
})

describe('team accounts and attribution', () => {
  test('a teammate\'s order is created as the company', async () => {
    const { brand, mfr } = await world()
    const { makeMember } = await import('./helpers/factories.js')
    const member = await makeMember(brand)
    const r = await TOOL_HANDLERS.create_order(order(mfr), ctx(member))
    assert.equal(r.ok, true, JSON.stringify(r.data))
    assert.equal(r.data.createdBy, String(brand._id))
  })

  test('Tradio staff can create too, and the server numbers it', async () => {
    const admin = await makeAdmin(), brand = await makeBuyer({ code: 'ZAR' })
    delete process.env.PLATFORM_MODE
    const r = await TOOL_HANDLERS.create_order(order(null, { buyerId: String(brand._id) }), ctx(admin))
    assert.equal(r.ok, true, JSON.stringify(r.data))
    assert.equal(r.data.id, 'ZAR-SWTSHT-FW26-001')
    assert.equal(r.data.createdByRole, 'admin')
  })
})
