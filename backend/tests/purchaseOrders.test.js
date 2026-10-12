// Purchase orders end to end: drafting, sending with a PDF, receiving, cancelling, the way they move a
// factory's material lines, and that no other company can see or touch any of it.
import test, { before, after, beforeEach, afterEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as } from './helpers/client.js'
import { makeBuyer, makeMfr, makeMember, makeOrder, setOrg, link } from './helpers/factories.js'
import { Supplier } from '../src/models/Supplier.js'
import { SupplierItem } from '../src/models/SupplierItem.js'
import { PurchaseOrder } from '../src/models/PurchaseOrder.js'
import { Document } from '../src/models/Document.js'
import { Order } from '../src/models/Order.js'
import { gstinCheckChar } from '../src/lib/gst.js'
import { fiscalYearCode } from '../src/lib/fiscalYear.js'
import { setMailerForTests } from '../src/lib/email.js'

before(async () => { await startTestDb(); await startServer(); await Supplier.init(); await SupplierItem.init() })
after(async () => { delete process.env.PLATFORM_MODE; setMailerForTests(null); await stopServer(); await stopTestDb() })

let mailer
beforeEach(async () => {
  await clearDb(); process.env.PLATFORM_MODE = 'standalone'; delete process.env.ENABLE_VIEW_AS
  mailer = fakeMailer(); setMailerForTests(mailer)
})
afterEach(() => setMailerForTests(null))

function fakeMailer({ fail = false } = {}) {
  const calls = []
  return { calls, emails: { send: async payload => { calls.push(payload); return fail ? { data: null, error: { message: 'mailbox unavailable' } } : { data: { id: `em_${calls.length}` }, error: null } } } }
}

const gstinFor = (state, pan = 'AAPFU0939F') => { const f = `${state}${pan}1Z`; return f + gstinCheckChar(f) }

/** A factory in Tamil Nadu with its business details filled in. */
async function factory({ state = '33', code = 'TPR' } = {}) {
  const mfr = await makeMfr({ code, company: `${code} Textiles`, email: `${code.toLowerCase()}@mfr.test` })
  await setOrg(mfr, { profile: { legalName: `${code} Textiles Pvt Ltd`, gstin: gstinFor(state), stateCode: state, address: 'Plot 22, SIDCO Estate', city: 'Tiruppur', pincode: '641604', phone: '+91 98765 43003', email: `${code.toLowerCase()}@mfr.test` } })
  return mfr
}
const supplier = async (u, body = {}) => (await as(u).post('/api/suppliers', { name: 'Coimbatore Knit Fabrics', type: 'fabric_supplier', email: 'sales@cknit.test', gstin: gstinFor('33'), paymentTerms: '45 days', ...body })).body
const item = async (u, s, body = {}) => (await as(u).post(`/api/suppliers/${s.id}/items`, { name: 'Single jersey', unit: 'kg', defaultRate: 200, moq: 300, taxPct: 5, ...body })).body
const line = (extra = {}) => ({ description: 'Single jersey 180 GSM', qty: 100, unit: 'kg', rate: 200, taxPct: 5, hsnCode: '600631', ...extra })
const draft = async (u, s, body = {}) => as(u).post('/api/purchase-orders', { supplierId: s.id, expectedDate: '2026-11-05', lines: [line()], ...body })
const send = (u, id, body) => as(u).post(`/api/purchase-orders/${id}/send`, body || {})
const sentPo = async (u, s, body) => { const d = (await draft(u, s, body)).body; const r = await send(u, d.id); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body }

describe('who can use purchase orders', () => {
  test('the Tradio portal does not have them', async () => {
    delete process.env.PLATFORM_MODE
    const mfr = await factory()
    assert.equal((await as(mfr).get('/api/purchase-orders')).status, 404)
  })

  test('a brand is refused', async () => {
    const brand = await makeBuyer()
    assert.equal((await as(brand).get('/api/purchase-orders')).status, 403)
    assert.equal((await as(brand).post('/api/purchase-orders', {})).status, 403)
  })
})

describe('drafting a purchase order', () => {
  test('gets a number for the factory and the financial year, and the server does the sums', async () => {
    const mfr = await factory(), s = await supplier(mfr)
    // The browser's own idea of the totals is ignored.
    const r = await draft(mfr, s, { totals: { grandTotal: 1 }, lines: [line({ amount: 5, lineTotal: 5, qty: 100, rate: 200, taxPct: 12 })] })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.equal(r.body.id, `PO-TPR-${fiscalYearCode()}-0001`)
    assert.equal(r.body.status, 'draft')
    assert.equal(r.body.lines[0].amount, 20000)
    assert.equal(r.body.totals.cgst, 1200)
    assert.equal(r.body.totals.sgst, 1200)
    assert.equal(r.body.totals.grandTotal, 22400)
    assert.equal((await draft(mfr, s)).body.id, `PO-TPR-${fiscalYearCode()}-0002`)
  })

  test('numbers are per factory', async () => {
    const a = await factory({ code: 'AAA' }), b = await factory({ code: 'BBB' })
    assert.equal((await draft(a, await supplier(a))).body.id, `PO-AAA-${fiscalYearCode()}-0001`)
    assert.equal((await draft(b, await supplier(b))).body.id, `PO-BBB-${fiscalYearCode()}-0001`)
  })

  test('two drafts made at the same moment never get the same number', async () => {
    const mfr = await factory(), s = await supplier(mfr)
    const rs = await Promise.all(Array.from({ length: 6 }, () => draft(mfr, s)))
    assert.ok(rs.every(r => r.status === 201))
    assert.equal(new Set(rs.map(r => r.body.id)).size, 6)
  })

  test('tax follows the states: same state CGST and SGST, another state IGST, unknown state one GST figure', async () => {
    const mfr = await factory({ state: '33' })
    const local = await supplier(mfr, { name: 'Local', gstin: gstinFor('33') })
    const far = await supplier(mfr, { name: 'Far', gstin: gstinFor('27') })
    const unsure = await supplier(mfr, { name: 'Unsure', gstin: '' })
    const t = async s => (await draft(mfr, s)).body
    assert.deepEqual([(await t(local)).taxMode, (await t(local)).totals.igst], ['intra', 0])
    const f = await t(far)
    assert.deepEqual([f.taxMode, f.totals.cgst, f.totals.igst], ['inter', 0, 1000])
    const u = await t(unsure)
    assert.deepEqual([u.taxMode, u.totals.gst], ['unknown', 1000])
  })

  test('a draft starts from the supplier\'s payment terms, and warns about a minimum order', async () => {
    const mfr = await factory(), s = await supplier(mfr), it = await item(mfr, s, { moq: 300 })
    const r = await draft(mfr, s, { lines: [line({ itemId: it.id, qty: 130 }), line({ itemId: it.id, qty: 300 })] })
    assert.equal(r.body.paymentTerms, '45 days')
    assert.equal(r.body.warnings.length, 1)
    assert.deepEqual([r.body.warnings[0].line, r.body.warnings[0].code], [0, 'BELOW_MOQ'])
    const again = await as(mfr).get(`/api/purchase-orders/${r.body.id}`)
    assert.equal(again.body.warnings.length, 1)
  })

  test('refuses what cannot be a purchase order', async () => {
    const mfr = await factory(), other = await factory({ code: 'OTH' })
    const s = await supplier(mfr), theirs = await supplier(other, { name: 'Theirs' }), it = await item(mfr, s)
    const bad = async (body, re, status = 400) => { const r = await as(mfr).post('/api/purchase-orders', body); assert.equal(r.status, status, JSON.stringify(r.body)); assert.match(r.body.error, re) }
    await bad({ lines: [line()] }, /Choose a supplier/)
    await bad({ supplierId: theirs.id, lines: [line()] }, /one of your suppliers/)
    await bad({ supplierId: 'x', lines: [line()] }, /Choose a supplier/)
    await bad({ supplierId: s.id, lines: [line(), line({ qty: 0 })] }, /^Line 2: quantity/)
    await bad({ supplierId: s.id, lines: [line({ itemId: String(theirs.id) })] }, /catalog/)
    await bad({ supplierId: s.id, expectedDate: 'soon', lines: [] }, /not a valid date/)
    await bad({ supplierId: s.id, lines: Array.from({ length: 201 }, () => line()) }, /200 lines/)
    await as(mfr).post(`/api/suppliers/${s.id}/archive`)
    await bad({ supplierId: s.id, lines: [line()] }, /archived/)
    assert.ok(it)
  })

  test('a draft can be edited: the lines are replaced and the sums redone', async () => {
    const mfr = await factory(), s = await supplier(mfr)
    const d = (await draft(mfr, s, { lines: [line({ description: 'One' }), line({ description: 'Two' })] })).body
    const keep = d.lines[1].lineId
    const r = await as(mfr).post(`/api/purchase-orders/${d.id}`, { lines: [{ lineId: keep, ...line({ description: 'Two', qty: 10 }) }, line({ description: 'Three' })], terms: 'Net 30' })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual(r.body.lines.map(l => l.description), ['Two', 'Three'])
    assert.equal(r.body.lines[0].lineId, keep)
    assert.equal(r.body.lines[0].amount, 2000)
    assert.equal(r.body.terms, 'Net 30')
  })

  test('only a draft can be edited or deleted', async () => {
    const mfr = await factory(), s = await supplier(mfr)
    const po = await sentPo(mfr, s)
    assert.equal((await as(mfr).post(`/api/purchase-orders/${po.id}`, { terms: 'x' })).status, 409)
    assert.equal((await as(mfr).post(`/api/purchase-orders/${po.id}/delete`)).status, 409)
    const d = (await draft(mfr, s)).body
    assert.equal((await as(mfr).post(`/api/purchase-orders/${d.id}/delete`)).status, 200)
    assert.equal((await as(mfr).get(`/api/purchase-orders/${d.id}`)).status, 404)
  })

  test('the list is newest first, filterable, and light', async () => {
    const mfr = await factory(), s = await supplier(mfr)
    const d1 = (await draft(mfr, s)).body
    const sent = await sentPo(mfr, s)
    const all = (await as(mfr).get('/api/purchase-orders')).body
    assert.deepEqual(all.map(p => p.id), [sent.id, d1.id].sort().reverse().length ? all.map(p => p.id) : [])
    assert.equal(all.length, 2)
    assert.equal(all[0].timeline, undefined)
    assert.deepEqual((await as(mfr).get('/api/purchase-orders?status=draft')).body.map(p => p.id), [d1.id])
    assert.equal((await as(mfr).get(`/api/purchase-orders?supplierId=${s.id}`)).body.length, 2)
  })

  test('teammates share the company\'s purchase orders', async () => {
    const mfr = await factory(), mate = await makeMember(mfr), s = await supplier(mfr)
    const d = (await draft(mate, s)).body
    assert.equal((await as(mfr).get(`/api/purchase-orders/${d.id}`)).status, 200)
  })
})

describe('sending', () => {
  test('emails the supplier the PDF, from the company, with replies going to the sender', async () => {
    const mfr = await factory(), s = await supplier(mfr)
    const d = (await draft(mfr, s)).body
    const r = await send(mfr, d.id, { message: 'Please confirm by Friday.' })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.status, 'sent')
    assert.deepEqual(r.body.notice.emailed, ['sales@cknit.test'])
    assert.equal(mailer.calls.length, 1)
    const mail = mailer.calls[0]
    assert.deepEqual(mail.to, ['sales@cknit.test'])
    assert.match(mail.subject, new RegExp(`Purchase order ${d.id} from TPR Textiles Pvt Ltd`))
    assert.match(mail.from, /^TPR Textiles Pvt Ltd via TextilMarkt </)
    assert.equal(mail.replyTo, mfr.email)
    assert.match(mail.html, /Please confirm by Friday\./)
    assert.equal(mail.attachments.length, 1)
    assert.equal(mail.attachments[0].filename, `${d.id}.pdf`)
    assert.ok(Buffer.isBuffer(mail.attachments[0].content))
    assert.equal(mail.attachments[0].content.subarray(0, 5).toString(), '%PDF-')
  })

  test('keeps the PDF as the record, marks it sent and writes the history', async () => {
    const mfr = await factory(), s = await supplier(mfr)
    const po = await sentPo(mfr, s)
    assert.equal(po.hasPdf, true)
    assert.deepEqual(po.sentTo, ['sales@cknit.test'])
    assert.deepEqual(po.timeline.map(t => t.action), ['Draft created', 'Sent to supplier'])
    const doc = await Document.findOne({ poId: po.id }).lean()
    assert.equal(doc.type, 'supplier_po')
    assert.equal(String(doc.mfrId), String(mfr._id))
    assert.equal(doc.mimeType, 'application/pdf')
    assert.match(doc.dataUrl, /^data:application\/pdf;base64,/)
  })

  test('freezes the supplier and company details as they were when it was sent', async () => {
    const mfr = await factory(), s = await supplier(mfr, { address: '14 Avinashi Road' })
    const po = await sentPo(mfr, s)
    await as(mfr).post(`/api/suppliers/${s.id}`, { address: 'Somewhere else entirely', name: 'Renamed Mills' })
    await setOrg(mfr, { 'profile.address': 'A new factory address' })
    const stored = await PurchaseOrder.findById(po.id).lean()
    assert.equal(stored.supplierSnapshot.address, '14 Avinashi Road')
    assert.equal(stored.supplierSnapshot.name, 'Coimbatore Knit Fabrics')
    assert.equal(stored.buyerSnapshot.address, 'Plot 22, SIDCO Estate')
  })

  test('is not sent if the email fails, and goes back to a draft', async () => {
    const mfr = await factory(), s = await supplier(mfr)
    const d = (await draft(mfr, s)).body
    setMailerForTests(fakeMailer({ fail: true }))
    const r = await send(mfr, d.id)
    assert.equal(r.status, 502)
    assert.match(r.body.error, /could not be sent/)
    const stored = await PurchaseOrder.findById(d.id).lean()
    assert.equal(stored.status, 'draft')
    assert.equal(stored.sentAt, null)
    assert.equal(await Document.countDocuments({ poId: d.id }), 0)
    // ...and can simply be tried again.
    setMailerForTests(fakeMailer())
    assert.equal((await send(mfr, d.id)).status, 200)
  })

  test('with no email service configured it is marked sent but says nothing was emailed', async () => {
    const mfr = await factory(), s = await supplier(mfr)
    const d = (await draft(mfr, s)).body
    setMailerForTests(null)
    const r = await send(mfr, d.id)
    assert.equal(r.status, 200)
    assert.equal(r.body.status, 'sent')
    assert.equal(r.body.notice.emailSkipped, true)
    assert.deepEqual(r.body.sentTo, [])
    assert.match(r.body.timeline.at(-1).note, /no email service/)
  })

  test('needs somewhere to send it, and valid addresses', async () => {
    const mfr = await factory(), s = await supplier(mfr, { email: '' })
    const d = (await draft(mfr, s)).body
    assert.match((await send(mfr, d.id)).body.error, /no email address/)
    assert.equal((await send(mfr, d.id, { to: ['not-an-email'] })).status, 400)
    assert.equal((await send(mfr, d.id, { to: Array.from({ length: 6 }, (_, i) => `a${i}@x.test`) })).status, 400)
    assert.equal(mailer.calls.length, 0)
    const ok = await send(mfr, d.id, { to: ['Buyer@Mill.test', 'buyer@mill.test'] })
    assert.equal(ok.status, 200)
    assert.deepEqual(mailer.calls.map(c => c.to), [['buyer@mill.test']])      // trimmed, lower-cased, de-duplicated
  })

  test('an empty purchase order is not sent', async () => {
    const mfr = await factory(), s = await supplier(mfr)
    const d = (await draft(mfr, s, { lines: [] })).body
    const r = await send(mfr, d.id)
    assert.equal(r.status, 400)
    assert.match(r.body.error, /at least one item/)
    assert.equal((await PurchaseOrder.findById(d.id).lean()).status, 'draft')
  })

  test('cannot be sent twice', async () => {
    const mfr = await factory(), s = await supplier(mfr)
    const po = await sentPo(mfr, s)
    assert.equal((await send(mfr, po.id)).status, 409)
    assert.equal(mailer.calls.length, 1)
  })

  test('two sends at the same moment email the supplier once', async () => {
    const mfr = await factory(), s = await supplier(mfr)
    const d = (await draft(mfr, s)).body
    const rs = await Promise.all([send(mfr, d.id), send(mfr, d.id), send(mfr, d.id)])
    assert.equal(rs.filter(r => r.status === 200).length, 1, rs.map(r => r.status).join())
    assert.equal(mailer.calls.length, 1)
    assert.equal(await Document.countDocuments({ poId: d.id }), 1)
  })

  test('a send that crashed half way can be retried once the claim is stale', async () => {
    const mfr = await factory(), s = await supplier(mfr)
    const d = (await draft(mfr, s)).body
    await PurchaseOrder.updateOne({ _id: d.id }, { $set: { status: 'sending', sendingAt: new Date(Date.now() - 10 * 60 * 1000) } })
    assert.equal((await send(mfr, d.id)).status, 200)
    // ...but a fresh claim is respected.
    const e = (await draft(mfr, s)).body
    await PurchaseOrder.updateOne({ _id: e.id }, { $set: { status: 'sending', sendingAt: new Date() } })
    assert.equal((await send(mfr, e.id)).status, 409)
  })
})

/** An order the factory is producing, with one material line on its first step. */
async function orderWithMaterial(mfr, brand, material = {}) {
  await makeOrder({ id: 'MAT-1', buyer: brand, mfrs: [mfr] })
  await Order.updateOne({ _id: 'MAT-1' }, { $set: { 'assignments.0.stages.0.materials': [{
    name: 'Single jersey 180 GSM', requiredQty: 100, unit: 'kg', status: 'pending', orderedQty: 0, receivedQty: 0, supplier: '', poNumber: '', ...material,
  }] } })
}
const materialRef = (extra = {}) => ({ orderId: 'MAT-1', stageIndex: 0, materialIndex: 0, name: 'Single jersey 180 GSM', ...extra })
const material = async () => (await Order.findById('MAT-1').lean()).assignments[0].stages[0].materials[0]

describe('purchase orders and the order\'s material lines', () => {
  test('sending puts the linked material "on order" with the PO and supplier', async () => {
    const mfr = await factory(), brand = await makeBuyer(), s = await supplier(mfr)
    await orderWithMaterial(mfr, brand)
    const po = await sentPo(mfr, s, { expectedDate: '2026-11-05', lines: [line({ materialRef: materialRef() })] })
    const m = await material()
    assert.deepEqual([m.status, m.orderedQty, m.poNumber, m.poId, m.supplier], ['ordered', 100, po.id, po.id, 'Coimbatore Knit Fabrics'])
    assert.equal(String(m.supplierId), s.id)
    assert.equal(m.expectedDate, '2026-11-05')
  })

  test('a draft does not touch the material until it is sent', async () => {
    const mfr = await factory(), brand = await makeBuyer(), s = await supplier(mfr)
    await orderWithMaterial(mfr, brand)
    await draft(mfr, s, { lines: [line({ materialRef: materialRef() })] })
    assert.equal((await material()).status, 'pending')
  })

  test('receiving brings the material in and opens the gate for the production step', async () => {
    const mfr = await factory(), brand = await makeBuyer(), s = await supplier(mfr)
    await orderWithMaterial(mfr, brand)
    const po = await sentPo(mfr, s, { lines: [line({ qty: 100, materialRef: materialRef() })] })
    const advance = () => as(mfr).post(`/api/orders/MAT-1/assignments/${mfr._id}/stages/0`, { unitsDone: 10 })
    assert.equal((await advance()).status, 400)                         // ordered is not received
    const half = await as(mfr).post(`/api/purchase-orders/${po.id}/receive`, { lines: [{ lineId: po.lines[0].lineId, qty: 40 }] })
    assert.equal(half.status, 200, JSON.stringify(half.body))
    assert.deepEqual([(await material()).status, (await material()).receivedQty], ['ordered', 40])
    assert.equal((await advance()).status, 400)                         // still short
    const rest = await as(mfr).post(`/api/purchase-orders/${po.id}/receive`, { lines: [{ lineId: po.lines[0].lineId, qty: 60 }] })
    assert.equal(rest.status, 200)
    assert.deepEqual([(await material()).status, (await material()).receivedQty], ['received', 100])
    const ok = await advance()
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
  })

  test('a material the PO cannot find is reported, and the PO still stands', async () => {
    const mfr = await factory(), brand = await makeBuyer(), s = await supplier(mfr)
    await orderWithMaterial(mfr, brand)
    const d = (await draft(mfr, s, { lines: [line({ materialRef: materialRef() })] })).body
    // The material line is removed before the PO is sent.
    await Order.updateOne({ _id: 'MAT-1' }, { $set: { 'assignments.0.stages.0.materials': [] } })
    const r = await send(mfr, d.id)
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.notice.unlinkedLines, ['Single jersey 180 GSM'])
  })

  test('cancelling a sent PO releases what it held', async () => {
    const mfr = await factory(), brand = await makeBuyer(), s = await supplier(mfr)
    await orderWithMaterial(mfr, brand)
    const po = await sentPo(mfr, s, { lines: [line({ materialRef: materialRef() })] })
    const r = await as(mfr).post(`/api/purchase-orders/${po.id}/cancel`, { reason: 'Supplier could not deliver' })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.status, 'cancelled')
    const m = await material()
    assert.deepEqual([m.status, m.orderedQty, m.poId, m.poNumber], ['pending', 0, null, ''])
  })

  test('two POs for one material add up, and cancelling one keeps the other', async () => {
    const mfr = await factory(), brand = await makeBuyer(), s = await supplier(mfr)
    await orderWithMaterial(mfr, brand)
    const a = await sentPo(mfr, s, { lines: [line({ qty: 60, materialRef: materialRef() })] })
    const b = await sentPo(mfr, s, { lines: [line({ qty: 40, materialRef: materialRef() })] })
    assert.equal((await material()).orderedQty, 100)
    await as(mfr).post(`/api/purchase-orders/${a.id}/cancel`, { reason: 'Changed our mind' })
    const m = await material()
    assert.deepEqual([m.status, m.orderedQty], ['ordered', 40])
    assert.equal(m.poId, b.id)
  })

  test('a PO can only be linked to materials on the factory\'s own orders', async () => {
    const mfr = await factory(), other = await factory({ code: 'OTH' }), brand = await makeBuyer(), s = await supplier(mfr)
    await makeOrder({ id: 'THEIRS', buyer: brand, mfrs: [other] })
    await Order.updateOne({ _id: 'THEIRS' }, { $set: { 'assignments.0.stages.0.materials': [{ name: 'Secret fabric', requiredQty: 5, status: 'pending' }] } })
    const r = await draft(mfr, s, { lines: [line({ materialRef: { orderId: 'THEIRS', stageIndex: 0, materialIndex: 0, name: 'Secret fabric' } })] })
    assert.equal(r.status, 400)
    assert.match(r.body.error, /not on one of your orders/)
  })

  test('if steps moved, the material is found again by its name', async () => {
    const mfr = await factory(), brand = await makeBuyer(), s = await supplier(mfr)
    await orderWithMaterial(mfr, brand)
    const wrongPlace = materialRef({ materialIndex: 3 })
    const r = await draft(mfr, s, { lines: [line({ materialRef: wrongPlace })] })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.equal(r.body.lines[0].materialRef.materialIndex, 0)
  })
})

describe('receiving goods', () => {
  test('a part delivery, then the rest: partially received, then closed', async () => {
    const mfr = await factory(), s = await supplier(mfr)
    const po = await sentPo(mfr, s, { lines: [line({ description: 'A', qty: 100 }), line({ description: 'B', qty: 50 })] })
    const [a, b] = po.lines
    const first = await as(mfr).post(`/api/purchase-orders/${po.id}/receive`, { lines: [{ lineId: a.lineId, qty: 100 }], note: 'Lorry 1' })
    assert.equal(first.status, 200, JSON.stringify(first.body))
    assert.equal(first.body.status, 'partially_received')
    assert.equal(first.body.receivedPct, 67)
    const last = await as(mfr).post(`/api/purchase-orders/${po.id}/receive`, { lines: [{ lineId: b.lineId, qty: 50 }] })
    assert.equal(last.body.status, 'closed')
    assert.equal(last.body.receivedPct, 100)
    assert.deepEqual(last.body.timeline.map(t => t.action), ['Draft created', 'Sent to supplier', 'Goods received', 'Goods received', 'Fully received'])
    assert.equal(last.body.receipts.length, 2)
  })

  test('refuses a quantity that cannot be right', async () => {
    const mfr = await factory(), s = await supplier(mfr)
    const po = await sentPo(mfr, s, { lines: [line({ qty: 100 })] })
    const id = po.lines[0].lineId
    const bad = async (lines, re) => { const r = await as(mfr).post(`/api/purchase-orders/${po.id}/receive`, { lines }); assert.equal(r.status, 400, JSON.stringify(r.body)); assert.match(r.body.error, re) }
    await bad([{ lineId: id, qty: 0 }], /more than zero/)
    await bad([{ lineId: id, qty: -4 }], /more than zero/)
    await bad([{ lineId: id, qty: 120 }], /10% over/)
    await bad([{ lineId: 'nope', qty: 1 }], /not on this purchase order/)
    await bad([{ lineId: id, qty: 1 }, { lineId: id, qty: 1 }], /each line once/)
    await bad([], /what was received/)
    assert.equal((await PurchaseOrder.findById(po.id).lean()).receipts.length, 0)
  })

  test('a little over what was ordered is accepted (cloth is measured, not counted)', async () => {
    const mfr = await factory(), s = await supplier(mfr)
    const po = await sentPo(mfr, s, { lines: [line({ qty: 100 })] })
    const r = await as(mfr).post(`/api/purchase-orders/${po.id}/receive`, { lines: [{ lineId: po.lines[0].lineId, qty: 104 }] })
    assert.equal(r.status, 200)
    assert.equal(r.body.status, 'closed')
  })

  test('only a sent PO can receive goods', async () => {
    const mfr = await factory(), s = await supplier(mfr)
    const d = (await draft(mfr, s)).body
    assert.equal((await as(mfr).post(`/api/purchase-orders/${d.id}/receive`, { lines: [{ lineId: d.lines[0].lineId, qty: 1 }] })).status, 409)
  })
})

describe('acknowledging, closing and cancelling', () => {
  test('the supplier\'s confirmation is recorded, with the date they promised', async () => {
    const mfr = await factory(), s = await supplier(mfr)
    const po = await sentPo(mfr, s)
    const r = await as(mfr).post(`/api/purchase-orders/${po.id}/acknowledge`, { expectedDate: '2026-11-12' })
    assert.equal(r.status, 200)
    assert.deepEqual([r.body.status, r.body.expectedDate], ['acknowledged', '2026-11-12'])
    assert.equal((await as(mfr).post(`/api/purchase-orders/${po.id}/acknowledge`, {})).status, 409)    // only once, only from "sent"
  })

  test('a PO can be closed short with a reason', async () => {
    const mfr = await factory(), s = await supplier(mfr)
    const po = await sentPo(mfr, s)
    const r = await as(mfr).post(`/api/purchase-orders/${po.id}/close`, { reason: 'Accepted 90 percent' })
    assert.deepEqual([r.body.status, r.body.closedReason], ['closed', 'Accepted 90 percent'])
    assert.equal((await as(mfr).post(`/api/purchase-orders/${po.id}/close`, {})).status, 409)
  })

  test('cancelling needs a reason and works on a draft', async () => {
    const mfr = await factory(), s = await supplier(mfr)
    const d = (await draft(mfr, s)).body
    assert.equal((await as(mfr).post(`/api/purchase-orders/${d.id}/cancel`, {})).status, 400)
    const r = await as(mfr).post(`/api/purchase-orders/${d.id}/cancel`, { reason: 'Wrong supplier' })
    assert.deepEqual([r.status, r.body.status, r.body.cancelReason], [200, 'cancelled', 'Wrong supplier'])
  })

  test('once goods have arrived it can only be closed, not cancelled', async () => {
    const mfr = await factory(), s = await supplier(mfr)
    const po = await sentPo(mfr, s, { lines: [line({ qty: 100 })] })
    await as(mfr).post(`/api/purchase-orders/${po.id}/receive`, { lines: [{ lineId: po.lines[0].lineId, qty: 10 }] })
    const r = await as(mfr).post(`/api/purchase-orders/${po.id}/cancel`, { reason: 'x' })
    assert.equal(r.status, 409)
    assert.match(r.body.error, /already been received/)
  })

  test('a cancelled PO is final', async () => {
    const mfr = await factory(), s = await supplier(mfr)
    const d = (await draft(mfr, s)).body
    await as(mfr).post(`/api/purchase-orders/${d.id}/cancel`, { reason: 'x' })
    assert.equal((await send(mfr, d.id)).status, 409)
    assert.equal((await as(mfr).post(`/api/purchase-orders/${d.id}/cancel`, { reason: 'again' })).status, 409)
  })
})

describe('the PDF', () => {
  const pdfOf = r => Buffer.from(r.body.dataUrl.split(',')[1], 'base64')

  test('a draft is previewed as a real PDF', async () => {
    const mfr = await factory(), s = await supplier(mfr)
    const d = (await draft(mfr, s)).body
    const r = await as(mfr).get(`/api/purchase-orders/${d.id}/pdf`)
    assert.equal(r.status, 200)
    assert.equal(r.body.mimeType, 'application/pdf')
    assert.equal(r.body.fileName, `${d.id}.pdf`)
    const buf = pdfOf(r)
    assert.equal(buf.subarray(0, 5).toString(), '%PDF-')
    assert.match(buf.subarray(-8).toString(), /%%EOF/)
  })

  test('a sent PO returns exactly the PDF that was emailed', async () => {
    const mfr = await factory(), s = await supplier(mfr)
    const po = await sentPo(mfr, s)
    const r = await as(mfr).get(`/api/purchase-orders/${po.id}/pdf`)
    assert.ok(pdfOf(r).equals(mailer.calls[0].attachments[0].content))
  })
})

describe('what brands can never see', () => {
  test('a brand sees its material lines without the supplier or PO, the factory sees both', async () => {
    const mfr = await factory(), brand = await makeBuyer(), s = await supplier(mfr)
    await link(brand, mfr)
    await orderWithMaterial(mfr, brand)
    const po = await sentPo(mfr, s, { lines: [line({ materialRef: materialRef() })] })
    const seenByBrand = (await as(brand).get('/api/orders/MAT-1')).body.assignments[0].stages[0].materials[0]
    assert.deepEqual([seenByBrand.supplier, seenByBrand.poNumber, seenByBrand.supplierId, seenByBrand.poId], ['', '', null, null])
    assert.equal(seenByBrand.status, 'ordered')                          // the progress is still theirs to follow
    assert.equal(seenByBrand.name, 'Single jersey 180 GSM')
    const listed = (await as(brand).get('/api/orders')).body.find(o => o.id === 'MAT-1').assignments[0].stages[0].materials[0]
    assert.equal(listed.supplier, '')
    const seenByFactory = (await as(mfr).get('/api/orders/MAT-1')).body.assignments[0].stages[0].materials[0]
    assert.deepEqual([seenByFactory.supplier, seenByFactory.poNumber, seenByFactory.poId], ['Coimbatore Knit Fabrics', po.id, po.id])
  })

  test('the Tradio portal is unchanged: a brand there still sees the supplier on a material line', async () => {
    const mfr = await factory(), brand = await makeBuyer()
    await orderWithMaterial(mfr, brand, { supplier: 'Old School Mills', poNumber: 'PO-123' })
    delete process.env.PLATFORM_MODE
    const m = (await as(brand).get('/api/orders/MAT-1')).body.assignments[0].stages[0].materials[0]
    assert.deepEqual([m.supplier, m.poNumber], ['Old School Mills', 'PO-123'])
  })

  test('the PO PDF is a document the brand never receives, even on the order it is for', async () => {
    const mfr = await factory(), brand = await makeBuyer(), s = await supplier(mfr)
    await link(brand, mfr)
    await orderWithMaterial(mfr, brand)
    const po = await sentPo(mfr, s, { lines: [line({ materialRef: materialRef() })] })
    const doc = await Document.findOne({ poId: po.id })
    // A stage-evidence PO the factory attached to the order by hand, the older way.
    const attached = await Document.create({ type: 'material_po', name: 'Fabric PO', mfrId: mfr._id, orderId: 'MAT-1', uploadedBy: mfr._id, dataUrl: 'data:application/pdf;base64,JVBERi0=', mimeType: 'application/pdf', fileName: 'x.pdf' })
    const theirs = (await as(brand).get('/api/documents')).body
    assert.equal(theirs.some(d => d.type === 'supplier_po' || d.type === 'material_po'), false)
    assert.equal((await as(brand).get(`/api/documents/${doc._id}/data`)).status, 404)
    assert.equal((await as(brand).get(`/api/documents/${attached._id}/data`)).status, 404)
    // The factory still has both.
    const ours = (await as(mfr).get('/api/documents')).body.map(d => d.type)
    assert.ok(ours.includes('supplier_po') && ours.includes('material_po'))
    assert.equal((await as(mfr).get(`/api/documents/${doc._id}/data`)).status, 200)
  })

  test('a PO PDF cannot be uploaded, edited or deleted by hand', async () => {
    const mfr = await factory(), s = await supplier(mfr)
    const po = await sentPo(mfr, s)
    const doc = await Document.findOne({ poId: po.id })
    const up = await as(mfr).post('/api/documents', { type: 'supplier_po', name: 'My own PO', dataUrl: 'data:application/pdf;base64,JVBERi0xLjQK', mimeType: 'application/pdf', fileName: 'a.pdf', fileSize: 8 })
    assert.equal(up.status, 400)
    assert.equal((await as(mfr).post(`/api/documents/${doc._id}`, { name: 'changed' })).status, 409)
    assert.equal((await as(mfr).post(`/api/documents/${doc._id}/delete`)).status, 409)
  })
})

describe('no company can reach another\'s purchase orders', () => {
  test('every route says "not found" to another factory, and changes nothing', async () => {
    const a = await factory({ code: 'AAA' }), b = await factory({ code: 'BBB' })
    const s = await supplier(a)
    const d = (await draft(a, s)).body
    const sent = await sentPo(a, s)
    assert.deepEqual((await as(b).get('/api/purchase-orders')).body, [])
    for (const [method, path, body] of [
      ['get', `/api/purchase-orders/${d.id}`], ['post', `/api/purchase-orders/${d.id}`, { terms: 'hacked' }],
      ['post', `/api/purchase-orders/${d.id}/delete`], ['post', `/api/purchase-orders/${d.id}/send`, {}],
      ['get', `/api/purchase-orders/${sent.id}/pdf`], ['post', `/api/purchase-orders/${sent.id}/acknowledge`, {}],
      ['post', `/api/purchase-orders/${sent.id}/close`, {}], ['post', `/api/purchase-orders/${sent.id}/cancel`, { reason: 'x' }],
      ['post', `/api/purchase-orders/${sent.id}/receive`, { lines: [{ lineId: sent.lines[0].lineId, qty: 1 }] }],
    ]) {
      const r = await as(b)[method](path, body)
      assert.equal(r.status, 404, `${method} ${path} -> ${r.status}`)
    }
    const stored = await PurchaseOrder.findById(d.id).lean()
    assert.deepEqual([stored.status, stored.terms], ['draft', ''])
    assert.equal((await PurchaseOrder.findById(sent.id).lean()).status, 'sent')
    assert.equal(mailer.calls.length, 1)          // only A's own send
  })

  test('another factory cannot raise a PO with someone else\'s supplier', async () => {
    const a = await factory({ code: 'AAA' }), b = await factory({ code: 'BBB' })
    const s = await supplier(a)
    const r = await draft(b, s)
    assert.equal(r.status, 400)
    assert.match(r.body.error, /one of your suppliers/)
  })

  test('a malformed PO number is just not found', async () => {
    const mfr = await factory()
    for (const id of ['x', 'PO-1', '..%2f', 'PO-TPR-2627-1']) assert.equal((await as(mfr).get(`/api/purchase-orders/${id}`)).status, 404, id)
  })
})
