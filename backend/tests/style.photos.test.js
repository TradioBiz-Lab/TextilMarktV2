// A style carries any number of product photos (up to 12), each tied to one of its colourways or to none. The first
// is the main photo, which every list shows as the thumbnail.

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
const LINK = 'https://example.com/navy.jpg'

async function arrange() {
  const admin = await makeMaster()
  const buyer = await makeBuyer()
  const mfr = await makeMfr()
  const res = await as(admin).post('/api/orders', orderPayload({ id: 'PH-001', buyerId: buyer._id, mfrId: mfr._id }))
  assert.equal(res.status, 201, JSON.stringify(res.body))
  const cw = await as(admin).post('/api/orders/PH-001', { colourways: [{ name: 'Coffee Brown' }, { name: 'Navy Blue' }] })
  assert.equal(cw.status, 200, JSON.stringify(cw.body))
  return { admin }
}

describe('style photos', () => {
  test('photos keep their order and colourway; the first becomes the main photo', async () => {
    const { admin } = await arrange()
    const res = await as(admin).post('/api/orders/PH-001', { photos: [
      { image: PNG, colourway: 'coffee brown' }, { image: LINK, colourway: 'Navy Blue' }, { image: PNG, colourway: 'Purple' }, { image: '' },
    ] })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    // Matched to the style's own spelling; an unknown colour is untied; an empty slot is dropped.
    assert.deepEqual(res.body.photos, [{ image: PNG, colourway: 'Coffee Brown' }, { image: LINK, colourway: 'Navy Blue' }, { image: PNG, colourway: '' }])
    const o = await Order.findById('PH-001').lean()
    assert.equal(o.imageDataUrl, PNG)
    assert.equal(o.imageUrl, null)

    const linkFirst = await as(admin).post('/api/orders/PH-001', { photos: [{ image: LINK }, { image: PNG }] })
    assert.equal(linkFirst.body.imageUrl, LINK)
    assert.equal(linkFirst.body.imageDataUrl, null)

    const none = await as(admin).post('/api/orders/PH-001', { photos: [] })
    assert.equal(none.body.imageDataUrl, null)
    assert.equal(none.body.imageUrl, null)
  })

  test('removing a colourway unties its photos', async () => {
    const { admin } = await arrange()
    await as(admin).post('/api/orders/PH-001', { photos: [{ image: PNG, colourway: 'Navy Blue' }] })
    const res = await as(admin).post('/api/orders/PH-001', { colourways: [{ name: 'Coffee Brown' }] })
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.photos, [{ image: PNG, colourway: '' }])
  })

  test('refuses a non-image, a script link, an oversized upload and more than 12 photos', async () => {
    const { admin } = await arrange()
    for (const image of ['data:text/html;base64,PGgxPg==', 'javascript:alert(1)', `data:image/jpeg;base64,${'A'.repeat(1500000)}`]) {
      const res = await as(admin).post('/api/orders/PH-001', { photos: [{ image }] })
      assert.equal(res.status, 400, image.slice(0, 30))
    }
    assert.equal((await as(admin).post('/api/orders/PH-001', { photos: Array.from({ length: 13 }, () => ({ image: PNG })) })).status, 400)
  })
})
