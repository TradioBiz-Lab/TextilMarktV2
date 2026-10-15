// The creation flow end to end: a master order with its commercial details, styles numbered by the server, photos at
// creation, a plan whose steps can be moved, and Kriyaa creating master orders and styles only on the admin's word.

import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as, tokenFor } from './helpers/client.js'
import { makeMaster, makeBuyer, makeMfr, makeMasterOrder, orderPayload } from './helpers/factories.js'
import { Order } from '../src/models/Order.js'
import { MasterOrder } from '../src/models/MasterOrder.js'
import { Document } from '../src/models/Document.js'
import { AuditLog } from '../src/models/AuditLog.js'
import { TOOL_HANDLERS, toolsFor } from '../src/routes/assistant.js'

before(async () => {
  await startTestDb()
  process.env.PORT = new URL(await startServer()).port
})
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(clearDb)

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const ctxFor = (user, conversation = []) => ({ cookie: `tradio_token=${tokenFor(user)}`, user: { id: String(user._id), role: user.role }, conversation })
const confirmed = [
  { role: 'user', content: 'Create it' },
  { role: 'assistant', content: 'I will create it as listed. Please confirm.' },
  { role: 'user', content: 'Yes, confirm' },
]

describe('master order details', () => {
  test('PO number, PO date, ship-by and notes are kept on create and edit, and an auto id is numbered', async () => {
    const admin = await makeMaster()
    const buyer = await makeBuyer({ code: 'KON' })
    const res = await as(admin).post('/api/master-orders', { id: 'auto', buyerId: String(buyer._id), orderName: 'Corporate tees', season: 'SS27', poNumber: 'KHA/PO/118', poDate: '2026-09-01', shipBy: '2026-10-20', notes: 'Door delivery to Hyderabad' })
    assert.equal(res.status, 201, JSON.stringify(res.body))
    assert.equal(res.body.id, 'MO-KON-SS27-001')
    assert.deepEqual([res.body.poNumber, res.body.poDate, res.body.shipBy, res.body.notes], ['KHA/PO/118', '2026-09-01', '2026-10-20', 'Door delivery to Hyderabad'])
    const second = await as(admin).post('/api/master-orders', { id: 'auto', buyerId: String(buyer._id), orderName: 'Second', season: 'FW27' })
    assert.equal(second.body.id, 'MO-KON-FW27-002')
    const edit = await as(admin).post(`/api/master-orders/${res.body.id}`, { shipBy: '2026-11-01', poNumber: '' })
    assert.equal(edit.status, 200, JSON.stringify(edit.body))
    assert.equal(edit.body.shipBy, '2026-11-01')
    assert.equal(edit.body.poNumber, '')
    assert.equal((await as(admin).post(`/api/master-orders/${res.body.id}`, { poDate: '1 Sept' })).status, 400)
  })
  test('a factory on the order sees the ship-by date, not the customer PO or the notes; the customer sees all of it', async () => {
    const admin = await makeMaster()
    const buyer = await makeBuyer({ code: 'KON' })
    const mfr = await makeMfr()
    const mo = await as(admin).post('/api/master-orders', { id: 'auto', buyerId: String(buyer._id), orderName: 'Corporate tees', season: 'SS27', poNumber: 'KHA/PO/118', poDate: '2026-09-01', shipBy: '2026-10-20', notes: 'Price 240 a piece' })
    assert.equal(mo.status, 201, JSON.stringify(mo.body))
    const style = await as(admin).post('/api/orders', orderPayload({ buyerId: buyer._id, mfrId: mfr._id, masterOrderId: mo.body.id }))
    assert.equal(style.status, 201, JSON.stringify(style.body))
    const seen = (await as(mfr).get('/api/master-orders')).body.find(m => m.id === mo.body.id)
    assert.deepEqual([seen.poNumber, seen.poDate, seen.shipBy, seen.notes], ['', null, '2026-10-20', ''])
    const own = (await as(buyer).get('/api/master-orders')).body.find(m => m.id === mo.body.id)
    assert.deepEqual([own.poNumber, own.notes], ['KHA/PO/118', 'Price 240 a piece'])
  })

  test('an edit that sends the stored values changes and logs nothing; a day that does not exist is refused', async () => {
    const admin = await makeMaster()
    const buyer = await makeBuyer({ code: 'KON' })
    const mo = await as(admin).post('/api/master-orders', { id: 'auto', buyerId: String(buyer._id), orderName: 'Corporate tees', season: 'SS27', poDate: '2026-09-01' })
    const same = await as(admin).post(`/api/master-orders/${mo.body.id}`, { orderName: 'Corporate tees', season: 'SS27', poNumber: '', poDate: '2026-09-01', shipBy: null, notes: '' })
    assert.equal(same.status, 200, JSON.stringify(same.body))
    assert.equal(await AuditLog.countDocuments({ action: 'Master Order Edited' }), 0)
    assert.equal((await as(admin).post(`/api/master-orders/${mo.body.id}`, { shipBy: '2026-02-30' })).status, 400)
    assert.equal((await as(admin).post(`/api/master-orders/${mo.body.id}`, { shipBy: '2026-11-01' })).status, 200)
    assert.equal(await AuditLog.countDocuments({ action: 'Master Order Edited' }), 1)
  })
})

describe('styles', () => {
  test('an auto id is numbered from the customer, category and season; photos at creation make the gallery', async () => {
    const admin = await makeMaster()
    const buyer = await makeBuyer({ code: 'KON' })
    const body = { id: 'auto', buyerId: String(buyer._id), product: 'Red Tee', category: 'tshrt', season: 'SS27', totalQty: 2000,
      colourways: [{ name: 'Red' }], photos: [{ image: PNG, colourway: 'red' }] }
    const a = await as(admin).post('/api/orders', body)
    assert.equal(a.status, 201, JSON.stringify(a.body))
    assert.equal(a.body.id, 'KON-TSHRT-SS27-001')
    assert.equal(a.body.delivery, null)
    assert.deepEqual(a.body.photos, [{ image: PNG, colourway: 'Red' }])
    assert.equal(a.body.imageDataUrl, PNG)
    const b = await as(admin).post('/api/orders', { ...body, photos: undefined })
    assert.equal(b.body.id, 'KON-TSHRT-SS27-002')
  })
})

describe('moving a step in the plan', () => {
  async function arrange() {
    const admin = await makeMaster()
    const buyer = await makeBuyer()
    const mfr = await makeMfr()
    const res = await as(admin).post('/api/orders', orderPayload({ id: 'MS-001', buyerId: buyer._id, mfrId: mfr._id, stageNames: ['Cutting', 'Stitching', 'Packing'] }))
    assert.equal(res.status, 201, JSON.stringify(res.body))
    return { admin, mfr }
  }
  const names = async () => (await Order.findById('MS-001').lean()).assignments[0].stages.map(s => s.name)

  test('up and down swap neighbours, and each step keeps its documents', async () => {
    const { admin, mfr } = await arrange()
    const before = await names()
    assert.equal(before[before.length - 1], 'Delivery')
    const doc = await Document.create({ type: 'floor_evidence', name: 'Cut panels', orderId: 'MS-001', mfrId: mfr._id, stageIndex: 0, uploadedBy: admin._id, notes: 'cut' })
    const down = await as(admin).post(`/api/orders/MS-001/assignments/${mfr._id}/stages/0/move`, { direction: 'down' })
    assert.equal(down.status, 200, JSON.stringify(down.body))
    assert.deepEqual((await names()).slice(0, 3), ['Stitching', 'Cutting', 'Packing'])
    assert.equal((await Document.findById(doc._id).lean()).stageIndex, 1)
    await as(admin).post(`/api/orders/MS-001/assignments/${mfr._id}/stages/1/move`, { direction: 'up' })
    assert.deepEqual((await names()).slice(0, 3), ['Cutting', 'Stitching', 'Packing'])
    assert.equal((await Document.findById(doc._id).lean()).stageIndex, 0)
  })

  test('the Delivery step stays last and the ends do not move further', async () => {
    const { admin, mfr } = await arrange()
    const n = (await names()).length
    for (const [i, direction] of [[n - 1, 'up'], [n - 2, 'down'], [0, 'up']])
      assert.equal((await as(admin).post(`/api/orders/MS-001/assignments/${mfr._id}/stages/${i}/move`, { direction })).status, 400, `${i} ${direction}`)
    assert.equal((await as(admin).post(`/api/orders/MS-001/assignments/${mfr._id}/stages/0/move`, { direction: 'sideways' })).status, 400)
  })

  test('a factory cannot move steps', async () => {
    const { mfr } = await arrange()
    assert.equal((await as(mfr).post(`/api/orders/MS-001/assignments/${mfr._id}/stages/0/move`, { direction: 'down' })).status, 403)
  })
})

describe('Kriyaa creating orders', () => {
  test('only admins get the create tools', () => {
    const names = u => toolsFor(u).map(t => t.name)
    for (const t of ['create_master_order', 'create_order', 'list_companies', 'list_master_orders']) {
      assert.ok(names({ role: 'admin' }).includes(t))
      assert.ok(!names({ role: 'buyer' }).includes(t) && !names({ role: 'manufacturer' }).includes(t))
    }
  })

  test('nothing is created until the admin confirms; then a master order and a style with its manufacturer', async () => {
    const admin = await makeMaster()
    const buyer = await makeBuyer({ code: 'KON' })
    const mfr = await makeMfr({ company: 'Fibrewear' })

    const companies = await TOOL_HANDLERS.list_companies({}, ctxFor(admin))
    assert.ok(companies.data.some(c => c.id === String(mfr._id) && c.kind === 'manufacturer'))

    const moInput = { orderName: 'Corporate tees', buyerId: String(buyer._id), season: 'SS27', poNumber: 'PO-9' }
    const ask = await TOOL_HANDLERS.create_master_order(moInput, ctxFor(admin, [{ role: 'user', content: 'make a master order' }]))
    assert.equal(ask.status, 409)
    assert.equal(await MasterOrder.countDocuments(), 0)
    const mo = await TOOL_HANDLERS.create_master_order(moInput, ctxFor(admin, confirmed))
    assert.equal(mo.ok, true, JSON.stringify(mo.data))
    assert.equal(mo.data.id, 'MO-KON-SS27-001')

    const styleInput = { masterOrderId: mo.data.id, product: 'Red Tee', category: 'TSHRT', totalQty: 2000, colourways: ['Red'], manufacturerId: String(mfr._id), delivery: '2026-10-16' }
    assert.equal((await TOOL_HANDLERS.create_order(styleInput, ctxFor(admin, []))).status, 409)
    // A manufacturer without a date is fine: the plan's Delivery step stays undated until the date is given.
    const undated = await TOOL_HANDLERS.create_order({ ...styleInput, product: 'Blue Tee', delivery: undefined }, ctxFor(admin, confirmed))
    assert.equal(undated.ok, true, JSON.stringify(undated.data))
    assert.equal((await Order.findOne({ product: 'Blue Tee' }).lean()).assignments[0].stages.at(-1).baselineEta, 'NA')
    const style = await TOOL_HANDLERS.create_order(styleInput, ctxFor(admin, confirmed))
    assert.equal(style.ok, true, JSON.stringify(style.data))
    const o = await Order.findOne({ product: 'Red Tee' }).lean()
    assert.equal(String(o.buyerId), String(buyer._id))      // the master order's customer
    assert.equal(o.masterOrderId, 'MO-KON-SS27-001')
    assert.equal(o.season, 'SS27')                           // the master order's season
    assert.equal(String(o.assignments[0].mfrId), String(mfr._id))
    assert.equal(o.assignments[0].stages.at(-1).name, 'Delivery')
    assert.equal(new Date(o.delivery).toISOString().slice(0, 10), '2026-10-16')
  })

  test('a repeated create, an inactive manufacturer and a day that does not exist are refused before anything is written', async () => {
    const admin = await makeMaster()
    const buyer = await makeBuyer({ code: 'KON' })
    const gone = await makeMfr({ isActive: false })
    const mo = await TOOL_HANDLERS.create_master_order({ orderName: 'Corporate tees', buyerId: String(buyer._id), season: 'SS27' }, ctxFor(admin, confirmed))
    const base = { masterOrderId: mo.data.id, product: 'Red Tee', styleNumber: 'RT-1', category: 'TSHRT', totalQty: 50 }
    assert.equal((await TOOL_HANDLERS.create_order({ ...base, manufacturerId: String(gone._id), delivery: '2026-12-01' }, ctxFor(admin, confirmed))).status, 400)
    assert.equal((await TOOL_HANDLERS.create_order({ ...base, delivery: '2026-02-30' }, ctxFor(admin, confirmed))).status, 400)
    assert.equal(await Order.countDocuments(), 0)
    const first = await TOOL_HANDLERS.create_order(base, ctxFor(admin, confirmed))
    assert.equal(first.ok, true, JSON.stringify(first.data))
    const again = await TOOL_HANDLERS.create_order({ ...base, product: 'red tee ' }, ctxFor(admin, confirmed))
    assert.equal(again.status, 409)
    assert.match(again.data.error, /ALREADY EXISTS/)
    assert.equal(await Order.countDocuments(), 1)
  })

  test('a confirmation in Hindi or Kannada script counts, and a no in it does not', async () => {
    const admin = await makeMaster()
    const buyer = await makeBuyer()
    const input = { orderName: 'Tees', buyerId: String(buyer._id) }
    const ask = { role: 'assistant', content: 'मैं यह मास्टर ऑर्डर बनाऊँगी। कृपया पुष्टि करें।' }
    assert.equal((await TOOL_HANDLERS.create_master_order(input, ctxFor(admin, [ask, { role: 'user', content: 'नहीं, रुको' }]))).status, 409)
    assert.equal((await TOOL_HANDLERS.create_master_order(input, ctxFor(admin, [ask, { role: 'user', content: 'हाँ, बना दो' }]))).ok, true)
    const askKn = { role: 'assistant', content: 'ನಾನು ಇದನ್ನು ರಚಿಸುತ್ತೇನೆ. ದಯವಿಟ್ಟು ದೃಢೀಕರಿಸಿ.' }
    assert.equal((await TOOL_HANDLERS.create_master_order({ ...input, orderName: 'Tees 2' }, ctxFor(admin, [askKn, { role: 'user', content: 'ಹೌದು' }]))).ok, true)
    assert.equal(await MasterOrder.countDocuments(), 2)
  })

  test('native-script words count only as whole words: "there", "where", "cancel it" or "not right" are not a yes', async () => {
    const admin = await makeMaster()
    const buyer = await makeBuyer()
    const ask = { role: 'assistant', content: 'कृपया पुष्टि करें (please confirm).' }
    const make = (reply, i) => TOOL_HANDLERS.create_master_order({ orderName: `Tees ${i}`, buyerId: String(buyer._id) }, ctxFor(admin, [ask, { role: 'user', content: reply }]))
    for (const [i, reply] of ['वहाँ quantity 1500 होनी चाहिए', 'कहां बनेगा?', 'ना, ठीक है, बाद में', 'रद्द कर दो', 'ಸರಿಯಲ್ಲ', 'ಮಾಡಿದ್ರೆ ಏನಾಗುತ್ತೆ?'].entries()) assert.equal((await make(reply, i)).status, 409, reply)
    assert.equal(await MasterOrder.countDocuments(), 0)
    for (const [i, reply] of ['हाँ, मैं सहमत हूँ', 'হ্যাঁ, বানাও', 'ಹೌದು, ಇಲ್ಲಿ ಮಾಡಿ'].entries()) assert.equal((await make(reply, 10 + i)).ok, true, reply)
  })

  test('get_order gives the model the photo count, not the photos', async () => {
    const admin = await makeMaster()
    const buyer = await makeBuyer({ code: 'KON' })
    const made = await as(admin).post('/api/orders', { id: 'auto', buyerId: String(buyer._id), product: 'Tee', category: 'TSHRT', season: 'SS27', totalQty: 10, photos: [{ image: PNG }, { image: PNG }] })
    assert.equal(made.status, 201, JSON.stringify(made.body))
    const res = await TOOL_HANDLERS.get_order({ orderId: made.body.id }, ctxFor(admin))
    assert.equal(res.ok, true)
    assert.equal(res.data.photos, undefined)
    assert.equal(res.data.imageDataUrl, undefined)
    assert.equal(res.data.photoCount, 2)
  })

  test('an unknown master order is refused before anything is created', async () => {
    const admin = await makeMaster()
    const res = await TOOL_HANDLERS.create_order({ masterOrderId: 'MO-NOPE-001', product: 'X', totalQty: 1 }, ctxFor(admin, confirmed))
    assert.equal(res.status, 404)
    assert.equal(await Order.countDocuments(), 0)
  })
})
