// One rule for where a split stands: Delayed is worked out from the plan (an open step, or the delivery date,
// past due), never set by hand; On Hold needs a reason; Delivered follows the Delivery step.

import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as } from './helpers/client.js'
import { makeMaster, makeBuyer, makeMfr, orderPayload } from './helpers/factories.js'
import { splitStatus } from '../src/lib/splitStatus.js'

before(async () => {
  await startTestDb()
  process.env.PORT = new URL(await startServer()).port
})
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(clearDb)

const step = (eta, extra = {}) => ({ name: 'Cutting', baselineEta: eta, eta: null, kind: 'quantity', unitsDone: 0, totalUnits: 10, ...extra })
const delivery = eta => ({ name: 'Delivery', isDelivery: true, baselineEta: eta, eta: null, kind: 'milestone', unitsDone: 0, totalUnits: 1 })

describe('splitStatus', () => {
  const today = '2026-10-15'
  test('an open step past its date makes the split Delayed; a finished one does not', () => {
    assert.equal(splitStatus({}, { status: 'Processing', stages: [step('2026-10-10'), delivery('2026-12-01')] }, today), 'Delayed')
    assert.equal(splitStatus({}, { status: 'Processing', stages: [step('2026-10-10', { unitsDone: 10, status: 'done' }), delivery('2026-12-01')] }, today), 'Processing')
    assert.equal(splitStatus({}, { status: 'Processing', stages: [step('2026-10-15'), delivery('2026-12-01')] }, today), 'Processing')   // due today is not late
  })
  test('a revised date counts, NA dates never do, and a stored manual Delayed is ignored', () => {
    assert.equal(splitStatus({}, { status: 'Delayed', stages: [step('2026-10-10', { eta: '2026-11-01' }), delivery('2026-12-01')] }, today), 'Processing')
    assert.equal(splitStatus({}, { status: 'Processing', stages: [step('NA'), delivery('NA')] }, today), 'Processing')
  })
  test('On Hold and Delivered are kept as set', () => {
    assert.equal(splitStatus({}, { status: 'On Hold', stages: [step('2026-10-01')] }, today), 'On Hold')
    assert.equal(splitStatus({}, { status: 'Delivered', stages: [step('2026-10-01')] }, today), 'Delivered')
  })
  test('with no Delivery step yet, a passed delivery date is Delayed in production but not in development', () => {
    assert.equal(splitStatus({ delivery: new Date('2026-10-01'), phase: 'production' }, { status: 'Processing', stages: [] }, today), 'Delayed')
    assert.equal(splitStatus({ delivery: new Date('2026-10-01'), phase: 'development' }, { status: 'Processing', stages: [] }, today), 'Processing')
  })
})

describe('setting the status', () => {
  async function arrange() {
    const master = await makeMaster()
    const buyer = await makeBuyer()
    const mfr = await makeMfr()
    const res = await as(master).post('/api/orders', orderPayload({ id: 'ST-001', buyerId: buyer._id, mfrId: mfr._id, delivery: '2027-12-31',
      stageNames: ['Cutting'], stageStartDates: ['2026-01-01'], stageEtas: ['2026-01-10'] }))
    assert.equal(res.status, 201, JSON.stringify(res.body))
    return { master, mfr, base: `/api/orders/ST-001/assignments/${mfr._id}` }
  }

  test('Delayed cannot be set by hand, and On Hold needs a reason', async () => {
    const { master, base } = await arrange()
    assert.equal((await as(master).post(base, { status: 'Delayed' })).status, 400)
    assert.equal((await as(master).post(base, { status: 'On Hold' })).status, 400)
    assert.equal((await as(master).post(base, { status: 'On Hold', note: '   ' })).status, 400)
    assert.equal((await as(master).post(base, { status: 'On Hold', note: 'Customer paused the range' })).status, 200)
  })

  test('the API reports the split as Delayed once a step is past its date', async () => {
    const { master } = await arrange()
    const o = (await as(master).get('/api/orders/ST-001')).body
    assert.equal(o.assignments[0].status, 'Delayed')   // Cutting was due on 10 Jan 2026
  })
})
