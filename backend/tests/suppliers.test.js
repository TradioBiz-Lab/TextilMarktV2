// A manufacturer's supplier book: its rules, and that nobody else can reach it.
import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as, req } from './helpers/client.js'
import { makeAdmin, makeMaster, makeBuyer, makeMfr, makeMember, link } from './helpers/factories.js'
import { Supplier } from '../src/models/Supplier.js'
import { SupplierItem } from '../src/models/SupplierItem.js'
import { gstinCheckChar } from '../src/lib/gst.js'

before(async () => { await startTestDb(); await startServer(); await Supplier.init(); await SupplierItem.init() })
after(async () => { delete process.env.PLATFORM_MODE; await stopServer(); await stopTestDb() })
beforeEach(async () => { await clearDb(); process.env.PLATFORM_MODE = 'standalone'; delete process.env.ENABLE_VIEW_AS })

const gstinFor = (state, pan = 'AAPFU0939F') => { const f = `${state}${pan}1Z`; return f + gstinCheckChar(f) }
const newSupplier = (u, body = {}) => as(u).post('/api/suppliers', { name: 'Coimbatore Knit Fabrics', type: 'fabric_supplier', email: 'sales@cknit.test', ...body })

describe('who can use the supplier book', () => {
  test('the Tradio portal does not have it at all', async () => {
    delete process.env.PLATFORM_MODE
    const mfr = await makeMfr()
    assert.equal((await as(mfr).get('/api/suppliers')).status, 404)
    assert.equal((await newSupplier(mfr)).status, 404)
  })

  test('a brand is refused, and so is Tradio staff', async () => {
    const brand = await makeBuyer(), admin = await makeAdmin(), master = await makeMaster()
    for (const u of [brand, admin, master]) {
      assert.equal((await as(u).get('/api/suppliers')).status, 403, u.role)
      assert.equal((await newSupplier(u)).status, 403, u.role)
    }
  })

  test('someone not signed in is refused', async () => {
    assert.equal((await req('GET', '/api/suppliers')).status, 401)
  })

  test('a manufacturer can, and so can everyone on its team', async () => {
    const mfr = await makeMfr(), mate = await makeMember(mfr)
    const made = await newSupplier(mfr)
    assert.equal(made.status, 201, JSON.stringify(made.body))
    const seen = await as(mate).get('/api/suppliers')
    assert.deepEqual(seen.body.map(s => s.name), ['Coimbatore Knit Fabrics'])
    assert.equal((await as(mate).post(`/api/suppliers/${made.body.id}`, { phone: '+91 98430 11223' })).status, 200)
  })
})

describe('adding and changing suppliers', () => {
  test('a supplier is stored cleaned, with the state taken from its GSTIN', async () => {
    const mfr = await makeMfr()
    const r = await newSupplier(mfr, { name: '  Salem Dyeing Works ', type: 'dyer', gstin: ` ${gstinFor('33').toLowerCase()} `, contacts: [{ name: 'Murugan', phone: '98430' }, { name: '', phone: '', email: '' }] })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.equal(r.body.name, 'Salem Dyeing Works')
    assert.equal(r.body.type, 'dyer')
    assert.equal(r.body.gstin, gstinFor('33'))
    assert.equal(r.body.stateCode, '33')
    assert.equal(r.body.stateName, 'Tamil Nadu')
    assert.equal(r.body.contacts.length, 1)          // the empty contact row is dropped
    assert.equal(r.body.visibility, 'private')
  })

  test('refuses what is not valid, and says why', async () => {
    const mfr = await makeMfr()
    const bad = async (body, re) => { const r = await newSupplier(mfr, body); assert.equal(r.status, 400, JSON.stringify(body)); assert.match(r.body.error, re) }
    await bad({ name: '' }, /Name is required/)
    await bad({ type: 'wizard' }, /type/)
    await bad({ email: 'nope' }, /email/)
    await bad({ gstin: '33AAPFU0939F1ZX' }, /GSTIN/)
    await bad({ pincode: '123' }, /PIN/)
    await bad({ stateCode: '98' }, /state/)
    await bad({ visibility: 'public' }, /private/)
    await bad({ contacts: Array.from({ length: 11 }, () => ({ name: 'x' })) }, /10 contacts/)
    await bad({ name: 'x'.repeat(201) }, /too long/)
  })

  test('two suppliers cannot share a name, however it is capitalised, but two companies can', async () => {
    const a = await makeMfr(), b = await makeMfr()
    assert.equal((await newSupplier(a)).status, 201)
    const dup = await newSupplier(a, { name: 'COIMBATORE KNIT fabrics' })
    assert.equal(dup.status, 409)
    assert.equal((await newSupplier(b)).status, 201)
  })

  test('an edit changes only what is sent', async () => {
    const mfr = await makeMfr()
    const s = (await newSupplier(mfr, { phone: '111', city: 'Coimbatore' })).body
    const r = await as(mfr).post(`/api/suppliers/${s.id}`, { phone: '222' })
    assert.equal(r.status, 200)
    assert.equal(r.body.phone, '222')
    assert.equal(r.body.city, 'Coimbatore')
    assert.equal((await as(mfr).post(`/api/suppliers/${s.id}`, {})).status, 400)
  })

  test('renaming onto an existing supplier is refused', async () => {
    const mfr = await makeMfr()
    await newSupplier(mfr, { name: 'Alpha' })
    const b = (await newSupplier(mfr, { name: 'Beta' })).body
    assert.equal((await as(mfr).post(`/api/suppliers/${b.id}`, { name: 'alpha' })).status, 409)
  })

  test('archiving hides a supplier from the list, restoring brings it back, nothing is deleted', async () => {
    const mfr = await makeMfr()
    const s = (await newSupplier(mfr)).body
    assert.equal((await as(mfr).post(`/api/suppliers/${s.id}/archive`)).body.isActive, false)
    assert.equal((await as(mfr).get('/api/suppliers')).body.length, 0)
    assert.equal((await as(mfr).get('/api/suppliers?all=1')).body.length, 1)
    assert.equal((await as(mfr).post(`/api/suppliers/${s.id}/restore`)).body.isActive, true)
    assert.equal((await as(mfr).get('/api/suppliers')).body.length, 1)
  })

  test('the list filters by type and counts the items each supplier sells', async () => {
    const mfr = await makeMfr()
    const mill = (await newSupplier(mfr, { name: 'Mill', type: 'fabric_supplier' })).body
    await newSupplier(mfr, { name: 'Dyer', type: 'dyer' })
    await as(mfr).post(`/api/suppliers/${mill.id}/items`, { name: 'Jersey', unit: 'kg' })
    await as(mfr).post(`/api/suppliers/${mill.id}/items`, { name: 'Rib', unit: 'kg' })
    const all = (await as(mfr).get('/api/suppliers')).body
    assert.deepEqual(all.map(s => [s.name, s.itemCount]), [['Dyer', 0], ['Mill', 2]])
    assert.deepEqual((await as(mfr).get('/api/suppliers?type=dyer')).body.map(s => s.name), ['Dyer'])
  })
})

describe('what a supplier sells', () => {
  test('an item is a structured record with the defaults a PO line starts from', async () => {
    const mfr = await makeMfr()
    const s = (await newSupplier(mfr)).body
    const r = await as(mfr).post(`/api/suppliers/${s.id}/items`, {
      category: 'fabric', name: 'Single jersey', unit: 'kg', defaultRate: '342.5', moq: 300, taxPct: 5, hsnCode: '6006 31',
      specs: { composition: '100% cotton', gsm: '180', widthInches: 72, construction: 'single jersey' },
    })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.deepEqual([r.body.defaultRate, r.body.moq, r.body.taxPct, r.body.hsnCode], [342.5, 300, 5, '600631'])
    assert.deepEqual([r.body.specs.composition, r.body.specs.gsm, r.body.specs.widthInches], ['100% cotton', 180, 72])
    const detail = (await as(mfr).get(`/api/suppliers/${s.id}`)).body
    assert.equal(detail.items.length, 1)
    assert.equal(detail.itemCount, 1)
  })

  test('refuses nonsense', async () => {
    const mfr = await makeMfr()
    const s = (await newSupplier(mfr)).body
    const bad = async (body, re) => { const r = await as(mfr).post(`/api/suppliers/${s.id}/items`, { name: 'Item', ...body }); assert.equal(r.status, 400); assert.match(r.body.error, re) }
    await bad({ name: '' }, /Item name/)
    await bad({ category: 'gold' }, /fabric, trim or other/)
    await bad({ defaultRate: -1 }, /Rate/)
    await bad({ taxPct: 41 }, /GST/)
    await bad({ hsnCode: '12' }, /HSN/)
    await bad({ specs: { gsm: 99999 } }, /GSM/)
  })

  test('changing the width does not wipe the composition', async () => {
    const mfr = await makeMfr()
    const s = (await newSupplier(mfr)).body
    const item = (await as(mfr).post(`/api/suppliers/${s.id}/items`, { name: 'Twill', specs: { composition: 'Cotton', widthInches: 58 } })).body
    const r = await as(mfr).post(`/api/suppliers/${s.id}/items/${item.id}`, { specs: { widthInches: 60 } })
    assert.equal(r.status, 200)
    assert.deepEqual([r.body.specs.composition, r.body.specs.widthInches], ['Cotton', 60])
  })

  test('an item can be archived and restored', async () => {
    const mfr = await makeMfr()
    const s = (await newSupplier(mfr)).body
    const item = (await as(mfr).post(`/api/suppliers/${s.id}/items`, { name: 'Zip' })).body
    assert.equal((await as(mfr).post(`/api/suppliers/${s.id}/items/${item.id}/archive`)).body.isActive, false)
    assert.equal((await as(mfr).get(`/api/suppliers/${s.id}`)).body.itemCount, 0)
    assert.equal((await as(mfr).post(`/api/suppliers/${s.id}/items/${item.id}/restore`)).body.isActive, true)
  })
})

describe('importing from a spreadsheet', () => {
  test('imports the good rows and reports each bad one by row', async () => {
    const mfr = await makeMfr()
    const r = await as(mfr).post('/api/suppliers/bulk', { suppliers: [
      { name: 'Alpha Mills', type: 'fabric_supplier', email: 'a@x.test' },
      { name: '', email: 'b@x.test' },
      { name: 'Gamma Dyers', type: 'dyer', email: 'not-an-email' },
      { name: 'alpha mills' },                       // same as row 1
      { name: 'Delta Trims', type: 'trims_supplier' },
    ] })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.created, 2)
    assert.deepEqual(r.body.skipped.map(s => s.row), [2, 3, 4])
    assert.match(r.body.skipped[2].error, /already have/)
    assert.deepEqual((await as(mfr).get('/api/suppliers')).body.map(s => s.name), ['Alpha Mills', 'Delta Trims'])
  })

  test('has a limit and wants something to import', async () => {
    const mfr = await makeMfr()
    assert.equal((await as(mfr).post('/api/suppliers/bulk', { suppliers: [] })).status, 400)
    assert.equal((await as(mfr).post('/api/suppliers/bulk', { suppliers: Array.from({ length: 501 }, (_, i) => ({ name: `S${i}` })) })).status, 400)
  })

  test('items import the same way, into one supplier', async () => {
    const mfr = await makeMfr()
    const s = (await newSupplier(mfr)).body
    const r = await as(mfr).post(`/api/suppliers/${s.id}/items/bulk`, { items: [{ name: 'Jersey', unit: 'kg' }, { name: '' }, { name: 'Rib', unit: 'kg', moq: -5 }, { name: 'Fleece', unit: 'kg' }] })
    assert.equal(r.body.created, 2)
    assert.deepEqual(r.body.skipped.map(x => x.row), [2, 3])
    assert.equal((await SupplierItem.countDocuments({ supplierId: s.id })), 2)
  })
})

describe('nobody else can reach a company\'s suppliers', () => {
  test('another factory gets a plain "not found" for every route, never a hint that it exists', async () => {
    const a = await makeMfr(), b = await makeMfr()
    const s = (await newSupplier(a)).body
    const item = (await as(a).post(`/api/suppliers/${s.id}/items`, { name: 'Jersey' })).body
    assert.deepEqual((await as(b).get('/api/suppliers')).body, [])
    for (const [method, path, body] of [
      ['get', `/api/suppliers/${s.id}`], ['post', `/api/suppliers/${s.id}`, { phone: '1' }],
      ['post', `/api/suppliers/${s.id}/archive`], ['post', `/api/suppliers/${s.id}/items`, { name: 'x' }],
      ['post', `/api/suppliers/${s.id}/items/${item.id}`, { moq: 1 }], ['post', `/api/suppliers/${s.id}/items/${item.id}/archive`],
      ['post', `/api/suppliers/${s.id}/items/bulk`, { items: [{ name: 'x' }] }],
    ]) {
      const r = await as(b)[method](path, body)
      assert.equal(r.status, 404, `${method} ${path}`)
    }
    // ...and none of that changed anything.
    const still = await Supplier.findById(s.id).lean()
    assert.equal(still.isActive, true)
    assert.equal(still.phone, '')
    assert.equal(await SupplierItem.countDocuments({ supplierId: s.id }), 1)
  })

  test('a brand the factory makes for still cannot see its suppliers', async () => {
    const mfr = await makeMfr(), brand = await makeBuyer()
    await link(brand, mfr)
    await newSupplier(mfr)
    assert.equal((await as(brand).get('/api/suppliers')).status, 403)
  })

  test('a malformed id is just not found', async () => {
    const mfr = await makeMfr()
    assert.equal((await as(mfr).get('/api/suppliers/not-an-id')).status, 404)
    assert.equal((await as(mfr).get('/api/suppliers/$ne')).status, 404)
  })
})
