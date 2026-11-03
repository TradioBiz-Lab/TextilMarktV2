// A customer gives its own style's product page (its Amazon listing) from the style page, instead of on WhatsApp.
import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as } from './helpers/client.js'
import { makeMaster, makeBuyer, makeMfr } from './helpers/factories.js'
import { Notification } from '../src/models/Notification.js'

before(async () => { await startTestDb(); await startServer() })
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(clearDb)

test('the customer sets, shortens and clears its own style\'s product link; Tradio is told; nobody else may', async () => {
  const master = await makeMaster()
  const buyer = await makeBuyer()
  assert.equal((await as(master).post('/api/orders', { id: 'S-1', buyerId: String(buyer._id), product: 'Midi Dress', category: 'DRESS', season: 'SS26', phase: 'production', totalQty: 10 })).status, 201)
  const set = await as(buyer).post('/api/orders/S-1/product-link', { ecommerceLink: 'www.amazon.in/FYLTR-Dress/dp/B0ABCDEFGH/ref=sr_1_3?th=1' })
  assert.equal(set.status, 200, JSON.stringify(set.body))
  assert.equal(set.body.ecommerceLink, 'https://www.amazon.in/dp/B0ABCDEFGH')
  assert.equal(await Notification.countDocuments({ toUser: master._id, msg: /added the product link of Midi Dress/ }), 1)
  assert.equal((await as(buyer).post('/api/orders/S-1/product-link', { ecommerceLink: 'javascript:alert(1)' })).status, 400)
  assert.equal((await as(buyer).post('/api/orders/S-1/product-link', { ecommerceLink: '' })).body.ecommerceLink, '')
  assert.equal((await as(await makeBuyer()).post('/api/orders/S-1/product-link', { ecommerceLink: 'https://x.example.com' })).status, 404)
  assert.equal((await as(await makeMfr()).post('/api/orders/S-1/product-link', { ecommerceLink: 'https://x.example.com' })).status, 403)
})
