// Order Setup Wizard, Phase 3: fabric wastage gross-up + the two-tier margin
// formula (manufacturer's own margin, then Tradio's margin/fee computed on
// the manufacturer's full price, confirmed directly rather than assumed).

import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as } from './helpers/client.js'
import { makeAdmin, makeMaster, makeBuyer, makeMfr, orderPayload } from './helpers/factories.js'

let baseUrl = null
before(async () => {
  await startTestDb()
  baseUrl = await startServer()
})
after(async () => {
  await stopServer()
  await stopTestDb()
})
beforeEach(clearDb)

const ORDER_ID = 'MATPHASE3-TEST-001'

async function arrangeOrder() {
  const admin = await makeAdmin()
  const master = await makeMaster()
  const buyer = await makeBuyer()
  const mfr = await makeMfr()
  const api = as(admin)
  const created = await api.post('/api/orders', orderPayload({ id: ORDER_ID, buyerId: buyer._id, mfrId: mfr._id }))
  assert.equal(created.status, 201, JSON.stringify(created.body))
  return { admin, master, buyer, mfr, api }
}

describe('CostSheet — fabric wastage gross-up', () => {
  test('fabricValue is computed on consumption grossed up by wastagePct, not the stated net figure', async () => {
    const { mfr } = await arrangeOrder()
    const res = await as(mfr).post('/api/cost-sheets', {
      scopeType: 'tradio_order', orderId: ORDER_ID,
      fabric: { name: 'Cotton', unit: 'm', consumption: 2, rate: 100, wastagePct: 10 },
    })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    // gross = 2 * 1.10 = 2.2; fabricValue = 2.2 * 100 = 220 (floating point, so compare with tolerance)
    assert.ok(Math.abs(res.body.fabricValue - 220) < 0.001, `expected ~220, got ${res.body.fabricValue}`)
  })

  test('wastagePct defaults to 0 — unchanged behavior for sheets that never set it', async () => {
    const { mfr } = await arrangeOrder()
    const res = await as(mfr).post('/api/cost-sheets', {
      scopeType: 'tradio_order', orderId: ORDER_ID,
      fabric: { name: 'Cotton', unit: 'm', consumption: 2, rate: 100 },
    })
    assert.equal(res.body.fabricValue, 200)
    assert.equal(res.body.fabric.wastagePct, 0)
  })

  test('negative wastagePct is rejected', async () => {
    const { mfr } = await arrangeOrder()
    const res = await as(mfr).post('/api/cost-sheets', {
      scopeType: 'tradio_order', orderId: ORDER_ID,
      fabric: { name: 'Cotton', unit: 'm', consumption: 2, rate: 100, wastagePct: -5 },
    })
    assert.equal(res.status, 400)
  })
})

describe('CostSheet — mfrMarginPct is manufacturer-writable content, unlike marginPct', () => {
  test('the owning manufacturer can set their own margin while draft', async () => {
    const { mfr } = await arrangeOrder()
    const res = await as(mfr).post('/api/cost-sheets', { scopeType: 'tradio_order', orderId: ORDER_ID, mfrMarginPct: 15 })
    assert.equal(res.status, 200)
    assert.equal(res.body.mfrMarginPct, 15)
  })

  test('a buyer response never contains mfrMarginPct/mfrMarginValue, even parsed raw — buyers get zero content, full stop', async () => {
    const { mfr, master, buyer } = await arrangeOrder()
    const create = await as(mfr).post('/api/cost-sheets', {
      scopeType: 'tradio_order', orderId: ORDER_ID, mfrMarginPct: 15,
      fabric: { name: 'Cotton', unit: 'm', consumption: 1, rate: 100 },
    })
    const id = create.body.id
    await as(mfr).post(`/api/cost-sheets/${id}/submit`, {})
    await as(master).post(`/api/cost-sheets/${id}/margin`, { marginPct: 20, tradioFeePct: 10, finalNegotiatedPrice: 999 })
    await as(master).post(`/api/cost-sheets/${id}/approve`, {})

    const res = await as(buyer).get(`/api/cost-sheets/${id}`)
    assert.equal(res.status, 200)
    assert.ok(!JSON.stringify(res.body).includes('mfrMargin'), 'no trace of mfrMargin fields anywhere in the raw buyer response')
  })
})

describe('CostSheet — the two-tier margin formula (confirmed: Tradio margin on the manufacturer\'s FULL price)', () => {
  test('priceValue stacks correctly when both percentages are set', async () => {
    const { mfr, master } = await arrangeOrder()
    // labour only, no fabric/overhead complexity — keeps the arithmetic simple to hand-verify
    const create = await as(mfr).post('/api/cost-sheets', {
      scopeType: 'tradio_order', orderId: ORDER_ID,
      labour: { cuttingThreads: 100, making: 0, finishingPacking: 0 },
      overheadPct: 0, rejectionPct: 0,
      mfrMarginPct: 20,
    })
    const id = create.body.id
    // baseCost = 100 (labour only, 0% overhead/rejection)
    assert.equal(create.body.baseCost, 100)
    // mfrMarginValue = 100 * 0.20 = 20; mfrSellPrice = 120
    assert.equal(create.body.mfrMarginValue, 20)
    assert.equal(create.body.mfrSellPrice, 120)

    await as(mfr).post(`/api/cost-sheets/${id}/submit`, {})
    const marginRes = await as(master).post(`/api/cost-sheets/${id}/margin`, { marginPct: 10, tradioFeePct: 10 })
    assert.equal(marginRes.status, 200, JSON.stringify(marginRes.body))
    // Tradio margin/fee compute on mfrSellPrice (120), NOT baseCost (100):
    // marginValue = 120 * 0.10 = 12; tradioFeeValue = 120 * 0.10 = 12
    // price = 120 + 12 + 12 = 144
    assert.equal(marginRes.body.marginValue, 12)
    assert.equal(marginRes.body.tradioFeeValue, 12)
    assert.equal(marginRes.body.price, 144)
  })

  test('priceValue falls back to baseCost when mfrMarginPct is unset — backward compatible with every pre-Phase-3 sheet', async () => {
    const { mfr, master } = await arrangeOrder()
    const create = await as(mfr).post('/api/cost-sheets', {
      scopeType: 'tradio_order', orderId: ORDER_ID,
      labour: { cuttingThreads: 100, making: 0, finishingPacking: 0 },
      overheadPct: 0, rejectionPct: 0,
      // mfrMarginPct deliberately never set
    })
    const id = create.body.id
    assert.equal(create.body.mfrMarginPct, null)
    assert.equal(create.body.mfrSellPrice, null)

    await as(mfr).post(`/api/cost-sheets/${id}/submit`, {})
    const marginRes = await as(master).post(`/api/cost-sheets/${id}/margin`, { marginPct: 10, tradioFeePct: 10 })
    // Falls back to baseCost (100): marginValue = 10, tradioFeeValue = 10, price = 120
    assert.equal(marginRes.body.marginValue, 10)
    assert.equal(marginRes.body.tradioFeeValue, 10)
    assert.equal(marginRes.body.price, 120)
  })

  test('mfr_project scope: baseCost + own margin IS the final price — no Tradio computation exists for this scope', async () => {
    const mfr = await makeMfr()
    const project = await as(mfr).post('/api/mfr-projects', { styleName: 'Private Style' })
    const create = await as(mfr).post('/api/cost-sheets', {
      scopeType: 'mfr_project', mfrProjectId: project.body.id,
      labour: { cuttingThreads: 100, making: 0, finishingPacking: 0 },
      overheadPct: 0, rejectionPct: 0,
      mfrMarginPct: 25,
    })
    assert.equal(create.status, 200, JSON.stringify(create.body))
    assert.equal(create.body.baseCost, 100)
    assert.equal(create.body.mfrMarginValue, 25)
    assert.equal(create.body.mfrSellPrice, 125)
    // No Tradio margin fields exist for this scope at all
    assert.equal(create.body.marginPct, undefined)
    assert.equal(create.body.price, undefined)

    // /margin route explicitly refuses mfr_project scope, confirming there is
    // no path for a Tradio layer to ever attach to this sheet.
    const marginAttempt = await as(mfr).post(`/api/cost-sheets/${create.body.id}/margin`, { marginPct: 5 })
    assert.equal(marginAttempt.status, 403, 'requireMaster gate — mfr never has master role, but even if it did the route itself also 400s mfr_project')
  })
})

describe('CostSheet — duplicate carries mfrMarginPct and fabric.wastagePct (content, not master-only)', () => {
  test('cloning a sheet preserves the manufacturer\'s own margin and wastage', async () => {
    const { mfr, buyer } = await arrangeOrder()
    const source = await as(mfr).post('/api/cost-sheets', {
      scopeType: 'tradio_order', orderId: ORDER_ID,
      fabric: { name: 'Cotton', unit: 'm', consumption: 2, rate: 100, wastagePct: 8 },
      mfrMarginPct: 12,
    })
    const secondOrderId = 'MATPHASE3-TEST-002'
    const admin = await makeAdmin()
    await as(admin).post('/api/orders', orderPayload({ id: secondOrderId, buyerId: buyer._id, mfrId: mfr._id }))

    const dup = await as(mfr).post(`/api/cost-sheets/${source.body.id}/duplicate`, { targetOrderId: secondOrderId })
    assert.equal(dup.status, 201, JSON.stringify(dup.body))
    assert.equal(dup.body.fabric.wastagePct, 8)
    assert.equal(dup.body.mfrMarginPct, 12)
  })
})
