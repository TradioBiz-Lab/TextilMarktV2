// Creating many styles from a spreadsheet: the reader (Excel and CSV, pictures matched to rows), the per-row checks, and
// the routes that preview and create. The workbook fixture is built the way the Cocoblu sheet was made (inline strings,
// absolute part paths, pictures floating over the cells), because that file crashes exceljs.

import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'
import JSZip from 'jszip'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as } from './helpers/client.js'
import { makeAdmin, makeMaster, makeBuyer, makeMfr, makeMasterOrder } from './helpers/factories.js'
import { Order } from '../src/models/Order.js'
import { Notification } from '../src/models/Notification.js'
import { StyleImportUpload } from '../src/models/StyleImportUpload.js'
import { readTable, analyseTable, ImportError } from '../src/lib/styleImport.js'

before(async () => { await startTestDb(); await startServer() })
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(clearDb)

// A 1x1 PNG, and a different one per row so a swap would show.
const PNG = n => Buffer.from(`iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==`, 'base64').fill(n, 60, 61)

const HEADER = ['Brand', 'Style No', 'Prod Description', 'Product Image', 'Amazon link', 'Fabric Composition', 'Stage']
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
const colLetter = i => String.fromCharCode(65 + i)

/** An .xlsx like the Cocoblu one. `images` maps a sheet row number to a picture; `heights` gives a row a custom height. */
async function workbook(table, { images = {}, heights = {}, sheets = ['Replen'] } = {}) {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
  zip.file('xl/workbook.xml', `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets>${sheets.map((n, i) => `<sheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" name="${n}" sheetId="${i + 1}" state="visible" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`)
  zip.file('xl/_rels/workbook.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet${i + 1}.xml" Id="rId${i + 1}"/>`).join('')}</Relationships>`)
  const links = []
  const rowsXml = table.map((cells, r) => {
    const n = r + 1
    const ht = heights[n] ? ` ht="${heights[n]}" customHeight="1"` : ''
    const cs = cells.map((v, c) => {
      if (v === null || v === undefined || v === '') return ''
      if (v && typeof v === 'object') { links.push({ ref: `${colLetter(c)}${n}`, url: v.link }); v = v.text }
      return `<c r="${colLetter(c)}${n}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`
    }).join('')
    return `<row r="${n}"${ht}>${cs}</row>`
  }).join('')
  zip.file('xl/worksheets/sheet1.xml', `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetFormatPr defaultRowHeight="15"/><sheetData>${rowsXml}</sheetData>${links.length ? `<hyperlinks>${links.map((l, i) => `<hyperlink xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ref="${l.ref}" r:id="rIdL${i}"/>`).join('')}</hyperlinks>` : ''}${Object.keys(images).length ? '<drawing xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rIdD"/>' : ''}</worksheet>`)
  for (let i = 1; i < sheets.length; i++) zip.file(`xl/worksheets/sheet${i + 1}.xml`, '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>')
  zip.file('xl/worksheets/_rels/sheet1.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${links.map((l, i) => `<Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${esc(l.url)}" TargetMode="External" Id="rIdL${i}"/>`).join('')}${Object.keys(images).length ? '<Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="/xl/drawings/drawing1.xml" Id="rIdD"/>' : ''}</Relationships>`)
  if (Object.keys(images).length) {
    const rows = Object.keys(images)
    zip.file('xl/drawings/drawing1.xml', `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${rows.map((row, i) => `<xdr:twoCellAnchor><xdr:from><xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row - 1}</xdr:row><xdr:rowOff>10000</xdr:rowOff></xdr:from><xdr:to><xdr:col>4</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row - 1}</xdr:row><xdr:rowOff>150000</xdr:rowOff></xdr:to><xdr:pic><xdr:blipFill><a:blip xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" r:embed="rIdI${i}"/></xdr:blipFill></xdr:pic></xdr:twoCellAnchor>`).join('')}</xdr:wsDr>`)
    zip.file('xl/drawings/_rels/drawing1.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rows.map((_, i) => `<Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="/xl/media/image${i + 1}.png" Id="rIdI${i}"/>`).join('')}</Relationships>`)
    rows.forEach((row, i) => zip.file(`xl/media/image${i + 1}.png`, images[row]))
  }
  return zip.generateAsync({ type: 'nodebuffer' })
}

const good = (n, extra = []) => ['FYLTR', `FYL-${n}`, `Women's Dress ${n}`, '', { text: 'listing', link: `https://www.amazon.in/dp/B0${n}` }, 'Cotton Poplin', 'Replen', ...extra]

describe('reading an Excel workbook', () => {
  test('reads cells, takes a link from the hyperlink, matches each picture to its row, and notes ignored sheets', async () => {
    const buf = await workbook([HEADER, good(1), good(2)], { images: { 3: PNG(3), 2: PNG(2) }, sheets: ['Replen', 'Spare'] })
    const table = await readTable(buf, 'sheet.xlsx')
    assert.equal(table.sheetName, 'Replen')
    assert.deepEqual(table.rows[1].values.slice(0, 3), ['FYLTR', 'FYL-1', "Women's Dress 1"])
    assert.equal(table.rows[1].links[4], 'https://www.amazon.in/dp/B01')
    assert.equal(table.rows[1].image.data[60], 2, 'row 2 gets the picture anchored on row 2')
    assert.equal(table.rows[2].image.data[60], 3)
    assert.ok(table.warnings.some(w => /Spare/.test(w)))
  })

  test('puts a tall picture on the row its middle sits on, not the row it starts in', async () => {
    // Row 2 is 60pt tall (762000 EMU); a picture from row 2 down to row 3 centred at 800000 EMU is on row 3.
    const buf = await workbook([HEADER, good(1), good(2)], { heights: { 2: 60 }, images: { 2: PNG(7) } })
    const zip = await JSZip.loadAsync(buf)
    const xml = (await zip.file('xl/drawings/drawing1.xml').async('string')).replace('<xdr:rowOff>10000', '<xdr:rowOff>700000').replace(/<xdr:to>[\s\S]*?<\/xdr:to>/, '<xdr:to><xdr:col>4</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>2</xdr:row><xdr:rowOff>100000</xdr:rowOff></xdr:to>')
    zip.file('xl/drawings/drawing1.xml', xml)
    const table = await readTable(await zip.generateAsync({ type: 'nodebuffer' }), 'a.xlsx')
    assert.equal(table.rows[1].image, null)
    assert.equal(table.rows[2].image.data[60], 7)
  })

  test('refuses a file that is not a workbook', async () => {
    await assert.rejects(readTable(Buffer.from('PK nonsense'), 'a.xlsx'), ImportError)
    await assert.rejects(readTable(Buffer.from('x'), 'a.pdf'), /Excel \(\.xlsx\) or CSV/)
  })
})

describe('a sheet with no Stage column', () => {
  test('takes the stage of the window it was sent from, and is refused anywhere else', async () => {
    const noStage = await workbook([HEADER.slice(0, 6), good(1).slice(0, 6)], { images: { 2: PNG(2) } })
    const table = await readTable(noStage, 'brand.xlsx')
    assert.throws(() => analyseTable(table), /missing these columns: Stage/)
    const replen = analyseTable(table, { defaultPhase: 'replen' })
    assert.equal(replen.summary.ok, 1, JSON.stringify(replen.rows[0].problems))
    assert.equal(replen.rows[0].payload.phase, 'replen')
    // A Stage the sheet does give still wins.
    assert.equal(analyseTable(await readTable(await workbook([HEADER, good(2)], { images: { 2: PNG(2) } }), 'b.xlsx'), { defaultPhase: 'development' }).rows[0].payload.phase, 'replen')
  })
})

// A crafted workbook of a few KB used to stall the server for every user (bug bash, 3 Nov 2026).
describe('a crafted workbook cannot stall the server', () => {
  /** Sets the size a zip says one of its entries inflates to, in both headers, without changing the data. */
  function lieAboutSize(buf, name, size) {
    for (let i = 0; i < buf.length - 4; i++) {
      if (buf.readUInt32LE(i) === 0x04034b50 && buf.toString('utf8', i + 30, i + 30 + buf.readUInt16LE(i + 26)) === name) buf.writeUInt32LE(size, i + 22)
      if (buf.readUInt32LE(i) === 0x02014b50 && buf.toString('utf8', i + 46, i + 46 + buf.readUInt16LE(i + 28)) === name) buf.writeUInt32LE(size, i + 24)
    }
    return buf
  }

  test('a picture anchored two billion rows down is set aside at once', async () => {
    const zip = await JSZip.loadAsync(await workbook([HEADER, good(1)], { images: { 2: PNG(2) } }))
    zip.file('xl/drawings/drawing1.xml', (await zip.file('xl/drawings/drawing1.xml').async('string')).replaceAll('<xdr:row>1</xdr:row>', '<xdr:row>2000000000</xdr:row>'))
    const started = Date.now()
    const table = await readTable(await zip.generateAsync({ type: 'nodebuffer' }), 'a.xlsx')
    assert.ok(Date.now() - started < 1000, `took ${Date.now() - started}ms`)
    assert.equal(table.rows[1].image, null)
    assert.ok(table.warnings.some(w => /could not be matched/.test(w)))
  })

  test('tens of thousands of rows left open are read in a single pass', async () => {
    const zip = await JSZip.loadAsync(await workbook([HEADER, good(1)]))
    zip.file('xl/worksheets/sheet1.xml', `<worksheet><sheetData>${'<row r="9"><c r="A9" t="inlineStr"><is><t>x'.repeat(40000)}</sheetData></worksheet>`)
    const started = Date.now()
    await readTable(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), 'a.xlsx').catch(() => {})
    assert.ok(Date.now() - started < 1000, `took ${Date.now() - started}ms`)
  })

  test('a part that claims to be small but inflates past the limit is refused while it is being read', async () => {
    const zip = await JSZip.loadAsync(await workbook([HEADER, good(1)]))
    zip.file('xl/worksheets/sheet1.xml', `<worksheet><sheetData>${' '.repeat(30 * 1024 * 1024)}</sheetData></worksheet>`)
    const buf = lieAboutSize(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), 'xl/worksheets/sheet1.xml', 1000)
    await assert.rejects(readTable(buf, 'a.xlsx'), /too large to read/)
  })
})

describe('checking the rows', () => {
  test('an Excel sheet with pictures and good data is all ok, with the picture kept', async () => {
    const buf = await workbook([HEADER, good(1), good(2)], { images: { 2: PNG(2), 3: PNG(3) } })
    const res = analyseTable(await readTable(buf, 'a.xlsx'))
    assert.deepEqual(res.summary, { total: 2, ok: 2, errors: 0, exists: 0 })
    assert.match(res.rows[0].payload.photos[0].image, /^data:image\/png;base64,/)
    assert.equal(res.rows[0].payload.phase, 'replen')
    assert.equal(res.rows[0].payload.brand, 'FYLTR')
  })

  test('columns that are not styles data (factory, prices) are named as ignored and not imported', async () => {
    const buf = await workbook([[...HEADER, 'Factory Name', 'Final Tradio Submission', 'Amazon ASP'], [...good(1), 'Manoj', '340', '599']], { images: { 2: PNG(2) } })
    const res = analyseTable(await readTable(buf, 'a.xlsx'))
    assert.deepEqual(res.ignoredColumns, ['Factory Name', 'Final Tradio Submission', 'Amazon ASP'])
    assert.deepEqual(Object.keys(res.rows[0].payload).sort(), ['brand', 'category', 'colourways', 'ecommerceLink', 'fabricDetails', 'phase', 'photos', 'product', 'styleNumber', 'techPackLink'])
  })

  test('a sheet without a Stage column is refused, naming it', async () => {
    const buf = await workbook([HEADER.slice(0, 6), good(1).slice(0, 6)], { images: { 2: PNG(2) } })
    const table = await readTable(buf, 'a.xlsx')
    assert.throws(() => analyseTable(table), /missing these columns: Stage/)
  })

  test('each missing mandatory value is named; a production stage is turned away', async () => {
    const rows = [
      HEADER,
      ['', 'A-1', 'Dress', '', 'https://x.com/a', 'Cotton', 'Replen'],            // no brand, no picture
      ['B', ' A-2', 'Dress', '', 'https://x.com/b', '', 'Replen'],                // no fabric
      ['B', 'A-3', 'Dress', '', '', 'Cotton', 'Replen'],                          // replen without a link
      ['B', 'A-4', 'Dress', '', '', 'Cotton', 'NPD'],                             // an NPD style may have no link
      ['B', 'A-5', 'Dress', '', 'https://x.com/e', 'Cotton', 'Production'],       // production
      ['B', 'A-6', 'Dress', '', 'javascript:alert(1)', 'Cotton', 'NPD'],          // not a web link
    ]
    const imgs = Object.fromEntries([3, 4, 5, 6, 7].map(r => [r, PNG(r)]))
    const res = analyseTable(await readTable(await workbook(rows, { images: imgs }), 'a.xlsx'))
    const byRow = Object.fromEntries(res.rows.map(r => [r.row, r]))
    assert.match(byRow[2].problems.join(' '), /Brand is missing/)
    assert.match(byRow[2].problems.join(' '), /Image is missing/)
    assert.match(byRow[3].problems.join(' '), /Fabric is missing/)
    assert.match(byRow[4].problems.join(' '), /Amazon link is missing/)
    assert.equal(byRow[5].status, 'ok')
    assert.match(byRow[6].problems.join(' '), /Production/)
    assert.match(byRow[7].problems.join(' '), /http/)
    assert.equal(byRow[3].styleNumber, 'A-2', 'a leading non-breaking or plain space is trimmed')
  })

  test('the category is guessed from the description, shown as a guess, and refused when it cannot be', async () => {
    const rows = [HEADER, ...['Shirt Dress', 'Maxi Skirt', 'Flared Top', 'Smocked Waist'].map((d, i) => ['B', `C-${i}`, d, '', '', 'Cotton', 'NPD'])]
    const res = analyseTable(await readTable(await workbook(rows, { images: Object.fromEntries([2, 3, 4, 5].map(r => [r, PNG(r)])) }), 'a.xlsx'))
    assert.deepEqual(res.rows.map(r => r.category), ['DRESS', 'SKIRT', 'TOP', ''])
    assert.deepEqual(res.rows.map(r => r.categoryGuessed), [true, true, true, false])
    assert.match(res.rows[3].problems.join(' '), /Category is missing/)
    const given = analyseTable(await readTable(await workbook([[...HEADER, 'Category'], ['B', 'C-9', 'Smocked Waist', '', '', 'Cotton', 'NPD', 'top']], { images: { 2: PNG(2) } }), 'a.xlsx'))
    assert.equal(given.rows[0].category, 'TOP')
    assert.equal(given.rows[0].categoryGuessed, false)
  })

  test('the same style number twice in the file, and one already in the master order', async () => {
    const buf = await workbook([HEADER, good(1), good(1), good(2)], { images: { 2: PNG(2), 3: PNG(3), 4: PNG(4) } })
    const res = analyseTable(await readTable(buf, 'a.xlsx'), { existing: new Map([['fyl-2', 'OLD-001']]) })
    assert.deepEqual(res.rows.map(r => r.status), ['ok', 'error', 'exists'])
    assert.match(res.rows[1].problems[0], /Same style number as row 2/)
    assert.equal(res.rows[2].existingId, 'OLD-001')
  })

  test('a CSV works, with a picture by web address instead of embedded', async () => {
    const csv = 'Brand,Style No,Description,Image,Amazon link,Fabric,Stage,Quantity,Colours\nFYLTR,F-1,Maxi Dress,https://img.example.com/a.jpg,amazon.in/dp/B01,Cotton,replen,"1,200","Red; Blue"\n'
    const res = analyseTable(await readTable(Buffer.from('﻿' + csv), 'a.csv'))
    const [r] = res.rows
    assert.equal(r.status, 'ok', r.problems.join())
    assert.equal(r.payload.photos[0].image, 'https://img.example.com/a.jpg')
    assert.equal(r.payload.ecommerceLink, 'https://amazon.in/dp/B01')
    assert.equal(r.payload.totalQty, 1200)
    assert.deepEqual(r.payload.colourways, [{ name: 'Red' }, { name: 'Blue' }])
  })

  test('the CSV template the app offers for download is accepted as it stands', async () => {
    // Keep in step with TEMPLATE_HEADER / TEMPLATE_EXAMPLE in frontend/src/styleImport.js.
    const csv = [
      'Brand,Style No,Description,Image,Amazon link,Fabric,Stage,Category,Tech pack link,Quantity,Colours',
      "FYLTR,FYLSS26WD-4002,Women's Cotton Midi Dress with Belt,https://example.com/photo.jpg,https://www.amazon.in/dp/B0EXAMPLE,Cotton Poplin,Replen,DRESS,,,Blue; White",
    ].join('\n')
    const res = analyseTable(await readTable(Buffer.from(csv), 'template.csv'))
    assert.equal(res.rows[0].status, 'ok', res.rows[0].problems.join())
    assert.deepEqual(res.rows[0].payload.colourways, [{ name: 'Blue' }, { name: 'White' }])
    assert.deepEqual(res.ignoredColumns, [])
  })

  test('a fibre mix in the description fills the fabric composition', async () => {
    const buf = await workbook([HEADER, ['B', 'F-1', 'Shirt Dress - 100% Cotton Dress', '', 'https://x.com/a', 'Cotton Poplin', 'Replen']], { images: { 2: PNG(2) } })
    assert.deepEqual(analyseTable(await readTable(buf, 'a.xlsx')).rows[0].payload.fabricDetails, [{ name: 'Cotton Poplin', composition: '100% Cotton', gsm: '', supplier: '' }])
  })
})

const b64 = buf => buf.toString('base64')
async function upload(user, buf, filename = 'styles.xlsx') {
  return as(user).post('/api/style-imports', { filename, data: b64(buf) })
}

describe('the import routes', () => {
  async function setup() {
    const admin = await makeMaster()
    const buyer = await makeBuyer({ company: 'Cocoblu' })
    const mo = await makeMasterOrder({ buyerId: buyer._id, createdBy: admin._id, season: 'SS26' })
    return { admin, buyer, mo }
  }
  const sheet = (rows, n = rows.length) => workbook([HEADER, ...rows], { images: Object.fromEntries(Array.from({ length: n }, (_, i) => [i + 2, PNG(i + 2)])) })

  test('upload, preview, then create: styles get their stage, brand, links, photo and fabric, and nothing is made by the preview', async () => {
    const { admin, mo } = await setup()
    const up = await upload(admin, await sheet([good(1), good(2, [])]))
    assert.equal(up.status, 201, JSON.stringify(up.body))
    const preview = await as(admin).post(`/api/style-imports/${up.body.id}/preview`, { masterOrderId: mo._id })
    assert.equal(preview.status, 200, JSON.stringify(preview.body))
    assert.equal(preview.body.summary.ok, 2)
    assert.equal(preview.body.rows[0].payload, undefined, 'the payload stays on the server')
    assert.equal(await Order.countDocuments(), 0)

    const done = await as(admin).post(`/api/style-imports/${up.body.id}/commit`, { masterOrderId: mo._id })
    assert.equal(done.status, 201, JSON.stringify(done.body))
    assert.equal(done.body.created.length, 2)
    const order = await Order.findById(done.body.created[0].id).lean()
    assert.equal(order.phase, 'replen')
    assert.equal(order.brand, 'FYLTR')
    assert.equal(order.styleNumber, 'FYL-1')
    assert.equal(order.masterOrderId, mo._id)
    assert.equal(order.ecommerceLink, 'https://www.amazon.in/dp/B01')
    assert.equal(order.fabricDetails[0].name, 'Cotton Poplin')
    assert.match(order.imageDataUrl, /^data:image\/png;base64,/)
    assert.equal(order.delivery, null)
    assert.equal(order.totalQty, null)
    assert.equal(order.assignments.length, 0)
  })

  test('creating twice does not duplicate: the second time everything already exists', async () => {
    const { admin, mo } = await setup()
    const up = await upload(admin, await sheet([good(1)]))
    assert.equal((await as(admin).post(`/api/style-imports/${up.body.id}/commit`, { masterOrderId: mo._id })).status, 201)
    const again = await as(admin).post(`/api/style-imports/${up.body.id}/commit`, { masterOrderId: mo._id })
    assert.equal(again.status, 400)
    assert.match(again.body.error, /already in this master order/)
    assert.equal(await Order.countDocuments(), 1)
  })

  test('rows with problems stop the import unless the rest is asked for', async () => {
    const { admin, mo } = await setup()
    const bad = ['', 'FYL-9', 'Dress', '', 'https://x.com', 'Cotton', 'Replen']
    const up = await upload(admin, await sheet([good(1), bad]))
    const refused = await as(admin).post(`/api/style-imports/${up.body.id}/commit`, { masterOrderId: mo._id })
    assert.equal(refused.status, 409)
    assert.equal(await Order.countDocuments(), 0)
    const partial = await as(admin).post(`/api/style-imports/${up.body.id}/commit`, { masterOrderId: mo._id, skipInvalid: true })
    assert.equal(partial.status, 201)
    assert.equal(partial.body.created.length, 1)
    assert.equal(partial.body.skipped.invalid, 1)
  })

  test('a factory cannot use it, and nobody can reach another person\'s upload', async () => {
    const { admin, buyer, mo } = await setup()
    const other = await makeAdmin()
    assert.equal((await upload(await makeMfr(), await sheet([good(1)]))).status, 403)
    const up = await upload(admin, await sheet([good(1)]))
    assert.equal((await as(other).post(`/api/style-imports/${up.body.id}/preview`, { masterOrderId: mo._id })).status, 404)
    assert.equal((await as(buyer).post(`/api/style-imports/${up.body.id}/commit`, { masterOrderId: mo._id })).status, 404)
    assert.equal(await Order.countDocuments(), 0)
  })

  test('bad uploads and bad targets are turned away', async () => {
    const { admin, mo } = await setup()
    assert.equal((await upload(admin, Buffer.from('hello'), 'notes.pdf')).status, 400)
    assert.equal((await upload(admin, Buffer.from('not a zip'), 'a.xlsx')).status, 400)
    assert.equal((await upload(admin, Buffer.alloc(0), 'a.csv')).status, 400)
    const up = await upload(admin, await sheet([good(1)]))
    assert.equal((await as(admin).post(`/api/style-imports/${up.body.id}/preview`, { masterOrderId: 'MO-NOPE' })).status, 404)
    assert.equal((await as(admin).post(`/api/style-imports/${up.body.id}/preview`, {})).status, 400)
    assert.equal((await as(admin).post('/api/style-imports/imp_0000000000000000/preview', { masterOrderId: mo._id })).status, 404)
    assert.equal((await as(admin).post('/api/style-imports/..%2Fx/preview', { masterOrderId: mo._id })).status, 404)
  })

  test('an expired or missing upload is reported as such', async () => {
    const { admin, mo } = await setup()
    const up = await upload(admin, await sheet([good(1)]))
    await StyleImportUpload.deleteOne({ _id: up.body.id })
    const res = await as(admin).post(`/api/style-imports/${up.body.id}/commit`, { masterOrderId: mo._id })
    assert.equal(res.status, 404)
    assert.match(res.body.error, /expired/)
  })
})

describe('a customer importing its own styles', () => {
  const sheetOf = n => workbook([HEADER, ...Array.from({ length: n }, (_, i) => good(i + 1))], { images: Object.fromEntries(Array.from({ length: n }, (_, i) => [i + 2, PNG(i + 2)])) })

  test('can preview, then SEND its sheet for review: nothing is created, a master admin is told, and approval creates NPD/Replen styles with no factory', async () => {
    const admin = await makeMaster()
    const buyer = await makeBuyer({ company: 'Cocoblu' })
    const mo = await makeMasterOrder({ buyerId: buyer._id, createdBy: admin._id, season: 'SS26' })
    const up = await upload(buyer, await sheetOf(2))
    assert.equal(up.status, 201, JSON.stringify(up.body))
    assert.equal((await as(buyer).post(`/api/style-imports/${up.body.id}/preview`, { masterOrderId: mo._id })).status, 200)
    const sent = await as(buyer).post(`/api/style-imports/${up.body.id}/commit`, { masterOrderId: mo._id })
    assert.equal(sent.status, 202, JSON.stringify(sent.body))
    assert.equal(sent.body.pending, true)
    assert.equal(await Order.countDocuments(), 0, 'nothing is created before approval')
    const told = await Notification.find({ toUser: admin._id }).lean()
    assert.equal(told.length, 1)
    assert.match(told[0].msg, /Cocoblu sent 2 styles for review/)
    assert.equal((await as(buyer).post(`/api/style-imports/${up.body.id}/commit`, { masterOrderId: mo._id })).status, 409, 'the same sheet is not sent twice')

    const approved = await as(admin).post(`/api/style-requests/${sent.body.requestId}/approve`)
    assert.equal(approved.status, 200, JSON.stringify(approved.body))
    const orders = await Order.find().lean()
    assert.equal(orders.length, 2)
    assert.ok(orders.every(o => String(o.buyerId) === String(buyer._id) && o.phase === 'replen' && !o.assignments.length))
    assert.equal(await Notification.countDocuments({ toUser: buyer._id, msg: /was approved/ }), 1)
  })

  test('cannot use another customer\'s master order, and a factory cannot use it at all', async () => {
    const admin = await makeMaster()
    const mine = await makeBuyer()
    const theirs = await makeBuyer()
    const moTheirs = await makeMasterOrder({ buyerId: theirs._id, createdBy: admin._id })
    const up = await upload(mine, await sheetOf(1))
    assert.equal((await as(mine).post(`/api/style-imports/${up.body.id}/preview`, { masterOrderId: moTheirs._id })).status, 404)
    assert.equal((await as(mine).post(`/api/style-imports/${up.body.id}/commit`, { masterOrderId: moTheirs._id })).status, 404)
    assert.equal(await Order.countDocuments(), 0)
    assert.equal((await upload(await makeMfr(), await sheetOf(1))).status, 403)
  })
})

describe('a style with a brand and a tech pack link', () => {
  test('the create and edit routes store them, trim them, and refuse a link that is not a web address', async () => {
    const admin = await makeMaster()
    const buyer = await makeBuyer()
    const base = { id: 'BR-001', buyerId: String(buyer._id), product: 'Dress', category: 'DRESS', season: 'FW26', phase: 'development' }
    const made = await as(admin).post('/api/orders', { ...base, brand: '  FYLTR ', techPackLink: 'drive.example.com/tp/1' })
    assert.equal(made.status, 201, JSON.stringify(made.body))
    assert.equal(made.body.brand, 'FYLTR')
    assert.equal(made.body.techPackLink, 'https://drive.example.com/tp/1')
    assert.equal((await as(admin).post('/api/orders', { ...base, id: 'BR-002', techPackLink: 'javascript:alert(1)' })).status, 400)
    assert.equal((await as(admin).post('/api/orders', { ...base, id: 'BR-003', brand: 'x'.repeat(61) })).status, 400)
    const edited = await as(admin).post('/api/orders/BR-001', { brand: 'Neobrands', techPackLink: '' })
    assert.equal(edited.status, 200, JSON.stringify(edited.body))
    assert.equal(edited.body.brand, 'Neobrands')
    assert.equal(edited.body.techPackLink, '')
    assert.equal((await as(admin).post('/api/orders/BR-001', { techPackLink: 'ftp://x' })).status, 400)
  })
})
