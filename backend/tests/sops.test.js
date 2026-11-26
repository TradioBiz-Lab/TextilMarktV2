// A customer's SOP: Tradio saves it; Tradio, a factory making that customer's styles and a coordinator at such a
// factory may open it; the customer never. Kriyaa is offered it for everyone but the customer.

import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as } from './helpers/client.js'
import { makeMaster, makeBuyer, makeMfr, makeCoordinator, orderPayload } from './helpers/factories.js'
import { setSopReader } from '../src/routes/sops.js'
import { toolsFor } from '../src/routes/assistant.js'
import { coordinatorMay } from '../src/lib/coordinator.js'
import { CustomerSop } from '../src/models/CustomerSop.js'

before(async () => { await startTestDb(); await startServer() })
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(async () => { await clearDb(); setSopReader(null) })

const PDF = `data:application/pdf;base64,${Buffer.from('%PDF-1.4 test').toString('base64')}`

async function arrange() {
  const master = await makeMaster(), buyer = await makeBuyer(), other = await makeBuyer()
  const mfr = await makeMfr(), outsider = await makeMfr()
  const coord = await makeCoordinator({ assignedFactories: [mfr._id] }), farCoord = await makeCoordinator({ assignedFactories: [outsider._id] })
  assert.equal((await as(master).post('/api/orders', orderPayload({ id: 'SOP-001', buyerId: buyer._id, mfrId: mfr._id }))).status, 201)
  assert.equal((await as(master).post('/api/orders', orderPayload({ id: 'OTH-001', buyerId: other._id, mfrId: outsider._id }))).status, 201)
  return { master, buyer, other, mfr, outsider, coord, farCoord }
}

describe("a customer's SOP", () => {
  test('Tradio saves it with its words; the factory and its coordinator open it; the customer and others cannot', async () => {
    const { master, buyer, mfr, outsider, coord, farCoord } = await arrange()
    assert.deepEqual((await as(master).get(`/api/sops?buyerId=${buyer._id}`)).body.exists, false)
    assert.equal((await as(mfr).post(`/api/sops/${buyer._id}`, { name: 'SOP', dataUrl: PDF })).status, 403, 'only Tradio saves it')
    assert.equal((await as(master).post(`/api/sops/${buyer._id}`, { name: 'SOP', dataUrl: 'data:image/png;base64,AAAA' })).status, 400)
    assert.equal((await as(master).post(`/api/sops/${buyer._id}`, { name: ' ', dataUrl: PDF })).status, 400)

    const saved = await as(master).post(`/api/sops/${buyer._id}`, { name: 'Manufacturer SOP v6', fileName: 'sop.pdf', dataUrl: PDF, text: 'Stage 4 - PP Sample\n2 PP samples in bulk fabric' })
    assert.equal(saved.status, 200, JSON.stringify(saved.body))
    assert.deepEqual([saved.body.exists, saved.body.name, saved.body.hasText], [true, 'Manufacturer SOP v6', true])

    for (const who of [master, mfr, coord]) {
      const byOrder = await as(who).get('/api/sops?orderId=SOP-001')
      assert.equal(byOrder.status, 200); assert.equal(byOrder.body.exists, true)
      assert.equal((await as(who).get('/api/sops/file?orderId=SOP-001')).body.dataUrl, PDF)
    }
    for (const who of [buyer, outsider, farCoord]) {
      assert.equal((await as(who).get('/api/sops?orderId=SOP-001')).status, 403)
      assert.equal((await as(who).get(`/api/sops/file?buyerId=${buyer._id}`)).status, 403)
      assert.equal((await as(who).get(`/api/sops/text?buyerId=${buyer._id}`)).status, 403)
    }
    const words = await as(mfr).get('/api/sops/text?orderId=SOP-001')
    assert.equal(words.status, 200); assert.match(words.body.text, /2 PP samples/)
    assert.equal((await as(coord).get('/api/sops/text?orderId=SOP-001')).status, 403, 'the words are for Kriyaa, which a coordinator does not have')
  })

  test('saving again replaces it, and a PDF sent without words is read once', async () => {
    const { master, buyer } = await arrange()
    setSopReader(async buf => `read ${buf.length} bytes: Stage 9 - Inspection`)
    assert.equal((await as(master).post(`/api/sops/${buyer._id}`, { name: 'First', dataUrl: PDF })).status, 200)
    assert.match((await as(master).get(`/api/sops/text?buyerId=${buyer._id}`)).body.text, /Stage 9 - Inspection/)
    setSopReader(async () => { throw new Error('no AI') })
    const again = await as(master).post(`/api/sops/${buyer._id}`, { name: 'Second', dataUrl: PDF })
    assert.deepEqual([again.status, again.body.name, again.body.hasText], [200, 'Second', false], 'the file is kept even when it cannot be read')
    assert.equal(await CustomerSop.countDocuments({}), 1)
    assert.equal((await as(master).get(`/api/sops/text?buyerId=${buyer._id}`)).status, 404)
  })

  test('Kriyaa is offered the SOP for Tradio and a factory, never a customer; the coordinator gate lets the file through', async () => {
    const has = role => toolsFor({ role }).some(t => t.name === 'get_customer_sop')
    assert.deepEqual([has('admin'), has('manufacturer'), has('buyer')], [true, true, false])
    assert.equal(coordinatorMay('GET', '/api/sops?orderId=X'), true)
    assert.equal(coordinatorMay('GET', '/api/sops/file?orderId=X'), true)
    assert.equal(coordinatorMay('GET', '/api/sops/text?orderId=X'), false)
    assert.equal(coordinatorMay('POST', '/api/sops/abc'), false)
  })
})
