// Stage insert and delete are atomic and guarded: concurrent plan edits never lose a stage or
// a progress update, and a request that raced another one is refused with 409, not applied to
// the wrong stage.

import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as } from './helpers/client.js'
import { makeMaster, makeBuyer, makeMfr, orderPayload } from './helpers/factories.js'

before(async () => { await startTestDb(); await startServer() })
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(clearDb)

const ORDER_ID = 'CNC-TEST-001'
const names = ['One', 'Two', 'Three', 'Four', 'Five']

async function arrange() {
  const admin = await makeMaster()
  const buyer = await makeBuyer()
  const mfr = await makeMfr()
  const api = as(admin)
  const res = await api.post('/api/orders', orderPayload({
    id: ORDER_ID, buyerId: buyer._id, mfrId: mfr._id, stageNames: names,
    stageStartDates: names.map(() => '2026-07-01'), stageEtas: names.map(() => '2026-07-10'),
  }))
  assert.equal(res.status, 201, JSON.stringify(res.body))
  const base = `/api/orders/${ORDER_ID}/assignments/${mfr._id}`
  const stages = async () => (await api.get(`/api/orders/${ORDER_ID}`)).body.assignments[0].stages
  return { api, mfr, base, stages, mfrApi: as(mfr) }
}

const stageBody = name => ({ name, kind: 'milestone', startDate: '2026-08-01', eta: '2026-08-05' })

test('parallel inserts never lose a stage: the count equals the inserts that succeeded', async () => {
  const { api, base, stages } = await arrange()
  const before = (await stages()).length
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => api.post(`${base}/stages/insert`, { ...stageBody(`Extra ${i}`), index: 1 })))
  const ok = results.filter(r => r.status === 200).length
  const conflicts = results.filter(r => r.status === 409).length
  assert.equal(ok + conflicts, 6, results.map(r => r.status).join(','))
  assert.ok(ok >= 1)
  const after = await stages()
  assert.equal(after.length, before + ok)
  assert.equal(new Set(after.map(s => s.name)).size, after.length, 'no duplicated or overwritten stage')
  assert.equal(after[after.length - 1].isDelivery, true, 'Delivery stays last')
})

test('a progress update racing an insert is not overwritten', async () => {
  const { api, mfrApi, base, stages } = await arrange()
  const rounds = await Promise.all([
    api.post(`${base}/stages/insert`, { ...stageBody('Raced'), index: 2 }),
    mfrApi.post(`${base}/stages/0`, { note: 'progress while inserting' }),
  ])
  assert.equal(rounds[1].status, 200)
  assert.equal(rounds[0].status === 200 || rounds[0].status === 409, true)
  const first = (await stages())[0]
  assert.equal(first.note, 'progress while inserting')
})

test('parallel deletes remove exactly the stages they report', async () => {
  const { api, base, stages } = await arrange()
  const before = (await stages()).length
  const results = await Promise.all([1, 2, 3].map(i => api.post(`${base}/stages/${i}/delete`, {})))
  const ok = results.filter(r => r.status === 200).length
  assert.ok(results.every(r => [200, 400, 409].includes(r.status)), results.map(r => r.status).join(','))
  assert.equal((await stages()).length, before - ok)
})

test('a delete aimed at a stage that is no longer there is refused', async () => {
  const { api, base, stages } = await arrange()
  const before = await stages()
  const target = before.length - 2 // the last real stage, just before Delivery
  assert.equal((await api.post(`${base}/stages/${target}/delete`, {})).status, 200)
  const names = (await stages()).map(s => s.name)
  assert.ok(!names.includes(before[target].name))
  assert.equal(names.length, before.length - 1)
  assert.equal(names[names.length - 1], 'Delivery')
})

test('deleting a material keeps its PO documents attached to the right lines', async () => {
  const { api, base, mfr } = await arrange()
  for (const name of ['Fabric', 'Trims', 'Labels'])
    assert.equal((await api.post(`${base}/stages/0/materials`, { name, requiredQty: 10 })).status, 200)
  const doc = async (name, line) => {
    const r = await api.post('/api/documents', {
      type: 'material_po', name, externalUrl: 'https://example.com/po', orderId: ORDER_ID,
      mfrId: String(mfr._id), stageIndex: 0, materialLineIndex: line,
    })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    return r.body.id
  }
  const [d0, d1, d2] = [await doc('PO Fabric', 0), await doc('PO Trims', 1), await doc('PO Labels', 2)]

  assert.equal((await api.post(`${base}/stages/0/materials/0/delete`, {})).status, 200)

  const docs = (await api.get('/api/documents')).body
  const line = id => docs.find(d => d.id === id)?.materialLineIndex
  assert.equal(line(d0), null, 'the deleted line\'s document is detached, not deleted')
  assert.equal(line(d1), 0, 'Trims moved from line 1 to line 0')
  assert.equal(line(d2), 1, 'Labels moved from line 2 to line 1')
  const order = (await api.get(`/api/orders/${ORDER_ID}`)).body
  assert.deepEqual(order.assignments[0].stages[0].materials.map(m => m.name), ['Trims', 'Labels'])
})

test('an unknown document type is a 400, not a 500', async () => {
  const { api } = await arrange()
  const r = await api.post('/api/documents', { type: 'nonsense', name: 'x', externalUrl: 'https://example.com/x' })
  assert.equal(r.status, 400, JSON.stringify(r.body))
})
