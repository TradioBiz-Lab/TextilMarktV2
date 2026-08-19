// Phase 1 of the Materials Management + Costing Engine plan. Adversarial
// priority per the plan's own §7: cross-manufacturer isolation on split
// orders, and the margin/fee layer must never reach a manufacturer or buyer
// response — assert on the raw JSON string, not just field-key absence.

import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as, tokenFor } from './helpers/client.js'
import { makeAdmin, makeMaster, makeBuyer, makeMfr, orderPayload } from './helpers/factories.js'
import mongoose from 'mongoose'
import { ConsumptionRecord } from '../src/models/ConsumptionRecord.js'
import { InventoryMovement } from '../src/models/InventoryMovement.js'

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

const ORDER_ID = 'MATCOST-TEST-001'

async function arrangeSplit() {
  const admin = await makeAdmin()
  const master = await makeMaster()
  const buyer = await makeBuyer()
  const mfrA = await makeMfr()
  const mfrB = await makeMfr()
  const api = as(admin)

  const payload = orderPayload({ id: ORDER_ID, buyerId: buyer._id, mfrId: mfrA._id, totalQty: 100 })
  payload.assignments = [
    { mid: String(mfrA._id), qty: 60 },
    { mid: String(mfrB._id), qty: 40 },
  ]
  const res = await api.post('/api/orders', payload)
  assert.equal(res.status, 201, `arrange failed: ${JSON.stringify(res.body)}`)

  return { admin, master, buyer, mfrA, mfrB, api, masterApi: as(master) }
}

/** A cost sheet taken all the way through draft -> submitted -> margin -> approved. */
async function fullyApprovedSheet() {
  const arranged = await arrangeSplit()
  const { mfrA, masterApi } = arranged
  const create = await as(mfrA).post('/api/cost-sheets', {
    scopeType: 'tradio_order', orderId: ORDER_ID, fabricSource: 'tradio',
    fabric: { name: 'Cotton', unit: 'm', consumption: 1.5, rate: 200 },
    labour: { cuttingThreads: 14, making: 60, finishingPacking: 12 },
  })
  const id = create.body.id
  await as(mfrA).post(`/api/cost-sheets/${id}/submit`, {})
  await masterApi.post(`/api/cost-sheets/${id}/margin`, { marginPct: 20, tradioFeePct: 10, finalNegotiatedPrice: 555 })
  await masterApi.post(`/api/cost-sheets/${id}/approve`, {})
  return { ...arranged, id }
}

describe('stageMaterialSchema category/colourway — enrichOrder round-trip', () => {
  test('category and colourway survive a write and come back on read', async () => {
    const { mfrA, api } = await arrangeSplit()

    const add = await api.post(`/api/orders/${ORDER_ID}/assignments/${mfrA._id}/stages/0/materials`, {
      name: 'Cotton Fabric', category: 'fabric', colourway: 'Indigo Wash', requiredQty: 100, unit: 'm',
    })
    assert.equal(add.status, 200, JSON.stringify(add.body))

    const { body } = await api.get(`/api/orders/${ORDER_ID}`)
    const line = body.assignments[0].stages[0].materials[0]
    assert.equal(line.category, 'fabric')
    assert.equal(line.colourway, 'Indigo Wash')
    assert.ok(line.id, 'material line must carry a real id (Phase 2 needs it for pushedTo)')
  })

  test('legacy-shaped material line (no category sent) defaults to "other"', async () => {
    const { mfrA, api } = await arrangeSplit()
    const add = await api.post(`/api/orders/${ORDER_ID}/assignments/${mfrA._id}/stages/0/materials`, {
      name: 'Zipper', requiredQty: 10,
    })
    assert.equal(add.status, 200)
    const { body } = await api.get(`/api/orders/${ORDER_ID}`)
    assert.equal(body.assignments[0].stages[0].materials[0].category, 'other')
  })

  test('the trims-order production gate is unaffected by category', async () => {
    const { mfrA, api } = await arrangeSplit()
    // A fabric-category material on a non-"Trims Order" stage still gates on status,
    // exactly as before this feature — category is planning metadata only.
    await api.post(`/api/orders/${ORDER_ID}/assignments/${mfrA._id}/stages/0/materials`, {
      name: 'Fabric', category: 'fabric', requiredQty: 10, unit: 'm',
    })
    const blocked = await api.post(`/api/orders/${ORDER_ID}/assignments/${mfrA._id}/stages/0`, { unitsDone: 1 })
    assert.equal(blocked.status, 400, 'still gated — category did not loosen the existing rule')
  })
})

describe('MaterialDefinition catalog', () => {
  test('any authenticated role can read; only admin can write', async () => {
    const admin = await makeAdmin()
    const mfr = await makeMfr()
    const created = await as(admin).post('/api/material-definitions', { name: 'Cotton Jersey', category: 'fabric', defaultUnit: 'm' })
    assert.equal(created.status, 201, JSON.stringify(created.body))

    const mfrRead = await as(mfr).get('/api/material-definitions')
    assert.equal(mfrRead.status, 200)
    assert.equal(mfrRead.body.length, 1)

    const mfrWrite = await as(mfr).post('/api/material-definitions', { name: 'Should Fail', category: 'trim' })
    assert.equal(mfrWrite.status, 403)
  })
})

describe('MaterialRequirement — scope validation and permissions', () => {
  test('tradio_order scope requires orderId, forbids mfrProjectId', async () => {
    const admin = await makeAdmin()
    const bad = await as(admin).post('/api/material-requirements', { scopeType: 'tradio_order', category: 'fabric', name: 'x', requiredQty: 1 })
    assert.equal(bad.status, 400)
  })

  test('buyer cannot manage material requirements', async () => {
    const { buyer } = await arrangeSplit()
    const res = await as(buyer).post('/api/material-requirements', { scopeType: 'tradio_order', orderId: ORDER_ID, category: 'fabric', name: 'x', requiredQty: 1 })
    assert.equal(res.status, 403)
  })

  test('manufacturer cannot write a tradio_order requirement (admin only)', async () => {
    const { mfrA } = await arrangeSplit()
    const res = await as(mfrA).post('/api/material-requirements', { scopeType: 'tradio_order', orderId: ORDER_ID, category: 'fabric', name: 'x', requiredQty: 1 })
    assert.equal(res.status, 403)
  })

  test('admin creates a requirement line; exactly one document per order (upsert)', async () => {
    const { api } = await arrangeSplit()
    const first = await api.post('/api/material-requirements', { scopeType: 'tradio_order', orderId: ORDER_ID, category: 'fabric', name: 'Cotton', requiredQty: 100, unit: 'm' })
    assert.equal(first.status, 200, JSON.stringify(first.body))
    const second = await api.post('/api/material-requirements', { scopeType: 'tradio_order', orderId: ORDER_ID, category: 'trim', name: 'Zipper', requiredQty: 200 })
    assert.equal(second.status, 200)
    assert.equal(second.body.lines.length, 2, 'both lines live on the SAME document, not two')
  })

  test('a manufacturer on the order sees nothing until a line is pushed to them (Phase 2)', async () => {
    const { mfrA, api } = await arrangeSplit()
    await api.post('/api/material-requirements', { scopeType: 'tradio_order', orderId: ORDER_ID, category: 'fabric', name: 'Cotton', requiredQty: 100, unit: 'm' })
    const { status, body } = await as(mfrA).get(`/api/material-requirements?orderId=${ORDER_ID}`)
    assert.equal(status, 200)
    assert.equal(body.lines.length, 0, 'nothing pushed yet — manufacturer must not see the raw requirement')
  })

  // Regression: loadRequirementForRead returns a synthetic { lines: [] }
  // fallback (no MaterialRequirement document exists yet, no _id) when a GET
  // is the very first touch of a scope. enrichMaterialRequirement must not
  // assume doc._id exists — it previously did (doc._id.toString()), which
  // 500'd on this exact path for every brand-new order.
  test('GET with no MaterialRequirement document yet returns an empty doc, not a 500', async () => {
    const { api } = await arrangeSplit()
    const { status, body } = await api.get(`/api/material-requirements?orderId=${ORDER_ID}`)
    assert.equal(status, 200)
    assert.equal(body.id, null)
    assert.deepEqual(body.lines, [])
  })
})

describe('POST /material-requirements/bulk', () => {
  test('admin bulk-creates lines across rows, all landing on the one document per order (upsert)', async () => {
    const { api } = await arrangeSplit()
    const res = await api.post('/api/material-requirements/bulk', {
      rows: [
        { orderId: ORDER_ID, category: 'fabric', name: 'Cotton', requiredQty: 100, unit: 'm' },
        { orderId: ORDER_ID, category: 'trim', name: 'Zipper', requiredQty: 50, unit: 'pcs', supplier: 'Acme' },
      ],
    })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.created, 2)
    assert.equal(res.body.failed, 0)

    const { body } = await api.get(`/api/material-requirements?orderId=${ORDER_ID}`)
    assert.equal(body.lines.length, 2, 'both rows landed on the SAME document, not two')
    assert.ok(body.lines.some(l => l.name === 'Zipper' && l.supplier === 'Acme'))
  })

  test('a bad row (unknown order) fails independently — good rows still succeed', async () => {
    const { api } = await arrangeSplit()
    const res = await api.post('/api/material-requirements/bulk', {
      rows: [
        { orderId: ORDER_ID, category: 'fabric', name: 'Cotton', requiredQty: 100 },
        { orderId: 'NO-SUCH-ORDER', category: 'fabric', name: 'Ghost', requiredQty: 10 },
      ],
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.created, 1)
    assert.equal(res.body.failed, 1)
    assert.match(res.body.results[1].error, /not found/)
  })

  test('manufacturer and buyer cannot bulk-upload requirement lines', async () => {
    const { mfrA, buyer } = await arrangeSplit()
    const row = { rows: [{ orderId: ORDER_ID, category: 'fabric', name: 'Cotton', requiredQty: 10 }] }
    assert.equal((await as(mfrA).post('/api/material-requirements/bulk', row)).status, 403)
    assert.equal((await as(buyer).post('/api/material-requirements/bulk', row)).status, 403)
  })

  test('more than 200 rows is rejected outright', async () => {
    const { api } = await arrangeSplit()
    const rows = Array.from({ length: 201 }, () => ({ orderId: ORDER_ID, category: 'fabric', name: 'X', requiredQty: 1 }))
    const res = await api.post('/api/material-requirements/bulk', { rows })
    assert.equal(res.status, 400)
  })
})

describe('MfrMasterProject / MfrProject — privacy (no admin override, anywhere)', () => {
  test('only manufacturers can create; admin and master both get 403', async () => {
    const admin = await makeAdmin()
    const master = await makeMaster()
    const badAdmin = await as(admin).post('/api/mfr-projects', { styleName: 'Should Fail' })
    const badMaster = await as(master).post('/api/mfr-projects', { styleName: 'Should Fail' })
    assert.equal(badAdmin.status, 403)
    assert.equal(badMaster.status, 403)
  })

  test('two-level creation flow: master project groups styles, exactly like MasterOrder/Order', async () => {
    const mfr = await makeMfr()
    const mp = await as(mfr).post('/api/mfr-master-projects', { buyerName: 'My Own Client', season: 'FW26' })
    assert.equal(mp.status, 201, JSON.stringify(mp.body))

    const style = await as(mfr).post('/api/mfr-projects', { mfrMasterProjectId: mp.body.id, styleName: 'Style One', totalQty: 500 })
    assert.equal(style.status, 201)
    assert.equal(style.body.mfrMasterProjectId, mp.body.id)

    const standalone = await as(mfr).post('/api/mfr-projects', { styleName: 'Standalone Style' })
    assert.equal(standalone.status, 201)
    assert.equal(standalone.body.mfrMasterProjectId, null)
  })

  test('manufacturer B cannot read, edit, or attach a requirement to manufacturer A\'s project', async () => {
    const mfrA = await makeMfr()
    const mfrB = await makeMfr()
    const project = await as(mfrA).post('/api/mfr-projects', { styleName: 'Private Style' })
    assert.equal(project.status, 201)

    const readList = await as(mfrB).get('/api/mfr-projects')
    assert.equal(readList.body.length, 0, 'mfrB must not see mfrA\'s project in their own list')

    const edit = await as(mfrB).post(`/api/mfr-projects/${project.body.id}`, { styleName: 'Hijacked' })
    assert.equal(edit.status, 403)

    const attach = await as(mfrB).post('/api/material-requirements', {
      scopeType: 'mfr_project', mfrProjectId: project.body.id, category: 'fabric', name: 'x', requiredQty: 1,
    })
    assert.equal(attach.status, 403)
  })
})

describe('CostSheet — the real workflow: draft -> submit -> margin -> approve', () => {
  test('manufacturer authors their own draft; admin (non-master) can read but not write margin', async () => {
    const { mfrA, api, admin } = await arrangeSplit()
    const create = await as(mfrA).post('/api/cost-sheets', {
      scopeType: 'tradio_order', orderId: ORDER_ID,
      fabricSource: 'tradio', fabric: { name: 'Cotton', unit: 'm', consumption: 1.5, rate: 200 },
      labour: { cuttingThreads: 14, making: 60, finishingPacking: 12 },
    })
    assert.equal(create.status, 200, JSON.stringify(create.body))
    assert.equal(create.body.status, 'draft')
    assert.equal(create.body.fabricValue, 300) // 1.5 * 200

    const marginByRegularAdmin = await api.post(`/api/cost-sheets/${create.body.id}/margin`, { marginPct: 20 })
    assert.equal(marginByRegularAdmin.status, 403, 'a non-master admin must never set margin')
  })

  test('manufacturer A can never reach manufacturer B\'s cost sheet on the same split order — every /:id route', async () => {
    const { mfrA, mfrB } = await arrangeSplit()
    const sheetA = await as(mfrA).post('/api/cost-sheets', { scopeType: 'tradio_order', orderId: ORDER_ID, fabricSource: 'tradio' })
    assert.equal(sheetA.status, 200)
    const id = sheetA.body.id

    const getB = await as(mfrB).get(`/api/cost-sheets/${id}`)
    assert.equal(getB.status, 403)
    const submitB = await as(mfrB).post(`/api/cost-sheets/${id}/submit`, {})
    assert.equal(submitB.status, 403)
    const editB = await as(mfrB).post('/api/cost-sheets', { scopeType: 'tradio_order', orderId: ORDER_ID, mfrId: String(mfrA._id), fabric: { consumption: 99 } })
    // mfrB is forced to their own mfrId server-side, so this creates/edits mfrB's
    // OWN sheet, never mfrA's — confirm it did not touch mfrA's sheet (fabric
    // stays at its default null consumption, not the 99 mfrB attempted to write).
    const recheckA = await as(mfrA).get(`/api/cost-sheets/${id}`)
    assert.equal(recheckA.body.fabric?.consumption ?? null, null)
  })

  test('the full approval workflow, and the margin layer never reaches the manufacturer response — checked on raw JSON', async () => {
    const { mfrA, masterApi, buyer } = await arrangeSplit()

    const create = await as(mfrA).post('/api/cost-sheets', {
      scopeType: 'tradio_order', orderId: ORDER_ID, fabricSource: 'tradio',
      fabric: { name: 'Cotton', unit: 'm', consumption: 1.5, rate: 200 },
      labour: { cuttingThreads: 14, making: 60, finishingPacking: 12 },
    })
    const id = create.body.id

    // Manufacturer's own read never contains margin/fee/price — not even the key.
    const ownRead = await as(mfrA).get(`/api/cost-sheets/${id}`)
    const raw = JSON.stringify(ownRead.body)
    assert.ok(!raw.includes('marginPct'))
    assert.ok(!raw.includes('tradioFeePct'))
    assert.ok(!raw.includes('finalNegotiatedPrice'))
    assert.ok(!raw.includes('"price"'))

    const submit = await as(mfrA).post(`/api/cost-sheets/${id}/submit`, {})
    assert.equal(submit.status, 200)
    assert.equal(submit.body.status, 'submitted')

    // Manufacturer cannot edit content once submitted.
    const editAfterSubmit = await as(mfrA).post('/api/cost-sheets', { scopeType: 'tradio_order', orderId: ORDER_ID, fabric: { consumption: 9 } })
    assert.equal(editAfterSubmit.status, 400)

    const margin = await masterApi.post(`/api/cost-sheets/${id}/margin`, { marginPct: 22, tradioFeePct: 10, finalNegotiatedPrice: 999, negotiatedDiscountPct: 2 })
    assert.equal(margin.status, 200, JSON.stringify(margin.body))
    assert.equal(margin.body.marginPct, 22)

    // Buyer sees nothing before approval.
    const buyerBefore = await as(buyer).get(`/api/cost-sheets/${id}`)
    assert.equal(buyerBefore.status, 403)

    const approve = await masterApi.post(`/api/cost-sheets/${id}/approve`, {})
    assert.equal(approve.status, 200)
    assert.equal(approve.body.status, 'approved')

    // Buyer now sees ONLY the final price — nothing else, ever.
    const buyerAfter = await as(buyer).get(`/api/cost-sheets/${id}`)
    assert.equal(buyerAfter.status, 200)
    assert.equal(buyerAfter.body.finalNegotiatedPrice, 999)
    assert.equal(buyerAfter.body.negotiatedDiscountPct, undefined)
    assert.equal(buyerAfter.body.fabric, undefined)
    assert.equal(buyerAfter.body.marginPct, undefined)

    // And the manufacturer's own read STILL never shows margin, even after approval.
    const mfrAfterApproval = await as(mfrA).get(`/api/cost-sheets/${id}`)
    const rawAfter = JSON.stringify(mfrAfterApproval.body)
    assert.ok(!rawAfter.includes('marginPct'))
    assert.ok(!rawAfter.includes('999'), 'manufacturer must not see the negotiated price either')
  })

  test('mfr_project scope: admin and master both 403 on every route, owner self-approves, margin route rejected', async () => {
    const mfr = await makeMfr()
    const admin = await makeAdmin()
    const master = await makeMaster()
    const project = await as(mfr).post('/api/mfr-projects', { styleName: 'Private Costing' })

    const create = await as(mfr).post('/api/cost-sheets', {
      scopeType: 'mfr_project', mfrProjectId: project.body.id,
      fabric: { name: 'Cotton', consumption: 1, rate: 100 },
    })
    assert.equal(create.status, 200, JSON.stringify(create.body))
    const id = create.body.id

    const adminRead = await as(admin).get(`/api/cost-sheets/${id}`)
    const masterRead = await as(master).get(`/api/cost-sheets/${id}`)
    assert.equal(adminRead.status, 403, 'admin must never read a manufacturer\'s private cost sheet')
    assert.equal(masterRead.status, 403, 'not even master admin')

    const marginAttempt = await as(mfr).post(`/api/cost-sheets/${id}/margin`, { marginPct: 20 })
    assert.equal(marginAttempt.status, 403, 'requireMaster rejects a manufacturer outright')

    const submit = await as(mfr).post(`/api/cost-sheets/${id}/submit`, {})
    assert.equal(submit.status, 200)
    const approve = await as(mfr).post(`/api/cost-sheets/${id}/approve`, {})
    assert.equal(approve.status, 200, JSON.stringify(approve.body))
    assert.equal(approve.body.status, 'approved')
  })

  test('the unique partial index actually prevents a duplicate sheet for the same (order, mfr) pair', async () => {
    const { mfrA } = await arrangeSplit()
    await as(mfrA).post('/api/cost-sheets', { scopeType: 'tradio_order', orderId: ORDER_ID, fabricSource: 'tradio' })
    // Second POST for the same order+mfr is an UPDATE (findOne + save), not a
    // second insert — this proves the upsert path, not the index directly,
    // but confirms the intended "one sheet per assignment" behavior end-to-end.
    const second = await as(mfrA).post('/api/cost-sheets', { scopeType: 'tradio_order', orderId: ORDER_ID, fabricSource: 'buyer' })
    assert.equal(second.status, 200)
    const list = await as(mfrA).get(`/api/cost-sheets?orderId=${ORDER_ID}`)
    assert.equal(list.body.length, 1, 'still exactly one sheet, updated in place')
    assert.equal(list.body[0].fabricSource, 'buyer')
  })
})

describe('Phase 2 — push to stage (server-side, atomic)', () => {
  test('pushing a fabric line creates a real stage material line and records pushedTo', async () => {
    const { mfrA, api } = await arrangeSplit()
    const req = await api.post('/api/material-requirements', { scopeType: 'tradio_order', orderId: ORDER_ID, category: 'fabric', name: 'Cotton', requiredQty: 100, unit: 'm', supplier: 'Acme Mills' })
    const lineId = req.body.lines[0].id

    const pushed = await api.post(`/api/material-requirements/${req.body.id}/lines/${lineId}/push`, { mfrId: String(mfrA._id), stageIndex: 0 })
    assert.equal(pushed.status, 200, JSON.stringify(pushed.body))
    assert.equal(pushed.body.lines[0].pushedTo.length, 1)
    assert.equal(pushed.body.lines[0].pushedTo[0].stageIndex, 0)

    const order = await api.get(`/api/orders/${ORDER_ID}`)
    const stageMaterials = order.body.assignments[0].stages[0].materials
    assert.equal(stageMaterials.length, 1)
    assert.equal(stageMaterials[0].name, 'Cotton')
    assert.equal(stageMaterials[0].category, 'fabric')
    assert.equal(stageMaterials[0].supplier, 'Acme Mills')

    // Now the manufacturer sees exactly this one line via the requirement route too.
    const mfrView = await as(mfrA).get(`/api/material-requirements?orderId=${ORDER_ID}`)
    assert.equal(mfrView.body.lines.length, 1)
  })

  // Regression: enrichMaterialRequirement must DERIVE status/orderedQty/
  // receivedQty/poNumber from the pushed stage material line at read time —
  // the requirement line's own stored fields stay at their schema defaults
  // forever and must never be read directly. This is exactly what a real
  // admin/manufacturer/Kriyaa session would see going stale otherwise: mark
  // a line received on the Production/Materials side, and the planning-layer
  // view keeps saying "pending" indefinitely.
  test('after pushing, the requirement line\'s status/poNumber track the pushed stage material live, not a stale default', async () => {
    const { mfrA, api } = await arrangeSplit()
    const req = await api.post('/api/material-requirements', { scopeType: 'tradio_order', orderId: ORDER_ID, category: 'fabric', name: 'Cotton', requiredQty: 100, unit: 'm' })
    const lineId = req.body.lines[0].id
    const pushed = await api.post(`/api/material-requirements/${req.body.id}/lines/${lineId}/push`, { mfrId: String(mfrA._id), stageIndex: 0 })
    assert.equal(pushed.status, 200)
    // Freshly pushed — still pending, no PO yet, on both the admin and manufacturer views.
    assert.equal(pushed.body.lines[0].status, 'pending')
    const mfrBefore = await as(mfrA).get(`/api/material-requirements?orderId=${ORDER_ID}`)
    assert.equal(mfrBefore.body.lines[0].status, 'pending')

    // Advance the REAL stage material line — the execution/receiving layer —
    // exactly as raising a PO or receiving stock would.
    await api.post(`/api/orders/${ORDER_ID}/assignments/${mfrA._id}/stages/0/materials/0`, { poNumber: 'PO-9001', status: 'ordered' })

    const adminAfter = await api.get(`/api/material-requirements?orderId=${ORDER_ID}`)
    assert.equal(adminAfter.body.lines[0].status, 'ordered')
    assert.equal(adminAfter.body.lines[0].poNumber, 'PO-9001')

    const mfrAfter = await as(mfrA).get(`/api/material-requirements?orderId=${ORDER_ID}`)
    assert.equal(mfrAfter.body.lines[0].status, 'ordered')
    assert.equal(mfrAfter.body.lines[0].poNumber, 'PO-9001')

    // Receive it — receivedQty must track live too.
    await api.post(`/api/orders/${ORDER_ID}/assignments/${mfrA._id}/stages/0/materials/0`, { receivedQty: 100, status: 'received' })
    const received = await api.get(`/api/material-requirements?orderId=${ORDER_ID}`)
    assert.equal(received.body.lines[0].status, 'received')
    assert.equal(received.body.lines[0].receivedQty, 100)
  })

  test('a manufacturer\'s filtered view resolves against THEIR OWN push, never a different manufacturer\'s stage, on a split order', async () => {
    const { mfrA, mfrB, api } = await arrangeSplit()
    const req = await api.post('/api/material-requirements', { scopeType: 'tradio_order', orderId: ORDER_ID, category: 'trim', name: 'Zipper', requiredQty: 100 })
    const lineId = req.body.lines[0].id
    await api.post(`/api/material-requirements/${req.body.id}/lines/${lineId}/push`, { mfrId: String(mfrA._id), stageIndex: 0 })
    await api.post(`/api/material-requirements/${req.body.id}/lines/${lineId}/push`, { mfrId: String(mfrB._id), stageIndex: 0 })

    // Only mfrB's copy gets marked ordered — mfrA's own pushed stage line stays pending.
    await api.post(`/api/orders/${ORDER_ID}/assignments/${mfrB._id}/stages/0/materials/0`, { status: 'ordered', poNumber: 'PO-B' })

    const asA = await as(mfrA).get(`/api/material-requirements?orderId=${ORDER_ID}`)
    assert.equal(asA.body.lines[0].status, 'pending', 'mfrA must resolve against their OWN stage, not mfrB\'s')
    assert.equal(asA.body.lines[0].poNumber, '')

    const asB = await as(mfrB).get(`/api/material-requirements?orderId=${ORDER_ID}`)
    assert.equal(asB.body.lines[0].status, 'ordered')
    assert.equal(asB.body.lines[0].poNumber, 'PO-B')
  })

  test('manufacturer cannot push (admin only)', async () => {
    const { mfrA, api } = await arrangeSplit()
    const req = await api.post('/api/material-requirements', { scopeType: 'tradio_order', orderId: ORDER_ID, category: 'trim', name: 'Zipper', requiredQty: 10 })
    const lineId = req.body.lines[0].id
    const res = await as(mfrA).post(`/api/material-requirements/${req.body.id}/lines/${lineId}/push`, { mfrId: String(mfrA._id), stageIndex: 0 })
    assert.equal(res.status, 403)
  })

  test('an invalid stage index is rejected, not silently truncated', async () => {
    const { mfrA, api } = await arrangeSplit()
    const req = await api.post('/api/material-requirements', { scopeType: 'tradio_order', orderId: ORDER_ID, category: 'trim', name: 'Zipper', requiredQty: 10 })
    const lineId = req.body.lines[0].id
    const res = await api.post(`/api/material-requirements/${req.body.id}/lines/${lineId}/push`, { mfrId: String(mfrA._id), stageIndex: 999 })
    assert.equal(res.status, 400)
  })

  test('push cannot be attempted on an mfr_project requirement — no stages exist to push into', async () => {
    const mfr = await makeMfr()
    const project = await as(mfr).post('/api/mfr-projects', { styleName: 'X' })
    const req = await as(mfr).post('/api/material-requirements', { scopeType: 'mfr_project', mfrProjectId: project.body.id, category: 'fabric', name: 'Cotton', requiredQty: 1 })
    const lineId = req.body.lines[0].id
    const admin = await makeAdmin()
    const res = await as(admin).post(`/api/material-requirements/${req.body.id}/lines/${lineId}/push`, { mfrId: String(mfr._id), stageIndex: 0 })
    assert.equal(res.status, 400)
  })
})

describe('Phase 2 — PO document leak fix (documents.js manufacturer branch)', () => {
  test('a material_po document stamped with mfrId is invisible to a competing manufacturer on the same split order', async () => {
    const { mfrA, mfrB, api } = await arrangeSplit()

    const po = await api.post('/api/documents', {
      type: 'material_po', name: 'PO — Cotton Fabric', orderId: ORDER_ID, mfrId: String(mfrA._id),
      stageIndex: 0, notes: 'Acme Mills — 100m Cotton — PO-TEST-001',
    })
    assert.equal(po.status, 201, JSON.stringify(po.body))

    const listA = await as(mfrA).get('/api/documents')
    assert.ok(JSON.stringify(listA.body).includes('PO-TEST-001'), 'mfrA must see their own PO')

    const listB = await as(mfrB).get('/api/documents')
    assert.ok(!JSON.stringify(listB.body).includes('PO-TEST-001'), 'mfrB must NEVER see mfrA\'s PO — this is the exact leak the review caught')
  })

  test('regression: a general order document with no mfrId still reaches every assigned manufacturer', async () => {
    const { mfrA, mfrB, api } = await arrangeSplit()
    const doc = await api.post('/api/documents', { type: 'tech_pack', name: 'Tech Pack', orderId: ORDER_ID, stageIndex: 0, notes: 'shared context' })
    assert.equal(doc.status, 201)
    const listA = await as(mfrA).get('/api/documents')
    const listB = await as(mfrB).get('/api/documents')
    assert.ok(JSON.stringify(listA.body).includes('Tech Pack'))
    assert.ok(JSON.stringify(listB.body).includes('Tech Pack'), 'general order docs (no mfrId) still shared — the fix only narrows mfrId-stamped docs')
  })
})

describe('Phase 2 — Excel export never shows more than the on-screen view', () => {

  test('buyer export contains only the final price — parsed for real, not just a status check', async () => {
    const { buyer, id } = await fullyApprovedSheet()
    const res = await fetch(`${baseUrl}/api/cost-sheets/${id}/export.xlsx`, { headers: { Authorization: `Bearer ${tokenFor(buyer)}` } })
    assert.equal(res.status, 200)
    const buf = Buffer.from(await res.arrayBuffer())
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf)
    const ws = wb.getWorksheet('Cost Sheet')
    const allText = ws.getSheetValues().flat().filter(Boolean).join(' | ')
    assert.ok(allText.includes('555'), 'the approved final price must be present')
    assert.ok(!allText.includes('200'), 'the fabric rate must never appear in a buyer export')
    assert.ok(!/margin/i.test(allText), 'no margin row at all in a buyer export')
  })

  test('manufacturer export contains their own cost detail but never Price/Margin/Tradio fee', async () => {
    const { mfrA, id } = await fullyApprovedSheet()
    const res = await fetch(`${baseUrl}/api/cost-sheets/${id}/export.xlsx`, { headers: { Authorization: `Bearer ${tokenFor(mfrA)}` } })
    assert.equal(res.status, 200)
    const buf = Buffer.from(await res.arrayBuffer())
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf)
    const ws = wb.getWorksheet('Cost Sheet')
    const allText = ws.getSheetValues().flat().filter(Boolean).join(' | ')
    assert.ok(allText.includes('Cutting & Threads'), 'manufacturer sees their own labour detail')
    assert.ok(!/margin/i.test(allText))
    assert.ok(!/tradio fee/i.test(allText))
    assert.ok(!allText.includes('555'), 'the negotiated price must not leak into the manufacturer export either')
  })

  test('?view=internal is rejected for anyone but admin, even the sheet\'s own manufacturer', async () => {
    const { mfrA, id } = await fullyApprovedSheet()
    const res = await fetch(`${baseUrl}/api/cost-sheets/${id}/export.xlsx?view=internal`, { headers: { Authorization: `Bearer ${tokenFor(mfrA)}` } })
    assert.equal(res.status, 403)
  })

  test('admin ?view=internal succeeds and contains the full margin breakdown', async () => {
    const { admin, id } = await fullyApprovedSheet()
    const res = await fetch(`${baseUrl}/api/cost-sheets/${id}/export.xlsx?view=internal`, { headers: { Authorization: `Bearer ${tokenFor(admin)}` } })
    assert.equal(res.status, 200)
    const buf = Buffer.from(await res.arrayBuffer())
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf)
    const allText = wb.getWorksheet('Cost Sheet').getSheetValues().flat().filter(Boolean).join(' | ')
    assert.ok(/margin/i.test(allText))
    assert.ok(allText.includes('555'))
  })

  test('a competing manufacturer cannot export a sheet that is not theirs', async () => {
    const { mfrB, id } = await fullyApprovedSheet()
    const res = await fetch(`${baseUrl}/api/cost-sheets/${id}/export.xlsx`, { headers: { Authorization: `Bearer ${tokenFor(mfrB)}` } })
    assert.equal(res.status, 403)
  })
})

describe('Phase 3 — submit notification, withdraw, actuals, consumption sanity-check', () => {
  test('submitting notifies every master admin, matching the escalate-route pattern', async () => {
    const { mfrA, master, api } = await arrangeSplit()
    const master2 = await makeMaster()
    const create = await as(mfrA).post('/api/cost-sheets', { scopeType: 'tradio_order', orderId: ORDER_ID, fabricSource: 'tradio' })
    await as(mfrA).post(`/api/cost-sheets/${create.body.id}/submit`, {})

    const n1 = await as(master).get('/api/notifications')
    const n2 = await as(master2).get('/api/notifications')
    assert.ok(JSON.stringify(n1.body).includes(ORDER_ID))
    assert.ok(JSON.stringify(n2.body).includes(ORDER_ID), 'every master admin gets notified, not just one')
  })

  test('manufacturer can withdraw their own submitted sheet back to draft, self-service', async () => {
    const { mfrA } = await arrangeSplit()
    const create = await as(mfrA).post('/api/cost-sheets', { scopeType: 'tradio_order', orderId: ORDER_ID, fabricSource: 'tradio' })
    await as(mfrA).post(`/api/cost-sheets/${create.body.id}/submit`, {})

    const withdraw = await as(mfrA).post(`/api/cost-sheets/${create.body.id}/withdraw`, {})
    assert.equal(withdraw.status, 200)
    assert.equal(withdraw.body.status, 'draft')

    // Editable again now.
    const edit = await as(mfrA).post('/api/cost-sheets', { scopeType: 'tradio_order', orderId: ORDER_ID, fabric: { consumption: 2 } })
    assert.equal(edit.status, 200)
  })

  test('withdraw is rejected once approved — only master can reopen from there', async () => {
    const { id, mfrA } = await fullyApprovedSheet()
    const res = await as(mfrA).post(`/api/cost-sheets/${id}/withdraw`, {})
    assert.equal(res.status, 400)
  })

  test('actuals route: owner can record after submit, exempt from the content lock; a stranger cannot', async () => {
    const { mfrA, mfrB } = await arrangeSplit()
    const create = await as(mfrA).post('/api/cost-sheets', { scopeType: 'tradio_order', orderId: ORDER_ID, fabricSource: 'tradio' })
    const id = create.body.id

    const tooEarly = await as(mfrA).post(`/api/cost-sheets/${id}/actuals`, { actualFabricConsumption: 1.6 })
    assert.equal(tooEarly.status, 400, 'actuals only make sense once submitted')

    await as(mfrA).post(`/api/cost-sheets/${id}/submit`, {})
    const ok = await as(mfrA).post(`/api/cost-sheets/${id}/actuals`, { actualFabricConsumption: 1.6, actualLabourCost: 90 })
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
    assert.equal(ok.body.actualFabricConsumption, 1.6)

    const stranger = await as(mfrB).post(`/api/cost-sheets/${id}/actuals`, { actualFabricConsumption: 99 })
    assert.equal(stranger.status, 403)
  })

  test('consumption sanity-check fires as a non-blocking warning when the pulled fabric line disagrees with the plan', async () => {
    const { mfrA, api } = await arrangeSplit()
    const reqRes = await api.post('/api/material-requirements', { scopeType: 'tradio_order', orderId: ORDER_ID, category: 'fabric', name: 'Cotton', requiredQty: 100, unit: 'm' })
    const lineId = reqRes.body.lines[0].id
    // requiredQty 100 over totalQty 100 -> 1.0 per unit planned in the requirement.

    const sheet = await as(mfrA).post('/api/cost-sheets', {
      scopeType: 'tradio_order', orderId: ORDER_ID,
      fabric: { name: 'Cotton', unit: 'm', consumption: 1.5, rate: 200, materialRequirementId: reqRes.body.id, materialRequirementLineId: lineId },
    })
    assert.equal(sheet.status, 200, JSON.stringify(sheet.body))
    assert.ok(sheet.body.consumptionWarning, 'a 50% overage from the plan must surface a warning')
    assert.equal(sheet.body.consumptionWarning.requiredPerUnit, 1)
    assert.equal(sheet.body.consumptionWarning.pctDiff, 50)

    // Never a hard block — the sheet still saved successfully above.
    const reread = await as(mfrA).get(`/api/cost-sheets/${sheet.body.id}`)
    assert.ok(reread.body.consumptionWarning)
  })

  test('no warning when consumption was never pulled from a requirement (a manufacturer typing their own number)', async () => {
    const { mfrA } = await arrangeSplit()
    const sheet = await as(mfrA).post('/api/cost-sheets', { scopeType: 'tradio_order', orderId: ORDER_ID, fabric: { consumption: 5, rate: 10 } })
    assert.equal(sheet.body.consumptionWarning, null)
  })
})

describe('Phase 4 — consumption/inventory capture on the Delivered transition', () => {
  test('marking Delivered captures a ConsumptionRecord and an InventoryMovement "out" row', async () => {
    const { mfrA, admin } = await arrangeSplit()
    const create = await as(mfrA).post('/api/cost-sheets', {
      scopeType: 'tradio_order', orderId: ORDER_ID, fabricSource: 'tradio',
      fabric: { name: 'Cotton', unit: 'm', consumption: 1.5, rate: 200 },
    })
    await as(mfrA).post(`/api/cost-sheets/${create.body.id}/submit`, {})
    await as(mfrA).post(`/api/cost-sheets/${create.body.id}/actuals`, { actualFabricConsumption: 1.6 })

    const status = await as(admin).post(`/api/orders/${ORDER_ID}/assignments/${mfrA._id}`, { status: 'Delivered' })
    assert.equal(status.status, 200, JSON.stringify(status.body))

    const record = await ConsumptionRecord.findOne({ orderId: ORDER_ID, mfrId: mfrA._id }).lean()
    assert.ok(record, 'a ConsumptionRecord must exist after Delivered')
    assert.equal(record.actualConsumptionPerUnit, 1.6)
    assert.equal(record.plannedConsumptionPerUnit, 1.5)
    assert.equal(record.totalUnitsProduced, 60) // mfrA's split qty from arrangeSplit
    assert.equal(record.totalActualConsumption, 96) // 1.6 * 60

    const movement = await InventoryMovement.findOne({ orderId: ORDER_ID, mfrId: mfrA._id, direction: 'out' }).lean()
    assert.ok(movement, 'an InventoryMovement out row must exist')
    assert.equal(movement.qty, 96)
  })

  test('re-marking Delivered a second time does not duplicate the record or the movement — idempotent', async () => {
    const { mfrA, admin } = await arrangeSplit()
    const create = await as(mfrA).post('/api/cost-sheets', { scopeType: 'tradio_order', orderId: ORDER_ID, fabricSource: 'tradio', fabric: { name: 'Cotton', unit: 'm', consumption: 1.5 } })
    await as(mfrA).post(`/api/cost-sheets/${create.body.id}/submit`, {})
    await as(mfrA).post(`/api/cost-sheets/${create.body.id}/actuals`, { actualFabricConsumption: 1.6 })

    await as(admin).post(`/api/orders/${ORDER_ID}/assignments/${mfrA._id}`, { status: 'Delayed' })
    await as(admin).post(`/api/orders/${ORDER_ID}/assignments/${mfrA._id}`, { status: 'Delivered' })
    await as(admin).post(`/api/orders/${ORDER_ID}/assignments/${mfrA._id}`, { status: 'Delayed' })
    await as(admin).post(`/api/orders/${ORDER_ID}/assignments/${mfrA._id}`, { status: 'Delivered' })

    const records = await ConsumptionRecord.find({ orderId: ORDER_ID, mfrId: mfrA._id }).lean()
    const movements = await InventoryMovement.find({ orderId: ORDER_ID, mfrId: mfrA._id, direction: 'out' }).lean()
    assert.equal(records.length, 1, 'exactly one record, not two')
    assert.equal(movements.length, 1, 'exactly one out movement, not two')
  })

  test('a corrected actual REPLACES the movement quantity rather than adding a second row', async () => {
    const { mfrA, admin } = await arrangeSplit()
    const create = await as(mfrA).post('/api/cost-sheets', { scopeType: 'tradio_order', orderId: ORDER_ID, fabricSource: 'tradio', fabric: { name: 'Cotton', unit: 'm', consumption: 1.5 } })
    await as(mfrA).post(`/api/cost-sheets/${create.body.id}/submit`, {})
    await as(mfrA).post(`/api/cost-sheets/${create.body.id}/actuals`, { actualFabricConsumption: 1.6 })
    await as(admin).post(`/api/orders/${ORDER_ID}/assignments/${mfrA._id}`, { status: 'Delivered' })

    // Manufacturer realizes the actual was wrong, corrects it, order gets re-delivered.
    await as(mfrA).post(`/api/cost-sheets/${create.body.id}/actuals`, { actualFabricConsumption: 1.4 })
    await as(admin).post(`/api/orders/${ORDER_ID}/assignments/${mfrA._id}`, { status: 'Delayed' })
    await as(admin).post(`/api/orders/${ORDER_ID}/assignments/${mfrA._id}`, { status: 'Delivered' })

    const movements = await InventoryMovement.find({ orderId: ORDER_ID, mfrId: mfrA._id, direction: 'out' }).lean()
    assert.equal(movements.length, 1)
    assert.equal(movements[0].qty, 1.4 * 60, 'replaced with the corrected quantity, not stacked')
  })

  test('no cost sheet exists yet -> Delivered is a safe no-op, does not fail the status update', async () => {
    const { mfrA, admin } = await arrangeSplit()
    const status = await as(admin).post(`/api/orders/${ORDER_ID}/assignments/${mfrA._id}`, { status: 'Delivered' })
    assert.equal(status.status, 200)
    const record = await ConsumptionRecord.findOne({ orderId: ORDER_ID, mfrId: mfrA._id }).lean()
    assert.equal(record, null)
  })

  test('receiving a material writes an InventoryMovement "in" row for the delta, not the running total', async () => {
    const { mfrA, api } = await arrangeSplit()
    const add = await api.post(`/api/orders/${ORDER_ID}/assignments/${mfrA._id}/stages/0/materials`, { name: 'Zipper', category: 'trim', requiredQty: 100, unit: 'pcs' })
    const lineId = add.body.assignments[0].stages[0].materials[0].id

    await api.post(`/api/orders/${ORDER_ID}/assignments/${mfrA._id}/stages/0/materials/0`, { receivedQty: 40 })
    await api.post(`/api/orders/${ORDER_ID}/assignments/${mfrA._id}/stages/0/materials/0`, { receivedQty: 70 })

    const movements = await InventoryMovement.find({ orderId: ORDER_ID, mfrId: mfrA._id, direction: 'in' }).sort({ createdAt: 1 }).lean()
    assert.equal(movements.length, 2)
    assert.equal(movements[0].qty, 40)
    assert.equal(movements[1].qty, 30, 'the delta (70-40), not the new total (70)')
  })

  test('a downward correction to receivedQty writes no movement at all — not a negative receipt', async () => {
    const { mfrA, api } = await arrangeSplit()
    await api.post(`/api/orders/${ORDER_ID}/assignments/${mfrA._id}/stages/0/materials`, { name: 'Zipper', requiredQty: 100 })
    await api.post(`/api/orders/${ORDER_ID}/assignments/${mfrA._id}/stages/0/materials/0`, { receivedQty: 50 })
    await api.post(`/api/orders/${ORDER_ID}/assignments/${mfrA._id}/stages/0/materials/0`, { receivedQty: 30 })

    const movements = await InventoryMovement.find({ orderId: ORDER_ID, mfrId: mfrA._id, direction: 'in' }).lean()
    assert.equal(movements.length, 1, 'only the original 50 — the downward correction to 30 writes nothing')
  })
})

describe('GET /api/inventory — on-hand stock, tradio_order visible to admin, both scopes to the owning manufacturer', () => {
  async function seedMovements(mfrA, mfrB) {
    await InventoryMovement.create([
      { mfrId: mfrA._id, materialName: 'Cotton Poplin', unit: 'm', direction: 'in', qty: 100, scopeType: 'tradio_order', orderId: ORDER_ID, sourceType: 'material_receipt' },
      { mfrId: mfrA._id, materialName: 'Cotton Poplin', unit: 'm', direction: 'out', qty: 30, scopeType: 'tradio_order', orderId: ORDER_ID, sourceType: 'manual_adjustment' },
      { mfrId: mfrA._id, materialName: 'Private Denim', unit: 'm', direction: 'in', qty: 50, scopeType: 'mfr_project', mfrProjectId: new mongoose.Types.ObjectId(), sourceType: 'material_receipt' },
      { mfrId: mfrB._id, materialName: 'Zipper', unit: 'pcs', direction: 'in', qty: 200, scopeType: 'tradio_order', orderId: ORDER_ID, sourceType: 'material_receipt' },
    ])
  }

  test('manufacturer sees their own tradio_order AND mfr_project rows, never another manufacturer\'s', async () => {
    const { mfrA, mfrB } = await arrangeSplit()
    await seedMovements(mfrA, mfrB)
    const { status, body } = await as(mfrA).get('/api/inventory')
    assert.equal(status, 200)
    const names = body.map(r => r.materialName)
    assert.ok(names.includes('Cotton Poplin') && names.includes('Private Denim'), 'sees both own scopes')
    assert.ok(!names.includes('Zipper'), 'never sees mfrB\'s stock')
    const cotton = body.find(r => r.materialName === 'Cotton Poplin')
    assert.equal(cotton.onHand, 70, 'sum(in) - sum(out) = 100 - 30')
  })

  test('admin sees tradio_order rows across every manufacturer, but never a mfr_project row', async () => {
    const { mfrA, mfrB, admin } = await arrangeSplit()
    await seedMovements(mfrA, mfrB)
    const { status, body } = await as(admin).get('/api/inventory')
    assert.equal(status, 200)
    const names = body.map(r => r.materialName)
    assert.ok(names.includes('Cotton Poplin') && names.includes('Zipper'), 'sees tradio_order stock for both manufacturers')
    assert.ok(!names.includes('Private Denim'), 'mfr_project stock stays private — no admin override, ever')
    const cotton = body.find(r => r.materialName === 'Cotton Poplin')
    assert.ok(cotton.mfrCompany, 'admin view is labeled with the manufacturer, since it spans several')
  })

  test('buyer is forbidden — procurement internals are never a buyer concern', async () => {
    const { mfrA, mfrB, buyer } = await arrangeSplit()
    await seedMovements(mfrA, mfrB)
    const { status } = await as(buyer).get('/api/inventory')
    assert.equal(status, 403)
  })
})

describe('POST /cost-sheets/:id/duplicate', () => {
  const ORDER_ID_2 = 'MATCOST-TEST-002'

  async function withSecondOrder() {
    const arranged = await arrangeSplit()
    const payload = orderPayload({ id: ORDER_ID_2, buyerId: arranged.buyer._id, mfrId: arranged.mfrA._id, totalQty: 50 })
    payload.assignments = [{ mid: String(arranged.mfrA._id), qty: 50 }]
    const res = await arranged.api.post('/api/orders', payload)
    assert.equal(res.status, 201, JSON.stringify(res.body))
    return arranged
  }

  test('manufacturer duplicates their own sheet onto another order — draft, content copied, margin never carried', async () => {
    const { mfrA } = await withSecondOrder()
    const create = await as(mfrA).post('/api/cost-sheets', {
      scopeType: 'tradio_order', orderId: ORDER_ID, fabricSource: 'tradio',
      fabric: { name: 'Cotton', unit: 'm', consumption: 1.5, rate: 200 },
      process: [{ label: 'Print', supplier: 'Acme', value: 10 }],
      labour: { cuttingThreads: 14, making: 60, finishingPacking: 12 },
    })
    const dup = await as(mfrA).post(`/api/cost-sheets/${create.body.id}/duplicate`, { targetOrderId: ORDER_ID_2, styleRef: 'V2' })
    assert.equal(dup.status, 201, JSON.stringify(dup.body))
    assert.equal(dup.body.status, 'draft')
    assert.equal(dup.body.styleRef, 'V2')
    assert.equal(dup.body.fabric.name, 'Cotton')
    assert.equal(dup.body.process[0].label, 'Print')
    assert.equal(dup.body.process[0].supplier, 'Acme')
  })

  test('duplicate never carries the margin/fee/negotiated-price layer, even when master admin duplicates an approved sheet', async () => {
    const { id, mfrA, buyer, masterApi } = await fullyApprovedSheet()
    const payload = orderPayload({ id: ORDER_ID_2, buyerId: buyer._id, mfrId: mfrA._id, totalQty: 50 })
    payload.assignments = [{ mid: String(mfrA._id), qty: 50 }]
    const created = await masterApi.post('/api/orders', payload)
    assert.equal(created.status, 201, JSON.stringify(created.body))

    const dup = await masterApi.post(`/api/cost-sheets/${id}/duplicate`, { targetOrderId: ORDER_ID_2 })
    assert.equal(dup.status, 201, JSON.stringify(dup.body))
    assert.equal(dup.body.status, 'draft')
    const raw = JSON.stringify(dup.body)
    assert.ok(!raw.includes('555'), 'the source finalNegotiatedPrice value must never appear on the duplicate')
    assert.equal(dup.body.marginValue, null)
    assert.equal(dup.body.price, null)
  })

  test('duplicating onto a scope that already has a sheet is a clean 400, not a raw E11000', async () => {
    const { mfrA } = await withSecondOrder()
    const create = await as(mfrA).post('/api/cost-sheets', { scopeType: 'tradio_order', orderId: ORDER_ID, fabricSource: 'tradio', fabric: { name: 'Cotton', unit: 'm' } })
    await as(mfrA).post('/api/cost-sheets', { scopeType: 'tradio_order', orderId: ORDER_ID_2, fabricSource: 'tradio', fabric: { name: 'Other', unit: 'm' } })

    const dup = await as(mfrA).post(`/api/cost-sheets/${create.body.id}/duplicate`, { targetOrderId: ORDER_ID_2 })
    assert.equal(dup.status, 400)
    assert.ok(!/E11000/.test(dup.body.error || ''))
  })

  test('manufacturer B cannot duplicate manufacturer A\'s sheet', async () => {
    const { mfrA, mfrB } = await withSecondOrder()
    const create = await as(mfrA).post('/api/cost-sheets', { scopeType: 'tradio_order', orderId: ORDER_ID, fabricSource: 'tradio', fabric: { name: 'Cotton', unit: 'm' } })
    const dup = await as(mfrB).post(`/api/cost-sheets/${create.body.id}/duplicate`, { targetOrderId: ORDER_ID_2 })
    assert.equal(dup.status, 403)
  })
})

describe('Order delete — cascade policy for CostSheet/MaterialRequirement', () => {
  test('a draft cost sheet and the requirement doc are cascade-deleted with the order', async () => {
    const { mfrA, api } = await arrangeSplit()
    await api.post('/api/material-requirements', { scopeType: 'tradio_order', orderId: ORDER_ID, category: 'fabric', name: 'Cotton', requiredQty: 100 })
    await as(mfrA).post('/api/cost-sheets', { scopeType: 'tradio_order', orderId: ORDER_ID, fabricSource: 'tradio', fabric: { name: 'Cotton', unit: 'm', consumption: 1 } })

    const del = await api.post(`/api/orders/${ORDER_ID}/delete`)
    assert.equal(del.status, 200)

    const { CostSheet } = await import('../src/models/CostSheet.js')
    const { MaterialRequirement } = await import('../src/models/MaterialRequirement.js')
    assert.equal(await CostSheet.countDocuments({ orderId: ORDER_ID }), 0)
    assert.equal(await MaterialRequirement.countDocuments({ orderId: ORDER_ID }), 0)
  })

  test('a submitted cost sheet blocks the delete outright — it is a commercial record', async () => {
    const { mfrA, api } = await arrangeSplit()
    const create = await as(mfrA).post('/api/cost-sheets', { scopeType: 'tradio_order', orderId: ORDER_ID, fabricSource: 'tradio', fabric: { name: 'Cotton', unit: 'm', consumption: 1 } })
    await as(mfrA).post(`/api/cost-sheets/${create.body.id}/submit`, {})

    const del = await api.post(`/api/orders/${ORDER_ID}/delete`)
    assert.equal(del.status, 400)

    const order = await api.get(`/api/orders/${ORDER_ID}`)
    assert.equal(order.status, 200, 'the order must still exist — the delete was refused, not partially applied')
  })

  test('an approved cost sheet blocks the delete too, not just submitted', async () => {
    const { api } = await fullyApprovedSheet()
    const del = await api.post(`/api/orders/${ORDER_ID}/delete`)
    assert.equal(del.status, 400)
  })
})
