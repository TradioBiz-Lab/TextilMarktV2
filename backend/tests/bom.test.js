import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'
import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as } from './helpers/client.js'
import { makeAdmin, makeBuyer, makeMfr, makeCoordinator, orderPayload } from './helpers/factories.js'
import { cleanBom, bomOut } from '../src/lib/bom.js'
import { FactoryVisit } from '../src/models/FactoryVisit.js'
import { BomImage } from '../src/models/BomImage.js'
import { Document } from '../src/models/Document.js'

before(async () => { await startTestDb(); await startServer(); await FactoryVisit.init() })
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(clearDb)

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mNk+M9Qz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC'
const AT = { lat: 26.85, lng: 75.8, accuracy: 15 }
const ITEMS = [
  { section: 'Fabric', name: 'Shell fabric', description: 'Polyester woven, 110 gsm', perPiece: '1.65 m', forOrder: '1,360 m', image: PNG },
  { section: 'Trims', name: 'Front zip', description: 'No. 5 vislon', perPiece: '1 pcs', forOrder: '830 pcs' },
]

describe('a bill of materials as it is sent', () => {
  test('items get an id; a kept id keeps its ticks and picture; a picture can be set, kept or removed', () => {
    const first = cleanBom({ items: ITEMS }, null)
    assert.deepEqual(first.items.map(i => [i.name, i.hasImage, i.checks.length]), [['Shell fabric', true, 0], ['Front zip', false, 0]])
    assert.equal(first.setImages.length, 1)
    const kept = { items: first.items.map(i => ({ ...i, checks: [{ mfrId: 'f1', by: 'u1', at: new Date() }] })) }
    const again = cleanBom({ items: [{ id: kept.items[0].id, name: 'Shell fabric (new name)' }, { name: 'Elastic' }] }, kept)
    assert.deepEqual(again.items.map(i => [i.id === kept.items[0].id, i.hasImage, i.checks.length]), [[true, true, 1], [false, false, 0]])
    assert.deepEqual([again.setImages, again.dropImages], [[], []])
    const removed = cleanBom({ items: [{ id: kept.items[0].id, name: 'Shell fabric', image: null }] }, kept)
    assert.deepEqual([removed.items[0].hasImage, removed.dropImages], [false, [kept.items[0].id]])
    assert.deepEqual(cleanBom({ items: [] }, kept).dropImages, [kept.items[0].id], 'a removed item takes its picture with it')
  })
  test('what is refused', () => {
    assert.match(cleanBom({}, null).error, /list of items/)
    assert.match(cleanBom({ items: [{ name: ' ' }] }, null).error, /needs a name/)
    assert.match(cleanBom({ items: [{ name: 'Zip', image: 'data:text/html;base64,AAAA' }] }, null).error, /JPEG, PNG or WebP/)
    assert.match(cleanBom({ items: Array(81).fill({ name: 'x' }) }, null).error, /at most 80/)
  })
  test('a customer is sent no ticks; a viewer of one factory only that factory\'s', () => {
    const bom = { items: [{ id: 'a', name: 'Zip', checks: [{ mfrId: 'f1', byName: 'Ravi', at: 1 }, { mfrId: 'f2', byName: 'Asha', at: 2 }] }] }
    assert.equal(bomOut(bom).items[0].checks.length, 2)
    assert.deepEqual(bomOut(bom, ['f2']).items[0].checks.map(c => c.byName), ['Asha'])
    assert.deepEqual(bomOut(bom, null, { forBuyer: true }).items[0].checks, [])
    assert.equal(bomOut({ items: [] }), null)
  })
})

describe('the checklist on a style', () => {
  async function arrange() {
    const admin = await makeAdmin({ name: 'Asha' }); const buyer = await makeBuyer()
    const a = await makeMfr({ company: 'Factory A' }); const b = await makeMfr({ company: 'Factory B' })
    const p = orderPayload({ id: 'S-1', buyerId: buyer._id, mfrId: a._id, totalQty: 100, product: 'Jacket' })
    p.assignments = [{ mid: String(a._id), qty: 60 }, { mid: String(b._id), qty: 40 }]
    assert.equal((await as(admin).post('/api/orders', p)).status, 201)
    const coord = await makeCoordinator({ name: 'Ravi', assignedFactories: [a] })
    const set = await as(admin).post('/api/orders/S-1/bom', { items: ITEMS })
    assert.equal(set.status, 200, JSON.stringify(set.body))
    return { admin, buyer, a, b, coord, items: set.body.bom.items }
  }

  test('Tradio sets it; everyone on the style reads it and its pictures; only Tradio writes it', async () => {
    const { admin, buyer, a, coord, items } = await arrange()
    assert.deepEqual(items.map(i => [i.section, i.name, i.perPiece, i.forOrder, i.hasImage]), [['Fabric', 'Shell fabric', '1.65 m', '1,360 m', true], ['Trims', 'Front zip', '1 pcs', '830 pcs', false]])
    for (const who of [admin, buyer, a, coord]) {
      assert.equal((await as(who).get('/api/orders/S-1')).body.bom.items.length, 2)
      assert.deepEqual(await (await as(who).get('/api/orders/S-1/bom/images')).body, { [items[0].id]: PNG })
    }
    const stranger = await makeBuyer(); const elsewhere = await makeCoordinator({ assignedFactories: [await makeMfr()] })
    for (const who of [stranger, elsewhere]) assert.equal((await as(who).get('/api/orders/S-1/bom/images')).status, 403)
    for (const who of [buyer, a, coord]) assert.equal((await as(who).post('/api/orders/S-1/bom', { items: [] })).status, 403)
    const cleared = await as(admin).post('/api/orders/S-1/bom', { items: [] })
    assert.equal(cleared.body.bom, null)
    assert.equal(await BomImage.countDocuments(), 0)
  })

  test('a coordinator ticks an item only while checked in at that factory; the tick says who and when and can be taken back', async () => {
    const { admin, buyer, a, b, coord, items } = await arrange()
    const api = as(coord); const url = `/api/orders/S-1/bom/${items[1].id}/check`
    const early = await api.post(url, { mfrId: String(a._id), checked: true })
    assert.deepEqual([early.status, early.body.code], [409, 'CHECK_IN_FIRST'])
    assert.equal((await api.post('/api/visits/check-in', { factoryId: String(a._id), ...AT })).status, 201)
    const done = await api.post(url, { mfrId: String(a._id), checked: true })
    assert.equal(done.status, 200, JSON.stringify(done.body))
    assert.deepEqual(done.body.bom.items.map(i => i.checks.map(c => [c.mfrId, c.byName])), [[], [[String(a._id), 'Ravi']]])
    await api.post(url, { mfrId: String(a._id), checked: true })
    assert.equal((await as(admin).get('/api/orders/S-1')).body.bom.items[1].checks.length, 1, 'ticking twice is one tick')
    assert.equal((await api.post(url, { mfrId: String(b._id), checked: true })).status, 403, 'not a factory of his')
    assert.equal((await api.post('/api/orders/S-1/bom/nope/check', { mfrId: String(a._id), checked: true })).status, 404)
    assert.equal((await api.post(url, { mfrId: String(a._id) })).status, 400)
    for (const who of [buyer, a]) assert.equal((await as(who).post(url, { mfrId: String(a._id), checked: true })).status, 403)
    // Tradio ticks at the other factory; each side sees only what it may.
    assert.equal((await as(admin).post(url, { mfrId: String(b._id), checked: true })).status, 200)
    assert.equal((await as(admin).get('/api/orders/S-1')).body.bom.items[1].checks.length, 2)
    assert.deepEqual((await api.get('/api/orders/S-1')).body.bom.items[1].checks.map(c => c.byName), ['Ravi'])
    assert.deepEqual((await as(buyer).get('/api/orders/S-1')).body.bom.items[1].checks, [])
    // An edit that keeps the item keeps its ticks.
    const edited = await as(admin).post('/api/orders/S-1/bom', { items: [{ id: items[1].id, name: 'Front zip, 62 cm' }] })
    assert.deepEqual([edited.body.bom.items.length, edited.body.bom.items[0].checks.length], [1, 2])
    const back = await api.post(`/api/orders/S-1/bom/${items[1].id}/check`, { mfrId: String(a._id), checked: false })
    assert.deepEqual(back.body.bom.items[0].checks, [])
  })

  test('a photo of an item as seen at the factory: optional, one per factory, replaces the last, ticks the item, never the customer\'s', async () => {
    const { admin, buyer, a, b, coord, items } = await arrange()
    const api = as(coord); const url = `/api/orders/S-1/bom/${items[1].id}/evidence`
    assert.deepEqual([(await api.post(url, { mfrId: String(a._id), photo: PNG })).body.code], ['CHECK_IN_FIRST'])
    assert.equal((await api.post('/api/visits/check-in', { factoryId: String(a._id), ...AT })).status, 201)
    assert.equal((await api.post(url, { mfrId: String(a._id), photo: 'data:image/png;base64,AAAA' })).status, 400, 'not a real image')
    const first = await api.post(url, { mfrId: String(a._id), photo: PNG })
    assert.equal(first.status, 200, JSON.stringify(first.body))
    const it = first.body.bom.items[1]
    assert.deepEqual([it.evidence.length, it.evidence[0].byName, it.checks.length], [1, 'Ravi', 1], 'the photo ticks the item')
    assert.deepEqual(first.body.bom.items[0].evidence, [], 'an item with no photo is fine as it is')
    const doc = await Document.findById(it.evidence[0].docId).lean()
    assert.deepEqual([doc.type, doc.bomItemId, doc.internal, String(doc.mfrId)], ['bom_evidence', items[1].id, true, String(a._id)])
    for (const who of [coord, admin, a]) assert.equal((await as(who).get(`/api/documents/${doc._id}/data`)).status, 200)
    assert.equal((await as(buyer).get(`/api/documents/${doc._id}/data`)).status, 403)
    assert.deepEqual((await as(buyer).get('/api/orders/S-1')).body.bom.items[1].evidence, [])
    // A second photo replaces the first; the old file is gone.
    const second = await api.post(url, { mfrId: String(a._id), photo: PNG })
    assert.equal(second.body.bom.items[1].evidence.length, 1)
    assert.notEqual(second.body.bom.items[1].evidence[0].docId, String(doc._id))
    assert.equal(await Document.countDocuments({ type: 'bom_evidence' }), 1)
    // Unticking leaves the photo; taking the photo away leaves the tick as it is.
    const unticked = await api.post(`/api/orders/S-1/bom/${items[1].id}/check`, { mfrId: String(a._id), checked: false })
    assert.deepEqual([unticked.body.bom.items[1].checks.length, unticked.body.bom.items[1].evidence.length], [0, 1])
    const gone = await api.post(url, { mfrId: String(a._id), photo: null })
    assert.deepEqual(gone.body.bom.items[1].evidence, [])
    assert.equal(await Document.countDocuments({ type: 'bom_evidence' }), 0)
    assert.equal((await api.post(url, { mfrId: String(b._id), photo: PNG })).status, 403, 'not a factory of his')
    for (const who of [buyer, a]) assert.equal((await as(who).post(url, { mfrId: String(a._id), photo: PNG })).status, 403)
  })
})
