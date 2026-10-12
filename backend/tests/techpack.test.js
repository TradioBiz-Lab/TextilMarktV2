// Reading a tech pack into a draft bill of materials and a measurement spec. The model is never called in a
// test: a fake reader returns what it would read from the real Fitleasure FLGCM14 Recovery Tee pack (its
// header, its callouts and its 12-point measurement table, as printed).
import test, { before, after, beforeEach, afterEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as, req } from './helpers/client.js'
import { makeAdmin, makeBuyer, makeMfr, makeOrder, setOrg, link } from './helpers/factories.js'
import { Bom } from '../src/models/Bom.js'
import { SpecSheet } from '../src/models/SpecSheet.js'
import { Document } from '../src/models/Document.js'
import {
  techPackSchema, sizesFromRange, sizesOf, linesFromTechPack, specFromTechPack, setTechPackReaderForTests,
} from '../src/lib/ai/techpack.js'
import { callJsonDetailed } from '../src/lib/ai/extract.js'

before(async () => { await startTestDb(); await startServer(); await Bom.init(); await SpecSheet.init() })
after(async () => { delete process.env.PLATFORM_MODE; setTechPackReaderForTests(null); await stopServer(); await stopTestDb() })

/** What the model returns for FLGCM14 Recovery Tee, in the shape the prompt asks for. */
const RECOVERY_TEE = {
  header: { brand: 'Fitleasure', styleNo: 'FLGCM14', description: 'Recovery Tee', category: 'Tees', gender: 'Mens', fabricComposition: 'Poly Spandex', gsm: '220', sizeRange: 'S-XXL', collection: 'GYM - Lift Series', designer: 'Prithikha Goldie', season: 'AMJ\'26' },
  sizes: ['S', 'M', 'L', 'XL', 'XXL'],
  colourways: [],
  bomCandidates: [
    { section: 'fabric', item: 'Poly spandex jersey', spec: '220 GSM', unit: 'kg', perPiece: null, perColour: true, evidence: 'Style sheet: Fabric Comp. Poly Spandex, GSM 220', confidence: 0.92 },
    { section: 'fabric', item: 'Back mesh panel', spec: 'cut and sew panel on both sides', unit: null, perPiece: null, perColour: true, evidence: 'Construction sheet: cut and sew panel; spec sheet rows I and J', confidence: 0.6 },
    { section: 'process', item: 'DTM HD logo print', spec: 'HD heatset, 150-160 C, 8-10 s, colour same as body fabric', unit: null, perPiece: 2, perColour: true, evidence: 'Logo CAD: Print Technique HD Heatset', confidence: 0.9 },
    { section: 'process', item: 'Silver reflective print', spec: 'above shoulder seam', unit: null, perPiece: null, perColour: false, evidence: 'Finishing details: silver reflective print above shoulder seam', confidence: 0.85 },
    { section: 'process', item: 'Laser cut holes', spec: 'above bottom hem and beside side seam', unit: null, perPiece: null, perColour: false, evidence: 'Construction sheet', confidence: 0.8 },
    { section: 'trims', item: 'Stitch legend', spec: 'not a material', unit: null, perPiece: null, perColour: null, evidence: 'Stitch details', confidence: 0.2 },
    { section: 'nonsense', item: 'Something odd', spec: null, unit: null, perPiece: null, perColour: null, evidence: null, confidence: 0.4 },
    { section: 'fabric', item: '', spec: null, unit: null, perPiece: null, perColour: null, evidence: null, confidence: 0.4 },
  ],
  specPoints: [
    { code: 'A', name: 'Armhole', tolPlus: 1, tolMinus: null, values: [52, 54, 56, 58, 60] },
    { code: 'B', name: 'Across Shoulder (seam to seam)', tolPlus: 0.5, tolMinus: null, values: [44, 46, 48, 50, 52] },
    { code: 'C', name: 'Body Length (HPS to Bottom Hem)', tolPlus: 1, tolMinus: null, values: [70, 72, 74, 76, 78] },
    { code: 'D', name: 'Sleeve Length (shoulder point to sleeve hem)', tolPlus: 0.5, tolMinus: null, values: [21, 22, 23, 24, 25] },
    { code: 'E', name: 'Bicep (half width, straight across)', tolPlus: 0.5, tolMinus: null, values: [19.5, 20.5, 21.5, 22.5, 23.5] },
    { code: 'F', name: 'Sleeve Opening (half width)', tolPlus: 0.5, tolMinus: null, values: [17.5, 18.5, 19.5, 20.5, 21.5] },
    { code: 'G', name: 'Neck Width (seam to seam)', tolPlus: 0.5, tolMinus: null, values: [18.5, 19, 19.5, 20, 20.5] },
    { code: 'H', name: 'Armhole Depth (straight seam to seam)', tolPlus: 0.5, tolMinus: null, values: [23, 24, 25, 26, 27] },
    { code: 'I', name: 'Back Mesh Panel Height', tolPlus: 1, tolMinus: null, values: [38, 39, 40, 41, 42] },
    { code: 'J', name: 'Back Mesh Panel Width', tolPlus: 0.5, tolMinus: null, values: [22, 23, 24, 25, 26] },
    { code: 'K', name: 'Front Neck Drop (HPS to seam)', tolPlus: 0.5, tolMinus: null, values: [10.5, 11, 11.5, 12, 12.5] },
    { code: 'L', name: 'Back Neck Drop (HPS to seam)', tolPlus: 0.3, tolMinus: null, values: [2, 2, 2.2, 2.2, 2.4] },
  ],
  notes: ['No fabric consumption is given', 'Colourways page has images only'],
  confidence: 0.82,
}

describe('what the model returns is checked and tidied', () => {
  test('the real-pack reading passes the schema, and loose values are coerced', () => {
    const r = techPackSchema.parse(RECOVERY_TEE)
    assert.equal(r.header.styleNo, 'FLGCM14')
    assert.equal(r.specPoints.length, 12)
    const loose = techPackSchema.parse({ header: { gsm: 220 }, sizes: ['S', null, ' M '], bomCandidates: [{ section: 'trims', item: ' Zip ', perPiece: '2 pcs', confidence: 'high' }], specPoints: [{ name: 'Chest', tolPlus: '±1', values: ['52', '', 'x', 54] }], confidence: 7 })
    assert.equal(loose.header.gsm, '220')
    assert.deepEqual(loose.sizes, ['S', 'M'])
    assert.equal(loose.bomCandidates[0].item, 'Zip')
    assert.equal(loose.bomCandidates[0].perPiece, 2)
    assert.equal(loose.bomCandidates[0].confidence, 0.5)                    // not a number: a middling default, not a crash
    assert.deepEqual(loose.specPoints[0].values, [52, null, null, 54])
    assert.equal(loose.specPoints[0].tolPlus, 1)
    assert.equal(loose.confidence, 0.5)                                      // out of range: the default
  })

  test('an empty reading is still a valid, empty one', () => {
    const r = techPackSchema.parse({})
    assert.deepEqual([r.bomCandidates, r.specPoints, r.sizes, r.notes], [[], [], [], []])
  })

  test('the call returns the reason when the model\'s reply cannot be used', async () => {
    const sdk = { messages: { create: async () => ({ content: [{ type: 'text', text: 'sorry, I cannot read that' }] }) } }
    const r = await callJsonDetailed({ content: [], schema: techPackSchema, sdk })
    assert.equal(r.data, null)
    assert.match(r.error, /no JSON object/)
  })

  test('and asks for more room and the model it was given', async () => {
    let seen
    const sdk = { messages: { create: async p => { seen = p; return { content: [{ type: 'text', text: '{"confidence":0.9}' }] } } } }
    const r = await callJsonDetailed({ content: [], schema: techPackSchema, sdk, model: 'm-x', maxTokens: 8000 })
    assert.equal(r.data.confidence, 0.9)
    assert.deepEqual([seen.model, seen.max_tokens], ['m-x', 8000])
  })
})

describe('sizes', () => {
  test('a range on the usual ladder', () => {
    assert.deepEqual(sizesFromRange('S-XXL'), ['S', 'M', 'L', 'XL', 'XXL'])
    assert.deepEqual(sizesFromRange('xs - l'), ['XS', 'S', 'M', 'L'])
    assert.equal(sizesFromRange('28-36'), null)
    assert.equal(sizesFromRange('XXL-S'), null)
    assert.equal(sizesFromRange(''), null)
  })

  test('the measurement table\'s columns win over the stated range', () => {
    assert.deepEqual(sizesOf({ sizes: ['S', 'M'], header: { sizeRange: 'S-XXL' } }), ['S', 'M'])
    assert.deepEqual(sizesOf({ sizes: [], header: { sizeRange: 'S-L' } }), ['S', 'M', 'L'])
    assert.deepEqual(sizesOf({ sizes: [], header: {} }), [])
  })
})

describe('the bill of materials lines a pack suggests', () => {
  const data = techPackSchema.parse(RECOVERY_TEE)

  test('every line is from the AI and needs a look; nonsense sections and nameless items are dropped', () => {
    const lines = linesFromTechPack(data)
    assert.deepEqual(lines.map(l => l.item), ['Poly spandex jersey', 'Back mesh panel', 'DTM HD logo print', 'Silver reflective print', 'Laser cut holes', 'Stitch legend'])
    assert.ok(lines.every(l => l.source === 'ai' && l.needsReview === true && l.lineId))
    const fleece = lines[0]
    assert.deepEqual([fleece.section, fleece.unit, fleece.consumption, fleece.perColour, fleece.confidence], ['fabric', 'kg', 0, true, 0.92])
    assert.match(fleece.evidence, /Style sheet/)
  })

  test('a quantity per piece is kept only when the pack states it; a missing unit takes the section\'s usual one', () => {
    const lines = linesFromTechPack(data)
    assert.equal(lines.find(l => l.item === 'DTM HD logo print').consumption, 2)
    assert.equal(lines.find(l => l.item === 'Laser cut holes').consumption, 0)
    assert.equal(lines.find(l => l.item === 'Back mesh panel').unit, 'm')           // fabric: metres until told otherwise
    assert.equal(lines.find(l => l.item === 'Laser cut holes').unit, 'pcs')
  })

  test('what is already on the BOM is not suggested again', () => {
    const lines = linesFromTechPack(data, [{ section: 'fabric', item: '  POLY SPANDEX   jersey ' }])
    assert.ok(!lines.some(l => l.item === 'Poly spandex jersey'))
    assert.equal(lines.length, 5)
  })
})

describe('the measurement spec a pack gives', () => {
  const data = techPackSchema.parse(RECOVERY_TEE)

  test('keeps every point with a value for each size and its tolerance', () => {
    const s = specFromTechPack(data)
    assert.deepEqual(s.sizes, ['S', 'M', 'L', 'XL', 'XXL'])
    assert.equal(s.points.length, 12)
    assert.deepEqual(s.points[4], { code: 'E', name: 'Bicep (half width, straight across)', tolPlus: 0.5, tolMinus: null, values: [19.5, 20.5, 21.5, 22.5, 23.5], confidence: null, needsReview: false })
    assert.equal(s.points[11].tolPlus, 0.3)
    assert.equal(s.header.styleNo, 'FLGCM14')
  })

  test('drops a point with no name or no values, and pads a short row with blanks', () => {
    const s = specFromTechPack(techPackSchema.parse({
      sizes: ['S', 'M', 'L'],
      specPoints: [{ name: '', values: [1, 2, 3] }, { name: 'Empty', values: [] }, { name: 'Short', code: 'Z', values: [10] }],
    }))
    assert.deepEqual(s.points.map(p => [p.name, p.values]), [['Short', [10, null, null]]])
  })
})

// ── The route ────────────────────────────────────────────────────────────────

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< >>\nendobj\ntrailer\n<< >>\n%%EOF\n')
const pdfDataUrl = `data:application/pdf;base64,${PDF.toString('base64')}`

let reads
beforeEach(async () => {
  await clearDb(); process.env.PLATFORM_MODE = 'standalone'; delete process.env.ENABLE_VIEW_AS
  reads = []
  setTechPackReaderForTests(async (buffer, mime) => { reads.push({ bytes: buffer.length, mime }); return { data: techPackSchema.parse(RECOVERY_TEE), error: null } })
})
afterEach(() => setTechPackReaderForTests(null))

async function world() {
  const mfr = await makeMfr({ code: 'TPR', company: 'TPR Textiles' })
  await setOrg(mfr, { profile: { stateCode: '33' } })
  const brand = await makeBuyer({ code: 'FIT', company: 'Fitleasure' })
  await link(brand, mfr)
  await makeOrder({ id: 'FIT-TEE', buyer: brand, mfrs: [mfr], product: 'Recovery Tee', totalQty: 5000 })
  const pack = await Document.create({ type: 'tech_pack', name: 'FLGCM14 Recovery Tee.pdf', orderId: 'FIT-TEE', uploadedBy: brand._id, dataUrl: pdfDataUrl, mimeType: 'application/pdf', fileName: 'FLGCM14.pdf', fileSize: PDF.length })
  return { mfr, brand, pack }
}
const extract = (u, body) => as(u).post('/api/boms/extract', body)

describe('reading a tech pack into the order\'s bill of materials', () => {
  test('starts a draft from it: its sizes, the AI lines needing a look, the pack attached', async () => {
    const { mfr, pack } = await world()
    const r = await extract(mfr, { orderId: 'FIT-TEE', documentId: String(pack._id) })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual(reads, [{ bytes: PDF.length, mime: 'application/pdf' }])
    const bom = r.body.bom
    assert.equal(bom.status, 'draft')
    assert.deepEqual(bom.plan.sizes, ['S', 'M', 'L', 'XL', 'XXL'])
    assert.deepEqual(bom.plan.ratio, [1, 2, 3, 2, 1])
    assert.equal(bom.plan.totalQty, 5000)
    assert.equal(bom.lines.length, 6)
    assert.ok(bom.lines.every(l => l.source === 'ai' && l.needsReview))
    assert.equal(bom.techPackDocumentId, String(pack._id))
    assert.equal(bom.extraction.confidence, 0.82)
    assert.deepEqual(bom.extraction.notes, ['No fabric consumption is given', 'Colourways page has images only'])
    assert.deepEqual([r.body.extraction.lines, r.body.extraction.specPoints], [6, 12])
  })

  test('cannot be frozen until the suggestions are checked', async () => {
    const { mfr, pack } = await world()
    const r = await extract(mfr, { orderId: 'FIT-TEE', documentId: String(pack._id) })
    const frozen = await as(mfr).post(`/api/boms/${r.body.bom.id}/freeze`)
    assert.equal(frozen.status, 409)
    assert.equal(frozen.body.code, 'NEEDS_REVIEW')
    assert.equal(frozen.body.unreviewed, 6)
    const confirmed = await as(mfr).post(`/api/boms/${r.body.bom.id}`, { lines: r.body.bom.lines, confirmAll: true })
    assert.equal(confirmed.status, 200)
    assert.equal((await as(mfr).post(`/api/boms/${r.body.bom.id}/freeze`)).status, 200)
  })

  test('adds to a draft that already exists without repeating what is there', async () => {
    const { mfr, pack } = await world()
    const b = (await as(mfr).post('/api/boms', { orderId: 'FIT-TEE' })).body
    await as(mfr).post(`/api/boms/${b.id}`, { lines: [{ section: 'fabric', item: 'Poly spandex jersey', unit: 'kg', consumption: 0.26, rate: 650 }] })
    const r = await extract(mfr, { orderId: 'FIT-TEE', documentId: String(pack._id) })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.bom.id, b.id)
    assert.equal(r.body.bom.lines.length, 6)                     // 1 of its own + 5 new
    assert.equal(r.body.bom.lines[0].consumption, 0.26)          // what the person entered is untouched
    assert.equal(r.body.bom.lines[0].needsReview, false)
    assert.equal(r.body.extraction.skipped, 3)                    // the one it already had, and the two it could not use
    const again = await extract(mfr, { orderId: 'FIT-TEE', documentId: String(pack._id) })
    assert.equal(again.body.bom.lines.length, 6)                 // a second reading adds nothing new
    assert.equal(again.body.extraction.lines, 0)
  })

  test('keeps the measurement spec for the order, and a second reading replaces it', async () => {
    const { mfr, pack } = await world()
    const r = await extract(mfr, { orderId: 'FIT-TEE', documentId: String(pack._id) })
    assert.equal(r.body.spec.points.length, 12)
    assert.deepEqual(r.body.spec.sizes, ['S', 'M', 'L', 'XL', 'XXL'])
    assert.equal(r.body.spec.header.styleNo, 'FLGCM14')
    await extract(mfr, { orderId: 'FIT-TEE', documentId: String(pack._id) })
    assert.equal(await SpecSheet.countDocuments({ orderId: 'FIT-TEE' }), 1)
  })

  test('colourways in the pack are used when the order has none', async () => {
    const { mfr, pack } = await world()
    setTechPackReaderForTests(async () => ({ data: techPackSchema.parse({ ...RECOVERY_TEE, colourways: ['Black', 'Navy'] }), error: null }))
    const r = await extract(mfr, { orderId: 'FIT-TEE', documentId: String(pack._id) })
    assert.deepEqual(r.body.bom.plan.colours, [{ name: 'Black', qty: 2500 }, { name: 'Navy', qty: 2500 }])
  })

  test('a frozen BOM is not changed by it', async () => {
    const { mfr, pack } = await world()
    const b = (await as(mfr).post('/api/boms', { orderId: 'FIT-TEE' })).body
    await as(mfr).post(`/api/boms/${b.id}`, { lines: [{ section: 'trims', item: 'Zip', consumption: 1 }] })
    await as(mfr).post(`/api/boms/${b.id}/freeze`)
    assert.equal((await extract(mfr, { orderId: 'FIT-TEE', documentId: String(pack._id) })).status, 409)
    assert.equal(reads.length, 0)                                // and the model was not even asked
  })

  test('says so when the pack cannot be read, and changes nothing', async () => {
    const { mfr, pack } = await world()
    setTechPackReaderForTests(async () => ({ data: null, error: 'no JSON object in reply' }))
    const r = await extract(mfr, { orderId: 'FIT-TEE', documentId: String(pack._id) })
    assert.equal(r.status, 502)
    assert.match(r.body.error, /enter the bill of materials by hand/)
    assert.equal(await Bom.countDocuments({}), 0)
    assert.equal(await SpecSheet.countDocuments({}), 0)
  })

  test('only a tech pack on this order, that is a readable file', async () => {
    const { mfr, brand, pack } = await world()
    const other = await makeMfr({ code: 'OTH' })
    await makeOrder({ id: 'OTHER-ORDER', buyer: brand, mfrs: [other] })
    const notPack = await Document.create({ type: 'compliance_cert', name: 'cert', orderId: 'FIT-TEE', uploadedBy: brand._id, dataUrl: pdfDataUrl, mimeType: 'application/pdf' })
    const elsewhere = await Document.create({ type: 'tech_pack', name: 'other', orderId: 'OTHER-ORDER', uploadedBy: brand._id, dataUrl: pdfDataUrl, mimeType: 'application/pdf' })
    const link_ = await Document.create({ type: 'tech_pack', name: 'drive link', orderId: 'FIT-TEE', uploadedBy: brand._id, externalUrl: 'https://drive.example/x' })
    const word = await Document.create({ type: 'tech_pack', name: 'doc', orderId: 'FIT-TEE', uploadedBy: brand._id, dataUrl: 'data:application/msword;base64,AAAA', mimeType: 'application/msword' })
    assert.equal((await extract(mfr, { orderId: 'FIT-TEE', documentId: String(notPack._id) })).status, 404)
    assert.equal((await extract(mfr, { orderId: 'FIT-TEE', documentId: String(elsewhere._id) })).status, 404)
    assert.equal((await extract(mfr, { orderId: 'FIT-TEE', documentId: 'nope' })).status, 404)
    assert.equal((await extract(mfr, { orderId: 'FIT-TEE', documentId: String(link_._id) })).status, 400)
    assert.equal((await extract(mfr, { orderId: 'FIT-TEE', documentId: String(word._id) })).status, 400)
    assert.equal((await extract(mfr, { orderId: 'OTHER-ORDER', documentId: String(pack._id) })).status, 404)    // an order the factory is not on
    assert.equal(reads.length, 0)
  })

  test('an oversized file is refused before it is sent anywhere', async () => {
    const { mfr, brand } = await world()
    const big = await Document.create({ type: 'tech_pack', name: 'big', orderId: 'FIT-TEE', uploadedBy: brand._id, dataUrl: `data:application/pdf;base64,${Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64')}`, mimeType: 'application/pdf' })
    assert.equal((await extract(mfr, { orderId: 'FIT-TEE', documentId: String(big._id) })).status, 400)
    assert.equal(reads.length, 0)
  })

  test('brands, Tradio staff and visitors cannot use it', async () => {
    const { brand, pack } = await world()
    for (const u of [brand, await makeAdmin()]) assert.equal((await extract(u, { orderId: 'FIT-TEE', documentId: String(pack._id) })).status, 403, u.role)
    assert.equal((await req('POST', '/api/boms/extract', { body: {} })).status, 401)
    assert.equal(reads.length, 0)
  })
})

describe('the measurement spec', () => {
  async function withSpec() {
    const w = await world()
    const r = await extract(w.mfr, { orderId: 'FIT-TEE', documentId: String(w.pack._id) })
    return { ...w, spec: r.body.spec }
  }

  test('the factory and the brand it is for can read it, nobody else', async () => {
    const { mfr, brand, spec } = await withSpec()
    const mineRead = await as(mfr).get('/api/spec-sheets?orderId=FIT-TEE')
    assert.equal(mineRead.status, 200)
    assert.equal(mineRead.body[0].points.length, 12)
    assert.equal(mineRead.body[0].editable, true)
    const brandRead = await as(brand).get('/api/spec-sheets?orderId=FIT-TEE')
    assert.equal(brandRead.body[0].id, spec.id)
    assert.equal(brandRead.body[0].editable, false)
    assert.equal(brandRead.body[0].factoryName, 'TPR Textiles')
    const rival = await makeMfr({ code: 'RVL' })
    const otherBrand = await makeBuyer({ code: 'OTH' })
    assert.equal((await as(rival).get('/api/spec-sheets?orderId=FIT-TEE')).status, 404)
    assert.equal((await as(otherBrand).get('/api/spec-sheets?orderId=FIT-TEE')).status, 404)
    assert.equal((await as(mfr).get('/api/spec-sheets?orderId=nope')).status, 404)
  })

  test('only the factory that read it corrects it, with checked numbers', async () => {
    const { mfr, brand, spec } = await withSpec()
    const rival = await makeMfr({ code: 'RVL' })
    const body = { sizes: spec.sizes, points: spec.points.map(p => (p.code === 'A' ? { ...p, values: [53, 55, 57, 59, 61] } : p)) }
    assert.equal((await as(brand).post(`/api/spec-sheets/${spec.id}`, body)).status, 403)
    assert.equal((await as(rival).post(`/api/spec-sheets/${spec.id}`, body)).status, 404)
    const ok = await as(mfr).post(`/api/spec-sheets/${spec.id}`, body)
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
    assert.deepEqual(ok.body.points.find(p => p.code === 'A').values, [53, 55, 57, 59, 61])
    const bad = async b => (await as(mfr).post(`/api/spec-sheets/${spec.id}`, b)).status
    assert.equal(await bad({ sizes: [], points: [] }), 400)
    assert.equal(await bad({ sizes: ['S', 's'], points: [] }), 400)
    assert.equal(await bad({ sizes: ['S'], points: [{ name: '', values: [1] }] }), 400)
    assert.equal(await bad({ sizes: ['S'], points: [{ name: 'x', tolPlus: -1, values: [1] }] }), 400)
    assert.equal(await bad({ sizes: ['S'], points: [{ name: 'x', values: ['abc'] }] }), 400)
    assert.equal(await bad({ sizes: ['S'], points: 'no' }), 400)
  })

  test('the Tradio portal has none of it', async () => {
    const { mfr } = await withSpec()
    delete process.env.PLATFORM_MODE
    assert.equal((await as(mfr).get('/api/spec-sheets?orderId=FIT-TEE')).status, 404)
  })
})
