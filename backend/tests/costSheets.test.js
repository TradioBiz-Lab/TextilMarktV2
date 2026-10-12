// Open cost sheets end to end: building one (from a bill of materials too), sharing a version, the brand
// commenting and approving, revising, the PDF and email, and that no company sees one that is not its own.
import test, { before, after, beforeEach, afterEach, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as, req } from './helpers/client.js'
import { makeAdmin, makeMaster, makeBuyer, makeMfr, makeMember, makeOrder, setOrg, link } from './helpers/factories.js'
import { CostSheet } from '../src/models/CostSheet.js'
import { Bom } from '../src/models/Bom.js'
import { Order } from '../src/models/Order.js'
import { Notification } from '../src/models/Notification.js'
import { setMailerForTests } from '../src/lib/email.js'

before(async () => { await startTestDb(); await startServer(); await CostSheet.init(); await Bom.init() })
after(async () => { delete process.env.PLATFORM_MODE; setMailerForTests(null); await stopServer(); await stopTestDb() })

let mailer
beforeEach(async () => {
  await clearDb(); process.env.PLATFORM_MODE = 'standalone'; delete process.env.ENABLE_VIEW_AS
  mailer = fakeMailer(); setMailerForTests(mailer)
})
afterEach(() => setMailerForTests(null))

function fakeMailer() {
  const calls = []
  return { calls, emails: { send: async payload => { calls.push(payload); return { data: { id: `em_${calls.length}` }, error: null } } } }
}

const golden = JSON.parse(readFileSync(new URL('./fixtures/costing.cases.json', import.meta.url), 'utf8'))

/** A Tradio-managed factory (its fee line applies), a brand with an owner and a teammate, and another brand it does not work with. */
async function world({ tradioEnabled = true } = {}) {
  const mfr = await makeMfr({ code: 'TPR', company: 'TPR Textiles', email: 'raj@tpr.test' })
  await setOrg(mfr, { tradioEnabled, profile: { legalName: 'TPR Textiles Pvt Ltd', address: 'Plot 22', city: 'Tiruppur', stateCode: '33' } })
  const brand = await makeBuyer({ code: 'FIT', company: 'Fitleasure', email: 'owner@fit.test' })
  const brandMate = await makeMember(brand, { name: 'Merch Mehta', email: 'merch@fit.test' })
  const other = await makeBuyer({ code: 'OTH', company: 'Other Brand', email: 'owner@oth.test' })
  await link(brand, mfr)
  return { mfr, brand, brandMate, other }
}
const sheetBody = (brand, extra = {}) => ({
  brandId: String(brand._id), styleName: 'Baggy Active Jacket', styleCode: 'FLGCW17', qty: 1000, discountPct: 3.6,
  ...golden[0].sheet, discountPct: 3.6, ...extra,
})
const create = async (mfr, brand, extra) => { const r = await as(mfr).post('/api/cost-sheets', sheetBody(brand, extra)); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body }
const share = (mfr, id, body = {}) => as(mfr).post(`/api/cost-sheets/${id}/share`, body)
const shared = async (mfr, brand, extra) => { const s = await create(mfr, brand, extra); const r = await share(mfr, s.id); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.sheet }

describe('who can use cost sheets', () => {
  test('the Tradio portal does not have them', async () => {
    delete process.env.PLATFORM_MODE
    const { mfr } = await world()
    assert.equal((await as(mfr).get('/api/cost-sheets')).status, 404)
  })

  test('Tradio staff and visitors are refused; a factory and a brand are let in', async () => {
    const { mfr, brand } = await world()
    for (const u of [await makeAdmin(), await makeMaster()]) assert.equal((await as(u).get('/api/cost-sheets')).status, 403, u.role)
    assert.equal((await req('GET', '/api/cost-sheets')).status, 401)
    assert.equal((await as(mfr).get('/api/cost-sheets')).status, 200)
    assert.equal((await as(brand).get('/api/cost-sheets')).status, 200)
  })

  test('a brand cannot start, edit, share or delete one', async () => {
    const { mfr, brand } = await world()
    const s = await create(mfr, brand)
    assert.equal((await as(brand).post('/api/cost-sheets', sheetBody(brand))).status, 403)
    assert.equal((await as(brand).post(`/api/cost-sheets/${s.id}`, { styleName: 'x' })).status, 403)    // refused before any lookup: it says nothing about whether the id exists
    assert.equal((await as(brand).get(`/api/cost-sheets/${s.id}`)).status, 404)                         // and a draft is not visible to read
    await share(mfr, s.id)
    for (const path of ['', '/share', '/revise', '/delete']) assert.equal((await as(brand).post(`/api/cost-sheets/${s.id}${path}`, {})).status, 403, path)
  })
})

describe('starting one', () => {
  test('the approved Fitleasure style comes out at the approved price, with Tradio\'s fee for a Tradio factory', async () => {
    const { mfr, brand } = await world()
    const s = await create(mfr, brand)
    assert.equal(s.status, 'draft')
    assert.equal(s.version, 1)
    assert.match(s.chainId, /^CS-TPR-\d{4}-0001$/)
    assert.equal(s.computed.price, 609.09)
    assert.equal(s.computed.negotiated, 587.16)
    assert.equal(s.computed.tradio, 43.575)
    assert.equal(s.computed.orderValue, 609090)
    assert.equal(s.computed.negotiatedValue, 587160)
    assert.equal(s.factoryName, 'TPR Textiles')
    assert.equal(s.brandName, 'Fitleasure')
  })

  test('the other five real styles match too', async () => {
    const { mfr, brand } = await world()
    for (const g of golden) {
      const r = await as(mfr).post('/api/cost-sheets', { brandId: String(brand._id), styleName: g.name, ...g.sheet })
      assert.equal(r.status, 201, JSON.stringify(r.body))
      assert.equal(r.body.computed.price, g.expected.price, g.name)
      assert.equal(r.body.computed.negotiated, g.expected.negotiated, g.name)
    }
  })

  test('a factory Tradio does not manage has no Tradio fee, whatever the browser sends', async () => {
    const { mfr, brand } = await world({ tradioEnabled: false })
    const s = await create(mfr, brand, { tradioPct: 10 })
    assert.equal(s.tradioPct, 0)
    assert.equal(s.computed.tradio, 0)
    assert.equal(s.computed.price, 565.52)               // 435.75 + overhead + rejection + margin, no fee
    assert.equal(s.computed.negotiated, 545.16)
    const saved = await as(mfr).post(`/api/cost-sheets/${s.id}`, { tradioPct: 25 })
    assert.equal(saved.body.tradioPct, 0)
  })

  test('numbers are per factory and financial year, and every sheet gets the next', async () => {
    const { mfr, brand } = await world()
    const a = await create(mfr, brand), b = await create(mfr, brand)
    assert.match(a.chainId, /-0001$/)
    assert.match(b.chainId, /-0002$/)
  })

  test('only for one of the factory\'s customers, and an order it makes for that customer', async () => {
    const { mfr, brand, other } = await world()
    assert.equal((await as(mfr).post('/api/cost-sheets', sheetBody(other))).status, 400)           // not connected
    assert.equal((await as(mfr).post('/api/cost-sheets', sheetBody({ _id: 'nope' }))).status, 400)
    assert.equal((await as(mfr).post('/api/cost-sheets', {})).status, 400)
    await makeOrder({ id: 'NOT-MINE', buyer: brand, mfrs: [await makeMfr({ code: 'OTH' })] })
    assert.equal((await as(mfr).post('/api/cost-sheets', sheetBody(brand, { orderId: 'NOT-MINE' }))).status, 400)
    await makeOrder({ id: 'MINE', buyer: brand, mfrs: [mfr], product: 'Baggy jacket' })
    assert.equal((await as(mfr).post('/api/cost-sheets', sheetBody(brand, { orderId: 'MINE' }))).status, 201)
    await makeOrder({ id: 'OTHER-BRAND', buyer: other, mfrs: [mfr] })
    assert.equal((await as(mfr).post('/api/cost-sheets', sheetBody(brand, { orderId: 'OTHER-BRAND' }))).status, 400)   // that order is another brand's
  })

  test('is seeded from a bill of materials: consumption across the size mix, wastage, rates, quantity', async () => {
    const { mfr, brand } = await world()
    await makeOrder({ id: 'FIT-5117', buyer: brand, mfrs: [mfr], product: 'Polaire full zip', totalQty: 10800 })
    await Order.updateOne({ _id: 'FIT-5117' }, { $set: { colourways: [{ name: 'BLACK' }, { name: 'NAVY' }, { name: 'GREY' }], styleNumber: '5117' } })
    const b = (await as(mfr).post('/api/boms', { orderId: 'FIT-5117' })).body
    await as(mfr).post(`/api/boms/${b.id}`, { lines: [
      { section: 'fabric', item: 'Polar fleece 300 GSM', unit: 'kg', consumption: 0.72, perSize: [0.63, 0.675, 0.72, 0.765, 0.8325], wastagePct: 7, rate: 410 },
      { section: 'trims', item: 'YKK zip', unit: 'pcs', consumption: 1, wastagePct: 2, rate: 45 },
      { section: 'other', item: 'Sample charge', consumption: 1, rate: 99 },
    ] })
    await as(mfr).post(`/api/boms/${b.id}/freeze`)
    const r = await as(mfr).post('/api/cost-sheets', { brandId: String(brand._id), bomId: b.id, labour: { making: 80 } })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.equal(r.body.styleName, 'Polaire full zip')
    assert.equal(r.body.styleCode, '5117')
    assert.equal(r.body.orderId, 'FIT-5117')
    assert.equal(r.body.qty, 10800)
    assert.equal(r.body.fabric[0].consumption, 0.7225)
    assert.equal(r.body.fabric[0].wastagePct, 7)
    assert.equal(r.body.fabric[0].rate, 410)
    assert.equal(r.body.trims[0].name, 'YKK zip')
    assert.equal(r.body.computed.fabric, 316.9608)
    assert.ok(!JSON.stringify(r.body).includes('Sample charge'))
    assert.equal(r.body.bomId, b.id)
  })

  test('another factory\'s bill of materials cannot seed it', async () => {
    const { mfr, brand } = await world()
    const rival = await makeMfr({ code: 'RVL' })
    await link(brand, rival)
    await makeOrder({ id: 'RIVAL-1', buyer: brand, mfrs: [rival] })
    const theirs = (await as(rival).post('/api/boms', { orderId: 'RIVAL-1' })).body
    assert.equal((await as(mfr).post('/api/cost-sheets', { brandId: String(brand._id), styleName: 'x', bomId: theirs.id })).status, 400)
  })
})

describe('editing a draft', () => {
  test('the server works the figures and ignores the browser\'s', async () => {
    const { mfr, brand } = await world()
    const s = await create(mfr, brand)
    const r = await as(mfr).post(`/api/cost-sheets/${s.id}`, { labour: { cuttingThreads: 14, making: 200, finishingPacking: 12 }, computed: { price: 1 }, discountPct: 0 })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.computed.labour, 226)
    assert.ok(r.body.computed.price > 609)
    assert.equal(r.body.computed.negotiated, r.body.computed.price)
  })

  test('refuses what cannot be a cost sheet', async () => {
    const { mfr, brand } = await world()
    const s = await create(mfr, brand)
    const bad = async body => (await as(mfr).post(`/api/cost-sheets/${s.id}`, body)).status
    assert.equal(await bad({ styleName: '   ' }), 400)
    assert.equal(await bad({ qty: -5 }), 400)
    assert.equal(await bad({ discountPct: 101 }), 400)
    assert.equal(await bad({ marginPct: -1 }), 400)
    assert.equal(await bad({ labour: { making: -3 } }), 400)
    assert.equal(await bad({ fabric: [{ name: '', rate: 1 }] }), 400)
    assert.equal(await bad({ fabric: [{ name: 'x', rate: -1 }] }), 400)
    assert.equal(await bad({ fabric: [{ name: 'x', wastagePct: 500 }] }), 400)
    assert.equal(await bad({ trims: 'nope' }), 400)
    assert.equal(await bad({ trims: Array.from({ length: 61 }, () => ({ name: 'x' })) }), 400)
  })

  test('two people editing at once: the second to save is told to reload', async () => {
    const { mfr, brand } = await world()
    const s = await create(mfr, brand)
    const mine = (await as(mfr).post(`/api/cost-sheets/${s.id}`, { styleCode: 'A' })).body
    const stale = await as(mfr).post(`/api/cost-sheets/${s.id}`, { updatedAt: s.updatedAt, styleCode: 'B' })
    assert.equal(stale.status, 409)
    assert.equal(stale.body.code, 'STALE')
    assert.equal((await as(mfr).post(`/api/cost-sheets/${s.id}`, { updatedAt: mine.updatedAt, styleCode: 'C' })).status, 200)
  })

  test('a draft can be thrown away', async () => {
    const { mfr, brand } = await world()
    const s = await create(mfr, brand)
    assert.equal((await as(mfr).post(`/api/cost-sheets/${s.id}/delete`)).status, 200)
    assert.equal((await as(mfr).get(`/api/cost-sheets/${s.id}`)).status, 404)
  })
})

describe('sharing a version', () => {
  test('makes it the brand\'s to read, tells its team in the app, and emails them the PDF', async () => {
    const { mfr, brand, brandMate } = await world()
    const s = await create(mfr, brand)
    assert.equal((await as(brand).get(`/api/cost-sheets/${s.id}`)).status, 404)                    // a draft is the factory's alone
    const r = await share(mfr, s.id, { message: 'Prices valid till the 30th', extraEmails: ['buyer.friend@fit.test'] })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.sheet.status, 'shared')
    assert.ok(r.body.sheet.sharedAt)
    assert.deepEqual(r.body.emailed.sort(), ['buyer.friend@fit.test', 'merch@fit.test', 'owner@fit.test'])
    // each recipient got one mail, with the PDF, from the factory, replies going to the sender
    assert.equal(mailer.calls.length, 3)
    const m = mailer.calls.find(c => c.to[0] === 'merch@fit.test')
    assert.match(m.subject, /Cost sheet CS-TPR-\d{4}-0001 v1: Baggy Active Jacket from TPR Textiles/)
    assert.match(m.from, /^TPR Textiles via TextilMarkt/)
    assert.equal(m.replyTo, 'raj@tpr.test')
    assert.equal(m.attachments.length, 1)
    assert.match(m.attachments[0].filename, /^CS-TPR-\d{4}-0001-v1\.pdf$/)
    assert.equal(Buffer.from(m.attachments[0].content).subarray(0, 4).toString(), '%PDF')
    assert.match(m.html, /#cost=/)
    assert.match(m.html, /Prices valid till the 30th/)
    // the brand sees it, in the list and by id
    const seen = await as(brand).get(`/api/cost-sheets/${s.id}`)
    assert.equal(seen.status, 200)
    assert.equal(seen.body.computed.price, 609.09)
    assert.equal((await as(brandMate).get('/api/cost-sheets')).body.length, 1)
    // and its team was told in the app, with a link
    const notes = await Notification.find({ type: 'costing' }).lean()
    assert.deepEqual(notes.map(n => String(n.toUser)).sort(), [String(brand._id), String(brandMate._id)].sort())
    assert.ok(notes.every(n => n.link === `#cost=${s.id}`))
  })

  test('with no email service the sheet is still shared, and the factory is told nothing went out', async () => {
    setMailerForTests(null)
    const { mfr, brand } = await world()
    const s = await create(mfr, brand)
    const r = await share(mfr, s.id)
    assert.equal(r.status, 200)
    assert.equal(r.body.emailSkipped, true)
    assert.deepEqual(r.body.emailed, [])
    assert.equal(r.body.sheet.status, 'shared')
  })

  test('a shared version can no longer be edited, deleted or shared again', async () => {
    const { mfr, brand } = await world()
    const s = await shared(mfr, brand)
    assert.equal((await as(mfr).post(`/api/cost-sheets/${s.id}`, { styleName: 'changed' })).status, 409)
    assert.equal((await as(mfr).post(`/api/cost-sheets/${s.id}/delete`)).status, 409)
    assert.equal((await share(mfr, s.id)).status, 409)
    assert.equal((await CostSheet.findById(s.id).lean()).styleName, 'Baggy Active Jacket')
  })

  test('needs a price, a valid list of extra addresses, and a customer it is still connected to', async () => {
    const { mfr, brand } = await world()
    const empty = (await as(mfr).post('/api/cost-sheets', { brandId: String(brand._id), styleName: 'Blank' })).body
    assert.equal((await share(mfr, empty.id)).status, 409)
    const s = await create(mfr, brand)
    assert.equal((await share(mfr, s.id, { extraEmails: ['not-an-email'] })).status, 400)
    assert.equal((await share(mfr, s.id, { extraEmails: Array.from({ length: 6 }, (_, i) => `a${i}@x.test`) })).status, 400)
    await (await import('../src/models/Partnership.js')).Partnership.updateMany({}, { $set: { status: 'ended' } })
    assert.equal((await share(mfr, s.id)).status, 409)
  })

  test('two shares at the same moment share it once', async () => {
    const { mfr, brand } = await world()
    const s = await create(mfr, brand)
    const [a, b] = await Promise.all([share(mfr, s.id), share(mfr, s.id)])
    assert.deepEqual([a.status, b.status].sort(), [200, 409])
  })
})

describe('what the brand sees', () => {
  test('the whole build-up, but not the factory\'s own note or the BOM it came from', async () => {
    const { mfr, brand } = await world()
    const s = await shared(mfr, brand, { internalNote: 'our real margin is thin here' })
    assert.equal((await as(mfr).get(`/api/cost-sheets/${s.id}`)).body.internalNote, 'our real margin is thin here')
    const seen = (await as(brand).get(`/api/cost-sheets/${s.id}`)).body
    assert.equal(seen.internalNote, undefined)
    assert.equal(seen.bomId, undefined)
    assert.ok(!JSON.stringify(seen).includes('thin here'))
    assert.equal(seen.fabric[0].name, 'NS Lycra')
    assert.equal(seen.marginPct, 20)
    assert.equal(seen.computed.margin, 94.2527)
  })

  test('the list carries the latest shared version of each sheet and nothing that is still a draft', async () => {
    const { mfr, brand } = await world()
    await shared(mfr, brand)
    await create(mfr, brand, { styleName: 'Still drafting' })
    const rows = (await as(brand).get('/api/cost-sheets')).body
    assert.deepEqual(rows.map(r => r.styleName), ['Baggy Active Jacket'])
    assert.equal(rows[0].factoryName, 'TPR Textiles')
    assert.equal((await as(mfr).get('/api/cost-sheets')).body.length, 2)
  })
})

describe('comments and approval', () => {
  test('a brand\'s comment marks the version commented and tells the factory; a reply tells the brand', async () => {
    const { mfr, brand } = await world()
    const s = await shared(mfr, brand)
    const c = await as(brand).post(`/api/cost-sheets/${s.id}/comments`, { text: 'Can the zipper come down to 40?', kind: 'changes' })
    assert.equal(c.status, 200, JSON.stringify(c.body))
    assert.equal(c.body.status, 'commented')
    assert.equal(c.body.comments[0].kind, 'changes')
    assert.equal(c.body.comments[0].role, 'buyer')
    const note = await Notification.findOne({ toUser: mfr._id, type: 'costing' }).lean()
    assert.match(note.msg, /Fitleasure asked for changes on cost sheet CS-TPR-\d{4}-0001 v1/)
    const reply = await as(mfr).post(`/api/cost-sheets/${s.id}/comments`, { text: 'Yes, 42 is the best we can do' })
    assert.equal(reply.status, 200)
    assert.equal(reply.body.status, 'commented')
    assert.equal(reply.body.comments.length, 2)
    assert.equal(reply.body.comments[1].role, 'manufacturer')
    assert.ok(await Notification.exists({ toUser: brand._id, type: 'costing', msg: /TPR Textiles commented on/ }))
  })

  test('a comment needs words, and is for a shared version', async () => {
    const { mfr, brand } = await world()
    const draft = await create(mfr, brand)
    assert.equal((await as(mfr).post(`/api/cost-sheets/${draft.id}/comments`, { text: 'note to self' })).status, 409)
    const s = await shared(mfr, brand)
    assert.equal((await as(brand).post(`/api/cost-sheets/${s.id}/comments`, { text: '   ' })).status, 400)
    assert.equal((await as(brand).post(`/api/cost-sheets/${s.id}/comments`, { text: 'x'.repeat(2001) })).status, 400)
  })

  test('only the brand approves, at the negotiated price, and the factory is told', async () => {
    const { mfr, brand, brandMate } = await world()
    const s = await shared(mfr, brand)
    assert.equal((await as(mfr).post(`/api/cost-sheets/${s.id}/approve`)).status, 403)
    const r = await as(brandMate).post(`/api/cost-sheets/${s.id}/approve`)       // a teammate acts as the company
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.status, 'approved')
    assert.equal(r.body.approvedPrice, 587.16)
    assert.equal(r.body.approvedByName, brandMate.name)
    assert.ok(r.body.approvedAt)
    assert.equal((await as(brand).post(`/api/cost-sheets/${s.id}/approve`)).status, 409)
    assert.ok(await Notification.exists({ toUser: mfr._id, type: 'costing', msg: /Fitleasure approved cost sheet/ }))
    const mail = mailer.calls.find(c => c.to[0] === 'raj@tpr.test')
    assert.ok(mail, 'the factory was emailed')
    assert.match(mail.subject, /^Approved: Baggy Active Jacket/)
  })

  test('a commented version can still be approved, a draft or a stranger cannot approve', async () => {
    const { mfr, brand, other } = await world()
    const s = await shared(mfr, brand)
    await as(brand).post(`/api/cost-sheets/${s.id}/comments`, { text: 'ok with a small change' })
    assert.equal((await as(other).post(`/api/cost-sheets/${s.id}/approve`)).status, 404)
    assert.equal((await as(brand).post(`/api/cost-sheets/${s.id}/approve`)).status, 200)
    const draft = await create(mfr, brand)
    assert.equal((await as(brand).post(`/api/cost-sheets/${draft.id}/approve`)).status, 404)
  })

  test('Tradio staff cannot approve on a brand\'s behalf, even viewing it', async () => {
    const { mfr, brand } = await world()
    const s = await shared(mfr, brand)
    const master = await makeMaster()
    const open = await as(master).post('/api/auth/view-as', { userId: String(brand._id) })
    assert.equal(open.status, 200, JSON.stringify(open.body))
    const write = await req('POST', `/api/cost-sheets/${s.id}/approve`, { token: open.body.token })
    assert.equal(write.status, 403)
    assert.equal(write.body.code, 'VIEW_ONLY')
    assert.equal((await CostSheet.findById(s.id).lean()).status, 'shared')
  })
})

describe('revising', () => {
  test('starts the next draft with the same inputs and no comments; sharing it supersedes the old one', async () => {
    const { mfr, brand } = await world()
    const v1 = await shared(mfr, brand)
    await as(brand).post(`/api/cost-sheets/${v1.id}/comments`, { text: 'please lower the making cost' })
    const r = await as(mfr).post(`/api/cost-sheets/${v1.id}/revise`)
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.equal(r.body.version, 2)
    assert.equal(r.body.chainId, v1.chainId)
    assert.equal(r.body.status, 'draft')
    assert.equal(r.body.comments.length, 0)
    assert.equal(r.body.computed.price, v1.computed.price)
    assert.equal((await as(mfr).post(`/api/cost-sheets/${v1.id}/revise`)).status, 409)         // a draft of v2 already exists
    const edited = await as(mfr).post(`/api/cost-sheets/${r.body.id}`, { labour: { cuttingThreads: 14, making: 100, finishingPacking: 12 } })
    assert.ok(edited.body.computed.price < v1.computed.price)
    assert.equal((await as(brand).get(`/api/cost-sheets/${r.body.id}`)).status, 404)           // v2 is a draft: the brand still has v1
    assert.equal((await share(mfr, r.body.id)).status, 200)
    assert.equal((await CostSheet.findById(v1.id).lean()).status, 'superseded')
    const seen = (await as(brand).get(`/api/cost-sheets/${r.body.id}`)).body
    assert.deepEqual(seen.versions.map(v => [v.version, v.status]), [[2, 'shared'], [1, 'superseded']])
    assert.equal((await as(brand).get('/api/cost-sheets')).body.length, 1)                     // one sheet, its latest version
  })

  test('an approved version can be revised, and the new one needs approving again', async () => {
    const { mfr, brand } = await world()
    const v1 = await shared(mfr, brand)
    await as(brand).post(`/api/cost-sheets/${v1.id}/approve`)
    const v2 = (await as(mfr).post(`/api/cost-sheets/${v1.id}/revise`)).body
    await as(mfr).post(`/api/cost-sheets/${v2.id}`, { discountPct: 5 })
    const s2 = (await share(mfr, v2.id)).body.sheet
    assert.equal(s2.status, 'shared')
    assert.equal(s2.approvedAt, null)
    assert.equal((await CostSheet.findById(v1.id).lean()).status, 'superseded')
    assert.equal((await as(brand).post(`/api/cost-sheets/${v1.id}/approve`)).status, 409)      // the old one cannot be approved now
    assert.equal((await as(brand).post(`/api/cost-sheets/${v1.id}/comments`, { text: 'late' })).status, 409)
  })

  test('only the latest shared version can be revised', async () => {
    const { mfr, brand } = await world()
    const draft = await create(mfr, brand)
    assert.equal((await as(mfr).post(`/api/cost-sheets/${draft.id}/revise`)).status, 409)
    const v1 = await shared(mfr, brand, { styleName: 'Other style' })
    const v2 = (await as(mfr).post(`/api/cost-sheets/${v1.id}/revise`)).body
    await share(mfr, v2.id)
    assert.equal((await as(mfr).post(`/api/cost-sheets/${v1.id}/revise`)).status, 409)
  })
})

describe('the PDF', () => {
  test('a factory previews a draft, and a brand reads a shared one', async () => {
    const { mfr, brand } = await world()
    const s = await create(mfr, brand)
    const draft = await as(mfr).get(`/api/cost-sheets/${s.id}/pdf`)
    assert.equal(draft.status, 200)
    assert.equal(draft.body.mimeType, 'application/pdf')
    assert.equal(Buffer.from(draft.body.dataUrl.split(',')[1], 'base64').subarray(0, 4).toString(), '%PDF')
    assert.equal((await as(brand).get(`/api/cost-sheets/${s.id}/pdf`)).status, 404)
    await share(mfr, s.id)
    const real = await as(brand).get(`/api/cost-sheets/${s.id}/pdf`)
    assert.equal(real.status, 200)
    assert.match(real.body.fileName, /^CS-TPR-\d{4}-0001-v1\.pdf$/)
  })
})

describe('no company can reach another\'s cost sheets', () => {
  test('another factory and another brand get "not found" for everything, and change nothing', async () => {
    const { mfr, brand, other } = await world()
    const rival = await makeMfr({ code: 'RVL' })
    await setOrg(rival, { profile: { stateCode: '33' } })
    await link(other, rival)
    const s = await shared(mfr, brand)
    const draft = await create(mfr, brand, { styleName: 'Private draft' })
    for (const who of [rival, other]) {
      const a = as(who)
      assert.equal((await a.get(`/api/cost-sheets/${s.id}`)).status, 404, who.role)
      assert.equal((await a.get(`/api/cost-sheets/${draft.id}`)).status, 404, who.role)
      assert.equal((await a.get(`/api/cost-sheets/${s.id}/pdf`)).status, 404, who.role)
      assert.equal((await a.post(`/api/cost-sheets/${s.id}/comments`, { text: 'hi' })).status, 404, who.role)
      assert.equal((await a.post(`/api/cost-sheets/${s.id}/approve`)).status, who.role === 'buyer' ? 404 : 403, who.role)
      assert.equal((await a.get('/api/cost-sheets')).body.length, 0, who.role)
    }
    assert.equal((await as(rival).post(`/api/cost-sheets/${draft.id}`, { styleName: 'hijack' })).status, 404)
    assert.equal((await as(rival).post(`/api/cost-sheets/${draft.id}/delete`)).status, 404)
    assert.equal((await as(rival).post(`/api/cost-sheets/${s.id}/revise`)).status, 404)
    assert.equal((await CostSheet.findById(draft.id).lean()).styleName, 'Private draft')
    assert.equal((await CostSheet.findById(s.id).lean()).status, 'shared')
  })

  test('a malformed id is just not found', async () => {
    const { mfr } = await world()
    assert.equal((await as(mfr).get('/api/cost-sheets/not-an-id')).status, 404)
    assert.equal((await as(mfr).post('/api/cost-sheets/not-an-id/share')).status, 404)
  })
})
