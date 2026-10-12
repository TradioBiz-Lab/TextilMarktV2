// Twilio's WhatsApp channel: that only Twilio can post to the webhook (its signature), that media is fetched from
// Twilio's hosts and nowhere else, that retries are not processed twice, and that a delivery paper sent from a
// factory's WhatsApp becomes a draft goods received note and nothing more.
import test, { before, after, beforeEach, afterEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as, req } from './helpers/client.js'
import { makeMfr, makeBuyer, setOrg } from './helpers/factories.js'
import { Supplier } from '../src/models/Supplier.js'
import { InboundMessage } from '../src/models/InboundMessage.js'
import { Grn } from '../src/models/Grn.js'
import { StockLedger } from '../src/models/StockLedger.js'
import { gstinCheckChar } from '../src/lib/gst.js'
import { setMailerForTests } from '../src/lib/email.js'
import { setGoodsDocReaderForTests, goodsDocSchema } from '../src/lib/ai/goodsdoc.js'
import { twilioSignature, validTwilioSignature, fetchTwilioMedia, setTwilioFetchForTests, TwilioInboundAdapter, TwilioOutboundAdapter } from '../src/lib/inbound/twilio.js'
import { outbound } from '../src/lib/inbound/adapters.js'
import { setPipelineDeps } from '../src/lib/inbound/pipeline.js'

const TOKEN = 'twilio-auth-token-for-tests'
const SID = 'AC00000000000000000000000000000000'
const ENV = { WHATSAPP_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: TOKEN, TWILIO_WHATSAPP_FROM: '+14155238886', TWILIO_WEBHOOK_URL: 'https://example.test/api/inbound/webhook/twilio' }
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2Q==', 'base64')

before(async () => { await startTestDb(); await startServer(); for (const m of [Supplier, Grn, StockLedger, InboundMessage]) await m.init() })
after(async () => { for (const k of Object.keys(ENV)) delete process.env[k]; delete process.env.PLATFORM_MODE; setMailerForTests(null); setGoodsDocReaderForTests(null); setTwilioFetchForTests(null); setPipelineDeps(null); await stopServer(); await stopTestDb() })
beforeEach(async () => {
  await clearDb(); process.env.PLATFORM_MODE = 'standalone'; Object.assign(process.env, ENV)
  setMailerForTests({ emails: { send: async () => ({ data: { id: 'em_1' }, error: null }) } })
  outbound.sent.length = 0
})
afterEach(() => { setGoodsDocReaderForTests(null); setTwilioFetchForTests(null); setPipelineDeps(null) })

const gstinFor = (state, pan = 'AAPFU0939F') => { const f = `${state}${pan}1Z`; return f + gstinCheckChar(f) }
async function factory() {
  const mfr = await makeMfr({ code: 'TPR', company: 'TPR Textiles' })
  await setOrg(mfr, { profile: { legalName: 'TPR Textiles Pvt Ltd', gstin: gstinFor('33'), stateCode: '33', address: 'Plot 22', city: 'Tiruppur', pincode: '641604' } })
  mfr.whatsappNumber = '+91 98765 43210'; await mfr.save()
  return mfr
}
const fakeResponse = (status, body = Buffer.alloc(0), headers = {}) => ({
  status, ok: status >= 200 && status < 300, headers: { get: k => headers[k.toLowerCase()] ?? null },
  arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length), body: null,
})

// Twilio posts a urlencoded form with its signature in a header.
const post = (body, { sign = true, url = ENV.TWILIO_WEBHOOK_URL } = {}) =>
  req('POST', '/api/inbound/webhook/twilio', { form: body, headers: sign ? { 'X-Twilio-Signature': twilioSignature(TOKEN, url, body) } : {} })

describe('the request signature', () => {
  test('is Twilio\'s own scheme: HMAC-SHA1 of the URL and the sorted form, base64', () => {
    // The worked example in Twilio's documentation (checked against an independent HMAC computation as well).
    const url = 'https://mycompany.com/myapp.php?foo=1&bar=2'
    const params = { CallSid: 'CA1234567890ABCDE', Caller: '+14158675310', Digits: '1234', From: '+14158675310', To: '+18005551212' }
    assert.equal(twilioSignature('12345', url, params), 'GvWf1cFY/Q7PnoempGyD5oXAezc=')
  })

  test('only the right token, URL and form pass; a changed field, a missing header or no token fail', () => {
    const url = 'https://example.test/hook', p = { From: 'whatsapp:+919876543210', Body: 'hi' }
    const sig = twilioSignature(TOKEN, url, p)
    assert.equal(validTwilioSignature(TOKEN, sig, url, p), true)
    assert.equal(validTwilioSignature(TOKEN, sig, url, { ...p, Body: 'hello' }), false)
    assert.equal(validTwilioSignature(TOKEN, sig, 'https://example.test/other', p), false)
    assert.equal(validTwilioSignature('another-token', sig, url, p), false)
    assert.equal(validTwilioSignature(TOKEN, '', url, p), false)
    assert.equal(validTwilioSignature('', sig, url, p), false)
    assert.equal(validTwilioSignature(TOKEN, 'short', url, p), false)
  })
})

describe('fetching a message\'s media', () => {
  test('only from api.twilio.com over https, with the account\'s credentials; the one redirect goes to Twilio\'s storage without them', async () => {
    const calls = []
    const fetchImpl = async (url, opts = {}) => {
      calls.push({ url, auth: opts.headers?.Authorization, redirect: opts.redirect })
      return url.startsWith('https://api.twilio.com/') ? fakeResponse(307, Buffer.alloc(0), { location: 'https://s3-external-1.amazonaws.com/bucket/file?sig=1' }) : fakeResponse(200, JPEG)
    }
    const bytes = await fetchTwilioMedia('https://api.twilio.com/2010-04-01/Accounts/AC1/Messages/MM1/Media/ME1', { sid: SID, token: TOKEN, fetchImpl })
    assert.ok(bytes.equals(JPEG))
    assert.match(calls[0].auth, /^Basic /)
    assert.equal(calls[1].auth, undefined)
  })

  test('another host, plain http, a look-alike host, or a redirect elsewhere is refused before anything is sent', async () => {
    const never = async () => { throw new Error('must not be fetched') }
    for (const url of ['https://evil.example/x', 'http://api.twilio.com/x', 'https://api.twilio.com.evil.example/x', 'https://169.254.169.254/latest/meta-data', 'file:///etc/passwd', 'not a url'])
      await assert.rejects(() => fetchTwilioMedia(url, { sid: SID, token: TOKEN, fetchImpl: never }), /Twilio|not valid/, url)
    const elsewhere = async () => fakeResponse(302, Buffer.alloc(0), { location: 'https://evil.example/steal' })
    await assert.rejects(() => fetchTwilioMedia('https://api.twilio.com/x', { sid: SID, token: TOKEN, fetchImpl: elsewhere }), /Twilio/)
    const plain = async () => fakeResponse(302, Buffer.alloc(0), { location: 'http://s3.amazonaws.com/x' })
    await assert.rejects(() => fetchTwilioMedia('https://api.twilio.com/x', { sid: SID, token: TOKEN, fetchImpl: plain }), /Twilio/)
  })

  test('a failed fetch and an oversize file are errors, not data', async () => {
    await assert.rejects(() => fetchTwilioMedia('https://api.twilio.com/x', { sid: SID, token: TOKEN, fetchImpl: async () => fakeResponse(404) }), /could not be fetched/)
    const big = async () => fakeResponse(200, Buffer.alloc(1024), { 'content-length': String(50 * 1024 * 1024) })
    await assert.rejects(() => fetchTwilioMedia('https://api.twilio.com/x', { sid: SID, token: TOKEN, fetchImpl: big }), /too large/)
    const small = async () => fakeResponse(200, Buffer.alloc(2048))
    await assert.rejects(() => fetchTwilioMedia('https://api.twilio.com/x', { sid: SID, token: TOKEN, fetchImpl: small, maxBytes: 1024 }), /too large/)
  })
})

describe('the adapters', () => {
  test('a form from Twilio becomes the pipeline\'s message: a photo, a voice note, a PDF or plain text', async () => {
    const adapter = new TwilioInboundAdapter({ sid: SID, token: TOKEN, fetchImpl: async () => fakeResponse(200, JPEG) })
    const base = { From: 'whatsapp:+919876543210', MessageSid: 'SM1', Body: 'challan' }
    const photo = await adapter.normalize({ ...base, NumMedia: '1', MediaUrl0: 'https://api.twilio.com/m/1', MediaContentType0: 'image/jpeg' })
    assert.deepEqual([photo.sender_number, photo.type, photo.mime_type, photo.text, photo.message_id], ['+919876543210', 'image', 'image/jpeg', 'challan', 'SM1'])
    assert.ok(photo.media_bytes.equals(JPEG))
    assert.equal((await adapter.normalize({ ...base, NumMedia: '1', MediaUrl0: 'https://api.twilio.com/m/2', MediaContentType0: 'audio/ogg; codecs=opus' })).type, 'audio')
    assert.equal((await adapter.normalize({ ...base, NumMedia: '1', MediaUrl0: 'https://api.twilio.com/m/3', MediaContentType0: 'application/pdf' })).type, 'document')
    const text = await adapter.normalize({ ...base, NumMedia: '0' })
    assert.deepEqual([text.type, text.media_bytes], ['text', null])
    await assert.rejects(() => adapter.normalize({ Body: 'x' }), /From required/)
    await assert.rejects(() => adapter.normalize({ ...base, NumMedia: '1', MediaUrl0: 'https://evil.example/x', MediaContentType0: 'image/jpeg' }), /Twilio/)
  })

  test('a reply goes through the Messages API with the account\'s credentials, to the sender\'s number', async () => {
    const calls = []
    const sender = new TwilioOutboundAdapter({ sid: SID, token: TOKEN, from: '+14155238886', fetchImpl: async (url, opts) => { calls.push({ url, ...opts }); return fakeResponse(201) } })
    await sender.sendText('+91 98765 43210', 'Challan mil gaya')
    assert.equal(calls[0].url, `https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`)
    assert.match(calls[0].headers.Authorization, /^Basic /)
    const sent = new URLSearchParams(calls[0].body.toString())
    assert.deepEqual([sent.get('From'), sent.get('To'), sent.get('Body')], ['whatsapp:+14155238886', 'whatsapp:+919876543210', 'Challan mil gaya'])
    const failing = new TwilioOutboundAdapter({ sid: SID, token: TOKEN, from: '+14155238886', fetchImpl: async () => fakeResponse(401) })
    await assert.rejects(() => failing.sendText('+919876543210', 'x'), /could not send/)
    await assert.rejects(() => new TwilioOutboundAdapter({ sid: SID, token: TOKEN }).sendText('+919876543210', 'x'), /No sender/)
  })
})

describe('the webhook', () => {

  test('refuses a call that Twilio did not sign, and answers 404 when Twilio is not set up', async () => {
    const body = { From: 'whatsapp:+919876543210', Body: 'hello', NumMedia: '0', MessageSid: 'SM1' }
    assert.equal((await post(body, { sign: false })).status, 403)
    assert.equal((await req('POST', '/api/inbound/webhook/twilio', { form: body, headers: { 'X-Twilio-Signature': 'forged' } })).status, 403)
    assert.equal(await InboundMessage.countDocuments({}), 0)
    delete process.env.TWILIO_AUTH_TOKEN
    assert.equal((await post(body)).status, 404)
  })

  test('answers at once with an empty reply, then takes the message in; a retry of the same message is taken in once', async () => {
    const { drainInbound } = await import('../src/routes/inbound.js')
    const mfr = await factory()
    setPipelineDeps({ extractText: async () => ({ updates: [], confidence: 0.9 }) })
    const body = { From: 'whatsapp:+919876543210', Body: 'cutting ho gaya', NumMedia: '0', MessageSid: 'SM-ONCE' }
    const first = await post(body)
    assert.equal(first.status, 200)
    await drainInbound()
    await post(body); await post(body)
    await drainInbound()
    const saved = await InboundMessage.find({ externalId: 'SM-ONCE' }).lean()
    assert.equal(saved.length, 1)
    assert.equal(String(saved[0].factoryId), String(mfr._id))
    assert.equal(saved[0].channel, 'whatsapp')
  })
})

describe('a delivery paper from WhatsApp', () => {
  const reading = () => {
    const data = goodsDocSchema.parse({ docType: 'delivery_challan', docNumber: 'CH-88', supplierName: 'Coimbatore Knit Fabrics', lines: [{ description: 'Single jersey 180 GSM', qty: 120, unit: 'KGS' }], confidence: 0.9 })
    setGoodsDocReaderForTests(async () => ({ data, error: null }))
  }

  test('a photo captioned "challan" becomes a draft goods received note, the sender is told, and no stock moves', async () => {
    const { drainInbound } = await import('../src/routes/inbound.js')
    const mfr = await factory()
    reading()
    const replies = []
    // Twilio's servers: the photo is theirs to give, and the "challan mil gaya" reply is theirs to take.
    setTwilioFetchForTests(async (url, opts) => { if (opts?.method === 'POST') { replies.push({ url, body: new URLSearchParams(opts.body.toString()) }); return fakeResponse(201) } return fakeResponse(200, JPEG) })
    const body = { From: 'whatsapp:+919876543210', Body: 'challan', NumMedia: '1', MediaUrl0: 'https://api.twilio.com/m/1', MediaContentType0: 'image/jpeg', MessageSid: 'SM-GOODS' }
    assert.equal((await post(body)).status, 200)
    await drainInbound()
    assert.equal(replies.length, 1)
    assert.match(replies[0].body.get('Body'), /Challan mil gaya.*1 item/)
    assert.equal(replies[0].body.get('To'), 'whatsapp:+919876543210')
    const grns = await Grn.find({}).lean()
    assert.equal(grns.length, 1)
    assert.deepEqual([grns[0].status, grns[0].source, grns[0].challanNo, String(grns[0].createdBy)], ['draft', 'whatsapp', 'CH-88', String(mfr._id)])
    const msg = await InboundMessage.findOne({ externalId: 'SM-GOODS' }).lean()
    assert.deepEqual([msg.state, String(msg.grnId), msg.parsed.kind], ['auto_applied', String(grns[0]._id), 'goods_document'])
    assert.equal(await StockLedger.countDocuments({}), 0)
    // The factory sees it as a draft to check, and it carries the photo.
    const drafts = (await as(mfr).get('/api/grns?status=draft')).body
    assert.deepEqual(drafts.map(g => [g.source, g.photoCount]), [['whatsapp', 1]])
  })

  test('a PDF is read as one at once; a photo with no caption is tried as a production photo first, and a challan after that', async () => {
    const mfr = await factory()
    reading()
    const { ingestMessage } = await import('../src/lib/inbound/pipeline.js')
    process.env.WHATSAPP_PROVIDER = 'mock'
    const pdf = await ingestMessage({ factoryId: mfr._id, channel: 'web', type: 'document', buffer: Buffer.from('%PDF-1.4'), mimeType: 'application/pdf' })
    assert.equal(pdf.state, 'auto_applied')
    assert.ok(pdf.grnId)
    // An uncaptioned photo the production reader does not recognise ("unknown") is then tried as a challan.
    let production = 0
    const unknown = await ingestMessage({ factoryId: mfr._id, channel: 'web', type: 'image', buffer: JPEG, mimeType: 'image/jpeg' }, { extractPhoto: async () => { production++; return { stage: 'unknown', confidence: 0.3, issues: [], description: '', style_hint: null } } })
    assert.equal(production, 1)
    assert.ok(unknown.grnId)
    // A recognised production photo is never read as a challan.
    const cutting = await ingestMessage({ factoryId: mfr._id, channel: 'web', type: 'image', buffer: JPEG, mimeType: 'image/jpeg' }, { extractPhoto: async () => ({ stage: 'cutting', confidence: 0.95, issues: [], description: 'cutting table', style_hint: null }) })
    assert.equal(cutting.grnId, null)
    assert.equal(await Grn.countDocuments({}), 2)
  })

  test('a document that is not a challan, or the Tradio portal, takes the usual path', async () => {
    const mfr = await factory()
    const { ingestMessage } = await import('../src/lib/inbound/pipeline.js')
    setGoodsDocReaderForTests(async () => ({ data: goodsDocSchema.parse({ docType: 'other', lines: [], confidence: 0.9 }), error: null }))
    const other = await ingestMessage({ factoryId: mfr._id, channel: 'web', type: 'document', buffer: Buffer.from('%PDF-1.4'), mimeType: 'application/pdf' }, { extractDocument: async () => null })
    assert.equal(other.grnId, null)
    assert.equal(other.state, 'needs_review')                                         // the existing path: the AI could not read it
    assert.equal(await Grn.countDocuments({}), 0)
    reading()
    delete process.env.PLATFORM_MODE
    const portal = await ingestMessage({ factoryId: mfr._id, channel: 'web', type: 'document', buffer: Buffer.from('%PDF-1.4'), mimeType: 'application/pdf' }, { extractDocument: async () => null })
    assert.equal(portal.grnId, null)
    assert.equal(await Grn.countDocuments({}), 0)
    assert.ok(makeBuyer)
  })
})
