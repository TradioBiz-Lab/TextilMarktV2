import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'
import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as, req } from './helpers/client.js'
import { makeAdmin, makeBuyer, makeMfr, makeCoordinator, orderPayload } from './helpers/factories.js'
import { FieldUpdate } from '../src/models/FieldUpdate.js'
import { FactoryVisit } from '../src/models/FactoryVisit.js'
import { Document } from '../src/models/Document.js'
import { Order } from '../src/models/Order.js'
import { AuditLog } from '../src/models/AuditLog.js'
import { Notification } from '../src/models/Notification.js'
import { setFieldUpdateExtractor, readFieldUpdate } from '../src/routes/fieldUpdates.js'
import { registerFileDriver } from '../src/lib/fileStore.js'
import { setCatalystSdk } from '../src/lib/stratusDriver.js'
import { Readable } from 'node:stream'
import { makeMaster } from './helpers/factories.js'

before(async () => { await startTestDb(); await startServer(); await FactoryVisit.init() })
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(async () => { await clearDb(); setFieldUpdateExtractor(null); delete process.env.FILE_STORE })

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mNk+M9Qz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC'
const JPEG = `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]).toString('base64')}`
const AUDIO = `data:audio/webm;codecs=opus;base64,${Buffer.alloc(300, 3).toString('base64')}`
const AT = { lat: 26.85, lng: 75.8, accuracy: 15 }
const STEPS = ['Fabric Inhouse', 'Cutting', 'Stitching', 'Inspection']

// Style S-1 is made at factories A and B for one customer. The coordinator is allocated A and is checked in there.
async function arrange({ checkIn = true } = {}) {
  const admin = await makeAdmin({ name: 'Asha' }); const buyer = await makeBuyer({ company: 'Cocoblu' })
  const a = await makeMfr({ company: 'Factory A' }); const b = await makeMfr({ company: 'Factory B' })
  const p = orderPayload({ id: 'S-1', buyerId: buyer._id, mfrId: a._id, totalQty: 100, product: 'Polo', stageNames: STEPS, colourways: [{ name: 'Olivine' }, { name: 'Peacot' }] })
  p.assignments = [{ mid: String(a._id), qty: 60 }, { mid: String(b._id), qty: 40 }]
  assert.equal((await as(admin).post('/api/orders', p)).status, 201)
  const coord = await makeCoordinator({ name: 'Ravi', assignedFactories: [a] })
  const api = as(coord)
  if (checkIn) assert.equal((await api.post('/api/visits/check-in', { factoryId: String(a._id), ...AT })).status, 201)
  const body = (o = {}) => ({ orderId: 'S-1', mfrId: String(a._id), stageIndex: 2, text: '240 pieces stitched, blue shade is off', ...AT, ...o })
  return { admin, buyer, a, b, coord, api, body }
}
const threadOf = async (mfr, i = 2) => (await Order.findById('S-1').lean()).assignments.find(x => String(x.mfrId) === String(mfr._id)).stages[i].updates || []

describe('sending an update from the floor', () => {
  test('words, photos and a voice note are kept on the step; the plan itself does not change', async () => {
    const { admin, buyer, a, coord, api, body } = await arrange()
    await Notification.deleteMany({})
    const res = await api.post('/api/field-updates', body({ photos: [PNG, JPEG], audio: AUDIO, viaVoice: true, deviceAt: '2026-11-23T05:00:00.000Z' }))
    assert.equal(res.status, 201, JSON.stringify(res.body))
    assert.equal(res.body.stageName, 'Stitching')
    assert.equal(res.body.viaVoice, true)
    assert.deepEqual(res.body.files.map(f => [f.name, f.kind]), [['Stitching - photo 1', 'photo'], ['Stitching - photo 2', 'photo'], ['Stitching - voice note', 'audio']])
    assert.equal(res.body.place.mapsUrl, 'https://www.google.com/maps?q=26.85,75.8')
    assert.equal(res.body.ai.state, 'off', 'no key on this server: no suggestions, and the update is whole without them')

    const u = await FieldUpdate.findById(res.body.id).lean()
    assert.equal(String(u.coordinatorId), String(coord._id))
    assert.equal(String(u.factoryId), String(a._id))
    assert.equal(String(u.buyerId), String(buyer._id))
    assert.ok(u.visitId)
    assert.equal(u.state, 'new')
    assert.equal(u.deviceAt.toISOString(), '2026-11-23T05:00:00.000Z')

    const docs = await Document.find({ fieldUpdateId: u._id }).sort({ name: 1 }).lean()   // photo 1, photo 2, voice note
    assert.equal(docs.length, 3)
    for (const d of docs) {
      assert.equal(d.type, 'floor_evidence'); assert.equal(d.orderId, 'S-1'); assert.equal(d.stageIndex, 2)
      assert.equal(String(d.mfrId), String(a._id)); assert.equal(String(d.uploadedBy), String(coord._id)); assert.equal(d.internal, true)
    }
    assert.deepEqual(docs.map(d => d.tradioOnly), [false, false, true], 'the recording is Tradio\'s alone')
    assert.equal(docs[0].notes, '240 pieces stitched, blue shade is off')
    assert.equal(docs[2].mimeType, 'audio/webm')

    const thread = await threadOf(a)
    assert.equal(thread.length, 1)
    assert.equal(thread[0].text, '240 pieces stitched, blue shade is off')
    assert.equal(thread[0].internal, true)
    assert.equal(String(thread[0].fieldUpdateId), String(u._id))

    const stage = (await Order.findById('S-1').lean()).assignments[0].stages[2]
    assert.equal(stage.unitsDone ?? 0, 0, 'he reports; the account manager changes the plan')
    assert.ok(!stage.blocked)

    assert.match((await AuditLog.findOne({ action: 'Field Update Added' }).lean()).detail, /Ravi at Factory A: Stitching on S-1, 2 photos, voice note/)
    const told = await Notification.find().lean()
    assert.deepEqual(told.map(n => String(n.toUser)), [String(admin._id)], 'admins are told; the customer is not')
  })

  test('photos alone are enough, and so is a voice note alone', async () => {
    const { a, api, body } = await arrange()
    assert.equal((await api.post('/api/field-updates', body({ text: '', photos: [PNG] }))).status, 201)
    assert.equal((await api.post('/api/field-updates', body({ text: undefined, audio: AUDIO }))).status, 201)
    assert.deepEqual((await threadOf(a)).map(x => x.text), ['1 photo from the floor', 'Voice note from the floor'])
  })

  test('only while checked in at that factory, for a product made there, on a step of its plan', async () => {
    const { a, b, coord, api, body } = await arrange({ checkIn: false })
    const notIn = await api.post('/api/field-updates', body())
    assert.equal(notIn.status, 409); assert.equal(notIn.body.code, 'CHECK_IN_FIRST')
    assert.equal((await api.post('/api/field-updates', body({ mfrId: String(b._id) }))).status, 403, 'not his factory')
    await api.post('/api/visits/check-in', { factoryId: String(a._id), ...AT })
    assert.equal((await api.post('/api/field-updates', body({ orderId: 'NOPE' }))).status, 404)
    assert.equal((await api.post('/api/field-updates', body({ stageIndex: 9 }))).status, 400)
    assert.equal((await api.post('/api/field-updates', body({ stageIndex: '2' }))).status, 400)
    assert.equal((await api.post('/api/field-updates', body({ text: '   ' }))).status, 400, 'nothing to send')
    assert.equal((await api.post('/api/field-updates', body({ text: 'x'.repeat(2001) }))).status, 400)
    assert.equal((await api.post('/api/field-updates', body({ lat: 200 }))).status, 400)
    // Checked out again: no more updates.
    const open = await FactoryVisit.findOne({ coordinatorId: coord._id, closedBy: null }).lean()
    await api.post(`/api/visits/${open._id}/check-out`, AT)
    assert.equal((await api.post('/api/field-updates', body())).status, 409)
    assert.equal(await FieldUpdate.countDocuments(), 0)
    assert.equal(await Document.countDocuments({ fieldUpdateId: { $ne: null } }), 0)
  })

  test('a file must be a real photo or a voice note, and not too many or too big', async () => {
    const { api, body } = await arrange()
    const fakePng = `data:image/png;base64,${Buffer.from('<html><script>alert(1)</script>').toString('base64')}`
    const pdf = `data:application/pdf;base64,${Buffer.from('%PDF-1.4').toString('base64')}`
    const big = `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(1024 * 1024 + 10)]).toString('base64')}`
    for (const photos of [[fakePng], [pdf], [big], ['nope'], [{ $ne: null }], Array(7).fill(PNG), 'x']) {
      assert.equal((await api.post('/api/field-updates', body({ photos }))).status, 400, JSON.stringify(photos).slice(0, 60))
    }
    assert.equal((await api.post('/api/field-updates', body({ audio: PNG }))).status, 400)
    assert.equal(await FieldUpdate.countDocuments(), 0)
  })

  test('the location is kept when the phone gives it and the update goes without it when it does not', async () => {
    const { api, body } = await arrange()
    const res = await api.post('/api/field-updates', body({ lat: undefined, lng: undefined, accuracy: undefined }))
    assert.equal(res.status, 201)
    assert.equal(res.body.place, null)
  })

  test('he sees what he sent today; nobody but a coordinator sends one', async () => {
    const { admin, buyer, a, api, body } = await arrange()
    await api.post('/api/field-updates', body({ photos: [PNG] }))
    const mine = await api.get('/api/field-updates/mine')
    assert.equal(mine.status, 200)
    assert.deepEqual(mine.body.map(u => [u.product, u.stageName, u.files.length]), [['Polo', 'Stitching', 1]])
    for (const who of [admin, buyer, a]) {
      assert.equal((await as(who).post('/api/field-updates', body())).status, 403, who.role)
      assert.equal((await as(who).get('/api/field-updates/mine')).status, 403, who.role)
    }
    assert.equal((await req('POST', '/api/field-updates', { body: body() })).status, 401)
    // The admin's side is not his.
    for (const [m, p] of [['GET', '/api/field-updates'], ['GET', '/api/field-updates/count'], ['POST', '/api/field-updates/x/action'], ['POST', '/api/field-updates/x/release']]) {
      const r = await req(m, p, { token: api.token, ...(m === 'POST' ? { body: {} } : {}) })
      assert.equal(r.status, 403, p); assert.equal(r.body.code, 'COORDINATOR_NOT_ALLOWED', p)
    }
  })
})

describe('who sees an update before and after it is released', () => {
  test('Tradio and the factory it is about; the customer only what an admin releases; the recording never', async () => {
    const { admin, buyer, a, b, api, body } = await arrange()
    const sent = (await api.post('/api/field-updates', body({ photos: [PNG, JPEG], audio: AUDIO }))).body
    const [p1, p2, voice] = sent.files.map(f => f.id)
    const listed = async who => (await as(who).get('/api/documents')).body.filter(d => d.fieldUpdateId).map(d => String(d.id)).sort()
    const opens = async (who, id) => (await as(who).get(`/api/documents/${id}/data`)).status
    const thread = async who => { const o = (await as(who).get('/api/orders/S-1')).body; return o.assignments.flatMap(x => x.stages[2].updates) }

    assert.deepEqual(await listed(admin), [p1, p2, voice].sort())
    assert.deepEqual(await listed(a), [p1, p2].sort(), 'the factory sees the photos of its own work, not the recording')
    assert.deepEqual(await listed(b), [], 'another factory on the same style sees none of it')
    assert.deepEqual(await listed(buyer), [])
    assert.deepEqual([await opens(buyer, p1), await opens(buyer, voice), await opens(b, p1), await opens(a, voice), await opens(a, p1), await opens(admin, voice)], [403, 403, 403, 403, 200, 200])
    assert.equal((await thread(buyer)).length, 0, 'his note is not in what the customer is sent')
    assert.deepEqual((await thread(a)).map(x => [x.text, x.fromFloor]), [['240 pieces stitched, blue shade is off', true]])
    assert.equal((await thread(admin))[0].internal, true)
    // He hears his own recording.
    assert.equal((await api.get(`/api/documents/${voice}/data`)).status, 200)

    await Notification.deleteMany({})
    const bad = await as(admin).post(`/api/field-updates/${sent.id}/release`, { photoIds: [voice] })
    assert.equal(bad.status, 400, 'the recording cannot be released')
    const rel = await as(admin).post(`/api/field-updates/${sent.id}/release`, { photoIds: [p1] })
    assert.equal(rel.status, 200, JSON.stringify(rel.body))
    assert.equal(rel.body.released, true)
    assert.deepEqual(await listed(buyer), [p1])
    assert.deepEqual([await opens(buyer, p1), await opens(buyer, p2), await opens(buyer, voice)], [200, 403, 403])
    assert.deepEqual((await thread(buyer)).map(x => x.text), ['240 pieces stitched, blue shade is off'])
    assert.equal((await thread(buyer))[0].internal, undefined, 'a customer is not told what was once internal')
    assert.deepEqual((await Notification.find().lean()).map(n => String(n.toUser)), [String(buyer._id)], 'the customer hears of it only now')
    assert.match((await AuditLog.findOne({ action: 'Field Update Released' }).lean()).detail, /shown to the customer with 1 photo/)
    // Releasing again adds a photo and does not tell the customer twice.
    await as(admin).post(`/api/field-updates/${sent.id}/release`, { photoIds: [p2] })
    assert.deepEqual(await listed(buyer), [p1, p2].sort())
    assert.equal(await Notification.countDocuments(), 1)
  })
})

describe('what the AI makes of an update', () => {
  test('its reading is kept as suggestions; a wrong step or an unknown colour is dropped', async () => {
    const { api, body, a } = await arrange()
    let seen = null
    setFieldUpdateExtractor(async (text, photos, ctx) => {
      seen = { text, photos: photos.length, ctx }
      return { summary: '240 stitched; blue shade off', suggested_stage_index: 1, units: 240, status_hint: 'started', result: null, issues: ['blue shade is off'], colours: [{ name: 'olivine', note: 'ok' }, { name: 'Magenta', note: '?' }], confidence: 0.82 }
    })
    const sent = await api.post('/api/field-updates', body({ photos: [PNG] }))
    assert.equal(sent.body.ai.state, 'pending')
    await FieldUpdate.updateOne({ _id: sent.body.id }, { $set: { 'ai.state': 'pending' } })
    const ai = await readFieldUpdate(sent.body.id)
    assert.equal(seen.text, '240 pieces stitched, blue shade is off')
    assert.equal(seen.photos, 1)
    assert.deepEqual([seen.ctx.client, seen.ctx.product, seen.ctx.stageIndex, seen.ctx.stageName], ['Cocoblu', 'Polo', 2, 'Stitching'])
    assert.deepEqual(seen.ctx.colours, ['Olivine', 'Peacot'])
    assert.deepEqual(seen.ctx.steps.map(s => s.name), [...STEPS, 'Delivery'], 'the whole plan, with its Delivery step')
    assert.deepEqual([ai.state, ai.units, ai.statusHint, ai.suggestedStageIndex, ai.confidence], ['done', 240, 'started', 1, 0.82])
    assert.deepEqual(ai.colours, [{ name: 'Olivine', note: 'ok' }])
    // The note on the step is now what the AI read; his own words are kept beside it.
    const note = (await threadOf(a))[0]
    assert.deepEqual([note.text, note.original, note.aiRead], ['240 stitched; blue shade off', '240 pieces stitched, blue shade is off', true])

    setFieldUpdateExtractor(async () => ({ summary: 's', suggested_stage_index: 99, units: null, status_hint: null, result: 'fail', issues: [], colours: [], confidence: 0.4 }))
    const second = await api.post('/api/field-updates', body())
    await FieldUpdate.updateOne({ _id: second.body.id }, { $set: { 'ai.state': 'pending' } })
    const ai2 = await readFieldUpdate(second.body.id)
    assert.deepEqual([ai2.suggestedStageIndex, ai2.result], [null, 'fail'], 'a step that is not on the plan is not suggested')

    setFieldUpdateExtractor(async () => null)
    const third = await api.post('/api/field-updates', body())
    await FieldUpdate.updateOne({ _id: third.body.id }, { $set: { 'ai.state': 'pending' } })
    assert.equal(await readFieldUpdate(third.body.id), null)
    assert.equal((await FieldUpdate.findById(third.body.id).lean()).ai.state, 'failed')
    setFieldUpdateExtractor(async () => { throw new Error('boom') })
    const fourth = await api.post('/api/field-updates', body())
    await FieldUpdate.updateOne({ _id: fourth.body.id }, { $set: { 'ai.state': 'pending' } })
    assert.equal(await readFieldUpdate(fourth.body.id), null)
    assert.equal((await FieldUpdate.findById(fourth.body.id).lean()).ai.state, 'failed')
    // The plan was never touched by any of it.
    assert.equal((await Order.findById('S-1').lean()).assignments[0].stages[2].unitsDone ?? 0, 0)
  })
})

describe('the account manager\'s side', () => {
  test('the list, how long each has waited, the count for the menu, and the filters', async () => {
    const { admin, buyer, a, coord, api, body } = await arrange()
    const one = (await api.post('/api/field-updates', body({ photos: [PNG] }))).body
    const two = (await api.post('/api/field-updates', body({ stageIndex: 1, text: 'cutting started' }))).body
    await FieldUpdate.updateOne({ _id: one.id }, { $set: { at: new Date(Date.now() - 5 * 60 * 60000) } })
    const adm = as(admin)
    const list = await adm.get('/api/field-updates')
    assert.equal(list.status, 200)
    assert.equal(list.body.waiting, 2)
    const first = list.body.updates.find(u => u.id === one.id)
    assert.deepEqual([first.coordinatorName, first.factoryName, first.product, first.buyerCompany, first.stageName], ['Ravi', 'Factory A', 'Polo', 'Cocoblu', 'Stitching'])
    assert.ok(first.waitingMinutes >= 299 && first.waitingMinutes <= 301, String(first.waitingMinutes))
    assert.equal(first.visitAway, false)
    assert.equal(first.files.length, 1)
    assert.deepEqual((await adm.get('/api/field-updates/count')).body, { new: 2 })
    assert.equal((await adm.get(`/api/field-updates?factoryId=${a._id}`)).body.updates.length, 2)
    assert.equal((await adm.get(`/api/field-updates?coordinatorId=${coord._id}&buyerId=${buyer._id}&orderId=S-1`)).body.updates.length, 2)
    assert.equal((await adm.get(`/api/field-updates?buyerId=${a._id}`)).body.updates.length, 0)
    assert.equal((await adm.get('/api/field-updates?state=actioned')).body.updates.length, 0)
    assert.equal((await adm.get('/api/field-updates?state=whatever')).status, 400)
    assert.equal((await adm.get('/api/field-updates?factoryId=x')).status, 400)
    for (const who of [buyer, a]) for (const p of ['/api/field-updates', '/api/field-updates/count']) assert.equal((await as(who).get(p)).status, 403)
    assert.ok(two.id)
  })

  test('moving an update to the right step takes its files and its note along', async () => {
    const { admin, a, api, body } = await arrange()
    const sent = (await api.post('/api/field-updates', body({ photos: [PNG], audio: AUDIO }))).body
    const moved = await as(admin).post(`/api/field-updates/${sent.id}/move`, { stageIndex: 0 })
    assert.equal(moved.status, 200, JSON.stringify(moved.body))
    assert.deepEqual([moved.body.stageIndex, moved.body.stageName, moved.body.movedFromStageIndex], [0, 'Fabric Inhouse', 2])
    assert.deepEqual(moved.body.files.map(f => f.name), ['Fabric Inhouse - photo 1', 'Fabric Inhouse - voice note'])
    assert.deepEqual((await Document.find({ fieldUpdateId: sent.id }).lean()).map(d => d.stageIndex), [0, 0])
    assert.equal((await threadOf(a, 2)).length, 0)
    assert.deepEqual((await threadOf(a, 0)).map(x => x.text), ['240 pieces stitched, blue shade is off'])
    assert.match((await AuditLog.findOne({ action: 'Field Update Moved' }).lean()).detail, /from Stitching to Fabric Inhouse by Asha/)
    assert.equal((await as(admin).post(`/api/field-updates/${sent.id}/move`, { stageIndex: 9 })).status, 400)
    // Moved again, it still remembers where he first put it; released afterwards, the note on the new step is the one shown.
    await as(admin).post(`/api/field-updates/${sent.id}/move`, { stageIndex: 1 })
    assert.equal((await FieldUpdate.findById(sent.id).lean()).movedFromStageIndex, 2)
    await as(admin).post(`/api/field-updates/${sent.id}/release`, { photoIds: [] })
    assert.equal((await threadOf(a, 1))[0].internal, false)
  })

  test('confirming changes the step through the ordinary admin route; the update is then marked as dealt with', async () => {
    const { admin, a, api, body } = await arrange()
    const sent = (await api.post('/api/field-updates', body())).body
    const adm = as(admin)
    const stage = await adm.post(`/api/orders/S-1/assignments/${a._id}/stages/2`, { blocked: true, blockedReason: 'blue shade is off' })
    assert.equal(stage.status, 200, JSON.stringify(stage.body))
    const done = await adm.post(`/api/field-updates/${sent.id}/action`, { applied: ['Issue: blue shade is off'] })
    assert.equal(done.status, 200)
    assert.deepEqual([done.body.state, done.body.applied, done.body.actionedByName, done.body.waitingMinutes], ['actioned', ['Issue: blue shade is off'], 'Asha', null])
    assert.match((await AuditLog.findOne({ action: 'Field Update Actioned' }).lean()).detail, /S-1, Stitching: Issue: blue shade is off \(by Asha\)/)
    assert.deepEqual((await adm.get('/api/field-updates/count')).body, { new: 0 })
    assert.equal((await adm.post(`/api/field-updates/${sent.id}/action`, { applied: 'x' })).status, 400)

    const other = (await api.post('/api/field-updates', body({ text: 'nothing new' }))).body
    assert.equal((await adm.post(`/api/field-updates/${other.id}/dismiss`, {})).body.state, 'dismissed')
    assert.equal((await adm.post(`/api/field-updates/${other.id}/reopen`, {})).body.state, 'new')
    assert.equal((await adm.post('/api/field-updates/nope/action', {})).status, 404)
    assert.equal((await adm.post('/api/field-updates/6650f0f0f0f0f0f0f0f0f0f0/dismiss', {})).status, 404)
  })
})

describe('where the files are kept', () => {
  test('with a file driver the bytes leave the database and still open through the same checks', async () => {
    const kept = new Map()
    registerFileDriver('memory', {
      put: async (key, buffer) => { kept.set(key, buffer); return { bucket: 'test-bucket' } },
      get: async key => kept.get(key),
      remove: async key => { kept.delete(key) },
    })
    process.env.FILE_STORE = 'memory'
    const { admin, buyer, api, body } = await arrange()
    const sent = (await api.post('/api/field-updates', body({ photos: [PNG] }))).body
    const doc = await Document.findOne({ fieldUpdateId: sent.id }).lean()
    assert.equal(doc.dataUrl, null, 'nothing in the database')
    assert.deepEqual([doc.storage.driver, doc.storage.bucket], ['memory', 'test-bucket'])
    assert.match(doc.storage.key, new RegExp(`^field-updates/\\d{4}/\\d{2}/${sent.id}/${doc._id}\\.png$`))
    assert.equal(kept.size, 1)
    const opened = await as(admin).get(`/api/documents/${doc._id}/data`)
    assert.equal(opened.status, 200)
    assert.equal(opened.body.dataUrl, PNG)
    assert.equal((await as(buyer).get(`/api/documents/${doc._id}/data`)).status, 403, 'the same rule decides who may open it')
    assert.ok(!JSON.stringify((await as(admin).get('/api/documents')).body).includes('test-bucket'), 'where it is kept is not sent to the browser')
  })

  test('a driver that is not set up, or that fails, saves nothing at all', async () => {
    const { api, body } = await arrange()
    process.env.FILE_STORE = 'nowhere'
    const off = await api.post('/api/field-updates', body({ photos: [PNG] }))
    assert.equal(off.status, 503)
    assert.equal((await api.post('/api/field-updates', body())).status, 201, 'words alone need no file store')
    await FieldUpdate.deleteMany({})

    let n = 0
    registerFileDriver('flaky', { put: async () => { if (++n === 2) throw new Error('disk full'); return {} }, get: async () => Buffer.alloc(1), remove: async () => {} })
    process.env.FILE_STORE = 'flaky'
    const res = await api.post('/api/field-updates', body({ photos: [PNG, JPEG] }))
    assert.equal(res.status, 500)
    assert.equal(await FieldUpdate.countDocuments(), 0)
    assert.equal(await Document.countDocuments({ fieldUpdateId: { $ne: null } }), 0)
  })
})

describe('Zoho Stratus as the place the files are kept', () => {
  // A stand-in for zcatalyst-sdk-node: the real one works only inside Catalyst, from the headers its gateway adds.
  const fakeCatalyst = (store, seen) => ({
    initialize(obj, opts) {
      seen.push({ projectId: obj.headers['x-zc-projectid'] ?? null, scope: opts?.scope })
      return { stratus: () => ({ bucket: name => ({
        putObject: async (key, body, o) => { if (store.has(`${name}/${key}`)) throw new Error('exists'); store.set(`${name}/${key}`, { body, contentType: o?.contentType }); return true },
        getObject: async key => { const f = store.get(`${name}/${key}`); if (!f) throw new Error('no such object'); return Readable.from([f.body.subarray(0, 10), f.body.subarray(10)]) },
        deleteObject: async key => { store.delete(`${name}/${key}`); return { message: 'Object Deletion successful.' } },
      }) }) }
    },
  })

  test('a photo goes to the bucket, not the database, and opens again through the app\'s own checks', async () => {
    const store = new Map(); const seen = []
    setCatalystSdk(fakeCatalyst(store, seen))
    process.env.FILE_STORE = 'stratus'; process.env.STRATUS_BUCKET = 'tradio-test-floor'
    try {
      const { admin, buyer, api, body } = await arrange()
      const sent = await api.post('/api/field-updates', body({ photos: [PNG], audio: AUDIO }))
      assert.equal(sent.status, 201, JSON.stringify(sent.body))
      const docs = await Document.find({ fieldUpdateId: sent.body.id }).sort({ name: 1 }).lean()   // the photo, then the voice note
      assert.deepEqual(docs.map(d => [d.dataUrl, d.storage.driver, d.storage.bucket]), [[null, 'stratus', 'tradio-test-floor'], [null, 'stratus', 'tradio-test-floor']])
      assert.equal(store.size, 2)
      assert.deepEqual([...store.values()].map(f => f.contentType).sort(), ['audio/webm', 'image/png'])
      assert.ok(seen.every(s => s.scope === 'admin'))
      const opened = await as(admin).get(`/api/documents/${docs[0]._id}/data`)
      assert.equal(opened.status, 200)
      assert.equal(opened.body.dataUrl, PNG, 'the stream is read back whole')
      assert.equal((await as(buyer).get(`/api/documents/${docs[0]._id}/data`)).status, 403)
    } finally { setCatalystSdk(null); delete process.env.STRATUS_BUCKET }
  })

  test('without a bucket name nothing is sent and nothing is half-saved', async () => {
    setCatalystSdk(fakeCatalyst(new Map(), []))
    process.env.FILE_STORE = 'stratus'; delete process.env.STRATUS_BUCKET
    try {
      const { api, body } = await arrange()
      assert.equal((await api.post('/api/field-updates', body({ photos: [PNG] }))).status, 503)
      assert.equal(await FieldUpdate.countDocuments(), 0)
    } finally { setCatalystSdk(null) }
  })

  test('a master admin can prove it works on a server before switching it on; the result is audited', async () => {
    const store = new Map()
    setCatalystSdk(fakeCatalyst(store, []))
    process.env.STRATUS_BUCKET = 'tradio-test-floor'
    try {
      const { admin, api } = await arrange()
      const master = as(await makeMaster({ name: 'Ankit' }))
      const where = await master.get('/api/field-updates/storage')
      assert.deepEqual(where.body, { fileStore: 'mongo', bucket: 'tradio-test-floor', problem: null })
      const ok = await master.post('/api/field-updates/storage/check', {})
      assert.equal(ok.status, 200, JSON.stringify(ok.body))
      assert.deepEqual(ok.body.steps, [{ step: 'write', ok: true }, { step: 'read', ok: true }, { step: 'remove', ok: true }])
      assert.equal(store.size, 0, 'the check leaves nothing behind')
      assert.match((await AuditLog.findOne({ action: 'Storage Checked' }).lean()).detail, /tradio-test-floor: works \(by Ankit\)/)

      setCatalystSdk({ initialize: () => { throw new Error('Failed to parse object') } })
      const bad = await master.post('/api/field-updates/storage/check', {})
      assert.equal(bad.status, 502)
      assert.deepEqual(bad.body.steps.map(s => [s.step, s.ok]), [['write', false], ['read', false], ['remove', false]])
      assert.match(bad.body.steps[0].error, /Failed to parse object/)

      for (const who of [admin]) assert.equal((await as(who).post('/api/field-updates/storage/check', {})).status, 403, 'master only')
      assert.equal((await api.get('/api/field-updates/storage')).body.code, 'COORDINATOR_NOT_ALLOWED')
    } finally { setCatalystSdk(null); delete process.env.STRATUS_BUCKET }
  })
})
