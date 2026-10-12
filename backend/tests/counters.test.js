// Server-side numbering: unique under concurrency, and carries on from numbers that already exist.
import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { makeBuyer, makeMfr, makeMasterOrder } from './helpers/factories.js'
import { Order } from '../src/models/Order.js'
import { nextSeq, allocateOrderId, allocateMasterOrderId, categoryForId } from '../src/lib/counters.js'

before(async () => { await startTestDb() })
after(async () => { await stopTestDb() })
beforeEach(async () => { await clearDb() })

const bareOrder = (id, buyerId) => Order.create({
  _id: id, buyerId, product: 'p', category: 'TSHRT', season: 'SS26', totalQty: 10, delivery: new Date('2026-12-31'), assignments: [],
})

describe('nextSeq', () => {
  test('20 simultaneous callers get 20 distinct, gapless numbers', async () => {
    const nums = await Promise.all(Array.from({ length: 20 }, () => nextSeq('series:a')))
    assert.deepEqual([...nums].sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i + 1))
  })

  test('20 simultaneous FIRST callers of a seeded series do not collide either', async () => {
    const nums = await Promise.all(Array.from({ length: 20 }, () => nextSeq('series:seeded', async () => 100)))
    assert.deepEqual([...nums].sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => 101 + i))
  })

  test('series are independent', async () => {
    assert.equal(await nextSeq('x'), 1)
    assert.equal(await nextSeq('x'), 2)
    assert.equal(await nextSeq('y'), 1)
  })
})

describe('allocateOrderId', () => {
  test('carries on from the highest existing number, not the count', async () => {
    const buyer = await makeBuyer()
    await bareOrder('ZAR-TSHRT-SS26-001', buyer._id)
    await bareOrder('ZAR-TSHRT-SS26-007', buyer._id)   // 002-006 were dropped
    assert.equal(await allocateOrderId({ buyerCode: 'ZAR', category: 'TSHRT', season: 'SS26' }), 'ZAR-TSHRT-SS26-008')
  })

  test('numbers per buyer, category and season', async () => {
    const buyer = await makeBuyer()
    await bareOrder('ZAR-TSHRT-SS26-003', buyer._id)
    assert.equal(await allocateOrderId({ buyerCode: 'ZAR', category: 'JEANS', season: 'SS26' }), 'ZAR-JEANS-SS26-001')
    assert.equal(await allocateOrderId({ buyerCode: 'ZAR', category: 'TSHRT', season: 'FW26' }), 'ZAR-TSHRT-FW26-001')
    assert.equal(await allocateOrderId({ buyerCode: 'HMX', category: 'TSHRT', season: 'SS26' }), 'HMX-TSHRT-SS26-001')
  })

  test('is never handed out twice, even when many are created at once', async () => {
    const ids = await Promise.all(Array.from({ length: 15 }, () => allocateOrderId({ buyerCode: 'ZAR', category: 'TSHRT', season: 'SS26' })))
    assert.equal(new Set(ids).size, 15)
  })

  test('a free-text category becomes a safe ID segment', async () => {
    assert.equal(categoryForId('Kids wear (T-shirts)'), 'KIDSWE')
    assert.equal(categoryForId(''), 'XX')
    assert.equal(categoryForId(undefined), 'XX')
    assert.equal(await allocateOrderId({ buyerCode: 'ZAR', category: 'co-ord set', season: undefined }), 'ZAR-COORDS-XX-001')
  })
})

describe('allocateMasterOrderId', () => {
  test('numbers per buyer across seasons, like the browser used to', async () => {
    const buyer = await makeBuyer(), admin = buyer
    await makeMasterOrder({ buyerId: buyer._id, createdBy: admin._id, id: 'MO-ZAR-SS26-001' })
    await makeMasterOrder({ buyerId: buyer._id, createdBy: admin._id, id: 'MO-ZAR-FW26-004' })
    assert.equal(await allocateMasterOrderId({ buyerCode: 'ZAR', season: 'SS27' }), 'MO-ZAR-SS27-005')
    assert.equal(await allocateMasterOrderId({ buyerCode: 'ZAR', season: 'SS27' }), 'MO-ZAR-SS27-006')
    assert.equal(await allocateMasterOrderId({ buyerCode: 'HMX', season: 'SS27' }), 'MO-HMX-SS27-001')
  })

  test('a buyer whose code is a prefix of another\'s is not confused with it', async () => {
    const a = await makeBuyer(), b = await makeBuyer()
    await makeMasterOrder({ buyerId: a._id, createdBy: a._id, id: 'MO-ZARA-SS26-009' })
    assert.equal(await allocateMasterOrderId({ buyerCode: 'ZAR', season: 'SS26' }), 'MO-ZAR-SS26-001')
    void b, makeMfr
  })
})
