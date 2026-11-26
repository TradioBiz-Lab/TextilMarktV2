import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'
import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as } from './helpers/client.js'
import { makeAdmin, makeBuyer, makeMfr, makeCoordinator, orderPayload } from './helpers/factories.js'
import { Document } from '../src/models/Document.js'
import { MeasurementSession } from '../src/models/MeasurementSession.js'
import { AuditLog } from '../src/models/AuditLog.js'
import { setMeasurementExtractor, setMeasurementPhotoExtractor } from '../src/routes/measurements.js'
import { coordinatorMay } from '../src/lib/coordinator.js'

before(async () => { await startTestDb(); await startServer() })
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(async () => { await clearDb(); setMeasurementExtractor(null); setMeasurementPhotoExtractor(null) })

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
// A sheet in the real layout with one PP tab: three points, sizes S M L, the review column after M.
async function sheet() {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('PP')
  ws.getCell('F3').value = 'SAMPLE STAGE'; ws.getCell('I3').value = 'PP SAMPLE'
  ;['MEASUREMENT POINTS', 'Tolerance ( + / - )'].forEach((h, i) => { ws.getCell(4, 3 + i).value = h })
  ;['S', 'M', 'PP REVIEW', 'L'].forEach((h, i) => { ws.getCell(5, 5 + i).value = h })
  ;[['SHOULDER SEAM TO SEAM', 0.38, 17.5, 18, null, 18.5], ['CHEST 1" BELOW ARMHOLE', 0.5, 41, 43, null, 45], ['SLEEVE LENGTH', 0.25, 25.25, 25.5, null, 25.75]].forEach((r, i) => r.forEach((v, j) => { if (v != null) ws.getCell(6 + i, 3 + j).value = v }))
  return `data:${XLSX};base64,${Buffer.from(await wb.xlsx.writeBuffer()).toString('base64')}`
}
const open = async dataUrl => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(dataUrl.split(',')[1], 'base64')); return wb }

// Style S-1 is made at factories A and B. The coordinator is allocated A only.
async function arrange({ withSheet = true } = {}) {
  const admin = await makeAdmin({ name: 'Asha' }); const buyer = await makeBuyer({ company: 'Cocoblu' })
  const a = await makeMfr({ company: 'Factory A', name: 'Sandeep' }); const b = await makeMfr({ company: 'Factory B' })
  const p = orderPayload({ id: 'S-1', buyerId: buyer._id, mfrId: a._id, totalQty: 100, product: 'Corduroy Shirt' })
  p.assignments = [{ mid: String(a._id), qty: 60 }, { mid: String(b._id), qty: 40 }]
  assert.equal((await as(admin).post('/api/orders', p)).status, 201)
  const coord = await makeCoordinator({ name: 'Ravi', assignedFactories: [a] })
  const src = withSheet ? await Document.create({ type: 'measurements', measurementLabel: 'customer_submission', name: 'Spec', orderId: 'S-1', uploadedBy: admin._id, issueDate: new Date(), fileName: 'spec.xlsx', mimeType: XLSX, dataUrl: await sheet() }) : null
  const body = (o = {}) => ({ orderId: 'S-1', mfrId: String(a._id), stage: 'pp', size: 'M', tab: 'PP', points: [{ index: 0, measured: 18 }, { index: 1, measured: 42 }], ...o })
  return { admin, buyer, a, b, coord, src, body }
}

describe('the style\'s sheet as data', () => {
  test('everyone on the style reads its tabs, sizes and points; the factories listed are the ones he may record at', async () => {
    const { admin, buyer, a, b, coord } = await arrange()
    const res = await as(coord).get('/api/measurements/spec?orderId=S-1')
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.deepEqual([res.body.document.fileName, res.body.tabs.length, res.body.tabs[0].stage, res.body.tabs[0].sizes, res.body.tabs[0].sampleSize], ['spec.xlsx', 1, 'pp', ['S', 'M', 'L'], 'M'])
    assert.deepEqual(res.body.tabs[0].points.map(p => [p.name, p.tol, p.values.M]), [['SHOULDER SEAM TO SEAM', 0.38, 18], ['CHEST 1" BELOW ARMHOLE', 0.5, 43], ['SLEEVE LENGTH', 0.25, 25.5]])
    assert.deepEqual(res.body.factories.map(f => f.name), ['Factory A'])
    assert.deepEqual((await as(admin).get('/api/measurements/spec?orderId=S-1')).body.factories.map(f => f.name), ['Factory A', 'Factory B'])
    assert.deepEqual((await as(b).get('/api/measurements/spec?orderId=S-1')).body.factories.map(f => f.name), ['Factory B'])
    assert.deepEqual((await as(buyer).get('/api/measurements/spec?orderId=S-1')).body.factories, [])
    for (const who of [await makeBuyer(), await makeMfr(), await makeCoordinator({ assignedFactories: [await makeMfr()] })]) assert.equal((await as(who).get('/api/measurements/spec?orderId=S-1')).status, 403)
    assert.equal((await as(a).get('/api/measurements/spec?orderId=nope')).status, 404)
  })
  test('no sheet, or one that is not an Excel file, is said plainly', async () => {
    const { admin, coord } = await arrange({ withSheet: false })
    const none = await as(coord).get('/api/measurements/spec?orderId=S-1')
    assert.deepEqual([none.status, /no measurement sheet yet/.test(none.body.error)], [404, true])
    await Document.create({ type: 'measurements', measurementLabel: 'customer_submission', name: 'Spec', orderId: 'S-1', uploadedBy: admin._id, issueDate: new Date(), fileName: 'spec.pdf', mimeType: 'application/pdf', dataUrl: 'data:application/pdf;base64,JVBERi0xLjQK' })
    const pdf = await as(coord).get('/api/measurements/spec?orderId=S-1')
    assert.deepEqual([pdf.status, /not an Excel file/.test(pdf.body.error)], [422, true])
    // A style whose Locked Measurement is a PDF but which also has the Excel: the Excel is what is measured against.
    await Document.updateMany({ orderId: 'S-1' }, { $set: { locked: true } })
    const xl = await Document.create({ type: 'measurements', measurementLabel: 'customer_submission', name: 'Spec', orderId: 'S-1', uploadedBy: admin._id, issueDate: new Date(), fileName: 'spec.xlsx', mimeType: XLSX, dataUrl: await sheet() })
    const both = await as(coord).get('/api/measurements/spec?orderId=S-1')
    assert.deepEqual([both.status, both.body.document.id, both.body.document.locked], [200, String(xl._id), false])
  })
})

describe('reading what he said', () => {
  test('the reader is given the sheet\'s points with the required values in his size; its answer is tidied, nothing is saved', async () => {
    const { coord, buyer } = await arrange()
    let seen = null
    setMeasurementExtractor(async (transcript, points, opts) => { seen = { transcript, points, opts }; return { values: [{ index: 1, value: 42.5, heard: 'chest 42 and a half' }, { index: 0, value: 18, heard: 'shoulder 18' }, { index: 1, value: 42, heard: 'sorry 42' }, { index: 9, value: 5, heard: 'x' }], unmatched: [{ heard: 'cuff 9', value: 9 }] } })
    const res = await as(coord).post('/api/measurements/read', { orderId: 'S-1', tab: 'PP', size: 'm', transcript: 'shoulder 18 chest 42 and a half sorry 42 cuff 9' })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.deepEqual(seen.points, [{ name: 'SHOULDER SEAM TO SEAM', spec: 18 }, { name: 'CHEST 1" BELOW ARMHOLE', spec: 43 }, { name: 'SLEEVE LENGTH', spec: 25.5 }])
    assert.deepEqual(res.body.values.map(v => [v.index, v.value]), [[0, 18], [1, 42]], 'the last value said for a point; a point not on the sheet dropped')
    assert.deepEqual(res.body.unmatched, [{ heard: 'cuff 9', value: 9 }])
    assert.equal(await MeasurementSession.countDocuments(), 0)
    // "ok" and a difference are turned into measurements here, with the sheet's own required value.
    setMeasurementExtractor(async () => ({ values: [{ index: 0, kind: 'ok', value: null, heard: 'shoulder theek hai' }, { index: 1, kind: 'diff', value: -0.5, heard: 'chest half inch kam' }, { index: 2, kind: 'value', value: 0, heard: 'ok' }], unmatched: [] }))
    assert.deepEqual((await as(coord).post('/api/measurements/read', { orderId: 'S-1', tab: 'PP', size: 'M', transcript: 'x' })).body.values.map(v => [v.index, v.value]), [[0, 18], [1, 42.5], [2, 25.5]])
    setMeasurementExtractor(async () => ({ values: [{ index: 1, value: -0.25, heard: '-1/4' }, { index: 0, kind: 'diff', value: -500, heard: 'nonsense' }], unmatched: [] }))
    const odd = (await as(coord).post('/api/measurements/read', { orderId: 'S-1', tab: 'PP', size: 'M', transcript: 'x' })).body
    assert.deepEqual([odd.values.map(v => [v.index, v.value]), odd.unmatched], [[[1, 42.75]], [{ heard: 'nonsense', value: -500 }]], 'a negative number is a difference; one that makes no measurement is handed back')
    assert.equal((await as(buyer).post('/api/measurements/read', { orderId: 'S-1', tab: 'PP', size: 'M', transcript: 'x' })).status, 403)
    assert.equal((await as(coord).post('/api/measurements/read', { orderId: 'S-1', tab: 'PP', size: 'XXL', transcript: 'x' })).status, 400)
    assert.equal((await as(coord).post('/api/measurements/read', { orderId: 'S-1', tab: 'PP', size: 'M', transcript: ' ' })).status, 400)
    setMeasurementExtractor(async () => null)
    assert.equal((await as(coord).post('/api/measurements/read', { orderId: 'S-1', tab: 'PP', size: 'M', transcript: 'x' })).status, 502)
    setMeasurementExtractor(null)
    const off = await as(coord).post('/api/measurements/read', { orderId: 'S-1', tab: 'PP', size: 'M', transcript: 'x' })
    assert.deepEqual([off.status, off.body.code], [503, 'READER_OFF'])
  })
})

describe('reading a photo of his handwritten sheet', () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mNk+M9Qz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC'
  test('the reader is given the photos and the sheet\'s points; its answer is tidied like a spoken one; nothing is saved', async () => {
    const { coord, a, buyer } = await arrange()
    let seen = null
    setMeasurementPhotoExtractor(async (photos, points, opts) => { seen = { photos, points, opts }; return { values: [{ index: 0, value: 18.5, heard: 'Sh 18 1/2' }, { index: 2, value: 25.5, heard: 'slv ok' }, { index: 8, value: 3, heard: '?' }], unmatched: [{ heard: 'smudged line', value: null }] } })
    const res = await as(coord).post('/api/measurements/read-photo', { orderId: 'S-1', tab: 'PP', size: 'M', photos: [PNG, PNG] })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.deepEqual([seen.photos.length, seen.photos[0].mimeType, Buffer.isBuffer(seen.photos[0].buffer)], [2, 'image/png', true])
    assert.deepEqual(seen.points.map(p => p.spec), [18, 43, 25.5])
    assert.deepEqual(res.body, { values: [{ index: 0, value: 18.5, heard: 'Sh 18 1/2' }, { index: 2, value: 25.5, heard: 'slv ok' }], unmatched: [{ heard: 'smudged line', value: null }] })
    assert.deepEqual([await MeasurementSession.countDocuments(), await Document.countDocuments({ type: { $ne: 'measurements' } })], [0, 0], 'neither a session nor the photo is kept')
    assert.equal((await as(a).post('/api/measurements/read-photo', { orderId: 'S-1', tab: 'PP', size: 'M', photos: [PNG] })).status, 200, 'the factory\'s own QC person too')
    assert.equal((await as(buyer).post('/api/measurements/read-photo', { orderId: 'S-1', tab: 'PP', size: 'M', photos: [PNG] })).status, 403)
    for (const bad of [{ photos: [] }, { photos: [PNG, PNG, PNG, PNG] }, { photos: ['data:image/png;base64,AAAA'] }, { photos: ['data:application/pdf;base64,JVBERi0xLjQK'] }, { size: '5XL' }]) {
      assert.equal((await as(coord).post('/api/measurements/read-photo', { orderId: 'S-1', tab: 'PP', size: 'M', photos: [PNG], ...bad })).status, 400, JSON.stringify(bad).slice(0, 60))
    }
    setMeasurementPhotoExtractor(async () => null)
    assert.equal((await as(coord).post('/api/measurements/read-photo', { orderId: 'S-1', tab: 'PP', size: 'M', photos: [PNG] })).status, 502)
    setMeasurementPhotoExtractor(null)
    assert.deepEqual([(await as(coord).post('/api/measurements/read-photo', { orderId: 'S-1', tab: 'PP', size: 'M', photos: [PNG] })).body.code], ['READER_OFF'])
    // A session whose values came from a photo says so.
    const saved = await as(coord).post('/api/measurements', { orderId: 'S-1', mfrId: String(a._id), stage: 'pp', size: 'M', tab: 'PP', points: [{ index: 0, measured: 18.5 }], method: 'photo' })
    assert.deepEqual([saved.status, saved.body.session.method], [201, 'photo'])
  })
})

describe('saving a measured garment', () => {
  test('the differences are worked out on the server, the workbook is made and kept on the style, Tradio is told', async () => {
    const { admin, a, coord, body } = await arrange()
    const res = await as(coord).post('/api/measurements', body({ method: 'voice', transcript: 'shoulder 18 chest 42', points: [{ index: 0, measured: 18, diff: 99, ok: false }, { index: 1, measured: 42 }, { index: 2, measured: null }] }))
    assert.equal(res.status, 201, JSON.stringify(res.body))
    const s = res.body.session
    assert.deepEqual([s.stage, s.stageName, s.size, s.byName, s.byRole, s.method, s.measuredCount, s.outOfTolerance, s.released], ['pp', 'PP sample', 'M', 'Ravi', 'coordinator', 'voice', 2, 1, false])
    assert.deepEqual(s.points.map(p => [p.spec, p.measured, p.diff, p.ok]), [[18, 18, 0, true], [43, 42, -1, false], [25.5, null, null, null]])
    assert.match(res.body.fileName, /^Corduroy-Shirt-pp-M-\d{4}-\d{2}-\d{2}\.xlsx$/)
    const doc = await Document.findById(res.body.documentId).lean()
    assert.deepEqual([doc.type, doc.measurementLabel, doc.internal, String(doc.mfrId), String(doc.measurementSessionId), doc.mimeType], ['measurements', 'pp_approval', true, String(a._id), s.id, XLSX])
    const file = await as(coord).get(`/api/documents/${doc._id}/data`)
    assert.equal(file.status, 200)
    const ws = (await open(file.body.dataUrl)).getWorksheet('PP')
    assert.deepEqual([ws.getCell(6, 7).value, ws.getCell(7, 7).value, ws.getCell(8, 7).value], ['ok', -1, null], 'the sheet\'s own review column')
    assert.deepEqual([ws.getCell(5, 9).value, ws.getCell(6, 9).value, ws.getCell(7, 9).value], ['M MEASURED', 18, 42])
    assert.match((await AuditLog.findOne({ action: 'Measurement Recorded' }).lean()).detail, /S-1: PP sample, size M, 2 of 3 points, 1 outside tolerance \(by Ravi\)/)
    const told = (await as(admin).get('/api/notifications')).body.map(n => n.msg)
    assert.ok(told.some(m => /Ravi measured Corduroy Shirt \(PP sample, size M\): 1 point outside tolerance/.test(m)), told.join(' | '))
  })

  test('the Excel holds the measured step only: another size of that step is added to it, another step gets a file of its own', async () => {
    const { a, body, src } = await arrange()
    const first = await as(a).post('/api/measurements', body())
    const second = await as(a).post('/api/measurements', body({ size: 'L', points: [{ index: 0, measured: 18.5 }] }))
    const third = await as(a).post('/api/measurements', body({ stage: 'final', points: [{ index: 2, measured: 25.5 }] }))
    const inline = await as(a).post('/api/measurements', body({ stage: 'inline', size: 'L', points: [{ index: 1, measured: 45 }] }))
    assert.deepEqual([first.status, second.status, third.status, inline.status], [201, 201, 201, 201])
    assert.deepEqual([first.body.wroteTab, second.body.wroteTab, third.body.wroteTab, inline.body.wroteTab], ['PP', 'PP', 'FINAL QC', 'INLINE QC'])
    const file = async r => open((await as(a).get(`/api/documents/${r.body.documentId}/data`)).body.dataUrl)
    const pp = await file(second)
    assert.deepEqual(pp.worksheets.map(w => w.name), ['PP'])
    assert.deepEqual([9, 10, 11].map(c => pp.getWorksheet('PP').getCell(5, c).value), ['M MEASURED', 'L MEASURED', 'L REVIEW'], 'both sizes of the PP step')
    const fq = await file(third)
    assert.deepEqual(fq.worksheets.map(w => w.name), ['FINAL QC'])
    const ws = fq.getWorksheet('FINAL QC')
    assert.deepEqual([ws.getCell('I3').value, ws.getCell(4, 3).value, ws.getCell(5, 7).value, ws.getCell(5, 9).value, ws.getCell(8, 9).value, ws.getCell(6, 9).value], ['FINAL QC', 'MEASUREMENT POINTS', 'FINAL QC REVIEW', 'M MEASURED', 25.5, null], 'the sheet\'s format, with nothing of the PP step in it')
    assert.deepEqual([(await file(inline)).worksheets.map(w => w.name), inline.body.session.stageName], [['INLINE QC'], 'Inline QC'])
    assert.deepEqual((await Promise.all([third, inline].map(r => Document.findById(r.body.documentId).lean()))).map(d => d.measurementLabel), ['final_qc', 'inline_qc'])
    assert.equal((await as(a).post('/api/measurements', body({ stage: 'production', points: [{ index: 0, measured: 18 }] }))).status, 400, 'production is not a step: fit, PP, inline and final QC only')
    assert.equal((await as(a).get('/api/measurements/spec?orderId=S-1')).body.document.id, String(src._id), 'a recorded copy never becomes the spec')
  })

  test('who may record, and what is refused', async () => {
    const { admin, buyer, a, b, coord, body } = await arrange()
    assert.equal((await as(coord).post('/api/measurements', body({ mfrId: String(b._id) }))).status, 403, 'a factory that is not his')
    assert.equal((await as(a).post('/api/measurements', body({ mfrId: String(b._id) }))).status, 403, 'another factory\'s split')
    assert.equal((await as(buyer).post('/api/measurements', body())).status, 403)
    assert.equal((await as(admin).post('/api/measurements', body({ mfrId: String(b._id) }))).status, 201, 'Tradio at any factory making it')
    assert.equal((await as(a).post('/api/measurements', body())).status, 201, 'the factory on its own split')
    for (const bad of [{ stage: 'bulk' }, { size: '5XL' }, { tab: 'FIT' }, { points: [] }, { points: [{ index: 0, measured: null }] }, { points: [{ index: 7, measured: 1 }] }, { points: [{ index: 0, measured: 'x' }] }, { points: [{ index: 0, measured: 5000 }] }, { mfrId: 'x' }]) {
      assert.equal((await as(a).post('/api/measurements', body(bad))).status, 400, JSON.stringify(bad))
    }
  })
})

describe('saving as he goes, and picking it up again', () => {
  test('one unfinished session per style, factory, stage and size: saved again it is replaced, anyone who may record there resumes it', async () => {
    const { admin, buyer, a, b, coord, body } = await arrange()
    await MeasurementSession.init()
    const first = await as(coord).post('/api/measurements/draft', body({ points: [{ index: 0, measured: 18 }] }))
    assert.equal(first.status, 200, JSON.stringify(first.body))
    assert.deepEqual([first.body.draft.status, first.body.draft.measuredCount, first.body.draft.documentId, first.body.draft.byName, first.body.draft.tab], ['draft', 1, null, 'Ravi', 'PP'])
    const second = await as(a).post('/api/measurements/draft', body({ points: [{ index: 0, measured: 18 }, { index: 1, measured: 42 }], method: 'voice', transcript: 'chest 42' }))
    assert.deepEqual([second.body.draft.id, second.body.draft.measuredCount, second.body.draft.outOfTolerance, second.body.draft.byName], [first.body.draft.id, 2, 1, 'Sandeep'], 'the same session, picked up from another login')
    assert.equal(await MeasurementSession.countDocuments(), 1)
    assert.equal(await Document.countDocuments({ measurementSessionId: { $ne: null } }), 0, 'no workbook until he finishes')
    await as(coord).post('/api/measurements/draft', body({ size: 'L', points: [{ index: 0, measured: 18.5 }] }))
    await as(admin).post('/api/measurements/draft', body({ mfrId: String(b._id), points: [{ index: 0, measured: 17 }] }))
    const list = async who => (await as(who).get('/api/measurements?orderId=S-1')).body.map(s => `${s.status} ${s.size} ${s.measuredCount}`).sort()
    assert.deepEqual(await list(coord), ['draft L 1', 'draft M 2'], 'another size is its own session; another factory\'s is not his')
    assert.equal((await list(admin)).length, 3)
    assert.deepEqual(await list(buyer), [], 'the customer never sees unfinished work')
    assert.equal((await as(admin).get('/api/notifications')).body.filter(n => /measured/.test(n.msg)).length, 0, 'nobody is told about an auto-save')
    assert.equal((await as(admin).post(`/api/measurements/${first.body.draft.id}/release`)).status, 409)
    assert.equal((await as(coord).post('/api/measurements/draft', body({ mfrId: String(b._id), points: [{ index: 0, measured: 1 }] }))).status, 403)
    assert.equal((await as(buyer).post('/api/measurements/draft', body())).status, 403)
    assert.equal((await as(coord).post('/api/measurements/draft', body({ points: [{ index: 0, measured: 'x' }] }))).status, 400)
  })
  test('finishing turns the unfinished session into the record, with its workbook; sending no values discards it', async () => {
    const { a, coord, body } = await arrange()
    const draft = (await as(coord).post('/api/measurements/draft', body({ points: [{ index: 0, measured: 18 }] }))).body.draft
    const done = await as(a).post('/api/measurements', body({ points: [{ index: 0, measured: 18 }, { index: 1, measured: 43 }, { index: 2, measured: 25.5 }] }))
    assert.equal(done.status, 201, JSON.stringify(done.body))
    assert.deepEqual([done.body.session.id, done.body.session.status, done.body.session.measuredCount, !!done.body.session.documentId], [draft.id, 'final', 3, true])
    assert.equal(await MeasurementSession.countDocuments(), 1)
    // The next garment of the same size starts a new unfinished session; the finished one is left as it is.
    const next = (await as(coord).post('/api/measurements/draft', body({ points: [{ index: 1, measured: 44 }] }))).body.draft
    assert.notEqual(next.id, draft.id)
    assert.deepEqual((await as(coord).get('/api/measurements?orderId=S-1')).body.map(s => s.status).sort(), ['draft', 'final'])
    const gone = await as(coord).post('/api/measurements/draft', body({ points: [] }))
    assert.deepEqual([gone.status, gone.body.draft], [200, null])
    assert.deepEqual((await as(coord).get('/api/measurements?orderId=S-1')).body.map(s => s.status), ['final'])
  })
})

describe('who sees a record', () => {
  test('Tradio and the factory at once, a coordinator at his factories, the customer only once Tradio shares it', async () => {
    const { admin, buyer, a, b, coord, body } = await arrange()
    const mine = await as(a).post('/api/measurements', body())
    await as(admin).post('/api/measurements', body({ mfrId: String(b._id), size: 'S' }))
    const list = async who => (await as(who).get('/api/measurements?orderId=S-1')).body
    assert.equal((await list(admin)).length, 2)
    assert.deepEqual((await list(a)).map(s => s.size), ['M'])
    assert.deepEqual((await list(coord)).map(s => s.size), ['M'])
    assert.deepEqual((await list(b)).map(s => s.size), ['S'])
    assert.deepEqual(await list(buyer), [])
    const docId = mine.body.documentId
    assert.equal((await as(buyer).get(`/api/documents/${docId}/data`)).status, 403)
    assert.ok(!(await as(buyer).get('/api/documents')).body.some(d => d.id === docId))
    const inList = (await as(a).get('/api/documents')).body.find(d => d.id === docId)
    assert.deepEqual([inList.measurementLabel, inList.internal, inList.measurementSessionId], ['pp_approval', true, mine.body.session.id])
    for (const who of [buyer, a, coord]) assert.equal((await as(who).post(`/api/measurements/${mine.body.session.id}/release`)).status, 403)
    const shared = await as(admin).post(`/api/measurements/${mine.body.session.id}/release`)
    assert.deepEqual([shared.status, shared.body.released], [200, true])
    assert.deepEqual((await list(buyer)).map(s => [s.size, s.outOfTolerance]), [['M', 1]])
    assert.equal((await as(buyer).get(`/api/documents/${docId}/data`)).status, 200)
    assert.ok((await as(buyer).get('/api/notifications')).body.some(n => /Tradio shared the PP sample measurements of Corduroy Shirt \(size M\)/.test(n.msg)))
  })
  test('the coordinator\'s list of allowed requests has the four he needs and no release', () => {
    assert.deepEqual([['GET', '/api/measurements?orderId=S-1'], ['GET', '/api/measurements/spec?orderId=S-1'], ['POST', '/api/measurements'], ['POST', '/api/measurements/read'], ['POST', '/api/measurements/read-photo'], ['POST', '/api/measurements/draft'], ['POST', '/api/measurements/abc/release']].map(([m, u]) => coordinatorMay(m, u)), [true, true, true, true, true, true, false])
  })
})
