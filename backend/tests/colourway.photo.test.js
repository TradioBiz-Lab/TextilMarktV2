// A colourway can carry a photo of the style in that colour: a small uploaded image or an http(s) link.

import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as } from './helpers/client.js'
import { makeMaster, makeBuyer, makeMfr, orderPayload } from './helpers/factories.js'
import { Order } from '../src/models/Order.js'

before(async () => { await startTestDb(); await startServer() })
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(clearDb)

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

async function arrange() {
  const admin = await makeMaster()
  const buyer = await makeBuyer()
  const mfr = await makeMfr()
  const res = await as(admin).post('/api/orders', orderPayload({ id: 'CWP-001', buyerId: buyer._id, mfrId: mfr._id }))
  assert.equal(res.status, 201, JSON.stringify(res.body))
  return { admin }
}

describe('colourway photos', () => {
  test('an uploaded photo and a link are kept and read back; other colourways stay plain', async () => {
    const { admin } = await arrange()
    const res = await as(admin).post('/api/orders/CWP-001', { colourways: [
      { name: 'Coffee Brown', image: PNG }, { name: 'Navy Blue', image: 'https://example.com/navy.jpg' }, { name: 'Salsa Red' },
    ] })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.deepEqual(res.body.colourways.map(c => c.image), [PNG, 'https://example.com/navy.jpg', ''])
    assert.equal((await Order.findById('CWP-001').lean()).colourways[0].image, PNG)
  })

  test('refuses a non-image, a script link and an oversized upload', async () => {
    const { admin } = await arrange()
    for (const image of ['data:text/html;base64,PGgxPg==', 'javascript:alert(1)', `data:image/jpeg;base64,${'A'.repeat(420000)}`]) {
      const res = await as(admin).post('/api/orders/CWP-001', { colourways: [{ name: 'Red', image }] })
      assert.equal(res.status, 400, image.slice(0, 30))
    }
  })
})
