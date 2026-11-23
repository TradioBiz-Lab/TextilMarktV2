import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'
import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as, req } from './helpers/client.js'
import { makeAdmin, makeBuyer, makeMfr, orderPayload } from './helpers/factories.js'
import { cleanSizeBreakup, sizeBreakupTotals, sizeBreakupOut } from '../src/lib/sizeBreakup.js'
import { Order } from '../src/models/Order.js'
import { AuditLog } from '../src/models/AuditLog.js'
import { Notification } from '../src/models/Notification.js'

before(async () => { await startTestDb(); await startServer() })
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(clearDb)

// Cocoblu's own grid for FYLAW26MCT-4705 (PO-226): three colours, five waist sizes, 450 pieces.
const TROUSERS = { sizes: ['28', '30', '32', '34', '36'], rows: [
  { colour: 'Camel Brown', qty: [28, 41, 46, 23, 12] },
  { colour: 'Jet Black', qty: [28, 41, 46, 23, 12] },
  { colour: 'Marshmallow', qty: [28, 41, 46, 23, 12] },
] }

describe('a size breakup as it is sent', () => {
  test('the grid is kept as given, and its totals add up', () => {
    const { value } = cleanSizeBreakup(TROUSERS)
    assert.deepEqual(value, TROUSERS)
    assert.deepEqual(sizeBreakupTotals(value), { bySize: [84, 123, 138, 69, 36], byColour: [150, 150, 150], total: 450 })
    assert.equal(sizeBreakupOut(value).total, 450)
  })
  test('sizes may come as one line of text; blanks are zero; numbers typed as text are numbers', () => {
    const { value } = cleanSizeBreakup({ sizes: ' S, M ,L ', rows: [{ colour: ' Olivine ', qty: ['40', '', null] }] })
    assert.deepEqual(value, { sizes: ['S', 'M', 'L'], rows: [{ colour: 'Olivine', qty: [40, 0, 0] }] })
  })
  test('a style with no colours has one unnamed row', () => {
    assert.deepEqual(cleanSizeBreakup({ sizes: ['S'], rows: [{ qty: [10] }] }).value, { sizes: ['S'], rows: [{ colour: '', qty: [10] }] })
  })
  test('nothing, or an empty grid, clears it', () => {
    for (const v of [null, undefined, {}, { sizes: [], rows: [] }]) assert.deepEqual(cleanSizeBreakup(v), { value: null })
    assert.equal(sizeBreakupOut(null), null)
    assert.deepEqual(sizeBreakupTotals(null), { bySize: [], byColour: [], total: 0 })
  })
  test('what is refused, each with a plain reason', () => {
    const bad = [
      [{ sizes: ['S'], rows: [] }, /at least one colour/],
      [{ sizes: [], rows: [{ colour: 'A', qty: [] }] }, /at least one size/],
      [{ sizes: ['S', 's'], rows: [{ colour: 'A', qty: [1, 1] }] }, /twice/],
      [{ sizes: ['S', ''], rows: [{ colour: 'A', qty: [1, 1] }] }, /size is empty/],
      [{ sizes: ['EXTRA-EXTRA-LARGE'], rows: [{ colour: 'A', qty: [1] }] }, /too long/],
      [{ sizes: ['S'], rows: [{ colour: 'A', qty: [1] }, { colour: 'a', qty: [2] }] }, /twice/],
      [{ sizes: ['S'], rows: [{ colour: 'A', qty: [1] }, { colour: '', qty: [2] }] }, /Name every colour/],
      [{ sizes: ['S', 'M'], rows: [{ colour: 'A', qty: [1] }] }, /one quantity for each size/],
      [{ sizes: ['S'], rows: [{ colour: 'A', qty: [-1] }] }, /whole numbers/],
      [{ sizes: ['S'], rows: [{ colour: 'A', qty: [1.5] }] }, /whole numbers/],
      [{ sizes: ['S'], rows: [{ colour: 'A', qty: ['12 pcs'] }] }, /whole numbers/],
      [{ sizes: ['S'], rows: [{ colour: 'A', qty: [1000001] }] }, /whole numbers/],
      [{ sizes: [{ $gt: '' }], rows: [{ colour: 'A', qty: [1] }] }, /must be text/],
      [{ sizes: ['S'], rows: [{ colour: { $ne: 1 }, qty: [1] }] }, /must be text/],
      [{ sizes: Array.from({ length: 25 }, (_, i) => `S${i}`), rows: [{ colour: 'A', qty: Array(25).fill(1) }] }, /Too many sizes/],
      [{ sizes: ['S'], rows: Array.from({ length: 61 }, (_, i) => ({ colour: `C${i}`, qty: [1] })) }, /Too many colours/],
      ['S, M', /Invalid/], [[1, 2], /Invalid/], [{ sizes: 'S', rows: 'x' }, /Invalid/],
    ]
    for (const [input, re] of bad) assert.match(cleanSizeBreakup(input).error || '', re, JSON.stringify(input).slice(0, 80))
  })
})

describe('setting a style\'s size breakup', () => {
  async function arrange() {
    const admin = await makeAdmin({ name: 'Asha' }); const buyer = await makeBuyer({ company: 'Cocoblu' }); const other = await makeBuyer()
    const a = await makeMfr(); const b = await makeMfr()
    const p = orderPayload({ id: 'S-1', buyerId: buyer._id, mfrId: a._id, totalQty: 450, product: 'Corduroy Pants' })
    p.assignments = [{ mid: String(a._id), qty: 300 }, { mid: String(b._id), qty: 150 }]
    assert.equal((await as(admin).post('/api/orders', p)).status, 201)
    await Notification.deleteMany({})
    return { admin, buyer, other, a, b }
  }

  test('Tradio sets it; every viewer of the style then sees it; the customer and both factories are told', async () => {
    const { admin, buyer, a, b } = await arrange()
    const res = await as(admin).post('/api/orders/S-1/size-breakup', TROUSERS)
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.deepEqual([res.body.sizeBreakup.sizes, res.body.sizeBreakup.total], [TROUSERS.sizes, 450])
    assert.deepEqual(res.body.sizeBreakup.rows, TROUSERS.rows)
    const stored = (await Order.findById('S-1').lean()).sizeBreakup
    assert.equal(String(stored.updatedBy), String(admin._id))
    for (const who of [buyer, a, b, admin]) assert.equal((await as(who).get('/api/orders/S-1')).body.sizeBreakup.total, 450, who.role)
    assert.equal((await as(a).get('/api/orders')).body[0].sizeBreakup.rows.length, 3, 'in the list too')
    assert.match((await AuditLog.findOne({ action: 'Size Breakup Updated' }).lean()).detail, /S-1: 450 pieces in 5 sizes and 3 colours, by Asha/)
    const told = (await Notification.find().lean()).map(n => String(n.toUser)).sort()
    assert.deepEqual(told, [String(buyer._id), String(a._id), String(b._id)].sort())
    assert.match((await Notification.findOne().lean()).msg, /Tradio added the size breakup of Corduroy Pants/)
  })

  test('a customer sets it on its own style; Tradio and the factories are told; saving the same grid again says nothing', async () => {
    const { admin, buyer, a, b } = await arrange()
    const res = await as(buyer).post('/api/orders/S-1/size-breakup', TROUSERS)
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.sizeBreakup.total, 450)
    assert.equal(res.body.assignments[0].mfrCompany, 'Production lot 1', 'the answer is still the customer\'s view of the style')
    assert.deepEqual((await Notification.find().lean()).map(n => String(n.toUser)).sort(), [String(admin._id), String(a._id), String(b._id)].sort())
    assert.match((await AuditLog.findOne({ action: 'Size Breakup Updated' }).lean()).detail, /by the customer/)
    await as(buyer).post('/api/orders/S-1/size-breakup', TROUSERS)
    assert.equal(await AuditLog.countDocuments({ action: 'Size Breakup Updated' }), 1)
    assert.equal(await Notification.countDocuments(), 3)
  })

  test('changing and clearing it are recorded with what it was', async () => {
    const { admin } = await arrange()
    const api = as(admin)
    await api.post('/api/orders/S-1/size-breakup', TROUSERS)
    const changed = await api.post('/api/orders/S-1/size-breakup', { sizes: ['28', '30'], rows: [{ colour: 'Jet Black', qty: [10, 20] }] })
    assert.equal(changed.body.sizeBreakup.total, 30)
    const cleared = await api.post('/api/orders/S-1/size-breakup', { sizes: [], rows: [] })
    assert.equal(cleared.status, 200)
    assert.equal(cleared.body.sizeBreakup, null)
    assert.equal((await Order.findById('S-1').lean()).sizeBreakup, null)
    const logs = (await AuditLog.find({ action: 'Size Breakup Updated' }).sort({ createdAt: 1 }).lean()).map(l => l.detail)
    assert.match(logs[1], /30 pieces in 2 sizes and 1 colour \(was 450 pieces\)/)
    assert.match(logs[2], /cleared \(was 30 pieces\)/)
  })

  test('a factory, another customer and a signed-out visitor cannot; a bad grid changes nothing', async () => {
    const { admin, other, a } = await arrange()
    assert.equal((await as(a).post('/api/orders/S-1/size-breakup', TROUSERS)).status, 403)
    assert.equal((await as(other).post('/api/orders/S-1/size-breakup', TROUSERS)).status, 404, 'not told the style exists')
    assert.equal((await req('POST', '/api/orders/S-1/size-breakup', { body: TROUSERS })).status, 401)
    assert.equal((await as(admin).post('/api/orders/NOPE/size-breakup', TROUSERS)).status, 404)
    const bad = await as(admin).post('/api/orders/S-1/size-breakup', { sizes: ['S', 'M'], rows: [{ colour: 'A', qty: [1] }] })
    assert.equal(bad.status, 400)
    assert.match(bad.body.error, /one quantity for each size/)
    assert.equal((await Order.findById('S-1').lean()).sizeBreakup ?? null, null)
    assert.equal(await AuditLog.countDocuments({ action: 'Size Breakup Updated' }), 0)
  })

  test('a style with none says so plainly, and editing the style leaves the breakup alone', async () => {
    const { admin } = await arrange()
    assert.equal((await as(admin).get('/api/orders/S-1')).body.sizeBreakup, null)
    await as(admin).post('/api/orders/S-1/size-breakup', TROUSERS)
    const edit = await as(admin).post('/api/orders/S-1', { product: 'Corduroy Pants (Regular)' })
    assert.equal(edit.status, 200, JSON.stringify(edit.body))
    assert.equal((await as(admin).get('/api/orders/S-1')).body.sizeBreakup.total, 450)
  })
})
