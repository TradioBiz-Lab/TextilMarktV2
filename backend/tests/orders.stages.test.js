// Characterization: stage-write behaviour as it behaves TODAY.
//
// The sequential-reset tests below pin behaviour that is about to be DELETED.
// They are here so that removal shows up as a deliberate, reviewed edit to this
// file rather than a silent behaviour change on live orders.

import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as } from './helpers/client.js'
import { makeAdmin, makeMaster, makeBuyer, makeMfr, orderPayload } from './helpers/factories.js'

before(async () => {
  await startTestDb()
  await startServer()
})
after(async () => {
  await stopServer()
  await stopTestDb()
})
beforeEach(clearDb)

const ORDER_ID = 'STG-TEST-001'

/** Create an order with `stageNames` and return handles for acting on it. */
async function arrange({ stageNames = ['One', 'Two', 'Three'], totalQty = 100 } = {}) {
  const admin = await makeAdmin()
  const master = await makeMaster()
  const buyer = await makeBuyer()
  const mfr = await makeMfr()
  const api = as(admin)

  const res = await api.post('/api/orders', orderPayload({
    id: ORDER_ID, buyerId: buyer._id, mfrId: mfr._id, totalQty, stageNames,
    stageStartDates: stageNames.map(() => '2026-07-01'),
    stageEtas: stageNames.map(() => '2026-07-15'),
  }))
  assert.equal(res.status, 201, `arrange failed: ${JSON.stringify(res.body)}`)

  const stageUrl = i => `/api/orders/${ORDER_ID}/assignments/${mfr._id}/stages/${i}`
  const readStages = async () => (await api.get(`/api/orders/${ORDER_ID}`)).body.assignments[0].stages

  return { admin, master, buyer, mfr, api, masterApi: as(master), mfrApi: as(mfr), buyerApi: as(buyer), stageUrl, readStages }
}

describe('stage update — progress', () => {
  test('records unitsDone and note on the targeted stage', async () => {
    const { api, stageUrl, readStages } = await arrange()

    const { status } = await api.post(stageUrl(0), { unitsDone: 40, note: 'half cut' })
    assert.equal(status, 200)

    const stages = await readStages()
    assert.equal(stages[0].unitsDone, 40)
    assert.equal(stages[0].note, 'half cut')
  })

  test('rejects unitsDone above the stage total', async () => {
    const { api, stageUrl } = await arrange({ totalQty: 100 })
    const { status, body } = await api.post(stageUrl(0), { unitsDone: 101 })
    assert.equal(status, 400)
    assert.match(body.error, /exceed/i)
  })

  test('rejects an out-of-range stage index', async () => {
    const { api, stageUrl } = await arrange()
    assert.equal((await api.post(stageUrl(99), { unitsDone: 1 })).status, 400)
  })

  test('a write that omits unitsDone holds the current progress', async () => {
    const { api, stageUrl, readStages } = await arrange({ totalQty: 100 })

    await api.post(stageUrl(0), { unitsDone: 40 })
    // Flagging blocked shouldn't require resending progress.
    const { status } = await api.post(stageUrl(0), { blocked: true, blockedReason: 'mill delay' })
    assert.equal(status, 200)

    const s = (await readStages())[0]
    assert.equal(s.unitsDone, 40)
    assert.equal(s.status, 'in_progress')
    assert.equal(s.blocked, true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Stages are now INDEPENDENT. The sequential reset (which zeroed unitsDone and
// note on every later stage, on every write) is gone: real TNA plans overlap.
// ─────────────────────────────────────────────────────────────────────────────
describe('parallel stages — no sequential reset', () => {
  test('updating stage N leaves later stages untouched', async () => {
    const { api, stageUrl, readStages } = await arrange()

    await api.post(stageUrl(1), { unitsDone: 50 })
    await api.post(stageUrl(2), { unitsDone: 30 })
    await api.post(stageUrl(0), { unitsDone: 10 })

    assert.deepEqual((await readStages()).map(s => s.unitsDone), [10, 50, 30])
  })

  test('a save on an earlier stage preserves later notes', async () => {
    const { api, stageUrl, readStages } = await arrange()

    await api.post(stageUrl(2), { unitsDone: 30, note: 'dyeing lot 4 in' })
    await api.post(stageUrl(0), { unitsDone: 5, note: 'kickoff done' })

    const stages = await readStages()
    assert.equal(stages[2].note, 'dyeing lot 4 in')
    assert.equal(stages[2].unitsDone, 30)
    assert.equal(stages[0].note, 'kickoff done')
  })

  test('master override no longer wipes later stages either', async () => {
    const { api, masterApi, stageUrl, readStages } = await arrange()

    await api.post(stageUrl(2), { unitsDone: 30 })
    await masterApi.post(stageUrl(0), { unitsDone: 5, override: true })

    assert.equal((await readStages())[2].unitsDone, 30)
  })

  test('omitting note does not blank the existing note', async () => {
    const { api, stageUrl, readStages } = await arrange()

    await api.post(stageUrl(0), { unitsDone: 10, note: 'keep me' })
    await api.post(stageUrl(0), { unitsDone: 20 })

    assert.equal((await readStages())[0].note, 'keep me')
  })

  test('two stages sharing a window can both be in progress', async () => {
    const { api, stageUrl, readStages } = await arrange({
      stageNames: ['FPT Sent', 'PP Sample Sent', 'GPT Sent'],
    })

    await api.post(stageUrl(1), { unitsDone: 40 })
    await api.post(stageUrl(2), { unitsDone: 70 })

    const stages = await readStages()
    assert.equal(stages[1].status, 'in_progress')
    assert.equal(stages[2].status, 'in_progress')
  })

  // Advisory, not enforcement — a genuinely parallel plan trips this legitimately.
  test('completing a stage out of order returns a non-blocking warning', async () => {
    const { api, stageUrl, readStages } = await arrange({ totalQty: 100 })

    const { status, body } = await api.post(stageUrl(2), { unitsDone: 100 })
    assert.equal(status, 200)
    assert.equal(body.warnings.length, 1)
    assert.match(body.warnings[0], /marked done while 2 earlier step\(s\) are still open/)

    // The write still happened — nothing was blocked or reverted.
    assert.equal((await readStages())[2].status, 'done')
  })

  test('completing stages in order produces no warning', async () => {
    const { api, stageUrl } = await arrange({ totalQty: 100 })

    await api.post(stageUrl(0), { unitsDone: 100 })
    const { body } = await api.post(stageUrl(1), { unitsDone: 100 })
    assert.deepEqual(body.warnings, [])
  })
})

describe('materials gate', () => {
  test('blocks advancing while a material line is not received', async () => {
    const { api, stageUrl, readStages } = await arrange()

    await api.post(`${stageUrl(0)}/materials`, { name: 'Main fabric', requiredQty: 500, unit: 'm' })

    const { status, body } = await api.post(stageUrl(0), { unitsDone: 10 })
    assert.equal(status, 400)
    assert.match(body.error, /material\(s\) still pending/)
    assert.equal((await readStages())[0].unitsDone, 0)
  })

  test('allows advancing once the material is received', async () => {
    const { api, stageUrl, readStages } = await arrange()

    await api.post(`${stageUrl(0)}/materials`, { name: 'Main fabric', requiredQty: 500 })
    await api.post(`${stageUrl(0)}/materials/0`, { status: 'received', receivedQty: 500 })

    assert.equal((await api.post(stageUrl(0), { unitsDone: 10 })).status, 200)
    assert.equal((await readStages())[0].unitsDone, 10)
  })

  test('"ordered" is NOT enough on a normal stage', async () => {
    const { api, stageUrl } = await arrange()

    await api.post(`${stageUrl(0)}/materials`, { name: 'Buttons', requiredQty: 200 })
    await api.post(`${stageUrl(0)}/materials/0`, { status: 'ordered', orderedQty: 200 })

    assert.equal((await api.post(stageUrl(0), { unitsDone: 10 })).status, 400)
  })

  // Deliberate carve-out: placing the order IS the work of this step.
  test('"ordered" IS enough on the Trims Order stage', async () => {
    const { api, stageUrl, readStages } = await arrange({ stageNames: ['Trims Order', 'Two', 'Three'] })

    await api.post(`${stageUrl(0)}/materials`, { name: 'Labels', requiredQty: 200 })
    assert.equal((await api.post(stageUrl(0), { unitsDone: 10 })).status, 400, 'pending still blocks')

    await api.post(`${stageUrl(0)}/materials/0`, { status: 'ordered', orderedQty: 200 })

    assert.equal((await api.post(stageUrl(0), { unitsDone: 10 })).status, 200)
    assert.equal((await readStages())[0].unitsDone, 10)
  })

  test('master override bypasses the gate', async () => {
    const { api, masterApi, stageUrl, readStages } = await arrange()

    await api.post(`${stageUrl(0)}/materials`, { name: 'Main fabric', requiredQty: 500 })

    assert.equal((await masterApi.post(stageUrl(0), { unitsDone: 10, override: true })).status, 200)
    assert.equal((await readStages())[0].unitsDone, 10)
  })

  test('the gate blocks increases only — holding or lowering is allowed', async () => {
    const { api, stageUrl } = await arrange()

    await api.post(stageUrl(0), { unitsDone: 20 })
    await api.post(`${stageUrl(0)}/materials`, { name: 'Main fabric', requiredQty: 500 })

    assert.equal((await api.post(stageUrl(0), { unitsDone: 20 })).status, 200, 'holding allowed')
    assert.equal((await api.post(stageUrl(0), { unitsDone: 5 })).status, 200, 'lowering allowed')
    assert.equal((await api.post(stageUrl(0), { unitsDone: 21 })).status, 400, 'raising blocked')
  })
})

describe('/eta — admin stage metadata', () => {
  test('start date must be on or before the end date', async () => {
    const { api, stageUrl } = await arrange()
    const { status, body } = await api.post(`${stageUrl(0)}/eta`, { startDate: '2026-09-01', eta: '2026-08-01' })
    assert.equal(status, 400)
    assert.equal(body.error, 'Start date must be on or before the end date')
  })

  test('checks ordering against the side not being changed', async () => {
    const { api, stageUrl } = await arrange()
    // Stored window is 2026-07-01 → 2026-07-15; moving only the start past it must fail.
    const { status } = await api.post(`${stageUrl(0)}/eta`, { startDate: '2026-08-20' })
    assert.equal(status, 400)
  })

  test('a blank date is rejected — "NA" is the way to opt out', async () => {
    const { api, stageUrl } = await arrange()
    const { status, body } = await api.post(`${stageUrl(0)}/eta`, { eta: '' })
    assert.equal(status, 400)
    assert.match(body.error, /cannot be blank/)
  })

  test('totalUnits cannot be set below unitsDone', async () => {
    const { api, stageUrl } = await arrange({ totalQty: 100 })
    await api.post(stageUrl(0), { unitsDone: 60 })

    const { status } = await api.post(`${stageUrl(0)}/eta`, { totalUnits: 50 })
    assert.equal(status, 400)
  })

  test('responsibleId accepts an admin and a manufacturer', async () => {
    const { api, admin, mfr, stageUrl, readStages } = await arrange()

    assert.equal((await api.post(`${stageUrl(0)}/eta`, { responsibleId: String(admin._id) })).status, 200)
    assert.equal((await readStages())[0].responsibleId, String(admin._id))

    assert.equal((await api.post(`${stageUrl(0)}/eta`, { responsibleId: String(mfr._id) })).status, 200)
    assert.equal((await readStages())[0].responsibleId, String(mfr._id))
  })

  // Deliberately widened: a real TNA assigns its approval steps (lab dip,
  // FPT/PP/GPT, final inspection) to the buyer — about a third of the plan.
  // Previously this returned 400.
  test('responsibleId accepts a buyer', async () => {
    const { api, buyer, stageUrl, readStages } = await arrange()
    const { status } = await api.post(`${stageUrl(0)}/eta`, { responsibleId: String(buyer._id) })
    assert.equal(status, 200)

    const stage = (await readStages())[0]
    assert.equal(stage.responsibleId, String(buyer._id))
    assert.equal(stage.responsibleRole, 'buyer')
  })

  test('responsibleId rejects an inactive user', async () => {
    const { api, stageUrl } = await arrange()
    const inactive = await makeMfr({ isActive: false })
    const { status } = await api.post(`${stageUrl(0)}/eta`, { responsibleId: String(inactive._id) })
    assert.equal(status, 400)
  })
})

describe('stage delete', () => {
  test('removes the stage and leaves the rest intact', async () => {
    const { api, mfr, stageUrl, readStages } = await arrange({ stageNames: ['One', 'Two', 'Three', 'Four'] })

    await api.post(stageUrl(0), { unitsDone: 10 })
    const { status } = await api.post(`/api/orders/${ORDER_ID}/assignments/${mfr._id}/stages/2/delete`)
    assert.equal(status, 200)

    const stages = await readStages()
    assert.deepEqual(stages.map(s => s.name), ['One', 'Two', 'Four'])
    assert.equal(stages[0].unitsDone, 10)
  })

  test('refuses to delete the last remaining stage', async () => {
    const { api, mfr } = await arrange({ stageNames: ['Only'] })
    const { status } = await api.post(`/api/orders/${ORDER_ID}/assignments/${mfr._id}/stages/0/delete`)
    assert.equal(status, 400)
  })
})
