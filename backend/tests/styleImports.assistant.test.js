// Kriyaa's two tools for an attached style sheet. They are loopback wrappers around /api/style-imports, so the admin-only
// rule and the validation are the routes'; what is checked here is what the tools add: the id shapes, the confirmation the
// server can see, and that picture bytes never reach the model.

import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as, tokenFor } from './helpers/client.js'
import { makeMaster, makeBuyer, makeMasterOrder } from './helpers/factories.js'
import { Order } from '../src/models/Order.js'
import { TOOL_HANDLERS, toolsFor } from '../src/routes/assistant.js'

before(async () => {
  await startTestDb()
  process.env.PORT = new URL(await startServer()).port
})
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(clearDb)

const CSV = [
  'Brand,Style No,Description,Image,Amazon link,Fabric,Stage',
  'FYLTR,F-1,Maxi Dress,https://img.example.com/1.jpg,https://amazon.in/dp/1,Cotton,Replen',
  'FYLTR,F-2,Midi Dress,https://img.example.com/2.jpg,https://amazon.in/dp/2,Cotton,NPD',
].join('\n')

async function arrange() {
  const admin = await makeMaster()
  const buyer = await makeBuyer({ company: 'Cocoblu' })
  const mo = await makeMasterOrder({ buyerId: buyer._id, createdBy: admin._id, season: 'SS26' })
  const up = await as(admin).post('/api/style-imports', { filename: 'sheet.csv', data: Buffer.from(CSV).toString('base64') })
  assert.equal(up.status, 201)
  return { admin, buyer, mo, uploadId: up.body.id, ctx: { cookie: `tradio_token=${tokenFor(admin)}`, conversation: [] } }
}
const confirmed = [
  { role: 'user', content: 'create them' },
  { role: 'assistant', content: 'This will create 2 styles under the master order. Please confirm.' },
  { role: 'user', content: 'yes, confirm' },
]

describe('the sheet tools', () => {
  test('are offered to admins only', async () => {
    const admin = await makeMaster()
    const buyer = await makeBuyer()
    for (const name of ['preview_style_import', 'create_styles_from_import']) {
      assert.ok(toolsFor(admin).some(t => t.name === name))
      assert.ok(!toolsFor(buyer).some(t => t.name === name))
    }
  })

  test('preview gives the verdicts and no picture data, and creates nothing', async () => {
    const { mo, uploadId, ctx } = await arrange()
    const r = await TOOL_HANDLERS.preview_style_import({ uploadId, masterOrderId: mo._id }, ctx)
    assert.equal(r.ok, true, JSON.stringify(r.data))
    assert.deepEqual(r.data.summary, { total: 2, ok: 2, errors: 0, exists: 0 })
    assert.deepEqual(r.data.rows.map(x => [x.styleNumber, x.stage, x.category]), [['F-1', 'replen', 'DRESS'], ['F-2', 'development', 'DRESS']])
    assert.ok(!JSON.stringify(r.data).includes('imagePreview'))
    assert.ok(!JSON.stringify(r.data).includes('data:image'))
    assert.equal(await Order.countDocuments(), 0)
  })

  test('create is refused until the admin has confirmed, then makes the styles', async () => {
    const { mo, uploadId, ctx } = await arrange()
    const refused = await TOOL_HANDLERS.create_styles_from_import({ uploadId, masterOrderId: mo._id }, ctx)
    assert.equal(refused.ok, false)
    assert.match(refused.data.error, /CONFIRMATION REQUIRED/)
    assert.equal(await Order.countDocuments(), 0)
    const done = await TOOL_HANDLERS.create_styles_from_import({ uploadId, masterOrderId: mo._id }, { ...ctx, conversation: confirmed })
    assert.equal(done.ok, true, JSON.stringify(done.data))
    assert.equal(done.data.created.length, 2)
    assert.deepEqual((await Order.find().sort({ styleNumber: 1 }).lean()).map(o => o.phase), ['replen', 'development'])
  })

  test('ids that could change the loopback path are refused before any request is made', async () => {
    const { mo, uploadId, ctx } = await arrange()
    for (const bad of ['../x', 'imp_zz', `${uploadId}/commit`, undefined, 5]) {
      const r = await TOOL_HANDLERS.preview_style_import({ uploadId: bad, masterOrderId: mo._id }, ctx)
      assert.equal(r.status, 400)
      assert.match(r.data.error, /Invalid uploadId/)
    }
    const r = await TOOL_HANDLERS.preview_style_import({ uploadId, masterOrderId: '../orders' }, ctx)
    assert.match(r.data.error, /Invalid masterOrderId/)
    const s = await TOOL_HANDLERS.create_styles_from_import({ uploadId, masterOrderId: mo._id, skipInvalid: 'yes' }, { ...ctx, conversation: confirmed })
    assert.match(s.data.error, /Invalid skipInvalid/)
  })

  test('create_order carries the brand and the two links', async () => {
    const { mo, ctx } = await arrange()
    const r = await TOOL_HANDLERS.create_order({
      masterOrderId: mo._id, product: 'Wrap Dress', category: 'DRESS', phase: 'development',
      brand: 'FYLTR', techPackLink: 'https://drive.example.com/tp', ecommerceLink: 'https://amazon.in/dp/9',
    }, { ...ctx, conversation: confirmed })
    assert.equal(r.ok, true, JSON.stringify(r.data))
    const order = await Order.findById(r.data.id).lean()
    assert.equal(order.brand, 'FYLTR')
    assert.equal(order.techPackLink, 'https://drive.example.com/tp')
    assert.equal(order.ecommerceLink, 'https://amazon.in/dp/9')
    const bad = await TOOL_HANDLERS.create_order({ masterOrderId: mo._id, product: 'X', phase: 'development', brand: 'b'.repeat(61) }, { ...ctx, conversation: confirmed })
    assert.match(bad.data.error, /Invalid brand/)
  })
})
