// The review queue: what a customer sends waits for a master admin. Only a master admin decides; a customer sees and
// cancels only its own; every decision is final and creates nothing unless approved.

import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as } from './helpers/client.js'
import { makeAdmin, makeMaster, makeBuyer, makeMfr, makeMasterOrder } from './helpers/factories.js'
import { Order } from '../src/models/Order.js'
import { Notification } from '../src/models/Notification.js'
import { StyleRequest } from '../src/models/StyleRequest.js'

before(async () => { await startTestDb(); await startServer() })
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(clearDb)

const CSV = [
  'Brand,Style No,Description,Image,Amazon link,Fabric,Stage',
  'FYLTR,F-1,Maxi Dress,https://img.example.com/1.jpg,https://amazon.in/dp/1,Cotton,Replen',
  'FYLTR,F-2,Midi Dress,https://img.example.com/2.jpg,,Cotton,NPD',
].join('\n')
const BAD_CSV = CSV + '\nFYLTR,F-3,Wrap Dress,https://img.example.com/3.jpg,,,NPD'

async function arrange() {
  const master = await makeMaster()
  const buyer = await makeBuyer({ company: 'Cocoblu' })
  const mo = await makeMasterOrder({ buyerId: buyer._id, createdBy: master._id, season: 'SS26' })
  return { master, buyer, mo }
}
async function send(buyer, mo, csv = CSV, body = {}) {
  const up = await as(buyer).post('/api/style-imports', { filename: 'sheet.csv', data: Buffer.from(csv).toString('base64') })
  assert.equal(up.status, 201)
  const r = await as(buyer).post(`/api/style-imports/${up.body.id}/commit`, { masterOrderId: mo._id, ...body })
  assert.equal(r.status, 202, JSON.stringify(r.body))
  return r.body.requestId
}

describe('who sees the queue', () => {
  test('a master admin sees every pending request; a customer only its own; other admins and factories none', async () => {
    const { master, buyer, mo } = await arrange()
    const other = await makeBuyer()
    const moOther = await makeMasterOrder({ buyerId: other._id, createdBy: master._id })
    await send(buyer, mo)
    await send(other, moOther)
    const all = await as(master).get('/api/style-requests')
    assert.equal(all.status, 200)
    assert.equal(all.body.length, 2)
    assert.deepEqual(all.body.map(r => r.buyerCompany).sort(), [buyer.company, other.company].sort())
    assert.equal(all.body[0].data, undefined, 'the sheet bytes never leave the server')
    const mine = await as(buyer).get('/api/style-requests')
    assert.equal(mine.body.length, 1)
    assert.equal(mine.body[0].buyerCompany, 'Cocoblu')
    assert.equal((await as(await makeAdmin()).get('/api/style-requests')).status, 403)
    assert.equal((await as(await makeMfr()).get('/api/style-requests')).status, 403)
  })

  test('only a master admin (or the owner, for a preview) can open or decide one', async () => {
    const { master, buyer, mo } = await arrange()
    const id = await send(buyer, mo)
    const other = await makeBuyer()
    assert.equal((await as(other).post(`/api/style-requests/${id}/preview`)).status, 404)
    assert.equal((await as(await makeAdmin()).post(`/api/style-requests/${id}/preview`)).status, 404)
    assert.equal((await as(buyer).post(`/api/style-requests/${id}/approve`)).status, 403)
    assert.equal((await as(buyer).post(`/api/style-requests/${id}/decline`, {})).status, 403)
    assert.equal((await as(await makeAdmin()).post(`/api/style-requests/${id}/approve`)).status, 403)
    assert.equal((await as(buyer).post(`/api/style-requests/${id}/preview`)).status, 200)
    const prev = await as(master).post(`/api/style-requests/${id}/preview`)
    assert.equal(prev.status, 200)
    assert.equal(prev.body.rows.length, 2)
    assert.equal(prev.body.rows[0].payload, undefined)
    assert.equal(await Order.countDocuments(), 0)
  })
})

describe('deciding', () => {
  test('approve creates the styles once; a second approval is refused; the sheet is dropped', async () => {
    const { master, buyer, mo } = await arrange()
    const id = await send(buyer, mo)
    const first = await as(master).post(`/api/style-requests/${id}/approve`)
    assert.equal(first.status, 200, JSON.stringify(first.body))
    assert.equal(first.body.created.length, 2)
    assert.equal((await as(master).post(`/api/style-requests/${id}/approve`)).status, 409)
    assert.equal(await Order.countDocuments(), 2)
    const doc = await StyleRequest.findById(id).select('+data').lean()
    assert.equal(doc.status, 'approved')
    assert.equal(doc.data, undefined)
    assert.equal(doc.createdOrderIds.length, 2)
    const decided = await as(master).get('/api/style-requests?status=decided')
    assert.equal(decided.body[0].status, 'approved')
    assert.equal((await as(master).get('/api/style-requests')).body.length, 0)
  })

  test('decline creates nothing, keeps the reason, and tells the customer', async () => {
    const { master, buyer, mo } = await arrange()
    const id = await send(buyer, mo)
    assert.equal((await as(master).post(`/api/style-requests/${id}/decline`, { reason: 'x'.repeat(301) })).status, 400)
    const res = await as(master).post(`/api/style-requests/${id}/decline`, { reason: 'Photos are missing for two styles' })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(await Order.countDocuments(), 0)
    const told = await Notification.find({ toUser: buyer._id, msg: /declined/ }).lean()
    assert.equal(told.length, 1)
    assert.match(told[0].msg, /Photos are missing for two styles/)
    assert.equal((await as(master).post(`/api/style-requests/${id}/approve`)).status, 409, 'a declined request cannot be approved')
    assert.equal((await as(buyer).get('/api/style-requests')).body[0].decisionNote, 'Photos are missing for two styles')
  })

  test('a customer can cancel its own waiting request, and only that', async () => {
    const { master, buyer, mo } = await arrange()
    const id = await send(buyer, mo)
    const other = await makeBuyer()
    assert.equal((await as(other).post(`/api/style-requests/${id}/cancel`)).status, 409)
    assert.equal((await as(master).post(`/api/style-requests/${id}/cancel`)).status, 403)
    assert.equal((await as(buyer).post(`/api/style-requests/${id}/cancel`)).status, 200)
    assert.equal((await as(master).post(`/api/style-requests/${id}/approve`)).status, 409)
    assert.equal((await as(buyer).post(`/api/style-requests/${id}/cancel`)).status, 409)
    assert.equal(await Order.countDocuments(), 0)
  })

  test('a sheet with problems cannot be sent unless the valid rows are asked for, and approval honours that', async () => {
    const { master, buyer, mo } = await arrange()
    const up = await as(buyer).post('/api/style-imports', { filename: 'bad.csv', data: Buffer.from(BAD_CSV).toString('base64') })
    assert.equal((await as(buyer).post(`/api/style-imports/${up.body.id}/commit`, { masterOrderId: mo._id })).status, 409)
    assert.equal(await StyleRequest.countDocuments(), 0)
    const sent = await as(buyer).post(`/api/style-imports/${up.body.id}/commit`, { masterOrderId: mo._id, skipInvalid: true })
    assert.equal(sent.status, 202)
    const res = await as(master).post(`/api/style-requests/${sent.body.requestId}/approve`)
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.created.length, 2)
  })

  test('approval checks the sheet again: a style that has appeared since is skipped, and a request with nothing left to make stays in the queue', async () => {
    const { master, buyer, mo } = await arrange()
    const id = await send(buyer, mo)
    // Tradio adds both styles by hand before looking at the request.
    for (const [n, sn] of [[1, 'F-1'], [2, 'F-2']]) {
      assert.equal((await as(master).post('/api/orders', { id: `MANUAL-${n}`, buyerId: String(buyer._id), masterOrderId: mo._id, product: 'Dress', styleNumber: sn, category: 'DRESS', season: 'SS26', phase: 'development' })).status, 201)
    }
    const res = await as(master).post(`/api/style-requests/${id}/approve`)
    assert.equal(res.status, 409)
    assert.match(res.body.error, /already in this master order/)
    assert.equal(await Order.countDocuments(), 2)
    assert.equal((await StyleRequest.findById(id).lean()).status, 'pending', 'it goes back to the queue, not lost')
  })

  test('a replen request whose style has been dropped cannot be approved and stays in the queue', async () => {
    const { master, buyer, mo } = await arrange()
    const made = await as(master).post('/api/orders', { id: 'SRC-1', buyerId: String(buyer._id), masterOrderId: mo._id, product: 'Dress', category: 'DRESS', season: 'SS26', phase: 'production', totalQty: 100 })
    assert.equal(made.status, 201)
    const sent = await as(buyer).post('/api/orders/SRC-1/replen', { quantity: 50 })
    assert.equal(sent.status, 202)
    await Order.deleteOne({ _id: 'SRC-1' })
    const res = await as(master).post(`/api/style-requests/${sent.body.requestId}/approve`)
    assert.equal(res.status, 409)
    assert.equal((await StyleRequest.findById(sent.body.requestId).lean()).status, 'pending')
  })
})
