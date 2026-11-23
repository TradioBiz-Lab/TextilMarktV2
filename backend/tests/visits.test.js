import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'
import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as, req } from './helpers/client.js'
import { makeAdmin, makeBuyer, makeMfr, makeCoordinator } from './helpers/factories.js'
import { FactoryVisit } from '../src/models/FactoryVisit.js'
import { Manufacturer } from '../src/models/Manufacturer.js'
import { AuditLog } from '../src/models/AuditLog.js'

before(async () => { await startTestDb(); await startServer(); await FactoryVisit.init() })
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(clearDb)

const AT = { lat: 26.85, lng: 75.8, accuracy: 15, deviceAt: '2026-11-23T05:00:00.000Z' }
const pin = (mfr, lat, lng) => Manufacturer.updateOne({ linkedUserId: mfr._id }, { $set: { 'geo.lat': lat, 'geo.lng': lng, city: 'Jaipur' } })

describe('checking in', () => {
  test('at an allocated factory, with the phone\'s position and the server\'s time', async () => {
    const f = await makeMfr({ company: 'Neobrands' }); await pin(f, 26.85, 75.8)
    const coord = await makeCoordinator({ name: 'Ravi', assignedFactories: [f] })
    const before = Date.now()
    const res = await as(coord).post('/api/visits/check-in', { factoryId: String(f._id), ...AT })
    assert.equal(res.status, 201, JSON.stringify(res.body))
    assert.equal(res.body.factoryName, 'Neobrands')
    assert.equal(res.body.open, true)
    assert.equal(res.body.checkIn.distanceM, 0)
    assert.equal(res.body.checkIn.away, false)
    assert.ok(new Date(res.body.checkIn.at).getTime() >= before - 1000, 'the server clock, not the phone\'s')
    assert.equal(res.body.checkIn.deviceAt, AT.deviceAt)
    const log = await AuditLog.findOne({ action: 'Factory Check In' }).lean()
    assert.match(log.detail, /Ravi checked in at Neobrands/)
    assert.equal(String(log.byUser), String(coord._id))

    const mine = await as(coord).get('/api/visits/mine')
    assert.equal(mine.body.open.id, res.body.id)
    assert.deepEqual(mine.body.factories, [{ id: String(f._id), name: 'Neobrands', city: 'Jaipur', hasLocation: true, directionsUrl: 'https://www.google.com/maps?q=26.85,75.8' }])
    assert.equal(mine.body.today.length, 1)
  })

  test('refused without a real location, at a factory that is not his, or at something that is not a factory', async () => {
    const f = await makeMfr(); const other = await makeMfr(); const buyer = await makeBuyer()
    const coord = await makeCoordinator({ assignedFactories: [f] })
    const api = as(coord)
    for (const bad of [{}, { lat: null, lng: null }, { lat: 200, lng: 75 }, { lat: '26.8', lng: '75.8' }]) {
      const res = await api.post('/api/visits/check-in', { factoryId: String(f._id), ...bad })
      assert.equal(res.status, 400, JSON.stringify(bad))
      assert.equal(res.body.code, 'LOCATION_REQUIRED')
    }
    assert.equal((await api.post('/api/visits/check-in', { factoryId: String(other._id), ...AT })).status, 403)
    assert.equal((await api.post('/api/visits/check-in', { factoryId: String(buyer._id), ...AT })).status, 403)
    assert.equal((await api.post('/api/visits/check-in', { factoryId: { $ne: null }, ...AT })).status, 400)
    assert.equal(await FactoryVisit.countDocuments(), 0)
  })

  test('one open visit at a time', async () => {
    const f1 = await makeMfr({ company: 'Alpha' }); const f2 = await makeMfr({ company: 'Beta' })
    const coord = await makeCoordinator({ assignedFactories: [f1, f2] })
    const api = as(coord)
    assert.equal((await api.post('/api/visits/check-in', { factoryId: String(f1._id), ...AT })).status, 201)
    const second = await api.post('/api/visits/check-in', { factoryId: String(f2._id), ...AT })
    assert.equal(second.status, 409)
    assert.match(second.body.error, /Check out of Alpha first/)
    assert.equal(await FactoryVisit.countDocuments(), 1)
  })

  test('the distance from the factory is kept; far away is marked, never refused; no pin means no distance', async () => {
    const near = await makeMfr(); await pin(near, 26.85, 75.8)
    const none = await makeMfr()
    const coord = await makeCoordinator({ assignedFactories: [near, none] })
    const api = as(coord)
    const far = await api.post('/api/visits/check-in', { factoryId: String(near._id), lat: 26.87, lng: 75.8, accuracy: 20 })
    assert.equal(far.status, 201)
    assert.ok(far.body.checkIn.distanceM > 2000, String(far.body.checkIn.distanceM))
    assert.equal(far.body.checkIn.away, true)
    await api.post(`/api/visits/${far.body.id}/check-out`, AT)
    const unknown = await api.post('/api/visits/check-in', { factoryId: String(none._id), ...AT })
    assert.equal(unknown.body.checkIn.distanceM, null)
    assert.equal(unknown.body.checkIn.away, false)
  })
})

describe('checking out', () => {
  test('closes his own open visit with a position and a duration', async () => {
    const f = await makeMfr({ company: 'Neobrands' })
    const coord = await makeCoordinator({ name: 'Ravi', assignedFactories: [f] })
    const api = as(coord)
    const inn = await api.post('/api/visits/check-in', { factoryId: String(f._id), ...AT })
    await FactoryVisit.updateOne({ _id: inn.body.id }, { $set: { 'checkIn.at': new Date(Date.now() - 90 * 60000) } })
    assert.equal((await api.post(`/api/visits/${inn.body.id}/check-out`, {})).body.code, 'LOCATION_REQUIRED')
    const out = await api.post(`/api/visits/${inn.body.id}/check-out`, AT)
    assert.equal(out.status, 200, JSON.stringify(out.body))
    assert.equal(out.body.open, false)
    assert.equal(out.body.minutes, 90)
    assert.equal(out.body.didNotCheckOut, false)
    assert.match((await AuditLog.findOne({ action: 'Factory Check Out' }).lean()).detail, /Ravi checked out of Neobrands after 90 min/)
    assert.equal((await api.post(`/api/visits/${inn.body.id}/check-out`, AT)).status, 409, 'twice')
    assert.equal((await api.post('/api/visits/check-in', { factoryId: String(f._id), ...AT })).status, 201, 'and he can check in again')
  })

  test('not somebody else\'s visit', async () => {
    const f = await makeMfr()
    const a = await makeCoordinator({ assignedFactories: [f] }); const b = await makeCoordinator({ assignedFactories: [f] })
    const inn = await as(a).post('/api/visits/check-in', { factoryId: String(f._id), ...AT })
    assert.equal((await as(b).post(`/api/visits/${inn.body.id}/check-out`, AT)).status, 404)
    assert.equal((await as(b).post('/api/visits/not-an-id/check-out', AT)).status, 404)
    assert.equal((await FactoryVisit.findById(inn.body.id).lean()).closedBy, null)
  })

  test('a visit left open overnight is closed with no check-out time, and he can check in again', async () => {
    const f = await makeMfr()
    const coord = await makeCoordinator({ assignedFactories: [f] })
    const api = as(coord)
    const inn = await api.post('/api/visits/check-in', { factoryId: String(f._id), ...AT })
    await FactoryVisit.updateOne({ _id: inn.body.id }, { $set: { 'checkIn.at': new Date(Date.now() - 30 * 60 * 60000) } })
    const mine = await api.get('/api/visits/mine')
    assert.equal(mine.body.open, null)
    const stale = await FactoryVisit.findById(inn.body.id).lean()
    assert.equal(stale.closedBy, 'auto')
    assert.equal(stale.checkOut, null)
    assert.equal((await api.post(`/api/visits/${inn.body.id}/check-out`, AT)).status, 409)
    assert.equal((await api.post('/api/visits/check-in', { factoryId: String(f._id), ...AT })).status, 201)
  })
})

describe('who reads the visits', () => {
  test('admins see them all, with filters and the factories that have no location yet', async () => {
    const pinned = await makeMfr({ company: 'Pinned' }); await pin(pinned, 26.85, 75.8)
    const bare = await makeMfr({ company: 'Bare' })
    const a = await makeCoordinator({ name: 'Ravi', assignedFactories: [pinned, bare] })
    const b = await makeCoordinator({ name: 'Sita', assignedFactories: [pinned] })
    const va = await as(a).post('/api/visits/check-in', { factoryId: String(bare._id), ...AT })
    await as(b).post('/api/visits/check-in', { factoryId: String(pinned._id), ...AT })
    await FactoryVisit.updateOne({ _id: va.body.id }, { $set: { 'checkIn.at': new Date(Date.now() - 3 * 24 * 60 * 60000) } })

    const admin = as(await makeAdmin())
    const all = await admin.get('/api/visits')
    assert.equal(all.status, 200)
    assert.equal(all.body.visits.length, 2)
    assert.deepEqual(all.body.coordinators.map(c => c.name), ['Ravi', 'Sita'])
    assert.deepEqual(all.body.missingLocation.map(m => m.name), ['Bare'])
    assert.ok(all.body.missingLocation[0].partnerId)
    const old = all.body.visits.find(v => v.coordinatorName === 'Ravi')
    assert.equal(old.didNotCheckOut, true)
    assert.equal(old.minutes, null)

    const today = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10)
    assert.deepEqual((await admin.get(`/api/visits?from=${today}&to=${today}`)).body.visits.map(v => v.coordinatorName), ['Sita'])
    assert.deepEqual((await admin.get(`/api/visits?coordinatorId=${a._id}`)).body.visits.map(v => v.factoryName), ['Bare'])
    assert.deepEqual((await admin.get(`/api/visits?factoryId=${pinned._id}`)).body.visits.map(v => v.coordinatorName), ['Sita'])
    assert.equal((await admin.get('/api/visits?from=yesterday')).status, 400)
    assert.equal((await admin.get('/api/visits?factoryId=x')).status, 400)
  })

  test('customers and factories reach none of it; signed out gets 401', async () => {
    const f = await makeMfr()
    const coord = await makeCoordinator({ assignedFactories: [f] })
    const inn = await as(coord).post('/api/visits/check-in', { factoryId: String(f._id), ...AT })
    const routes = [['GET', '/api/visits'], ['GET', '/api/visits/mine'], ['POST', '/api/visits/check-in', { factoryId: String(f._id), ...AT }], ['POST', `/api/visits/${inn.body.id}/check-out`, AT]]
    for (const who of [await makeBuyer(), f]) for (const [m, p, b] of routes) {
      assert.equal((await req(m, p, { token: as(who).token, body: b })).status, 403, `${who.role} ${m} ${p}`)
    }
    for (const [m, p, b] of routes) assert.equal((await req(m, p, { body: b })).status, 401)
    // An admin reads visits but does not check in.
    assert.equal((await as(await makeAdmin()).post('/api/visits/check-in', { factoryId: String(f._id), ...AT })).status, 403)
    assert.equal((await FactoryVisit.findById(inn.body.id).lean()).closedBy, null)
  })
})

describe('a factory\'s location on its Partner Directory record', () => {
  test('set from a pasted link or pair, shown back, cleared with an empty value, audited', async () => {
    const admin = await makeAdmin(); const f = await makeMfr({ company: 'Neobrands' })
    const partner = await Manufacturer.findOne({ linkedUserId: f._id }).lean()
    const api = as(admin)
    const set = await api.post(`/api/manufacturers/${partner._id}`, { mapsLocation: 'https://www.google.com/maps/place/X/@26.8,75.8,17z/data=!3d26.851234!4d75.805678' })
    assert.equal(set.status, 200, JSON.stringify(set.body))
    assert.deepEqual(set.body.geo, { lat: 26.851234, lng: 75.805678, mapsUrl: 'https://www.google.com/maps?q=26.851234,75.805678' })
    const stored = await Manufacturer.findById(partner._id).lean()
    assert.equal(String(stored.geo.setBy), String(admin._id))
    assert.ok(stored.geo.setAt)
    assert.match((await AuditLog.findOne({ action: 'Partner Updated' }).sort({ createdAt: -1 }).lean()).detail, /location empty -> 26.851234, 75.805678/)

    const bad = await api.post(`/api/manufacturers/${partner._id}`, { mapsLocation: 'https://maps.app.goo.gl/abc' })
    assert.equal(bad.status, 400)
    assert.match(bad.body.error, /short Maps link/)
    const cleared = await api.post(`/api/manufacturers/${partner._id}`, { mapsLocation: '' })
    assert.equal(cleared.body.geo, null)

    const made = await api.post('/api/manufacturers', { name: 'New Mill', type: 'garment_manufacturer', mapsLocation: '26.9, 75.7' })
    assert.equal(made.status, 201, JSON.stringify(made.body))
    assert.deepEqual([made.body.geo.lat, made.body.geo.lng], [26.9, 75.7])
  })
})
