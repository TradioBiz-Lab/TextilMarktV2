// Wiki feature: WikiPage (Tech Pack/SOP pages) + Document's wiki_* link-only subset
// (Inspection Form/Fit Comments/Photos). Both share the same company/buyer scoping
// rule (backend/src/lib/wikiAccess.js) — the adversarial cross-tenant blocks below are
// the real gate, same bar as orders.permissions.test.js's cross-tenant stripping suite.

import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as } from './helpers/client.js'
import { makeAdmin, makeBuyer, makeMfr, orderPayload } from './helpers/factories.js'

before(async () => {
  await startTestDb()
  await startServer()
})
after(async () => {
  await stopServer()
  await stopTestDb()
})
beforeEach(clearDb)

describe('WikiPage — create/edit/delete', () => {
  test('admin creates a company-wide page', async () => {
    const admin = await makeAdmin()
    const res = await as(admin).post('/api/wiki-pages', {
      title: 'Tradio Tech Pack Template', category: 'tech_pack', bodyMarkdown: 'Header sizes...', wikiScope: 'company',
    })
    assert.equal(res.status, 201, JSON.stringify(res.body))
    assert.equal(res.body.wikiScope, 'company')
    assert.equal(res.body.buyerId, null)
  })

  test('admin creates a buyer-scoped page', async () => {
    const admin = await makeAdmin()
    const buyer = await makeBuyer()
    const res = await as(admin).post('/api/wiki-pages', {
      title: 'Neobrands SOP', category: 'sop', bodyMarkdown: 'Step 1...', wikiScope: 'buyer', buyerId: String(buyer._id),
    })
    assert.equal(res.status, 201, JSON.stringify(res.body))
    assert.equal(res.body.buyerId, String(buyer._id))
  })

  test('buyer and manufacturer cannot create pages', async () => {
    const buyer = await makeBuyer()
    const mfr = await makeMfr()
    for (const user of [buyer, mfr]) {
      const res = await as(user).post('/api/wiki-pages', {
        title: 'x', category: 'sop', bodyMarkdown: 'y', wikiScope: 'company',
      })
      assert.equal(res.status, 403)
    }
  })

  test('wikiScope "buyer" with no buyerId is rejected', async () => {
    const admin = await makeAdmin()
    const res = await as(admin).post('/api/wiki-pages', {
      title: 'x', category: 'sop', bodyMarkdown: 'y', wikiScope: 'buyer',
    })
    assert.equal(res.status, 400)
  })

  test('buyerId must resolve to a real buyer user', async () => {
    const admin = await makeAdmin()
    const mfr = await makeMfr()
    const res = await as(admin).post('/api/wiki-pages', {
      title: 'x', category: 'sop', bodyMarkdown: 'y', wikiScope: 'buyer', buyerId: String(mfr._id),
    })
    assert.equal(res.status, 400)
  })

  test('wikiScope "company" with a buyerId present is rejected', async () => {
    const admin = await makeAdmin()
    const buyer = await makeBuyer()
    const res = await as(admin).post('/api/wiki-pages', {
      title: 'x', category: 'sop', bodyMarkdown: 'y', wikiScope: 'company', buyerId: String(buyer._id),
    })
    assert.equal(res.status, 400)
  })

  test('admin edits a page and updatedBy is stamped', async () => {
    const admin = await makeAdmin()
    const api = as(admin)
    const created = await api.post('/api/wiki-pages', {
      title: 'Draft SOP', category: 'sop', bodyMarkdown: 'v1', wikiScope: 'company',
    })
    const edited = await api.post(`/api/wiki-pages/${created.body.id}`, { bodyMarkdown: 'v2' })
    assert.equal(edited.status, 200)
    assert.equal(edited.body.bodyMarkdown, 'v2')
    assert.equal(edited.body.updatedBy, String(admin._id))
  })

  test('buyer and manufacturer cannot edit or delete pages', async () => {
    const admin = await makeAdmin()
    const buyer = await makeBuyer()
    const mfr = await makeMfr()
    const created = await as(admin).post('/api/wiki-pages', {
      title: 'x', category: 'sop', bodyMarkdown: 'y', wikiScope: 'company',
    })
    for (const user of [buyer, mfr]) {
      const editRes = await as(user).post(`/api/wiki-pages/${created.body.id}`, { bodyMarkdown: 'hijacked' })
      assert.equal(editRes.status, 403)
      const delRes = await as(user).post(`/api/wiki-pages/${created.body.id}/delete`)
      assert.equal(delRes.status, 403)
    }
  })

  test('soft-deleted pages 404 on GET /:id and disappear from GET /', async () => {
    const admin = await makeAdmin()
    const api = as(admin)
    const created = await api.post('/api/wiki-pages', {
      title: 'Retire Me', category: 'sop', bodyMarkdown: 'x', wikiScope: 'company',
    })
    const delRes = await api.post(`/api/wiki-pages/${created.body.id}/delete`)
    assert.equal(delRes.status, 200)

    const getRes = await api.get(`/api/wiki-pages/${created.body.id}`)
    assert.equal(getRes.status, 404)

    const listRes = await api.get('/api/wiki-pages')
    assert.equal(listRes.body.find(p => p.id === created.body.id), undefined)
  })
})

describe('WikiPage — adversarial cross-tenant scoping', () => {
  test('buyer sees company-wide + own pages, never another buyer\'s', async () => {
    const admin = await makeAdmin()
    const buyerA = await makeBuyer()
    const buyerB = await makeBuyer()
    const api = as(admin)
    await api.post('/api/wiki-pages', { title: 'Company Page', category: 'sop', bodyMarkdown: 'x', wikiScope: 'company' })
    const pageA = await api.post('/api/wiki-pages', { title: 'Buyer A Page', category: 'sop', bodyMarkdown: 'x', wikiScope: 'buyer', buyerId: String(buyerA._id) })
    const pageB = await api.post('/api/wiki-pages', { title: 'Buyer B Page', category: 'sop', bodyMarkdown: 'x', wikiScope: 'buyer', buyerId: String(buyerB._id) })

    const listRes = await as(buyerA).get('/api/wiki-pages')
    const titles = listRes.body.map(p => p.title)
    assert.ok(titles.includes('Company Page'))
    assert.ok(titles.includes('Buyer A Page'))
    assert.ok(!titles.includes('Buyer B Page'))

    // Direct-id path enforces the same boundary, not just the list filter.
    const directOwn = await as(buyerA).get(`/api/wiki-pages/${pageA.body.id}`)
    assert.equal(directOwn.status, 200)
    const directOther = await as(buyerA).get(`/api/wiki-pages/${pageB.body.id}`)
    assert.equal(directOther.status, 403)
  })

  test('manufacturer sees a buyer-scoped page only while assigned to that buyer\'s order', async () => {
    const admin = await makeAdmin()
    const buyerA = await makeBuyer()
    const mfrAssigned = await makeMfr()
    const mfrUnrelated = await makeMfr()
    const api = as(admin)

    const pageA = await api.post('/api/wiki-pages', { title: 'Buyer A SOP', category: 'sop', bodyMarkdown: 'x', wikiScope: 'buyer', buyerId: String(buyerA._id) })

    const orderRes = await api.post('/api/orders', orderPayload({ id: 'WIKI-TEST-MFR-001', buyerId: buyerA._id, mfrId: mfrAssigned._id }))
    assert.equal(orderRes.status, 201, JSON.stringify(orderRes.body))

    const assignedList = await as(mfrAssigned).get('/api/wiki-pages')
    assert.ok(assignedList.body.map(p => p.title).includes('Buyer A SOP'))
    const assignedDirect = await as(mfrAssigned).get(`/api/wiki-pages/${pageA.body.id}`)
    assert.equal(assignedDirect.status, 200)

    const unrelatedList = await as(mfrUnrelated).get('/api/wiki-pages')
    assert.ok(!unrelatedList.body.map(p => p.title).includes('Buyer A SOP'))
    const unrelatedDirect = await as(mfrUnrelated).get(`/api/wiki-pages/${pageA.body.id}`)
    assert.equal(unrelatedDirect.status, 403)
  })
})

describe('Document wiki_* types — link-only', () => {
  test('admin creates a wiki document with an externalUrl', async () => {
    const admin = await makeAdmin()
    const res = await as(admin).post('/api/documents', {
      type: 'wiki_inspection_form', name: 'Fabric Test Report', wikiScope: 'company',
      externalUrl: 'https://workdrive.zoho.com/file/abc123',
    })
    assert.equal(res.status, 201, JSON.stringify(res.body))
    assert.equal(res.body.externalUrl, 'https://workdrive.zoho.com/file/abc123')
    assert.equal(res.body.wikiScope, 'company')
  })

  test('a dataUrl on a wiki type is rejected', async () => {
    const admin = await makeAdmin()
    const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    const res = await as(admin).post('/api/documents', {
      type: 'wiki_photos', name: 'Lab dip photo', wikiScope: 'company', dataUrl: tinyPng,
    })
    assert.equal(res.status, 400)
  })

  test('a wiki type with no externalUrl is rejected', async () => {
    const admin = await makeAdmin()
    const res = await as(admin).post('/api/documents', {
      type: 'wiki_fit_comments', name: 'Fit comments', wikiScope: 'company',
    })
    assert.equal(res.status, 400)
  })

  test('buyer and manufacturer cannot create wiki documents', async () => {
    const buyer = await makeBuyer()
    const mfr = await makeMfr()
    for (const user of [buyer, mfr]) {
      const res = await as(user).post('/api/documents', {
        type: 'wiki_inspection_form', name: 'x', wikiScope: 'company', externalUrl: 'https://workdrive.zoho.com/x',
      })
      assert.equal(res.status, 403)
    }
  })

  test('wikiScope required for a wiki_* type, and forbidden for a non-wiki type', async () => {
    const admin = await makeAdmin()
    const api = as(admin)

    const missingScope = await api.post('/api/documents', {
      type: 'wiki_photos', name: 'x', externalUrl: 'https://workdrive.zoho.com/x',
    })
    assert.equal(missingScope.status, 400)

    const strayScope = await api.post('/api/documents', {
      type: 'tech_pack', name: 'x', wikiScope: 'company', externalUrl: 'https://workdrive.zoho.com/x',
    })
    assert.equal(strayScope.status, 400)
  })

  test('adversarial: buyer sees company-wide + own wiki docs, never another buyer\'s', async () => {
    const admin = await makeAdmin()
    const buyerA = await makeBuyer()
    const buyerB = await makeBuyer()
    const api = as(admin)

    await api.post('/api/documents', { type: 'wiki_photos', name: 'Company Photo', wikiScope: 'company', externalUrl: 'https://workdrive.zoho.com/1' })
    await api.post('/api/documents', { type: 'wiki_photos', name: 'Buyer A Photo', wikiScope: 'buyer', buyerId: String(buyerA._id), externalUrl: 'https://workdrive.zoho.com/2' })
    await api.post('/api/documents', { type: 'wiki_photos', name: 'Buyer B Photo', wikiScope: 'buyer', buyerId: String(buyerB._id), externalUrl: 'https://workdrive.zoho.com/3' })

    const listRes = await as(buyerA).get('/api/documents')
    const names = listRes.body.map(d => d.name)
    assert.ok(names.includes('Company Photo'))
    assert.ok(names.includes('Buyer A Photo'))
    assert.ok(!names.includes('Buyer B Photo'))
  })

  test('adversarial: manufacturer sees a buyer-scoped wiki doc only while assigned to that buyer', async () => {
    const admin = await makeAdmin()
    const buyerA = await makeBuyer()
    const mfrAssigned = await makeMfr()
    const mfrUnrelated = await makeMfr()
    const api = as(admin)

    await api.post('/api/documents', { type: 'wiki_inspection_form', name: 'Buyer A Inspection', wikiScope: 'buyer', buyerId: String(buyerA._id), externalUrl: 'https://workdrive.zoho.com/4' })
    const orderRes = await api.post('/api/orders', orderPayload({ id: 'WIKI-TEST-DOC-001', buyerId: buyerA._id, mfrId: mfrAssigned._id }))
    assert.equal(orderRes.status, 201, JSON.stringify(orderRes.body))

    const assignedList = await as(mfrAssigned).get('/api/documents')
    assert.ok(assignedList.body.map(d => d.name).includes('Buyer A Inspection'))

    const unrelatedList = await as(mfrUnrelated).get('/api/documents')
    assert.ok(!unrelatedList.body.map(d => d.name).includes('Buyer A Inspection'))
  })

  test('GET /:id/data 404s for a wiki doc (link-only, nothing inline to fetch)', async () => {
    const admin = await makeAdmin()
    const api = as(admin)
    const created = await api.post('/api/documents', {
      type: 'wiki_photos', name: 'x', wikiScope: 'company', externalUrl: 'https://workdrive.zoho.com/5',
    })
    const dataRes = await api.get(`/api/documents/${created.body.id}/data`)
    assert.equal(dataRes.status, 404)
  })

  test('regression: a .pdf inline upload on an ordinary type still works unaffected', async () => {
    const admin = await makeAdmin()
    const tinyPdf = 'data:application/pdf;base64,JVBERi0xLjQKJeLjz9MK'
    const res = await as(admin).post('/api/documents', {
      type: 'tech_pack', name: 'Ordinary Tech Pack', dataUrl: tinyPdf, mimeType: 'application/pdf',
    })
    assert.equal(res.status, 201, JSON.stringify(res.body))
  })
})
