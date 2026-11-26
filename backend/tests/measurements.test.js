import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'
import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as } from './helpers/client.js'
import { makeAdmin, makeBuyer, makeMfr, makeCoordinator, orderPayload } from './helpers/factories.js'
import { Document } from '../src/models/Document.js'
import { MeasurementSession } from '../src/models/MeasurementSession.js'
import { AuditLog } from '../src/models/AuditLog.js'
import { setMeasurementExtractor } from '../src/routes/measurements.js'
import { coordinatorMay } from '../src/lib/coordinator.js'

before(async () => { await startTestDb(); await startServer() })
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(async () => { await clearDb(); setMeasurementExtractor(null) })

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

  test('the next garment is added to the same workbook; Final QC goes on a tab of its own; the style\'s own sheet stays the spec', async () => {
    const { a, body, src } = await arrange()
    const first = await as(a).post('/api/measurements', body())
    const second = await as(a).post('/api/measurements', body({ size: 'L', points: [{ index: 0, measured: 18.5 }] }))
    const third = await as(a).post('/api/measurements', body({ stage: 'final', points: [{ index: 2, measured: 25.5 }] }))
    assert.deepEqual([first.status, second.status, third.status], [201, 201, 201])
    assert.deepEqual([first.body.wroteTab, second.body.wroteTab, third.body.wroteTab], ['PP', 'PP', 'FINAL QC M'])
    const wb = await open((await as(a).get(`/api/documents/${third.body.documentId}/data`)).body.dataUrl)
    assert.deepEqual(wb.worksheets.map(w => w.name), ['PP', 'FINAL QC M'])
    assert.deepEqual([9, 10, 11].map(c => wb.getWorksheet('PP').getCell(5, c).value), ['M MEASURED', 'L MEASURED', 'L REVIEW'])
    assert.equal((await Document.findById(third.body.documentId).lean()).measurementLabel, 'final_qc')
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
    assert.deepEqual([['GET', '/api/measurements?orderId=S-1'], ['GET', '/api/measurements/spec?orderId=S-1'], ['POST', '/api/measurements'], ['POST', '/api/measurements/read'], ['POST', '/api/measurements/abc/release']].map(([m, u]) => coordinatorMay(m, u)), [true, true, true, true, false])
  })
})
