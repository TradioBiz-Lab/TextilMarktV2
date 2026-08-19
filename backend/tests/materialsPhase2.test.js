// Order Setup Wizard, Phase 2: category split + wastage/rate fields, the BOM
// clone/duplicate route, mfr_project-only PO generation, the new Supplier
// catalog, and the AI BOM-draft route's validation surface (never the real
// Anthropic call — same "don't mock/call the SDK, test the gates" discipline
// as assistant.route.test.js).

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

const ORDER_ID = 'MATPHASE2-TEST-001'

async function arrangeOrder() {
  const admin = await makeAdmin()
  const buyer = await makeBuyer()
  const mfr = await makeMfr()
  const api = as(admin)
  const created = await api.post('/api/orders', orderPayload({ id: ORDER_ID, buyerId: buyer._id, mfrId: mfr._id }))
  assert.equal(created.status, 201, JSON.stringify(created.body))
  return { admin, buyer, mfr, api }
}

describe('MaterialRequirement — category split, wastagePct, rate', () => {
  test('fabric_primary/fabric_secondary are valid categories alongside the original set', async () => {
    const { admin } = await arrangeOrder()
    const res = await as(admin).post('/api/material-requirements', {
      scopeType: 'tradio_order', orderId: ORDER_ID, category: 'fabric_primary', name: 'Main Body Fabric', requiredQty: 2.5, wastagePct: 8, rate: 250,
    })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    const line = res.body.lines[0]
    assert.equal(line.category, 'fabric_primary')
    assert.equal(line.wastagePct, 8)
    assert.equal(line.rate, 250)
    // qtyToOrder = requiredQty * (1 + wastagePct/100) = 2.5 * 1.08 = 2.7
    assert.equal(line.qtyToOrder, 2.7)
  })

  test('legacy "fabric" category still works unchanged', async () => {
    const { admin } = await arrangeOrder()
    const res = await as(admin).post('/api/material-requirements', {
      scopeType: 'tradio_order', orderId: ORDER_ID, category: 'fabric', name: 'X', requiredQty: 1,
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.lines[0].category, 'fabric')
    assert.equal(res.body.lines[0].wastagePct, 0)
    assert.equal(res.body.lines[0].qtyToOrder, 1)
  })

  test('an invalid category is rejected', async () => {
    const { admin } = await arrangeOrder()
    const res = await as(admin).post('/api/material-requirements', {
      scopeType: 'tradio_order', orderId: ORDER_ID, category: 'nonsense', name: 'X', requiredQty: 1,
    })
    assert.equal(res.status, 400)
  })

  test('negative wastagePct or rate is rejected', async () => {
    const { admin } = await arrangeOrder()
    const badWastage = await as(admin).post('/api/material-requirements', {
      scopeType: 'tradio_order', orderId: ORDER_ID, category: 'fabric', name: 'X', requiredQty: 1, wastagePct: -5,
    })
    assert.equal(badWastage.status, 400)
    const badRate = await as(admin).post('/api/material-requirements', {
      scopeType: 'tradio_order', orderId: ORDER_ID, category: 'fabric', name: 'X', requiredQty: 1, rate: -1,
    })
    assert.equal(badRate.status, 400)
  })
})

describe('MaterialRequirement — duplicate (clone a whole BOM)', () => {
  test('clones lines into a fresh target scope, resetting receiving/push fields', async () => {
    const { admin, buyer, mfr, api } = await arrangeOrder()
    const source = await api.post('/api/material-requirements', {
      scopeType: 'tradio_order', orderId: ORDER_ID, category: 'trim', name: 'Zipper', requiredQty: 2, supplier: 'YKK',
    })
    const secondOrderId = 'MATPHASE2-TEST-002'
    const created2 = await api.post('/api/orders', orderPayload({ id: secondOrderId, buyerId: buyer._id, mfrId: mfr._id }))
    assert.equal(created2.status, 201)

    const dup = await api.post(`/api/material-requirements/${source.body.id}/duplicate`, { targetOrderId: secondOrderId })
    assert.equal(dup.status, 201, JSON.stringify(dup.body))
    assert.equal(dup.body.lines.length, 1)
    assert.equal(dup.body.lines[0].name, 'Zipper')
    assert.equal(dup.body.lines[0].supplier, 'YKK')
    assert.equal(dup.body.lines[0].status, 'pending')
    assert.equal(dup.body.lines[0].pushedTo.length, 0)
  })

  test('duplicate into a scope that already has a requirement is rejected cleanly', async () => {
    const { admin, buyer, mfr, api } = await arrangeOrder()
    const source = await api.post('/api/material-requirements', {
      scopeType: 'tradio_order', orderId: ORDER_ID, category: 'trim', name: 'Zipper', requiredQty: 2,
    })
    const secondOrderId = 'MATPHASE2-TEST-003'
    await api.post('/api/orders', orderPayload({ id: secondOrderId, buyerId: buyer._id, mfrId: mfr._id }))
    await api.post('/api/material-requirements', { scopeType: 'tradio_order', orderId: secondOrderId, category: 'other', name: 'Already here', requiredQty: 1 })

    const dup = await api.post(`/api/material-requirements/${source.body.id}/duplicate`, { targetOrderId: secondOrderId })
    assert.equal(dup.status, 400)
  })

  test('a buyer cannot duplicate a requirement', async () => {
    const { admin, buyer, api } = await arrangeOrder()
    const source = await api.post('/api/material-requirements', {
      scopeType: 'tradio_order', orderId: ORDER_ID, category: 'trim', name: 'Zipper', requiredQty: 2,
    })
    const res = await as(buyer).post(`/api/material-requirements/${source.body.id}/duplicate`, { targetOrderId: ORDER_ID })
    assert.equal(res.status, 403)
  })
})

describe('MaterialRequirement — generate-po (mfr_project scope only)', () => {
  test('tradio_order scope is rejected with a pointer to the existing Raise PO action', async () => {
    const { admin, api } = await arrangeOrder()
    const line = await api.post('/api/material-requirements', {
      scopeType: 'tradio_order', orderId: ORDER_ID, category: 'trim', name: 'Zipper', requiredQty: 2,
    })
    const res = await api.post(`/api/material-requirements/${line.body.id}/generate-po`, { lineIds: [line.body.lines[0].id] })
    assert.equal(res.status, 400)
    assert.match(res.body.error, /Raise PO/)
  })

  test('mfr_project scope generates a PO across selected lines, sharing one poNumber', async () => {
    const mfr = await makeMfr()
    const project = await as(mfr).post('/api/mfr-projects', { styleName: 'Private Style' })
    const l1 = await as(mfr).post('/api/material-requirements', { scopeType: 'mfr_project', mfrProjectId: project.body.id, category: 'fabric', name: 'Fabric A', requiredQty: 5 })
    const l2 = await as(mfr).post('/api/material-requirements', { scopeType: 'mfr_project', mfrProjectId: project.body.id, category: 'trim', name: 'Trim B', requiredQty: 10 })
    const lineIds = l2.body.lines.map(l => l.id)

    const res = await as(mfr).post(`/api/material-requirements/${l2.body.id}/generate-po`, { lineIds })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    const poNumbers = new Set(res.body.lines.map(l => l.poNumber))
    assert.equal(poNumbers.size, 1)
    assert.ok([...poNumbers][0])
    for (const l of res.body.lines) assert.equal(l.status, 'ordered')
  })

  test('manufacturer B cannot generate a PO on manufacturer A\'s private project', async () => {
    const mfrA = await makeMfr()
    const mfrB = await makeMfr()
    const project = await as(mfrA).post('/api/mfr-projects', { styleName: 'Private Style' })
    const line = await as(mfrA).post('/api/material-requirements', { scopeType: 'mfr_project', mfrProjectId: project.body.id, category: 'fabric', name: 'Fabric A', requiredQty: 5 })
    const res = await as(mfrB).post(`/api/material-requirements/${line.body.id}/generate-po`, { lineIds: line.body.lines.map(l => l.id) })
    assert.equal(res.status, 403)
  })
})

describe('Supplier catalog', () => {
  test('admin creates a global (Tradio-shared) supplier; a manufacturer sees it', async () => {
    const admin = await makeAdmin()
    const mfr = await makeMfr()
    const created = await as(admin).post('/api/suppliers', { name: 'Global Mill', category: 'fabric' })
    assert.equal(created.status, 201)
    assert.equal(created.body.ownerType, 'tradio')

    const list = await as(mfr).get('/api/suppliers')
    assert.equal(list.body.some(s => s.name === 'Global Mill'), true)
  })

  test('a manufacturer-created supplier is private — not visible to another manufacturer, and mfrId is server-forced', async () => {
    const mfrA = await makeMfr()
    const mfrB = await makeMfr()
    const created = await as(mfrA).post('/api/suppliers', { name: 'My Own Trim Guy', mfrId: mfrB.id })
    assert.equal(created.status, 201)
    assert.equal(created.body.mfrId, String(mfrA._id), 'mfrId must be server-forced from the caller, never client-trusted')

    const listA = await as(mfrA).get('/api/suppliers')
    assert.equal(listA.body.some(s => s.name === 'My Own Trim Guy'), true)
    const listB = await as(mfrB).get('/api/suppliers')
    assert.equal(listB.body.some(s => s.name === 'My Own Trim Guy'), false)
  })

  test('a buyer sees the global catalog but cannot create/edit/delete', async () => {
    const admin = await makeAdmin()
    const buyer = await makeBuyer()
    const created = await as(admin).post('/api/suppliers', { name: 'Global Mill' })
    const list = await as(buyer).get('/api/suppliers')
    assert.equal(list.body.some(s => s.name === 'Global Mill'), true)

    const write = await as(buyer).post('/api/suppliers', { name: 'Should Fail' })
    assert.equal(write.status, 403)
  })

  test('manufacturer B cannot edit or delete manufacturer A\'s private supplier', async () => {
    const mfrA = await makeMfr()
    const mfrB = await makeMfr()
    const created = await as(mfrA).post('/api/suppliers', { name: 'Private Supplier' })
    const edit = await as(mfrB).post(`/api/suppliers/${created.body.id}`, { name: 'Hijacked' })
    assert.equal(edit.status, 403)
    const del = await as(mfrB).post(`/api/suppliers/${created.body.id}/delete`)
    assert.equal(del.status, 403)
  })

  test('any admin may edit a Tradio-shared supplier, even one created by a different admin', async () => {
    const admin1 = await makeAdmin()
    const admin2 = await makeAdmin()
    const created = await as(admin1).post('/api/suppliers', { name: 'Global Mill' })
    const edit = await as(admin2).post(`/api/suppliers/${created.body.id}`, { name: 'Renamed Mill' })
    assert.equal(edit.status, 200)
  })
})

describe('AI BOM draft — validation surface (never calls the real Anthropic API)', () => {
  test('a buyer is refused regardless of whether AI drafting is configured', async () => {
    const { buyer } = await arrangeOrder()
    const original = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      const res = await as(buyer).post('/api/material-requirements/ai-draft', { scopeType: 'tradio_order', orderId: ORDER_ID, documentIds: ['000000000000000000000000'] })
      assert.equal(res.status, 403)
    } finally {
      if (original !== undefined) process.env.ANTHROPIC_API_KEY = original
    }
  })

  test('a manufacturer with no relationship to the order is refused', async () => {
    await arrangeOrder()
    const outsider = await makeMfr()
    const res = await as(outsider).post('/api/material-requirements/ai-draft', { scopeType: 'tradio_order', orderId: ORDER_ID, documentIds: ['000000000000000000000000'] })
    assert.equal(res.status, 403)
  })

  test('missing documentIds is a 400, not a 503, even with no API key configured', async () => {
    const { admin } = await arrangeOrder()
    const original = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      const res = await as(admin).post('/api/material-requirements/ai-draft', { scopeType: 'tradio_order', orderId: ORDER_ID, documentIds: [] })
      assert.equal(res.status, 400)
    } finally {
      if (original !== undefined) process.env.ANTHROPIC_API_KEY = original
    }
  })

  test('a link-only (externalUrl) document is rejected with a clear error, never silently fetched', async () => {
    const { admin } = await arrangeOrder()
    const doc = await as(admin).post('/api/documents', { type: 'pattern', name: 'Pattern', externalUrl: 'https://workdrive.zoho.com/x.dxf', orderId: ORDER_ID })
    assert.equal(doc.status, 201)
    const res = await as(admin).post('/api/material-requirements/ai-draft', { scopeType: 'tradio_order', orderId: ORDER_ID, documentIds: [doc.body.id] })
    assert.equal(res.status, 400)
    assert.match(res.body.error, /link/i)
  })

  test('a document belonging to a different order is refused (in-scope check)', async () => {
    const { admin, buyer, mfr } = await arrangeOrder()
    const otherOrderId = 'MATPHASE2-TEST-OTHER'
    await as(admin).post('/api/orders', orderPayload({ id: otherOrderId, buyerId: buyer._id, mfrId: mfr._id }))
    const tinyPdf = 'data:application/pdf;base64,JVBERi0xLjQKJeLjz9MK'
    const doc = await as(admin).post('/api/documents', { type: 'tech_pack', name: 'Tech Pack', dataUrl: tinyPdf, orderId: otherOrderId })
    const res = await as(admin).post('/api/material-requirements/ai-draft', { scopeType: 'tradio_order', orderId: ORDER_ID, documentIds: [doc.body.id] })
    assert.equal(res.status, 403)
  })

  test('reaches the 503 config-missing response once permission and validation pass', async () => {
    const { admin } = await arrangeOrder()
    const tinyPdf = 'data:application/pdf;base64,JVBERi0xLjQKJeLjz9MK'
    const doc = await as(admin).post('/api/documents', { type: 'tech_pack', name: 'Tech Pack', dataUrl: tinyPdf, orderId: ORDER_ID })
    const original = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      const res = await as(admin).post('/api/material-requirements/ai-draft', { scopeType: 'tradio_order', orderId: ORDER_ID, documentIds: [doc.body.id] })
      assert.equal(res.status, 503)
    } finally {
      if (original !== undefined) process.env.ANTHROPIC_API_KEY = original
    }
  })
})
