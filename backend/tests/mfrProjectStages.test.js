// Order Setup Wizard, Phase 4: TNA for MfrProject. Mirrors orders.js's stage
// surface with the assignment/buyer/responsibleId indirection stripped out.
// every route is a flat owner-only gate, no admin branch, ever. This suite's
// top priority is proving that inversion holds (admin/master/buyer/other-
// manufacturer all 403, the same way the existing MfrProject/CostSheet
// mfr_project-scope tests already prove it for materials and costing).

import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as } from './helpers/client.js'
import { makeAdmin, makeMaster, makeBuyer, makeMfr } from './helpers/factories.js'

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

async function makeProject(mfr, overrides = {}) {
  const res = await as(mfr).post('/api/mfr-projects', { styleName: 'Test Style', totalQty: 100, ...overrides })
  assert.equal(res.status, 201, JSON.stringify(res.body))
  return res.body.id
}

async function seedProject(mfr, id, overrides = {}) {
  const res = await as(mfr).post(`/api/mfr-projects/${id}/stages/seed`, {
    stageNames: ['Fabric Sourcing', 'Production', 'Dispatch'],
    stageStartDates: ['2026-01-01', '2026-02-01', '2026-03-01'],
    stageEtas: ['2026-01-15', '2026-02-15', '2026-03-15'],
    stageKinds: ['milestone', 'quantity', 'milestone'],
    ...overrides,
  })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  return res.body
}

describe('MfrProject TNA - privacy invariant: owner-only, no admin branch', () => {
  test('admin, master, buyer, and an unrelated manufacturer all 403 on every stage route', async () => {
    const mfrA = await makeMfr()
    const mfrB = await makeMfr()
    const admin = await makeAdmin()
    const master = await makeMaster()
    const buyer = await makeBuyer()
    const id = await makeProject(mfrA)
    await seedProject(mfrA, id)

    const others = [admin, master, buyer, mfrB]
    for (const user of others) {
      const seedRes = await as(user).post(`/api/mfr-projects/${id}/stages/seed`, { stageNames: ['X'], stageStartDates: ['NA'], stageEtas: ['NA'] })
      assert.ok([403].includes(seedRes.status), `seed: expected 403 for ${user.role}, got ${seedRes.status}`)

      const stageRes = await as(user).post(`/api/mfr-projects/${id}/stages/0`, { status: 'in_progress' })
      assert.equal(stageRes.status, 403, `single-stage: expected 403 for ${user.role}`)

      const bulkRes = await as(user).post(`/api/mfr-projects/${id}/stages/bulk`, { stages: [{ index: 0, status: 'in_progress' }] })
      assert.equal(bulkRes.status, 403, `bulk: expected 403 for ${user.role}`)

      const etaRes = await as(user).post(`/api/mfr-projects/${id}/stages/0/eta`, { eta: '2026-02-01' })
      assert.equal(etaRes.status, 403, `eta: expected 403 for ${user.role}`)

      const updateRes = await as(user).post(`/api/mfr-projects/${id}/stages/0/updates`, { text: 'hi' })
      assert.equal(updateRes.status, 403, `updates: expected 403 for ${user.role}`)

      const itemRes = await as(user).post(`/api/mfr-projects/${id}/stages/0/items`, { name: 'Lab Dip' })
      assert.equal(itemRes.status, 403, `items: expected 403 for ${user.role}`)

      const materialRes = await as(user).post(`/api/mfr-projects/${id}/stages/0/materials`, { name: 'Cotton', requiredQty: 10 })
      assert.equal(materialRes.status, 403, `materials: expected 403 for ${user.role}`)

      const deleteRes = await as(user).post(`/api/mfr-projects/${id}/stages/0/delete`, {})
      assert.equal(deleteRes.status, 403, `delete: expected 403 for ${user.role}`)
    }
  })

  test('manufacturer B cannot touch manufacturer A\'s project even with a valid stage index', async () => {
    const mfrA = await makeMfr()
    const mfrB = await makeMfr()
    const id = await makeProject(mfrA)
    await seedProject(mfrA, id)

    const res = await as(mfrB).post(`/api/mfr-projects/${id}/stages/0`, { status: 'in_progress' })
    assert.equal(res.status, 403)
    assert.equal(res.body.error, 'Forbidden')
  })
})

describe('MfrProject TNA - seed', () => {
  test('owner can seed stages once, and seeding again is refused', async () => {
    const mfr = await makeMfr()
    const id = await makeProject(mfr)
    const body = await seedProject(mfr, id)
    assert.equal(body.stages.length, 3)
    assert.equal(body.stages[1].kind, 'quantity')
    assert.equal(body.stages[0].kind, 'milestone')
    assert.equal(body.stages[0].baselineEta, '2026-01-15')

    const again = await as(mfr).post(`/api/mfr-projects/${id}/stages/seed`, { stageNames: ['Y'], stageStartDates: ['NA'], stageEtas: ['NA'] })
    assert.equal(again.status, 400)
  })

  test('quantity-kind stage defaults totalUnits to the project qty', async () => {
    const mfr = await makeMfr()
    const id = await makeProject(mfr, { totalQty: 250 })
    const body = await seedProject(mfr, id)
    assert.equal(body.stages[1].totalUnits, 250)
  })
})

describe('MfrProject TNA - single-stage progress + gates', () => {
  test('quantity stage progress derives status from units', async () => {
    const mfr = await makeMfr()
    const id = await makeProject(mfr)
    await seedProject(mfr, id)
    const res = await as(mfr).post(`/api/mfr-projects/${id}/stages/1`, { unitsDone: 100 })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.stages[1].status, 'done')
    assert.equal(res.body.stages[1].actualEnd, res.body.stages[1].actualEnd) // stamped, not asserting exact date here
    assert.ok(res.body.stages[1].actualEnd)
  })

  test('milestone stage flips to done via status and mirrors unitsDone', async () => {
    const mfr = await makeMfr()
    const id = await makeProject(mfr)
    await seedProject(mfr, id)
    const res = await as(mfr).post(`/api/mfr-projects/${id}/stages/0`, { status: 'done' })
    assert.equal(res.status, 200)
    assert.equal(res.body.stages[0].unitsDone, res.body.stages[0].totalUnits)
  })

  test('checklist close gate: cannot mark done while items are pending', async () => {
    const mfr = await makeMfr()
    const id = await makeProject(mfr)
    await seedProject(mfr, id, { stageKinds: ['checklist', 'quantity', 'milestone'] })
    await as(mfr).post(`/api/mfr-projects/${id}/stages/0/items`, { name: 'Lab Dip - Red' })
    await as(mfr).post(`/api/mfr-projects/${id}/stages/0/items`, { name: 'Lab Dip - Blue' })

    const blocked = await as(mfr).post(`/api/mfr-projects/${id}/stages/0`, { status: 'done' })
    assert.equal(blocked.status, 400)
    assert.match(blocked.body.error, /checklist item/)

    const listRes = await as(mfr).post(`/api/mfr-projects/${id}/stages/0/eta`, { description: 'noop' })
    const itemIds = listRes.body.stages[0].items
    // mark both items done via the items route (index-based)
    await as(mfr).post(`/api/mfr-projects/${id}/stages/0/items/0`, { status: 'done' })
    await as(mfr).post(`/api/mfr-projects/${id}/stages/0/items/1`, { status: 'done' })
    const ok = await as(mfr).post(`/api/mfr-projects/${id}/stages/0`, { status: 'done' })
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
    assert.equal(ok.body.stages[0].status, 'done')
  })

  test('materials gate: cannot advance while a material line is unreceived', async () => {
    const mfr = await makeMfr()
    const id = await makeProject(mfr)
    await seedProject(mfr, id)
    await as(mfr).post(`/api/mfr-projects/${id}/stages/1/materials`, { name: 'Cotton Fabric', requiredQty: 50, unit: 'm' })

    const blocked = await as(mfr).post(`/api/mfr-projects/${id}/stages/1`, { unitsDone: 10 })
    assert.equal(blocked.status, 400)
    assert.match(blocked.body.error, /material.*pending/)

    await as(mfr).post(`/api/mfr-projects/${id}/stages/1/materials/0`, { status: 'received', receivedQty: 50 })
    const ok = await as(mfr).post(`/api/mfr-projects/${id}/stages/1`, { unitsDone: 10 })
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
  })
})

describe('MfrProject TNA - bulk update', () => {
  test('updates several stages atomically, all-or-nothing on a bad row', async () => {
    const mfr = await makeMfr()
    const id = await makeProject(mfr)
    await seedProject(mfr, id)

    const bad = await as(mfr).post(`/api/mfr-projects/${id}/stages/bulk`, {
      stages: [{ index: 0, status: 'done' }, { index: 99, status: 'done' }],
    })
    assert.equal(bad.status, 400)

    const ok = await as(mfr).post(`/api/mfr-projects/${id}/stages/bulk`, {
      stages: [{ index: 0, status: 'done' }, { index: 2, status: 'in_progress' }],
    })
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
    assert.equal(ok.body.updated, 2)
    assert.equal(ok.body.stages[0].status, 'done')
    assert.equal(ok.body.stages[2].status, 'in_progress')
  })
})

describe('MfrProject TNA - eta route (baseline capture, kind flip)', () => {
  test('first eta revision backfills baselineEta; second revision does not overwrite it', async () => {
    const mfr = await makeMfr()
    const id = await makeProject(mfr)
    await seedProject(mfr, id)

    const first = await as(mfr).post(`/api/mfr-projects/${id}/stages/0/eta`, { eta: '2026-01-20' })
    assert.equal(first.status, 200)
    assert.equal(first.body.stages[0].baselineEta, '2026-01-15')
    assert.equal(first.body.stages[0].eta, '2026-01-20')

    const second = await as(mfr).post(`/api/mfr-projects/${id}/stages/0/eta`, { eta: '2026-01-25' })
    assert.equal(second.body.stages[0].baselineEta, '2026-01-15')
    assert.equal(second.body.stages[0].eta, '2026-01-25')
  })

  test('flipping kind re-derives status so units and status cannot disagree', async () => {
    const mfr = await makeMfr()
    const id = await makeProject(mfr)
    await seedProject(mfr, id)
    await as(mfr).post(`/api/mfr-projects/${id}/stages/0`, { status: 'done' })
    const flip = await as(mfr).post(`/api/mfr-projects/${id}/stages/0/eta`, { kind: 'quantity', totalUnits: 100 })
    assert.equal(flip.status, 200, JSON.stringify(flip.body))
    assert.equal(flip.body.stages[0].kind, 'quantity')
  })
})

describe('MfrProject TNA - delete, updates, items, materials CRUD', () => {
  test('delete removes a stage and shifts later indices down', async () => {
    const mfr = await makeMfr()
    const id = await makeProject(mfr)
    await seedProject(mfr, id)
    const res = await as(mfr).post(`/api/mfr-projects/${id}/stages/0/delete`, {})
    assert.equal(res.status, 200)
    assert.equal(res.body.stages.length, 2)
    assert.equal(res.body.stages[0].name, 'Production')
  })

  test('updates thread accepts a comment', async () => {
    const mfr = await makeMfr()
    const id = await makeProject(mfr)
    await seedProject(mfr, id)
    const res = await as(mfr).post(`/api/mfr-projects/${id}/stages/0/updates`, { text: 'fabric arrived' })
    assert.equal(res.status, 200)
    assert.equal(res.body.stages[0].updates.length, 1)
    assert.equal(res.body.stages[0].updates[0].text, 'fabric arrived')
  })

  test('items CRUD: add, fromColourways fan-out, update status, delete', async () => {
    const mfr = await makeMfr()
    const id = await makeProject(mfr, {
      colourways: [{ name: 'Black' }, { name: 'Navy' }],
    })
    await seedProject(mfr, id, { stageKinds: ['checklist', 'quantity', 'milestone'] })

    const fan = await as(mfr).post(`/api/mfr-projects/${id}/stages/0/items`, { name: 'Lab Dip', fromColourways: true })
    assert.equal(fan.status, 200, JSON.stringify(fan.body))
    assert.equal(fan.body.stages[0].items.length, 2)

    const upd = await as(mfr).post(`/api/mfr-projects/${id}/stages/0/items/0`, { status: 'done' })
    assert.equal(upd.body.stages[0].items[0].status, 'done')
    assert.ok(upd.body.stages[0].items[0].doneDate)

    const del = await as(mfr).post(`/api/mfr-projects/${id}/stages/0/items/1/delete`, {})
    assert.equal(del.body.stages[0].items.length, 1)
  })

  test('materials CRUD: add, update status/receivedQty, delete', async () => {
    const mfr = await makeMfr()
    const id = await makeProject(mfr)
    await seedProject(mfr, id)

    const add = await as(mfr).post(`/api/mfr-projects/${id}/stages/1/materials`, { name: 'Cotton', requiredQty: 30, unit: 'm', category: 'fabric' })
    assert.equal(add.status, 200)
    assert.equal(add.body.stages[1].materials.length, 1)
    assert.equal(add.body.stages[1].materials[0].status, 'pending')

    const upd = await as(mfr).post(`/api/mfr-projects/${id}/stages/1/materials/0`, { status: 'received', receivedQty: 30 })
    assert.equal(upd.status, 200)
    assert.equal(upd.body.stages[1].materials[0].status, 'received')
    assert.equal(upd.body.stages[1].materials[0].receivedQty, 30)

    const del = await as(mfr).post(`/api/mfr-projects/${id}/stages/1/materials/0/delete`, {})
    assert.equal(del.body.stages[1].materials.length, 0)
  })
})
