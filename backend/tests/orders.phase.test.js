// A style is in Sampling & Development or in Production. Old styles are production; the customer and Tradio
// move a style across, the factory does not.

import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as } from './helpers/client.js'
import { makeMaster, makeBuyer, makeMfr, orderPayload } from './helpers/factories.js'
import { Order } from '../src/models/Order.js'

before(async () => { await startTestDb(); await startServer() })
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(clearDb)

async function arrange(extra = {}) {
  const master = await makeMaster()
  const buyer = await makeBuyer()
  const mfr = await makeMfr()
  const res = await as(master).post('/api/orders', orderPayload({ id: 'PH-001', buyerId: buyer._id, mfrId: mfr._id, ...extra }))
  assert.equal(res.status, 201, JSON.stringify(res.body))
  return { master, buyer, mfr, res }
}

describe('style phase', () => {
  test('a new style is production unless said otherwise', async () => {
    const { res } = await arrange()
    assert.equal(res.body.phase, 'production')
  })

  test('a style can be created in sampling and development, and moved to production', async () => {
    const { master, res } = await arrange({ phase: 'development' })
    assert.equal(res.body.phase, 'development')
    const moved = await as(master).post('/api/orders/PH-001', { phase: 'production' })
    assert.equal(moved.status, 200, JSON.stringify(moved.body))
    assert.equal((await Order.findById('PH-001').lean()).phase, 'production')
  })

  test('a style from before the field reads as production', async () => {
    const { master } = await arrange()
    await Order.collection.updateOne({ _id: 'PH-001' }, { $unset: { phase: '' } })
    const list = await as(master).get('/api/orders')
    assert.equal(list.body.find(o => o.id === 'PH-001').phase, 'production')
  })

  test('only a known phase is accepted, and a factory cannot change it', async () => {
    const { master, mfr } = await arrange({ phase: 'development' })
    assert.equal((await as(master).post('/api/orders/PH-001', { phase: 'launched' })).status, 400)
    assert.equal((await as(mfr).post('/api/orders/PH-001', { phase: 'production' })).status, 403)
    assert.equal((await Order.findById('PH-001').lean()).phase, 'development')
  })
})
