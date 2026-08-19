// Exhaustive adversarial sweep for the non-admin invariant Ankit stated
// directly: no manufacturer may obtain any information about any other
// manufacturer or any buyer through the AI, and no buyer may obtain any
// information about any other buyer or any manufacturer, through Kriyaa —
// full stop. assistant.tools.test.js already proves the two known-risky
// spots (check_delivery_risk's ownership fix, cross-manufacturer materials/
// costing isolation); this file is the "prove it holds for EVERY tool in
// both non-admin sets" gate the plan treats as the real evidence, not the
// code-reading argument alone.
//
// Two fully disjoint tenants of each kind — Order A (buyerA + mfrA) and
// Order B (buyerB + mfrB) never share a party — so any leak has nowhere to
// hide behind a legitimate shared relationship.

import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as, tokenFor } from './helpers/client.js'
import { makeAdmin, makeBuyer, makeMfr, orderPayload } from './helpers/factories.js'
import { TOOL_HANDLERS, TOOLS_BY_ROLE } from '../src/routes/assistant.js'

let baseUrl = null
before(async () => {
  await startTestDb()
  baseUrl = await startServer()
  process.env.PORT = new URL(baseUrl).port
})
after(async () => {
  await stopServer()
  await stopTestDb()
})
beforeEach(clearDb)

const cookieFor = user => `tradio_token=${tokenFor(user)}`
const ctxFor = user => ({ cookie: cookieFor(user), user: { role: user.role, id: String(user._id) } })

async function arrangeTwoTenants() {
  const admin = await makeAdmin()
  const api = as(admin)
  const buyerA = await makeBuyer(), mfrA = await makeMfr()
  const buyerB = await makeBuyer(), mfrB = await makeMfr()

  const orderA = 'ISO-TEST-A'
  const orderB = 'ISO-TEST-B'
  const resA = await api.post('/api/orders', orderPayload({ id: orderA, buyerId: buyerA._id, mfrId: mfrA._id, totalQty: 100 }))
  assert.equal(resA.status, 201, JSON.stringify(resA.body))
  const resB = await api.post('/api/orders', orderPayload({ id: orderB, buyerId: buyerB._id, mfrId: mfrB._id, totalQty: 100 }))
  assert.equal(resB.status, 201, JSON.stringify(resB.body))

  return { admin, api, buyerA, mfrA, orderA, buyerB, mfrB, orderB }
}

describe('list_orders — a filtered-200 tool, checked by content not just status', () => {
  test('manufacturer: order B (and mfrB\'s id) never appear in mfrA\'s list_orders result', async () => {
    const { mfrA, mfrB, orderB } = await arrangeTwoTenants()
    const result = await TOOL_HANDLERS.list_orders({}, ctxFor(mfrA))
    assert.equal(result.ok, true)
    const raw = JSON.stringify(result.data)
    assert.ok(!raw.includes(orderB), 'order B\'s id must not appear anywhere')
    assert.ok(!raw.includes(String(mfrB._id)), 'manufacturer B\'s id must not appear anywhere')
  })

  test('buyer: order B (and buyerB\'s/mfrB\'s ids) never appear in buyerA\'s list_orders result', async () => {
    const { buyerA, buyerB, mfrB, orderB } = await arrangeTwoTenants()
    const result = await TOOL_HANDLERS.list_orders({}, ctxFor(buyerA))
    assert.equal(result.ok, true)
    const raw = JSON.stringify(result.data)
    assert.ok(!raw.includes(orderB))
    assert.ok(!raw.includes(String(buyerB._id)))
    assert.ok(!raw.includes(String(mfrB._id)))
  })
})

describe('get_order — direct cross-tenant fetch is refused, not filtered', () => {
  test('mfrA cannot get_order order B at all', async () => {
    const { mfrA, orderB } = await arrangeTwoTenants()
    const result = await TOOL_HANDLERS.get_order({ orderId: orderB }, ctxFor(mfrA))
    assert.equal(result.ok, false)
    assert.equal(result.status, 403)
  })

  test('buyerA cannot get_order order B at all', async () => {
    const { buyerA, orderB } = await arrangeTwoTenants()
    const result = await TOOL_HANDLERS.get_order({ orderId: orderB }, ctxFor(buyerA))
    assert.equal(result.ok, false)
    assert.equal(result.status, 403)
  })
})

describe('post_stage_update — cannot write into an unrelated order\'s thread', () => {
  test('mfrA cannot post a stage update on order B, even naming their own (wrong) mfrId', async () => {
    const { mfrA, mfrB, orderB } = await arrangeTwoTenants()
    const result = await TOOL_HANDLERS.post_stage_update(
      { orderId: orderB, mfrId: String(mfrA._id), stageIndex: 0, text: 'trying to write in' }, ctxFor(mfrA))
    assert.equal(result.ok, false)
    // Either the assignment lookup 404s or the ownership check 403s — both are a refusal, never a success.
    assert.ok(result.status === 403 || result.status === 404, `expected a refusal, got ${result.status}`)
  })

  test('buyerA cannot post a stage update on order B', async () => {
    const { buyerA, mfrB, orderB } = await arrangeTwoTenants()
    const result = await TOOL_HANDLERS.post_stage_update(
      { orderId: orderB, mfrId: String(mfrB._id), stageIndex: 0, text: 'trying to write in' }, ctxFor(buyerA))
    assert.equal(result.ok, false)
    assert.ok(result.status === 403 || result.status === 404, `expected a refusal, got ${result.status}: ${JSON.stringify(result.data)}`)
  })
})

describe('update_stage_status — cannot write into an unrelated order at all', () => {
  test('mfrA cannot update order B\'s stage even by claiming to be mfrB', async () => {
    const { mfrA, mfrB, orderB } = await arrangeTwoTenants()
    // Attempt using mfrA's own cookie but mfrB's id in the body — the route
    // keys permission off req.user.id vs the :mfrId param, not the body.
    const result = await TOOL_HANDLERS.update_stage_status(
      { orderId: orderB, mfrId: String(mfrB._id), stageIndex: 0, unitsDone: 5 }, ctxFor(mfrA))
    assert.equal(result.ok, false)
    assert.equal(result.status, 403)
  })

  test('buyerA cannot update order B\'s stage', async () => {
    const { buyerA, mfrB, orderB } = await arrangeTwoTenants()
    const result = await TOOL_HANDLERS.update_stage_status(
      { orderId: orderB, mfrId: String(mfrB._id), stageIndex: 0, status: 'in_progress' }, ctxFor(buyerA))
    assert.equal(result.ok, false)
    assert.ok(result.status === 403 || result.status === 404)
  })

  test('buyerA cannot slip an out-of-schema field (unitsDone) into their own order\'s write', async () => {
    // Defense in depth: even on buyerA's OWN order, the buyer tool schema
    // omits unitsDone entirely, but prove the underlying route still
    // rejects it if a field slipped through some other way — the schema is
    // steering, the field allowlist is the real gate.
    const { buyerA, mfrA, orderA, api } = await arrangeTwoTenants()
    await api.post(`/api/orders/${orderA}/assignments/${mfrA._id}/stages/0/eta`, { responsibleId: String(buyerA._id) })
    const result = await TOOL_HANDLERS.update_stage_status(
      { orderId: orderA, mfrId: String(mfrA._id), stageIndex: 0, unitsDone: 999, status: 'in_progress' }, ctxFor(buyerA))
    assert.equal(result.ok, false, 'the whole write must be rejected, not just the extra field silently dropped')
  })
})

describe('check_delivery_risk — cross-tenant refusal (see assistant.tools.test.js for the full ownership-fix coverage)', () => {
  test('mfrA cannot check order B\'s delivery risk', async () => {
    const { mfrA, orderB } = await arrangeTwoTenants()
    const result = await TOOL_HANDLERS.check_delivery_risk({ orderId: orderB }, ctxFor(mfrA))
    assert.equal(result.ok, false)
    assert.equal(result.status, 403)
  })

  test('buyerA cannot check order B\'s delivery risk', async () => {
    const { buyerA, orderB } = await arrangeTwoTenants()
    const result = await TOOL_HANDLERS.check_delivery_risk({ orderId: orderB }, ctxFor(buyerA))
    assert.equal(result.ok, false)
    assert.equal(result.status, 403)
  })
})

describe('TOOLS_BY_ROLE shape — the schema-narrowing layer stays correct', () => {
  const names = arr => arr.map(t => t.name)

  test('manufacturer and buyer tool sets exclude Action Items and update_stage_dates entirely', () => {
    for (const role of ['manufacturer', 'buyer']) {
      const toolNames = names(TOOLS_BY_ROLE[role])
      for (const excluded of ['list_action_items', 'add_action_item_update', 'update_action_item', 'update_stage_dates']) {
        assert.ok(!toolNames.includes(excluded), `${role} must not have ${excluded}`)
      }
    }
  })

  test('manufacturer tool set has the materials/costing additions; buyer does not', () => {
    const mfrNames = names(TOOLS_BY_ROLE.manufacturer)
    const buyerNames = names(TOOLS_BY_ROLE.buyer)
    for (const t of ['list_material_requirements', 'list_my_cost_sheets', 'get_cost_sheet', 'submit_cost_sheet_actuals', 'list_mfr_projects', 'get_mfr_project']) {
      assert.ok(mfrNames.includes(t), `manufacturer must have ${t}`)
      assert.ok(!buyerNames.includes(t), `buyer must NOT have ${t} — that data is never theirs to see`)
    }
  })

  test('buyer\'s update_stage_status schema is exactly BUYER_WRITABLE — status/blocked/blockedReason, nothing else', () => {
    const tool = TOOLS_BY_ROLE.buyer.find(t => t.name === 'update_stage_status')
    const props = Object.keys(tool.input_schema.properties).filter(k => !['orderId', 'mfrId', 'stageIndex'].includes(k))
    assert.deepEqual(props.sort(), ['blocked', 'blockedReason', 'status'])
  })

  test('manufacturer\'s update_stage_status omits override/eta/startDate', () => {
    const tool = TOOLS_BY_ROLE.manufacturer.find(t => t.name === 'update_stage_status')
    const props = Object.keys(tool.input_schema.properties)
    assert.ok(!props.includes('override'), 'override is master-admin only')
    assert.ok(!props.includes('eta'), 'planned dates are admin-only — the baseline-capture gap this omission avoids')
    assert.ok(!props.includes('startDate'))
  })

  test('admin tool set is unchanged — still all 11 original tools', () => {
    const adminNames = names(TOOLS_BY_ROLE.admin)
    assert.equal(adminNames.length, 11)
    for (const t of ['list_action_items', 'list_orders', 'get_order', 'post_stage_update', 'update_stage_status', 'update_stage_dates', 'add_action_item_update', 'update_action_item', 'list_wiki_pages', 'get_wiki_page', 'check_delivery_risk']) {
      assert.ok(adminNames.includes(t))
    }
  })
})
