// "Live" is Tradio's mark that a manufacturer has orders with us now. Only a live manufacturer (one with a platform
// account) can be given a style or a split; live partners sit on top of the directory; tiles load as small thumbnails in
// one batch. All admin only.

import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as, req } from './helpers/client.js'
import { makeAdmin, makeMaster, makeBuyer, makeMfr, makeMasterOrder, orderPayload } from './helpers/factories.js'
import { Manufacturer } from '../src/models/Manufacturer.js'
import { User } from '../src/models/User.js'
import { AuditLog } from '../src/models/AuditLog.js'
import { Order } from '../src/models/Order.js'
import { ensurePartnerForUser } from '../src/lib/partnerSync.js'

before(async () => { await startTestDb(); await startServer(); await Manufacturer.init() })
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(clearDb)

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const THUMB = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q=='
const partnerOf = user => Manufacturer.findOne({ linkedUserId: user._id })

describe('marking a partner live', () => {
  test('Live is a status: only a partner with a platform account can have it; the change is audited', async () => {
    const admin = await makeAdmin()
    const api = as(admin)
    const lone = (await api.post('/api/manufacturers', { name: 'No Account Mills', type: 'garment_manufacturer' })).body
    const refused = await api.post(`/api/manufacturers/${lone.id}`, { status: 'live' })
    assert.equal(refused.status, 400)
    assert.match(refused.body.error, /manufacturer account/)
    assert.equal((await Manufacturer.findById(lone.id).lean()).status, 'new')
    // nor can a new partner start as Live
    assert.equal((await api.post('/api/manufacturers', { name: 'Born Live', type: 'garment_manufacturer', status: 'live' })).status, 400)

    const mfr = await makeMfr({ live: false })
    const p = await partnerOf(mfr)
    const ok = await api.post(`/api/manufacturers/${p._id}`, { status: 'live' })
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
    assert.equal(ok.body.status, 'live')
    assert.equal(ok.body.isLive, true)
    assert.match((await AuditLog.findOne({ action: 'Partner Updated' }).lean()).detail, /status pilot -> live/)
    // a client cannot set the derived flag on its own
    assert.equal((await api.post(`/api/manufacturers/${p._id}`, { isLive: false })).body.status, 'live')
    const back = await api.post(`/api/manufacturers/${p._id}`, { status: 'pilot' })
    assert.equal(back.body.isLive, false)
  })

  test('a buyer or manufacturer cannot mark anything live', async () => {
    const mfr = await makeMfr({ live: false })
    const p = await partnerOf(mfr)
    for (const who of [await makeBuyer(), mfr]) {
      assert.equal((await as(who).post(`/api/manufacturers/${p._id}`, { status: 'live' })).status, 403)
    }
    assert.equal((await Manufacturer.findById(p._id).lean()).status, 'pilot')
  })
})

describe('live partners come first', () => {
  const setup = async () => {
    const admin = await makeAdmin()
    const api = as(admin)
    for (const [name, score] of [['Alpha', 90], ['Bravo', 10], ['Charlie', 50], ['Delta', 70]]) {
      await api.post('/api/manufacturers', { name, type: 'garment_manufacturer', verification: { score } })
    }
    const m = await makeMfr({ listed: false })
    await Manufacturer.updateOne({ name: 'Bravo' }, { linkedUserId: m._id, status: 'live' })
    const m2 = await makeMfr({ listed: false })
    await Manufacturer.updateOne({ name: 'Charlie' }, { linkedUserId: m2._id, status: 'live' })
    return api
  }
  const names = async (api, qs) => (await api.get(`/api/manufacturers?${qs}`)).body.items.map(p => p.name)

  test('whatever the sort, live ones are on top and the sort orders each group', async () => {
    const api = await setup()
    assert.deepEqual(await names(api, 'sort=score'), ['Charlie', 'Bravo', 'Alpha', 'Delta'])
    assert.deepEqual(await names(api, 'sort=name'), ['Bravo', 'Charlie', 'Alpha', 'Delta'])
    assert.deepEqual(await names(api, ''), ['Charlie', 'Bravo', 'Alpha', 'Delta'])
    assert.deepEqual(await names(api, 'sort=updated').then(n => n.slice(0, 2).sort()), ['Bravo', 'Charlie'])
  })

  test('the live filter lists only live ones, and a partial-word search keeps live first', async () => {
    const api = await setup()
    assert.deepEqual(await names(api, 'live=1&sort=name'), ['Bravo', 'Charlie'])
    assert.deepEqual(await names(api, 'search=a&sort=score'), ['Charlie', 'Bravo', 'Alpha', 'Delta'])
  })
})

describe('rejected partners come last', () => {
  const setup = async () => {
    const api = as(await makeAdmin())
    for (const [name, score] of [['Alpha', 90], ['Bravo', 10], ['Charlie', 50], ['Delta', 70], ['Echo', 95]]) {
      await api.post('/api/manufacturers', { name, type: 'garment_manufacturer', verification: { score } })
    }
    await Manufacturer.updateOne({ name: 'Echo' }, { status: 'rejected' })
    await Manufacturer.updateOne({ name: 'Alpha' }, { status: 'rejected' })
    return api
  }
  const names = async (api, qs) => (await api.get(`/api/manufacturers?${qs}`)).body.items.map(p => p.name)

  test('under every sort, with a search, and the best score does not lift them', async () => {
    const api = await setup()
    assert.deepEqual(await names(api, 'sort=score'), ['Delta', 'Charlie', 'Bravo', 'Echo', 'Alpha'])
    assert.deepEqual(await names(api, 'sort=name'), ['Bravo', 'Charlie', 'Delta', 'Alpha', 'Echo'])
    assert.deepEqual(await names(api, 'search=a&sort=score'), ['Delta', 'Charlie', 'Bravo', 'Alpha'])
    assert.deepEqual(await names(api, 'search=ech&sort=name'), ['Echo'])
  })

  test('paging runs on through the rejected group and the total counts both', async () => {
    const api = await setup()
    const second = (await api.get('/api/manufacturers?sort=score&limit=2&skip=2')).body
    assert.deepEqual(second.items.map(p => p.name), ['Bravo', 'Echo'])
    assert.equal(second.total, 5)
    const third = (await api.get('/api/manufacturers?sort=score&limit=2&skip=4')).body
    assert.deepEqual(third.items.map(p => p.name), ['Alpha'])
  })
})

describe('only live manufacturers can be given work', () => {
  const arrange = async () => {
    const admin = await makeAdmin()
    const buyer = await makeBuyer()
    const live = await makeMfr({ company: 'Live Mills' })
    const idle = await makeMfr({ company: 'Idle Mills', live: false })
    const unlisted = await makeMfr({ company: 'Unlisted Mills', listed: false })
    const mo = await makeMasterOrder({ buyerId: buyer._id, createdBy: admin._id })
    const api = as(admin)
    const make = (id, mfr) => api.post('/api/orders', orderPayload({ id, buyerId: buyer._id, mfrId: mfr._id, masterOrderId: mo._id }))
    return { admin, buyer, live, idle, unlisted, mo, api, make }
  }

  test('creating a style: live is accepted, not-live and unlisted are refused with the reason, nothing is created', async () => {
    const { live, idle, unlisted, make } = await arrange()
    assert.equal((await make('LV-001', live)).status, 201)
    const r1 = await make('LV-002', idle)
    assert.equal(r1.status, 400)
    assert.match(r1.body.error, /Idle Mills is not marked live in Partners yet/)
    const r2 = await make('LV-003', unlisted)
    assert.equal(r2.status, 400)
    assert.match(r2.body.error, /Unlisted Mills/)
    assert.deepEqual((await Order.find({}, '_id').lean()).map(o => o._id), ['LV-001'])
  })

  test('becoming live is all it takes', async () => {
    const { api, idle, make } = await arrange()
    assert.equal((await make('LV-010', idle)).status, 400)
    const p = await partnerOf(idle)
    assert.equal((await api.post(`/api/manufacturers/${p._id}`, { status: 'live' })).status, 200)
    assert.equal((await make('LV-010', idle)).status, 201)
  })

  test('adding a manufacturer to a style, and handing a split to another one, need live too', async () => {
    const { api, live, idle, buyer, mo } = await arrange()
    const first = await api.post('/api/orders', orderPayload({ id: 'LV-020', buyerId: buyer._id, mfrId: live._id, masterOrderId: mo._id }))
    assert.equal(first.status, 201)
    const add = await api.post('/api/orders/LV-020/assignments', { mfrId: String(idle._id), qty: 10 })
    assert.equal(add.status, 400)
    assert.match(add.body.error, /not marked live/)
    const re = await api.post(`/api/orders/LV-020/assignments/${live._id}/reassign`, { newMfrId: String(idle._id) })
    assert.equal(re.status, 400)
    assert.match(re.body.error, /not marked live/)
    assert.equal((await Order.findById('LV-020').lean()).assignments[0].mfrId.toString(), String(live._id))
    // once live, both work
    await Manufacturer.updateOne({ linkedUserId: idle._id }, { status: 'live' })
    assert.equal((await api.post(`/api/orders/LV-020/assignments/${live._id}/reassign`, { newMfrId: String(idle._id) })).status, 200)
  })

  test('a manufacturer that is switched off live keeps the work it already has', async () => {
    const { api, live, make } = await arrange()
    assert.equal((await make('LV-030', live)).status, 201)
    await Manufacturer.updateOne({ linkedUserId: live._id }, { status: 'pilot' })
    const order = await api.get('/api/orders/LV-030')
    assert.equal(order.status, 200)
    assert.equal(order.body.assignments.length, 1)
    assert.equal((await make('LV-031', live)).status, 400)
  })

  test('the users list tells the pickers which manufacturers are live', async () => {
    const { master } = { master: await makeMaster() }
    const live = await makeMfr({ company: 'Live Two' })
    const idle = await makeMfr({ company: 'Idle Two', live: false })
    const unlisted = await makeMfr({ company: 'Unlisted Two', listed: false })
    const users = (await as(master).get('/api/users')).body
    const flag = u => users.find(x => x.id === String(u._id)).live
    assert.equal(flag(live), true)
    assert.equal(flag(idle), false)
    assert.equal(flag(unlisted), false)
    assert.equal(users.find(x => x.id === String(master._id)).live, undefined)
  })
})

describe('a new manufacturer account gets a directory record, not live', () => {
  test('creating a manufacturer in User Setup adds it to the directory', async () => {
    const master = await makeMaster()
    const res = await as(master).post('/api/users', { email: 'new.mfr@example.com', password: 'Strong@Pass1', role: 'manufacturer', company: 'Brand New Mills', name: 'Nita', code: 'BNM', phone: '+91 99999 00000' })
    assert.equal(res.status, 201, JSON.stringify(res.body))
    const p = await Manufacturer.findOne({ linkedUserId: res.body.id }).lean()
    assert.equal(p.name, 'Brand New Mills')
    assert.equal(p.isLive, false)
    assert.equal(p.status, 'pilot')
    assert.equal(p.type, 'garment_manufacturer')
    assert.equal(p.contacts[0].email, 'new.mfr@example.com')
    // and cannot be given a style until marked live
    const buyer = await makeBuyer()
    const mo = await makeMasterOrder({ buyerId: buyer._id, createdBy: master._id })
    const refused = await as(master).post('/api/orders', orderPayload({ id: 'NEW-001', buyerId: buyer._id, mfrId: res.body.id, masterOrderId: mo._id }))
    assert.equal(refused.status, 400)
  })

  test('a buyer account makes no record; the helper is idempotent and links a same-named record instead of duplicating', async () => {
    const master = await makeMaster()
    const b = await as(master).post('/api/users', { email: 'b@example.com', password: 'Strong@Pass1', role: 'buyer', company: 'Some Buyer', name: 'B', code: 'SBY' })
    assert.equal(b.status, 201)
    assert.equal(await Manufacturer.countDocuments(), 0)

    await Manufacturer.create({ name: 'Spreadsheet Mills', type: 'garment_manufacturer', status: 'contacted' })
    const user = await User.create({ email: 'sm@example.com', passwordHash: 'x', role: 'manufacturer', company: 'spreadsheet  MILLS', name: 'S', code: 'SPM' })
    const r1 = await ensurePartnerForUser(user.toObject())
    assert.equal(r1.action, 'linked')
    assert.equal(await Manufacturer.countDocuments(), 1)
    const linked = await Manufacturer.findOne({ linkedUserId: user._id }).lean()
    assert.equal(linked.status, 'pilot')
    assert.equal((await ensurePartnerForUser(user.toObject())).action, 'exists')
    assert.equal(await Manufacturer.countDocuments(), 1)
  })
})

describe('tiles load as thumbnails, in one request', () => {
  const arrange = async () => {
    const admin = await makeAdmin()
    const api = as(admin)
    const mk = async name => (await api.post('/api/manufacturers', { name, type: 'garment_manufacturer' })).body
    return { admin, api, a: await mk('Tile A'), b: await mk('Tile B'), c: await mk('Tile C') }
  }

  test('an upload with a thumbnail is served as the thumbnail; one without falls back to the full picture; no upload is left out', async () => {
    const { api, a, b, c } = await arrange()
    assert.equal((await api.post(`/api/manufacturers/${a.id}/image`, { image: PNG, thumb: THUMB })).status, 200)
    assert.equal((await api.post(`/api/manufacturers/${b.id}/image`, { image: PNG })).status, 200)
    const res = await api.get(`/api/manufacturers/thumbs?ids=${a.id},${b.id},${c.id}`)
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.thumbs, { [a.id]: THUMB, [b.id]: PNG })
    // the full picture is still its own request, and lists carry no image bytes
    assert.equal((await api.get(`/api/manufacturers/${a.id}/image`)).body.image, PNG)
    assert.equal(JSON.stringify((await api.get('/api/manufacturers')).body).includes('base64'), false)
  })

  test('the answer can be cached by the browser, and replacing or removing the tile replaces the thumbnail', async () => {
    const { api, a } = await arrange()
    await api.post(`/api/manufacturers/${a.id}/image`, { image: PNG, thumb: THUMB })
    const direct = await fetch(`${await startServer()}/api/manufacturers/thumbs?ids=${a.id}`, { headers: { Authorization: `Bearer ${api.token}` } })
    assert.match(direct.headers.get('cache-control'), /private, max-age=\d+/)
    await api.post(`/api/manufacturers/${a.id}/image`, { image: PNG })
    assert.equal((await api.get(`/api/manufacturers/thumbs?ids=${a.id}`)).body.thumbs[a.id], PNG, 'a new upload without a thumbnail does not keep the old one')
    await api.post(`/api/manufacturers/${a.id}/image`, { image: null })
    assert.deepEqual((await api.get(`/api/manufacturers/thumbs?ids=${a.id}`)).body.thumbs, {})
  })

  test('bad requests: no ids, too many, not ids, an oversized or non-image thumbnail', async () => {
    const { api, a } = await arrange()
    assert.equal((await api.get('/api/manufacturers/thumbs')).status, 400)
    assert.equal((await api.get('/api/manufacturers/thumbs?ids=abc')).status, 400)
    assert.equal((await api.get(`/api/manufacturers/thumbs?ids=${Array(61).fill(a.id).join(',')}`)).status, 400)
    assert.equal((await api.post(`/api/manufacturers/${a.id}/image`, { image: PNG, thumb: `data:image/png;base64,${'A'.repeat(200 * 1024)}` })).status, 400)
    assert.equal((await api.post(`/api/manufacturers/${a.id}/image`, { image: PNG, thumb: 'data:text/html;base64,PGgxPg==' })).status, 400)
    assert.equal((await Manufacturer.findById(a.id).lean()).imageUploadedAt, null)
  })
})

describe('one status: Live replaces Onboarded and On platform', () => {
  test('the status list has Live and no Onboarded; isLive follows the status however it is written', async () => {
    const { PARTNER_STATUSES } = await import('../src/models/Manufacturer.js')
    assert.deepEqual(PARTNER_STATUSES, ['new', 'contacted', 'qualified', 'pilot', 'live', 'rejected', 'off_scope'])
    const admin = await makeAdmin()
    const api = as(admin)
    assert.equal((await api.post('/api/manufacturers', { name: 'Old Word', type: 'trader', status: 'onboarded' })).status, 400)
    const m = await makeMfr({ live: false })
    const p = await partnerOf(m)
    await Manufacturer.updateOne({ _id: p._id }, { $set: { status: 'live' } })
    assert.equal((await Manufacturer.findById(p._id).lean()).isLive, true)
    await Manufacturer.findOneAndUpdate({ _id: p._id }, { status: 'rejected' })
    assert.equal((await Manufacturer.findById(p._id).lean()).isLive, false)
    const doc = await Manufacturer.findById(p._id)
    doc.status = 'live'; await doc.save()
    assert.equal((await Manufacturer.findById(p._id).lean()).isLive, true)
    // the live filter and the status filter agree
    assert.deepEqual((await api.get('/api/manufacturers?live=1')).body.items.map(x => x.status), ['live'])
    assert.equal((await api.get('/api/manufacturers?status=live')).body.total, 1)
  })

  test('a file import cannot make anyone Live, and "onboarded" or "active" in a file reads as Pilot', async () => {
    const api = as(await makeAdmin())
    const res = await api.post('/api/manufacturers/import', { rows: [
      { name: 'Wants Live', type: 'garment_manufacturer', status: 'live' },
      { Company: 'Says Onboarded', Status: 'Onboarded' },
    ].slice(0, 1) })
    assert.equal(res.body.created, 0)
    assert.match(res.body.errors[0].errors[0], /needs a manufacturer account/)
    const csv = (await api.post('/api/manufacturers/csv/preview', { csv: 'Company,Status\nSays Onboarded,Onboarded\nSays Active,Active' })).body
    const imp = await api.post('/api/manufacturers/import', { rows: csv.rows, mapping: csv.suggestedMapping })
    assert.equal(imp.body.created, 2)
    assert.equal((await Manufacturer.findOne({ name: 'Says Onboarded' }).lean()).status, 'pilot')
    assert.equal((await Manufacturer.findOne({ name: 'Says Active' }).lean()).status, 'pilot')
  })
})
