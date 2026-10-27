// The Partner Directory (routes/manufacturers.js) is strategically sensitive sourcing data: admins only, on every
// endpoint, enforced by the server. These tests pin that wall, then the CRUD, search, filters, audit trail, image
// handling and bulk import behind it.

import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as, req } from './helpers/client.js'
import { makeAdmin, makeMaster, makeBuyer, makeMfr } from './helpers/factories.js'
import { Manufacturer } from '../src/models/Manufacturer.js'
import { AuditLog } from '../src/models/AuditLog.js'
import { Notification } from '../src/models/Notification.js'

before(async () => { await startTestDb(); await startServer(); await Manufacturer.init() })
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(clearDb)

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

const P = (o = {}) => ({ name: 'Dossil Fashions', type: 'garment_manufacturer', ...o })
const seed = async (admin, rows) => {
  const api = as(admin)
  const out = []
  for (const r of rows) {
    const res = await api.post('/api/manufacturers', P(r))
    assert.equal(res.status, 201, JSON.stringify(res.body))
    out.push(res.body)
  }
  return out
}
const names = body => body.items.map(p => p.name)

describe('the directory is admin only, on every endpoint', () => {
  // [method, path, body]; :id is filled with a real partner so a 403 cannot be mistaken for a 404.
  const endpoints = id => [
    ['GET', '/api/manufacturers'],
    ['GET', '/api/manufacturers/facets'],
    ['GET', `/api/manufacturers/${id}`],
    ['GET', `/api/manufacturers/${id}/image`],
    ['GET', `/api/manufacturers/thumbs?ids=${id}`],
    ['POST', '/api/manufacturers', P({ name: 'Intruder' })],
    ['POST', `/api/manufacturers/${id}`, { status: 'rejected' }],
    ['POST', `/api/manufacturers/${id}/delete`, {}],
    ['POST', `/api/manufacturers/${id}/image`, { image: PNG }],
    ['POST', '/api/manufacturers/import', { rows: [P({ name: 'Intruder Two' })] }],
    ['POST', '/api/manufacturers/csv/preview', { csv: 'name\nX' }],
  ]

  test('buyers and manufacturers get 403 and nothing changes; signed-out gets 401', async () => {
    const admin = await makeAdmin()
    const [partner] = await seed(admin, [{ name: 'Secret Mills' }])
    for (const who of [await makeBuyer(), await makeMfr({ listed: false })]) {
      const api = as(who)
      for (const [method, path, body] of endpoints(partner.id)) {
        const res = await req(method, path, { token: api.token, body })
        assert.equal(res.status, 403, `${who.role} ${method} ${path} -> ${res.status}`)
      }
    }
    for (const [method, path, body] of endpoints(partner.id)) {
      const res = await req(method, path, { body })
      assert.equal(res.status, 401, `anonymous ${method} ${path} -> ${res.status}`)
    }
    const all = await Manufacturer.find().lean()
    assert.deepEqual(all.map(p => p.name), ['Secret Mills'])
    assert.equal(all[0].status, 'new')
    assert.equal(all[0].imageUploadedAt, null)
  })

  test('both kinds of admin can use it', async () => {
    for (const admin of [await makeAdmin(), await makeMaster()]) {
      const res = await as(admin).get('/api/manufacturers')
      assert.equal(res.status, 200)
    }
  })

  test('nothing about partners reaches a buyer or manufacturer through notifications or the audit log', async () => {
    const admin = await makeAdmin()
    const buyer = await makeBuyer()
    const mfr = await makeMfr({ listed: false })
    const [partner] = await seed(admin, [{ name: 'Quiet Knits' }])
    await as(admin).post(`/api/manufacturers/${partner.id}`, { status: 'contacted' })
    assert.equal(await Notification.countDocuments(), 0)
    assert.equal((await as(buyer).get('/api/audit')).status, 403)
    assert.equal((await as(mfr).get('/api/audit')).status, 403)
  })
})

describe('adding, reading, editing and deleting a partner', () => {
  test('name and type are required, everything else is optional', async () => {
    const admin = await makeAdmin()
    const api = as(admin)
    assert.equal((await api.post('/api/manufacturers', { type: 'trader' })).status, 400)
    assert.equal((await api.post('/api/manufacturers', { name: 'No Type' })).status, 400)
    const res = await api.post('/api/manufacturers', { name: '  Bare   Minimum  ', type: 'fabric_supplier' })
    assert.equal(res.status, 201, JSON.stringify(res.body))
    assert.equal(res.body.name, 'Bare Minimum')
    assert.equal(res.body.status, 'new')
    assert.equal(res.body.priority, 'C')
    assert.equal(res.body.isActive, true)
    assert.equal(res.body.verification.score, null)
    assert.equal(res.body.onPlatform, false)
    assert.equal(String(res.body.createdBy), String(admin._id))
  })

  test('bad values are refused with a reason', async () => {
    const api = as(await makeAdmin())
    const bad = async body => (await api.post('/api/manufacturers', P(body))).status
    assert.equal(await bad({ type: 'wizard' }), 400)
    assert.equal(await bad({ cluster: 'mars' }), 400)
    assert.equal(await bad({ status: 'maybe' }), 400)
    assert.equal(await bad({ priority: 'Z' }), 400)
    assert.equal(await bad({ gstin: '123' }), 400)
    assert.equal(await bad({ website: 'javascript:alert(1)' }), 400)
    assert.equal(await bad({ imageUrl: 'data:image/png;base64,AAAA' }), 400)
    assert.equal(await bad({ moqPerStyleColour: -5 }), 400)
    assert.equal(await bad({ contacts: [{ name: 'A', email: 'not-an-email' }] }), 400)
    assert.equal(await bad({ verification: { score: 101 } }), 400)
    assert.equal(await bad({ products: 'leggings' }), 201) // a bare string is read as a list of one
  })

  test('tags are stored normalised, contacts keep their order, unknown fields are dropped', async () => {
    const api = as(await makeAdmin())
    const res = await api.post('/api/manufacturers', P({
      name: 'Tag Test', products: ['Sports Bra', 'sports-bra', 'Leggings'], fabrics: ['Poly Spandex'], keywords: ['Low MOQ', 'Ludhiana'],
      gstin: '03aabcd1234e1z5', website: 'dossilfashions.com',
      contacts: [{ name: 'Vipan', phone: '+91 161 2612693' }, { name: '', phone: '', email: '' }],
      machines: { flatlock: 12, overlock: '4' },
      linkedUserId: '507f1f77bcf86cd799439011', createdBy: '507f1f77bcf86cd799439011', imageData: 'x', isAdmin: true,
    }))
    assert.equal(res.status, 201, JSON.stringify(res.body))
    assert.deepEqual(res.body.products, ['sports_bra', 'leggings'])
    assert.deepEqual(res.body.fabrics, ['poly_spandex'])
    assert.deepEqual(res.body.keywords, ['low moq', 'ludhiana'])
    assert.equal(res.body.gstin, '03AABCD1234E1Z5')
    assert.equal(res.body.website, 'https://dossilfashions.com')
    assert.equal(res.body.contacts.length, 1)
    assert.equal(res.body.contacts[0].name, 'Vipan')
    assert.deepEqual(res.body.machines, { flatlock: 12, coverstitch: 0, overlock: 4, singleNeedle: 0 })
    // never taken from a body
    assert.equal(res.body.linkedUserId, null)
    assert.notEqual(res.body.createdBy, '507f1f77bcf86cd799439011')
    assert.equal(res.body.isAdmin, undefined)
  })

  test('a name is unique whatever its capitalisation or spacing', async () => {
    const api = as(await makeAdmin())
    await api.post('/api/manufacturers', P({ name: 'Ganesh Fabrics' }))
    const dup = await api.post('/api/manufacturers', P({ name: '  ganesh   FABRICS ' }))
    assert.equal(dup.status, 409)
    const other = await api.post('/api/manufacturers', P({ name: 'Ganesh Fabrics Two' }))
    assert.equal(other.status, 201)
    // renaming onto an existing name is refused too
    const clash = await api.post(`/api/manufacturers/${other.body.id}`, { name: 'GANESH FABRICS' })
    assert.equal(clash.status, 409)
  })

  test('edit sends only what changed, and a no-op edit writes nothing', async () => {
    const admin = await makeAdmin()
    const api = as(admin)
    const [p] = await seed(admin, [{ name: 'Edit Me', city: 'Ludhiana', notes: 'first' }])
    const res = await api.post(`/api/manufacturers/${p.id}`, { notes: 'second', cluster: 'ludhiana' })
    assert.equal(res.status, 200)
    assert.equal(res.body.notes, 'second')
    assert.equal(res.body.city, 'Ludhiana')
    assert.equal(res.body.cluster, 'ludhiana')
    const entries = await AuditLog.countDocuments({ action: 'Partner Updated' })
    assert.equal(entries, 1)
    await api.post(`/api/manufacturers/${p.id}`, { notes: 'second' })
    assert.equal(await AuditLog.countDocuments({ action: 'Partner Updated' }), 1)
    // clearing a field
    const cleared = await api.post(`/api/manufacturers/${p.id}`, { cluster: null, notes: '' })
    assert.equal(cleared.body.cluster, null)
    assert.equal(cleared.body.notes, '')
    assert.equal((await api.post(`/api/manufacturers/${p.id}`, { name: '' })).status, 400)
  })

  test('status, priority and verification changes are audited; verification stamps the check date', async () => {
    const admin = await makeAdmin({ name: 'Asha Admin' })
    const api = as(admin)
    const [p] = await seed(admin, [{ name: 'Audit Me' }])
    const res = await api.post(`/api/manufacturers/${p.id}`, { status: 'qualified', priority: 'A', verification: { gstVerified: true, score: 72 } })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.verification.gstVerified, true)
    assert.equal(res.body.verification.score, 72)
    assert.ok(res.body.verification.lastCheckedAt, 'the server stamps the check date')
    const upd = await AuditLog.findOne({ action: 'Partner Updated' }).lean()
    assert.match(upd.detail, /status new -> qualified/)
    assert.match(upd.detail, /priority C -> A/)
    const ver = await AuditLog.findOne({ action: 'Partner Verification Updated' }).lean()
    assert.match(ver.detail, /gstVerified false -> true/)
    assert.match(ver.detail, /score empty -> 72/)
    assert.equal(String(ver.byUser), String(admin._id))
    // a client cannot set the check date or send a non-boolean flag
    const forged = await api.post(`/api/manufacturers/${p.id}`, { verification: { lastCheckedAt: '2020-01-01', siteVisited: 'yes' } })
    assert.equal(forged.status, 400)
  })

  test('delete removes the partner and is audited; unknown ids are 404', async () => {
    const admin = await makeAdmin()
    const api = as(admin)
    const [p] = await seed(admin, [{ name: 'Short Lived', city: 'Noida' }])
    assert.equal((await api.post(`/api/manufacturers/${p.id}/delete`, {})).status, 200)
    assert.equal(await Manufacturer.countDocuments(), 0)
    assert.match((await AuditLog.findOne({ action: 'Partner Deleted' }).lean()).detail, /Short Lived/)
    assert.equal((await api.get(`/api/manufacturers/${p.id}`)).status, 404)
    assert.equal((await api.get('/api/manufacturers/not-an-id')).status, 404)
    assert.equal((await api.post('/api/manufacturers/507f1f77bcf86cd799439011/delete', {})).status, 404)
  })

  test('creating is audited', async () => {
    const admin = await makeAdmin()
    await seed(admin, [{ name: 'Logged', city: 'Tiruppur' }])
    const entry = await AuditLog.findOne({ action: 'Partner Created' }).lean()
    assert.match(entry.detail, /Logged/)
    assert.match(entry.detail, /Tiruppur/)
  })
})

describe('search and filters', () => {
  const rows = [
    { name: 'Dossil Fashions', cluster: 'ludhiana', city: 'Ludhiana', products: ['tee', 'jogger'], fabrics: ['cotton_lycra'], priority: 'A', keywords: ['knitwear', 'low moq'], verification: { score: 80, gstVerified: true } },
    { name: 'Sukartik Clothing', cluster: 'ludhiana', city: 'Ludhiana', products: ['sports_bra', 'leggings'], fabrics: ['poly_spandex'], priority: 'B', verification: { score: 55 }, status: 'contacted' },
    { name: 'ARNIT Creations', cluster: 'ncr', city: 'Noida', products: ['leggings'], fabrics: ['poly_spandex'], priority: 'A', verification: { score: 30, sampleApproved: true } },
    { name: 'Weave Works', type: 'fabric_supplier', cluster: 'tiruppur', city: 'Tiruppur', fabricTypes: ['single_jersey', 'rib'], priority: 'C' },
    { name: 'Button Bazaar', type: 'trims_supplier', cluster: 'ncr', city: 'Delhi', trimCategories: ['buttons', 'zips'], priority: 'D' },
    { name: 'Hidden Agent', type: 'unknown', isActive: false, city: 'Jaipur' },
  ]
  const setup = async () => { const admin = await makeAdmin(); await seed(admin, rows); return as(admin) }
  const q = async (api, qs) => { const r = await api.get(`/api/manufacturers?${qs}`); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body }

  test('inactive partners are hidden unless asked for', async () => {
    const api = await setup()
    assert.equal((await q(api, '')).total, 5)
    assert.equal((await q(api, 'includeInactive=1')).total, 6)
  })

  test('type, cluster, status, priority and product filters', async () => {
    const api = await setup()
    assert.deepEqual(names(await q(api, 'type=fabric_supplier')), ['Weave Works'])
    assert.deepEqual(names(await q(api, 'type=dyer_processor,trader,buying_house,unknown')), [])
    assert.deepEqual((await q(api, 'cluster=ludhiana&sort=name')).items.map(p => p.name), ['Dossil Fashions', 'Sukartik Clothing'])
    assert.deepEqual(names(await q(api, 'status=contacted')), ['Sukartik Clothing'])
    assert.deepEqual((await q(api, 'priority=A&sort=name')).items.map(p => p.name), ['ARNIT Creations', 'Dossil Fashions'])
    assert.deepEqual((await q(api, 'product=leggings&sort=name')).items.map(p => p.name), ['ARNIT Creations', 'Sukartik Clothing'])
    assert.deepEqual((await q(api, 'product=Sports Bra')).items.map(p => p.name), ['Sukartik Clothing'])
    assert.deepEqual((await q(api, 'fabric=poly_spandex&sort=name')).items.map(p => p.name), ['ARNIT Creations', 'Sukartik Clothing'])
    assert.deepEqual(names(await q(api, 'fabric=rib')), ['Weave Works'])
  })

  test('score range, verified only and on platform', async () => {
    const api = await setup()
    assert.deepEqual(names(await q(api, 'minScore=70')), ['Dossil Fashions'])
    assert.deepEqual(names(await q(api, 'minScore=50&maxScore=69')), ['Sukartik Clothing'])
    assert.deepEqual((await q(api, 'verifiedOnly=1&sort=name')).items.map(p => p.name), ['ARNIT Creations', 'Dossil Fashions'])
    assert.equal((await q(api, 'onPlatform=1')).total, 0)
    const ar = await Manufacturer.findOne({ name: 'ARNIT Creations' })
    const mfr = await makeMfr({ listed: false })
    await Manufacturer.updateOne({ _id: ar._id }, { linkedUserId: mfr._id })
    const linked = await q(api, 'onPlatform=1')
    assert.deepEqual(names(linked), ['ARNIT Creations'])
    assert.equal(linked.items[0].onPlatform, true)
  })

  test('sorting by score, priority and name', async () => {
    const api = await setup()
    assert.equal((await q(api, 'sort=score')).items[0].name, 'Dossil Fashions')
    assert.deepEqual((await q(api, 'sort=priority')).items.slice(0, 2).map(p => p.priority), ['A', 'A'])
    assert.equal((await q(api, 'sort=name')).items[0].name, 'ARNIT Creations')
  })

  test('text search finds whole words, with stemming, across name, city, products and keywords', async () => {
    const api = await setup()
    const byCity = await q(api, 'search=Ludhiana')
    assert.equal(byCity.mode, 'text')
    assert.deepEqual(byCity.items.map(p => p.name).sort(), ['Dossil Fashions', 'Sukartik Clothing'])
    assert.deepEqual(names(await q(api, 'search=legging&sort=name')), ['ARNIT Creations', 'Sukartik Clothing'])
    assert.deepEqual(names(await q(api, 'search=knitwear')), ['Dossil Fashions'])
    assert.deepEqual(names(await q(api, 'search=zips')), ['Button Bazaar'])
  })

  test('partial words fall back to a regex over the same fields', async () => {
    const api = await setup()
    const partial = await q(api, 'search=ludh')
    assert.equal(partial.mode, 'regex')
    assert.deepEqual(partial.items.map(p => p.name).sort(), ['Dossil Fashions', 'Sukartik Clothing'])
    assert.deepEqual(names(await q(api, 'search=sports br')), ['Sukartik Clothing'])
    assert.deepEqual(names(await q(api, 'search=sukar')), ['Sukartik Clothing'])
    assert.deepEqual(names(await q(api, 'search=butt')), ['Button Bazaar'])
    assert.deepEqual(names(await q(api, 'search=nothingmatchesthis')), [])
  })

  test('a search combines with filters, and cannot be used to inject regex or text operators', async () => {
    const api = await setup()
    assert.deepEqual(names(await q(api, 'search=ludh&priority=A')), ['Dossil Fashions'])
    assert.deepEqual(names(await q(api, 'search=.*')), [])
    // a leading minus would negate a word in a raw text search; here it is just a word, so Dossil still matches
    assert.ok(names(await q(api, 'search=ludhiana -dossil')).includes('Dossil Fashions'))
    const res = await api.get('/api/manufacturers?cluster[$ne]=x')
    assert.equal(res.status, 400)
  })

  test('bad query values are 400, and paging works', async () => {
    const api = await setup()
    for (const bad of ['type=wizard', 'sort=hax', 'minScore=abc', 'minScore=101', 'limit=0', 'limit=9999', 'priority=Z', 'cluster=mars']) {
      assert.equal((await api.get(`/api/manufacturers?${bad}`)).status, 400, bad)
    }
    const first = await q(api, 'sort=name&limit=2')
    assert.equal(first.items.length, 2)
    assert.equal(first.total, 5)
    const next = await q(api, 'sort=name&limit=2&skip=2')
    assert.notEqual(next.items[0].name, first.items[0].name)
  })

  test('facets count what is in use', async () => {
    const api = await setup()
    const f = (await api.get('/api/manufacturers/facets')).body
    assert.equal(f.total, 5)
    assert.equal(f.inactive, 1)
    assert.equal(f.byType.garment_manufacturer, 3)
    assert.equal(f.byType.fabric_supplier, 1)
    assert.equal(f.byCluster.ludhiana, 2)
    assert.deepEqual(f.products.find(x => x.value === 'leggings'), { value: 'leggings', count: 2 })
    assert.ok(f.fabrics.some(x => x.value === 'rib'))
    assert.ok(f.keywords.some(x => x.value === 'low moq'))
  })
})

describe('images', () => {
  test('an upload is kept off list and detail responses and served by its own route', async () => {
    const admin = await makeAdmin()
    const api = as(admin)
    const [p] = await seed(admin, [{ name: 'Tile Me' }])
    const set = await api.post(`/api/manufacturers/${p.id}/image`, { image: PNG })
    assert.equal(set.status, 200, JSON.stringify(set.body))
    assert.equal(set.body.hasUpload, true)
    assert.equal(JSON.stringify(set.body).includes('base64'), false)
    const list = await api.get('/api/manufacturers')
    assert.equal(JSON.stringify(list.body).includes('base64'), false)
    assert.equal(list.body.items[0].hasUpload, true)
    const detail = await api.get(`/api/manufacturers/${p.id}`)
    assert.equal(JSON.stringify(detail.body).includes('base64'), false)
    assert.equal((await api.get(`/api/manufacturers/${p.id}/image`)).body.image, PNG)
    // a later edit does not lose it
    await api.post(`/api/manufacturers/${p.id}`, { notes: 'still has its tile' })
    assert.equal((await api.get(`/api/manufacturers/${p.id}/image`)).body.image, PNG)
    // removing it
    const gone = await api.post(`/api/manufacturers/${p.id}/image`, { image: null })
    assert.equal(gone.body.hasUpload, false)
    assert.equal((await api.get(`/api/manufacturers/${p.id}/image`)).body.image, null)
    assert.ok(await AuditLog.findOne({ action: 'Partner Image Updated' }))
  })

  test('only small JPEG, PNG or WebP pictures, or http links, are accepted', async () => {
    const admin = await makeAdmin()
    const api = as(admin)
    const [p] = await seed(admin, [{ name: 'Strict Tiles' }])
    const url = `/api/manufacturers/${p.id}/image`
    assert.equal((await api.post(url, { image: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' })).status, 400)
    assert.equal((await api.post(url, { image: 'data:text/html;base64,PGgxPmhpPC9oMT4=' })).status, 400)
    assert.equal((await api.post(url, { image: `data:image/png;base64,${'A'.repeat(900 * 1024)}` })).status, 400)
    assert.equal((await api.post(url, { image: 'javascript:alert(1)' })).status, 400)
    assert.equal((await api.post(url, { image: 12 })).status, 400)
    const link = await api.post(url, { image: 'https://example.com/tile.png' })
    assert.equal(link.status, 200)
    assert.equal(link.body.imageUrl, 'https://example.com/tile.png')
    assert.equal((await api.get(url)).body.image, 'https://example.com/tile.png')
  })
})

describe('bulk import', () => {
  test('creates the new rows and skips names already in the directory, whatever their capitalisation', async () => {
    const admin = await makeAdmin()
    const api = as(admin)
    await seed(admin, [{ name: 'Indra Hosiery Mills' }])
    const res = await api.post('/api/manufacturers/import', {
      rows: [
        P({ name: 'indra   hosiery MILLS' }),
        P({ name: 'Fresh One', city: 'Noida' }),
        P({ name: 'Fresh Two', type: 'trader' }),
        P({ name: 'FRESH one' }),
      ],
    })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.total, 4)
    assert.equal(res.body.created, 2)
    assert.deepEqual(res.body.skipped.map(s => [s.row, s.reason]), [[1, 'duplicate_existing'], [4, 'duplicate_in_file']])
    assert.equal(res.body.skipped[1].firstRow, 2)
    assert.deepEqual(res.body.errors, [])
    assert.equal(await Manufacturer.countDocuments(), 3)
    // importing the same file again changes nothing
    const again = await api.post('/api/manufacturers/import', { rows: [P({ name: 'Fresh One' }), P({ name: 'Fresh Two' })] })
    assert.equal(again.body.created, 0)
    assert.equal(again.body.skipped.length, 2)
    assert.equal(await Manufacturer.countDocuments(), 3)
    assert.match((await AuditLog.findOne({ action: 'Partners Imported' }).lean()).detail, /2 partners created/)
  })

  test('a bad row is reported with its row number and the rest still import', async () => {
    const admin = await makeAdmin()
    const api = as(admin)
    const res = await api.post('/api/manufacturers/import', {
      rows: [P({ name: 'Good One' }), { type: 'trader' }, P({ name: 'Bad Type', type: 'wizard' }), P({ name: 'Bad Mail', contacts: [{ email: 'nope' }] }), 'not an object', P({ name: 'Good Two' })],
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.created, 2)
    assert.deepEqual(res.body.errors.map(e => e.row), [2, 3, 4, 5])
    assert.match(res.body.errors[0].errors[0], /Name is required/)
    assert.match(res.body.errors[1].errors[0], /Invalid type/)
    assert.equal(res.body.errors[1].name, 'Bad Type')
  })

  test('a dry run reports exactly what would happen and writes nothing', async () => {
    const admin = await makeAdmin()
    const api = as(admin)
    await seed(admin, [{ name: 'Already There' }])
    const rows = [P({ name: 'Already There' }), P({ name: 'Brand New' }), P({ name: 'Brand New' })]
    const dry = await api.post('/api/manufacturers/import', { rows, dryRun: true })
    assert.equal(dry.body.dryRun, true)
    assert.equal(dry.body.created, 0)
    assert.equal(dry.body.wouldCreate, 1)
    assert.equal(dry.body.skipped.length, 2)
    assert.equal(await Manufacturer.countDocuments(), 1)
    assert.equal(await AuditLog.countDocuments({ action: 'Partners Imported' }), 0)
    const real = await api.post('/api/manufacturers/import', { rows })
    assert.equal(real.body.created, 1)
  })

  test('the type column can be missing: rows take the default type', async () => {
    const api = as(await makeAdmin())
    const res = await api.post('/api/manufacturers/import', { rows: [{ name: 'Typeless' }, { name: 'Typed Trims', type: 'trims_supplier' }], defaultType: 'trader' })
    assert.equal(res.body.created, 2)
    assert.equal((await Manufacturer.findOne({ name: 'Typeless' }).lean()).type, 'trader')
    assert.equal((await Manufacturer.findOne({ name: 'Typed Trims' }).lean()).type, 'trims_supplier')
    assert.equal((await api.post('/api/manufacturers/import', { rows: [{ name: 'X' }], defaultType: 'wizard' })).status, 400)
  })

  test('refuses an empty list, too many rows and a malformed mapping', async () => {
    const api = as(await makeAdmin())
    assert.equal((await api.post('/api/manufacturers/import', { rows: [] })).status, 400)
    assert.equal((await api.post('/api/manufacturers/import', {})).status, 400)
    assert.equal((await api.post('/api/manufacturers/import', { rows: Array.from({ length: 1001 }, (_, i) => P({ name: `Row ${i}` })) })).status, 400)
    assert.equal((await api.post('/api/manufacturers/import', { rows: [{ A: 'x' }], mapping: { A: 'shoeSize' } })).status, 400)
    assert.equal((await api.post('/api/manufacturers/import', { rows: [{ A: 'x' }], mapping: { A: 'city' } })).status, 400)
  })
})

describe('CSV upload', () => {
  const CSV = [
    'Company,Type,City,Cluster,Products / capability,MOQ claim (self-reported),Contact,Phone,Email,Website,Priority,Status',
    '16th July Exports,Manufacturer (claimed),New Delhi,Delhi-NCR,"leggings, sports bras, joggers",100 pcs/style,Anil;Rita,+91 98680 88882 (WhatsApp); 011 2345,anil@x.in;rita@x.in,16thjulyexports.com,A,New',
    'Bee Kay Brothers,Trading company (NOT a factory),Ludhiana,Ludhiana,Sports bras (trader),200 pcs,,,,,C,New',
    'Neva Garments Ltd,Manufacturer,Ludhiana,Ludhiana,Knitwear,Not listed,,,,,B,Excluded for now',
    ',Manufacturer,Nowhere,,,,,,,,,',
    'bee kay brothers,Manufacturer,Ludhiana,,,,,,,,,',
  ].join('\n')

  test('the preview reads the file, shows five rows and suggests a mapping', async () => {
    const api = as(await makeAdmin())
    const res = await api.post('/api/manufacturers/csv/preview', { csv: CSV })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.rowCount, 5)
    assert.equal(res.body.preview.length, 5)
    assert.equal(res.body.rows.length, 5)
    const m = res.body.suggestedMapping
    assert.equal(m['Company'], 'name')
    assert.equal(m['Type'], 'type')
    assert.equal(m['City'], 'city')
    assert.equal(m['Cluster'], 'cluster')
    assert.equal(m['Products / capability'], 'products')
    assert.equal(m['MOQ claim (self-reported)'], 'moqPerStyleColour')
    assert.equal(m['Contact'], 'contactName')
    assert.equal(m['Phone'], 'contactPhone')
    assert.equal(m['Email'], 'contactEmail')
    assert.equal(m['Website'], 'website')
    assert.equal(m['Priority'], 'priority')
    assert.equal(m['Status'], 'status')
    assert.ok(res.body.fields.some(f => f.key === 'name'))
  })

  test('an empty or header-only file is refused', async () => {
    const api = as(await makeAdmin())
    assert.equal((await api.post('/api/manufacturers/csv/preview', { csv: '' })).status, 400)
    assert.equal((await api.post('/api/manufacturers/csv/preview', { csv: 'Company,City\n' })).status, 400)
    assert.equal((await api.post('/api/manufacturers/csv/preview', {})).status, 400)
    assert.equal((await api.post('/api/manufacturers/csv/preview', { csv: 'a'.repeat(2_100_000) })).status, 400)
  })

  test('importing with the mapping builds partners, reports errors per row and de-duplicates within the file', async () => {
    const admin = await makeAdmin()
    const api = as(admin)
    const preview = (await api.post('/api/manufacturers/csv/preview', { csv: CSV })).body
    const dry = await api.post('/api/manufacturers/import', { rows: preview.rows, mapping: preview.suggestedMapping, dryRun: true })
    assert.equal(dry.body.wouldCreate, 3)
    assert.equal(await Manufacturer.countDocuments(), 0)
    const res = await api.post('/api/manufacturers/import', { rows: preview.rows, mapping: preview.suggestedMapping })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.created, 3)
    // line numbers are the file's: header is line 1
    assert.deepEqual(res.body.errors.map(e => e.row), [5])
    assert.match(res.body.errors[0].errors[0], /Name is required/)
    assert.deepEqual(res.body.skipped.map(s => [s.row, s.reason, s.firstRow]), [[6, 'duplicate_in_file', 3]])

    const first = await Manufacturer.findOne({ name: '16th July Exports' }).lean()
    assert.equal(first.type, 'garment_manufacturer')
    assert.equal(first.cluster, 'ncr')
    // a products column feeds keywords (specialised products are keywords), not the products field
    assert.deepEqual(first.keywords, ['leggings', 'sports bras', 'joggers'])
    assert.deepEqual(first.products, [])
    assert.equal(first.moqPerStyleColour, 100)
    assert.equal(first.moqNote, '100 pcs/style')
    assert.equal(first.website, 'https://16thjulyexports.com')
    assert.equal(first.priority, 'A')
    assert.equal(first.contacts.length, 2)
    assert.deepEqual(first.contacts[0], { name: 'Anil', role: '', phone: '+91 98680 88882', email: 'anil@x.in', whatsapp: '+91 98680 88882' })
    assert.deepEqual(first.contacts[1], { name: 'Rita', role: '', phone: '011 2345', email: 'rita@x.in', whatsapp: '' })
    const trader = await Manufacturer.findOne({ name: 'Bee Kay Brothers' }).lean()
    assert.equal(trader.type, 'trader')
    const excluded = await Manufacturer.findOne({ name: 'Neva Garments Ltd' }).lean()
    assert.equal(excluded.status, 'rejected')
    assert.equal(excluded.moqPerStyleColour, null)
    assert.equal(excluded.moqNote, 'Not listed')
    // the second run changes nothing
    const again = await api.post('/api/manufacturers/import', { rows: preview.rows, mapping: preview.suggestedMapping })
    assert.equal(again.body.created, 0)
  })
})

describe('categories (athleisure, indian, western, fusion, home textiles)', () => {
  const rows = [
    { name: 'Active Only', categories: ['athleisure'] },
    { name: 'Active And Fusion', categories: ['athleisure', 'fusion'] },
    { name: 'Ethnic House', categories: ['indian', 'fusion'] },
    { name: 'Denim Works', categories: ['western'] },
    { name: 'Linen Mill', type: 'fabric_supplier', categories: ['home_textiles'] },
    { name: 'Uncategorised' },
  ]
  const setup = async () => { const admin = await makeAdmin(); await seed(admin, rows); return as(admin) }

  test('a partner can be in several categories; they are stored once each, in the allowed set', async () => {
    const api = as(await makeAdmin())
    const res = await api.post('/api/manufacturers', P({ name: 'Multi', categories: ['Athleisure', 'activewear', 'Indo-western', 'Home Textiles'] }))
    assert.equal(res.status, 201, JSON.stringify(res.body))
    assert.deepEqual(res.body.categories, ['athleisure', 'fusion', 'home_textiles'])
    assert.deepEqual((await api.post('/api/manufacturers', P({ name: 'None' }))).body.categories, [])
    assert.equal((await api.post('/api/manufacturers', P({ name: 'Bad', categories: ['athleisure', 'streetwear'] }))).status, 400)
    assert.equal((await api.post('/api/manufacturers', P({ name: 'Bad Two', categories: [5] }))).status, 400)
  })

  test('editing sets, adds to and clears categories, and is audited', async () => {
    const admin = await makeAdmin()
    const api = as(admin)
    const [p] = await seed(admin, [{ name: 'Edit Cats' }])
    assert.deepEqual((await api.post(`/api/manufacturers/${p.id}`, { categories: ['western', 'indian'] })).body.categories, ['western', 'indian'])
    assert.match((await AuditLog.findOne({ action: 'Partner Updated' }).lean()).detail, /categories/)
    assert.deepEqual((await api.post(`/api/manufacturers/${p.id}`, { categories: ['western', 'indian', 'fusion'] })).body.categories, ['western', 'indian', 'fusion'])
    assert.deepEqual((await api.post(`/api/manufacturers/${p.id}`, { categories: [] })).body.categories, [])
  })

  test('the category filter matches a partner that has any of the chosen categories', async () => {
    const api = await setup()
    const q = async qs => (await api.get(`/api/manufacturers?${qs}&sort=name`)).body.items.map(p => p.name)
    assert.deepEqual(await q('category=athleisure'), ['Active And Fusion', 'Active Only'])
    assert.deepEqual(await q('category=fusion'), ['Active And Fusion', 'Ethnic House'])
    assert.deepEqual(await q('category=athleisure,indian'), ['Active And Fusion', 'Active Only', 'Ethnic House'])
    assert.deepEqual(await q('category=home_textiles'), ['Linen Mill'])
    assert.deepEqual(await q('category=activewear'), ['Active And Fusion', 'Active Only'])
    assert.deepEqual(await q('category=fusion&type=fabric_supplier'), [])
    assert.equal((await api.get('/api/manufacturers?category=streetwear')).status, 400)
  })

  test('facets count each category', async () => {
    const api = await setup()
    const f = (await api.get('/api/manufacturers/facets')).body
    assert.deepEqual(f.byCategory, { athleisure: 2, fusion: 2, indian: 1, western: 1, home_textiles: 1 })
  })

  test('CSV and bulk import read category words, and report ones they cannot', async () => {
    const api = as(await makeAdmin())
    const csv = 'Company,Type,Segments\nA Co,Manufacturer,"Activewear; Indo-western"\nB Co,Manufacturer,Streetwear\nC Co,Fabric,Home textiles'
    const pre = (await api.post('/api/manufacturers/csv/preview', { csv })).body
    assert.equal(pre.suggestedMapping.Segments, 'categories')
    const res = (await api.post('/api/manufacturers/import', { rows: pre.rows, mapping: pre.suggestedMapping })).body
    assert.equal(res.created, 2)
    assert.deepEqual(res.errors.map(e => e.row), [3])
    assert.match(res.errors[0].errors[0], /Unknown category/)
    assert.deepEqual((await Manufacturer.findOne({ name: 'A Co' }).lean()).categories, ['athleisure', 'fusion'])
    assert.deepEqual((await Manufacturer.findOne({ name: 'C Co' }).lean()).categories, ['home_textiles'])
  })
})

describe('clusters: Ludhiana, NCR, Jaipur, Kolkata, Tiruppur', () => {
  test('Jaipur and Kolkata are clusters; the old Noida and Delhi values mean NCR', async () => {
    const api = as(await makeAdmin())
    const mk = async (name, cluster) => api.post('/api/manufacturers', P({ name, cluster }))
    assert.equal((await mk('J One', 'jaipur')).body.cluster, 'jaipur')
    assert.equal((await mk('K One', 'kolkata')).body.cluster, 'kolkata')
    assert.equal((await mk('N One', 'ncr')).body.cluster, 'ncr')
    // an older client still sending the two old values gets NCR
    assert.equal((await mk('N Two', 'noida_ncr')).body.cluster, 'ncr')
    assert.equal((await mk('N Three', 'delhi_ncr')).body.cluster, 'ncr')
    assert.equal((await mk('Bad', 'pune')).status, 400)
    const q = async qs => (await api.get(`/api/manufacturers?${qs}&sort=name`)).body.items.map(p => p.name)
    assert.deepEqual(await q('cluster=ncr'), ['N One', 'N Three', 'N Two'])
    assert.deepEqual(await q('cluster=noida_ncr'), ['N One', 'N Three', 'N Two'])
    assert.deepEqual(await q('cluster=jaipur,kolkata'), ['J One', 'K One'])
    const f = (await api.get('/api/manufacturers/facets')).body
    assert.deepEqual(f.byCluster, { jaipur: 1, kolkata: 1, ncr: 3 })
    const moved = await api.post(`/api/manufacturers/${(await mk('Mover', 'ludhiana')).body.id}`, { cluster: 'delhi_ncr' })
    assert.equal(moved.body.cluster, 'ncr')
  })
})

describe('brands they work with', () => {
  const rows = [
    { name: 'Cocoblu Vendor One', brands: ['Cocoblu'] },
    { name: 'Two Brand Mills', brands: ['Cocoblu', 'Fitleasure'] },
    { name: 'Kids Only', brands: ['Cocoblu Kids'] },
    { name: 'No Brands' },
  ]
  const setup = async () => { const admin = await makeAdmin(); await seed(admin, rows); return as(admin) }
  const q = async (api, qs) => (await api.get(`/api/manufacturers?${qs}&sort=name`)).body.items.map(p => p.name)

  test('brand names are kept as typed, de-duplicated whatever their capitalisation, and listed in the response', async () => {
    const api = as(await makeAdmin())
    const res = await api.post('/api/manufacturers', P({ name: 'Brand Test', brands: ['  Cocoblu ', 'cocoblu', 'Fit  Leisure', 'H&M'] }))
    assert.equal(res.status, 201, JSON.stringify(res.body))
    assert.deepEqual(res.body.brands, ['Cocoblu', 'Fit Leisure', 'H&M'])
    assert.deepEqual((await api.post('/api/manufacturers', P({ name: 'No Brand Test' }))).body.brands, [])
    assert.equal((await api.post('/api/manufacturers', P({ name: 'Bad Brand', brands: [5] }))).status, 400)
    assert.equal((await api.post('/api/manufacturers', P({ name: 'Long Brand', brands: ['x'.repeat(61)] }))).status, 400)
    const edit = await api.post(`/api/manufacturers/${res.body.id}`, { brands: ['Fitleasure'] })
    assert.deepEqual(edit.body.brands, ['Fitleasure'])
    assert.match((await AuditLog.findOne({ action: 'Partner Updated' }).lean()).detail, /brands/)
  })

  test('the brand filter matches the exact brand, in any capitalisation, or any of several', async () => {
    const api = await setup()
    assert.deepEqual(await q(api, 'brand=Cocoblu'), ['Cocoblu Vendor One', 'Two Brand Mills'])
    assert.deepEqual(await q(api, 'brand=cocoblu'), ['Cocoblu Vendor One', 'Two Brand Mills'])
    assert.deepEqual(await q(api, 'brand=Fitleasure'), ['Two Brand Mills'])
    assert.deepEqual(await q(api, 'brand=Fitleasure,Cocoblu Kids'), ['Kids Only', 'Two Brand Mills'])
    assert.deepEqual(await q(api, 'brand=.*'), [], 'a pattern is not a brand')
    assert.equal((await api.get(`/api/manufacturers?brand=${'x'.repeat(61)}`)).status, 400)
  })

  test('a search finds a brand, and the facets count each brand', async () => {
    const api = await setup()
    assert.deepEqual(await q(api, 'search=fitleas'), ['Two Brand Mills'])
    const f = (await api.get('/api/manufacturers/facets')).body
    assert.deepEqual(f.brands.map(b => [b.value, b.count]), [['Cocoblu', 2], ['Cocoblu Kids', 1], ['Fitleasure', 1]])
  })

  test('CSV and bulk import read a brands column', async () => {
    const api = as(await makeAdmin())
    const csv = 'Company,Clients\nA Co,"Cocoblu; Fitleasure"\nB Co,Cocoblu'
    const pre = (await api.post('/api/manufacturers/csv/preview', { csv })).body
    assert.equal(pre.suggestedMapping.Clients, 'brands')
    await api.post('/api/manufacturers/import', { rows: pre.rows, mapping: pre.suggestedMapping })
    assert.deepEqual((await Manufacturer.findOne({ name: 'A Co' }).lean()).brands, ['Cocoblu', 'Fitleasure'])
  })
})
