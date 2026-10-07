// Regression tests for the first bug-review batch: cross-tenant leaks, plan
// fields a manufacturer must not write, document access, Kriyaa tool input, and
// async route errors that used to hang the request.

import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as, tokenFor } from './helpers/client.js'
import { makeMaster, makeBuyer, makeMfr, orderPayload } from './helpers/factories.js'
import { TOOL_HANDLERS } from '../src/routes/assistant.js'
import { generateTempPassword } from '../src/routes/users.js'

before(async () => {
  await startTestDb()
  const baseUrl = await startServer()
  process.env.PORT = new URL(baseUrl).port
})
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(clearDb)

const ORDER_ID = 'HARD-TEST-001'

async function arrange() {
  const admin = await makeMaster()
  const buyer = await makeBuyer()
  const mfrA = await makeMfr({ company: 'Factory A' })
  const mfrB = await makeMfr({ company: 'Factory B' })
  const outsider = await makeMfr({ company: 'Factory C' })
  const res = await as(admin).post('/api/orders', orderPayload({
    id: ORDER_ID, buyerId: buyer._id, mfrId: mfrA._id, totalQty: 100, delivery: '2026-12-31',
    assignments: [{ mid: String(mfrA._id), qty: 60 }, { mid: String(mfrB._id), qty: 40 }],
    stageNames: ['Cutting', 'Packing'],
    stageStartDates: ['2026-07-01', '2026-07-05'], stageEtas: ['2026-07-03', '2026-07-10'],
  }))
  assert.equal(res.status, 201, JSON.stringify(res.body))
  return { admin, buyer, mfrA, mfrB, outsider, api: as(admin), a: as(mfrA), b: as(mfrB) }
}

describe('manufacturer write responses are scoped to the caller', () => {
  test('a stage update returns only the caller\'s own split', async () => {
    const { mfrA, mfrB, a } = await arrange()
    const res = await a.post(`/api/orders/${ORDER_ID}/assignments/${mfrA._id}/stages/0`, { note: 'cutting started' })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    const mids = res.body.assignments.map(x => String(x.mid))
    assert.deepEqual(mids, [String(mfrA._id)])
    assert.ok(!JSON.stringify(res.body).includes(String(mfrB._id)))
  })

  test('a stage note returns only the caller\'s own split', async () => {
    const { mfrA, mfrB, a } = await arrange()
    const res = await a.post(`/api/orders/${ORDER_ID}/assignments/${mfrA._id}/stages/0/updates`, { text: 'hello' })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.ok(!JSON.stringify(res.body).includes(String(mfrB._id)))
  })

  test('an admin still gets every split back', async () => {
    const { mfrA, api } = await arrange()
    const res = await api.post(`/api/orders/${ORDER_ID}/assignments/${mfrA._id}/stages/0`, { note: 'x' })
    assert.equal(res.status, 200)
    assert.equal(res.body.assignments.length, 2)
  })
})

describe('plan fields are admin-only for manufacturers', () => {
  test('single-stage route rejects eta and startDate but allows progress', async () => {
    const { mfrA, a } = await arrange()
    const base = `/api/orders/${ORDER_ID}/assignments/${mfrA._id}/stages/0`
    assert.equal((await a.post(base, { eta: '2027-01-01' })).status, 403)
    assert.equal((await a.post(base, { startDate: '2027-01-01' })).status, 403)
    assert.equal((await a.post(base, { status: 'in_progress' })).status, 200)
  })

  test('bulk route rejects plan keys but allows progress', async () => {
    const { mfrA, a } = await arrange()
    const base = `/api/orders/${ORDER_ID}/assignments/${mfrA._id}/stages/bulk`
    for (const patch of [{ eta: '2027-01-01' }, { totalUnits: 5 }, { kind: 'milestone' }, { description: 'x' }, { responsibleId: String(mfrA._id) }]) {
      const res = await a.post(base, { stages: [{ index: 0, ...patch }] })
      assert.equal(res.status, 403, `${Object.keys(patch)[0]}: ${JSON.stringify(res.body)}`)
    }
    assert.equal((await a.post(base, { stages: [{ index: 0, blocked: true, blockedReason: 'waiting on trims' }] })).status, 200)
  })

  test('an admin can still move dates', async () => {
    const { mfrA, api } = await arrange()
    const res = await api.post(`/api/orders/${ORDER_ID}/assignments/${mfrA._id}/stages/bulk`, { stages: [{ index: 0, eta: '2026-08-01' }] })
    assert.equal(res.status, 200, JSON.stringify(res.body))
  })
})

describe('manufacturer document access', () => {
  const link = orderId => ({ type: 'tech_pack', name: 'Spec', externalUrl: 'https://example.com/spec', ...(orderId ? { orderId } : {}) })

  test('cannot attach a document to an order they are not assigned to', async () => {
    const { outsider } = await arrange()
    const res = await as(outsider).post('/api/documents', link(ORDER_ID))
    assert.equal(res.status, 403, JSON.stringify(res.body))
  })

  test('can attach a document to an order they are assigned to', async () => {
    const { b } = await arrange()
    const res = await b.post('/api/documents', link(ORDER_ID))
    assert.equal(res.status, 201, JSON.stringify(res.body))
  })

  test('the list hides a competing manufacturer\'s documents on a shared order', async () => {
    const { mfrA, a, b } = await arrange()
    const mine = await a.post('/api/documents', { ...link(ORDER_ID), name: 'A only', mfrId: String(mfrA._id) })
    assert.equal(mine.status, 201)
    const listB = await b.get('/api/documents')
    assert.ok(!listB.body.some(d => d.name === 'A only'), 'B must not see A\'s own document')
    const listA = await a.get('/api/documents')
    assert.ok(listA.body.some(d => d.name === 'A only'))
  })
})

describe('Kriyaa tool input is validated', () => {
  const ctxFor = user => ({ cookie: `tradio_token=${tokenFor(user)}`, user })

  test('traversal and malformed ids never reach a request', async () => {
    const { admin, mfrA } = await arrange()
    const ctx = ctxFor(admin)
    const bad = [
      { orderId: 'x/../../action-items/abc/delete#', mfrId: String(mfrA._id), stageIndex: 0 },
      { orderId: ORDER_ID, mfrId: '../../users', stageIndex: 0 },
      { orderId: ORDER_ID, mfrId: String(mfrA._id), stageIndex: '0/../..' },
      { orderId: '..', mfrId: String(mfrA._id), stageIndex: 0 },
    ]
    for (const input of bad) {
      for (const tool of ['post_stage_update', 'update_stage_status', 'update_stage_dates']) {
        const r = await TOOL_HANDLERS[tool]({ ...input, text: 't' }, ctx)
        assert.equal(r.ok, false, `${tool} ${JSON.stringify(input)}`)
        assert.equal(r.status, 400)
      }
    }
    assert.equal((await TOOL_HANDLERS.get_order({ orderId: 'a/../../users' }, ctx)).status, 400)
    assert.equal((await TOOL_HANDLERS.check_delivery_risk({ orderId: 'a?b' }, ctx)).status, 400)
    assert.equal((await TOOL_HANDLERS.update_action_item({ id: '../orders' }, ctx)).status, 400)
    assert.equal((await TOOL_HANDLERS.add_action_item_update({ id: 'abc', text: 't' }, ctx)).status, 400)
  })

  test('valid ids still work', async () => {
    const { admin, mfrA } = await arrange()
    const ctx = ctxFor(admin)
    const r = await TOOL_HANDLERS.post_stage_update({ orderId: ORDER_ID, mfrId: String(mfrA._id), stageIndex: 0, text: 'ok' }, ctx)
    assert.equal(r.ok, true, JSON.stringify(r.data))
  })

  test('unknown body keys are not forwarded to the route', async () => {
    const { admin, mfrA, api } = await arrange()
    const ctx = ctxFor(admin)
    const r = await TOOL_HANDLERS.update_stage_status(
      { orderId: ORDER_ID, mfrId: String(mfrA._id), stageIndex: 0, note: 'n', sneaky: 'x', responsibleId: String(admin._id) }, ctx)
    assert.equal(r.ok, true, JSON.stringify(r.data))
    const after = (await api.get(`/api/orders/${ORDER_ID}`)).body
    const stage = after.assignments.find(x => String(x.mid) === String(mfrA._id)).stages[0]
    assert.notEqual(String(stage.responsibleId), String(admin._id))
  })

  test('check_delivery_risk does not reveal another factory\'s overrun to a manufacturer', async () => {
    const { admin, mfrA, mfrB, api } = await arrange()
    const late = await api.post(`/api/orders/${ORDER_ID}/assignments/${mfrB._id}/stages/1/eta`, { eta: '2027-03-01' })
    assert.equal(late.status, 200, JSON.stringify(late.body))
    const asAdmin = await TOOL_HANDLERS.check_delivery_risk({ orderId: ORDER_ID }, ctxFor(admin))
    assert.ok(asAdmin.data.deliveryOverrunDays > 0, 'admin sees the overrun')
    const asA = await TOOL_HANDLERS.check_delivery_risk({ orderId: ORDER_ID }, ctxFor(mfrA))
    assert.equal(asA.ok, true, JSON.stringify(asA.data))
    assert.equal(asA.data.deliveryOverrunDays, null)
    assert.equal(asA.data.assignments.length, 1)
  })
})

describe('async route errors', () => {
  test('a rejected handler answers with an error instead of hanging', async () => {
    const { api } = await arrange()
    const timeout = new Promise(resolve => setTimeout(() => resolve('hung'), 4000))
    const res = await Promise.race([api.post('/api/review/not-an-id/approve', {}), timeout])
    assert.notEqual(res, 'hung', 'request never completed')
    assert.ok(res.status >= 400 && res.status < 600, `status ${res.status}`)
  })
})

describe('admin password reset', () => {
  test('temporary passwords satisfy the password policy', () => {
    for (let i = 0; i < 200; i++) {
      const pw = generateTempPassword()
      assert.equal(pw.length, 14)
      assert.match(pw, /[A-Z]/)
      assert.match(pw, /[a-z]/)
      assert.match(pw, /[0-9]/)
      assert.match(pw, /[^A-Za-z0-9]/)
    }
    assert.notEqual(generateTempPassword(), generateTempPassword())
  })

  test('a reset signs out the user\'s existing sessions', async () => {
    const master = await makeMaster()
    const victim = await makeMfr()
    const old = as(victim)
    assert.equal((await old.get('/api/orders')).status, 200)
    await new Promise(r => setTimeout(r, 1100)) // token iat is in whole seconds
    const res = await as(master).post(`/api/users/${victim._id}/reset-password`, {})
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal((await old.get('/api/orders')).status, 401)
  })
})

describe('bad input is a 400, not a 500', () => {
  test('order creation rejects a bad quantity or malformed lists', async () => {
    const { admin, buyer, mfrA } = await arrange()
    const api = as(admin)
    const base = orderPayload({ buyerId: buyer._id, mfrId: mfrA._id })
    for (const patch of [{ totalQty: -5 }, { totalQty: 'abc' }, { totalQty: 2.5 }, { category: { x: 1 } }, { stageEtas: 'nope' }, { stageNames: 'nope' }]) {
      const res = await api.post('/api/orders', { ...base, id: `BAD-${Math.random().toString(36).slice(2, 8)}`, ...patch })
      assert.equal(res.status, 400, `${JSON.stringify(patch)} -> ${res.status} ${JSON.stringify(res.body)}`)
    }
  })

  test('action items reject a malformed id or a non-text title', async () => {
    const { admin } = await arrange()
    const api = as(admin)
    assert.equal((await api.post('/api/action-items/not-an-id', { status: 'done' })).status, 400)
    assert.equal((await api.post('/api/action-items', { title: 42, assigneeId: String(admin._id) })).status, 400)
  })
})

describe('product links must be real web addresses', () => {
  test('a bare address gets https://, a dangerous scheme is refused', async () => {
    const { admin, buyer, mfrA } = await arrange()
    const api = as(admin)
    const mk = (id, ecommerceLink) => api.post('/api/orders', { ...orderPayload({ buyerId: buyer._id, mfrId: mfrA._id }), id, ecommerceLink })
    assert.equal((await mk('LNK-001', 'javascript:alert(1)')).status, 400)
    assert.equal((await mk('LNK-002', 'not a link at all')).status, 400)
    assert.equal((await mk('LNK-003', 'data:text/html,<script>1</script>')).status, 400)
    const bare = await mk('LNK-004', 'amazon.in/some-product')
    assert.equal(bare.status, 201, JSON.stringify(bare.body))
    assert.equal(bare.body.ecommerceLink, 'https://amazon.in/some-product')
    const full = await mk('LNK-005', 'https://example.com/product/1')
    assert.equal(full.body.ecommerceLink, 'https://example.com/product/1')
    assert.equal((await mk('LNK-006', '')).status, 201)
    assert.equal((await api.post('/api/orders/LNK-005', { ecommerceLink: 'vbscript:x' })).status, 400)
    const edited = await api.post('/api/orders/LNK-005', { ecommerceLink: 'example.com' })
    assert.equal(edited.status, 200)
    assert.equal(edited.body.ecommerceLink, 'https://example.com')
    assert.equal((await api.post('/api/orders/LNK-005', { ecommerceLink: '' })).status, 200)
  })
})
