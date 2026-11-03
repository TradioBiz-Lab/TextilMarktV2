// Reading a spreadsheet of styles (Excel .xlsx or CSV) and checking it, row by row, before anything is created.
//
// Pure functions: no database and no Express here. The route supplies the file and the styles that already exist, and
// gets back one verdict per row. The same code runs for the preview and for the commit, so what was shown is what is
// created.
//
// Excel is read straight from the zip with JSZip rather than through exceljs: exceljs is a dev-only dependency, and it
// also crashes on workbooks whose drawing parts use absolute paths (the Cocoblu replen sheet is one). Pictures in an
// .xlsx float over the cells, anchored to a row, so each is matched to the row it sits on.
import JSZip from 'jszip'
import Papa from 'papaparse'
import { cleanLink } from './links.js'

/** A problem with the file as a whole, worded for the person who uploaded it. */
export class ImportError extends Error {}

export const MAX_ROWS = 100
const MAX_XML_BYTES = 20 * 1024 * 1024   // uncompressed size of any one XML part: a guard against a zip bomb
const MAX_IMAGE_READ = 5 * 1024 * 1024   // a picture larger than this is not even read out of the zip
const MAX_SHEET_ROW = 1_048_576          // Excel's last row: a picture anchored below it is not real
const MAX_PICTURES = 2000                // pictures looked at in one sheet
const MAX_PHOTO_BYTES = 1024 * 1024      // the same cap a style's photo has everywhere else (routes/orders.js)
const PREVIEW_IMAGE_BYTES = 150 * 1024   // a picture this small or smaller is sent back for the preview

// ── XML helpers (the bits of SpreadsheetML we need; no general parser) ────────────────────────────────────────────
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
  if (e[0] !== '#') return ENTITIES[e.toLowerCase()]
  const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
  try { return String.fromCodePoint(code) } catch { return m }
})
const attr = (tag, name) => { const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(tag); return m ? decode(m[1]) : null }
/**
 * Each `<tag ...>body</tag>` (or `<tag .../>`) in `xml`, as { attrs, body, start, end }, in one forward pass. A tag left
 * open ends the scan, so a crafted file cannot make every later search run to the end of the text again (which made
 * the old lazy regexes quadratic). Elements of the same name never nest in the parts read here.
 */
function* elements(xml, tag) {
  const open = new RegExp(`<(?:\\w+:)?${tag}(?=[\\s>/])`, 'g')
  const close = new RegExp(`</(?:\\w+:)?${tag}>`, 'g')
  for (let m; (m = open.exec(xml));) {
    const gt = xml.indexOf('>', m.index)
    if (gt === -1) return
    if (xml[gt - 1] === '/') { yield { attrs: xml.slice(m.index + m[0].length, gt - 1), body: '', start: m.index, end: gt + 1 }; open.lastIndex = gt + 1; continue }
    close.lastIndex = gt + 1
    const c = close.exec(xml)
    if (!c) return
    yield { attrs: xml.slice(m.index + m[0].length, gt), body: xml.slice(gt + 1, c.index), start: m.index, end: c.index + c[0].length }
    open.lastIndex = close.lastIndex
  }
}
/** All the text in a shared-string or inline-string element (rich text has several runs; phonetic hints are skipped). */
function textOf(xml) {
  xml = String(xml)
  let kept = '', from = 0
  for (const e of elements(xml, 'rPh')) { kept += xml.slice(from, e.start); from = e.end }
  kept += xml.slice(from)
  return [...elements(kept, 't')].map(e => decode(e.body)).join('')
}

const colIndex = letters => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1

const resolveTarget = (baseFile, target) => {
  if (target.startsWith('/')) return target.slice(1)
  const parts = baseFile.split('/').slice(0, -1)
  for (const seg of target.split('/')) { if (seg === '..') parts.pop(); else if (seg !== '.') parts.push(seg) }
  return parts.join('/')
}

/**
 * A zip entry's bytes, counted as they are inflated: past `max` the read stops. The size a zip states about its own
 * entries is not trusted, since a crafted file can claim 1KB for a part that inflates to gigabytes.
 */
function readBounded(file, max) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0, done = false
    const stream = file.internalStream('uint8array')
    stream.on('data', chunk => {
      if (done) return
      total += chunk.length
      if (total > max) { done = true; stream.pause(); reject(new ImportError('That workbook is too large to read.')); return }
      chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length))
    }).on('error', err => { if (!done) { done = true; reject(err) } })
      .on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)) } })
      .resume()
  })
}

async function readPart(zip, path) {
  const file = zip.file(path)
  if (!file) return null
  if ((file._data?.uncompressedSize ?? 0) > MAX_XML_BYTES) throw new ImportError('That workbook is too large to read.')
  return (await readBounded(file, MAX_XML_BYTES)).toString('utf8')
}

/** The relationships of a part: id -> { type, target (resolved to a zip path unless external), external }. */
async function readRels(zip, partPath) {
  const dir = partPath.split('/').slice(0, -1).join('/')
  const xml = await readPart(zip, `${dir ? dir + '/' : ''}_rels/${partPath.split('/').pop()}.rels`)
  const rels = new Map()
  for (const m of (xml || '').matchAll(/<Relationship\s[^>]*>/g)) {
    const id = attr(m[0], 'Id'), target = attr(m[0], 'Target')
    if (!id || !target) continue
    const external = /^External$/i.test(attr(m[0], 'TargetMode') || '')
    rels.set(id, { type: attr(m[0], 'Type') || '', target: external ? target : resolveTarget(partPath, target), external })
  }
  return rels
}

const IMAGE_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }

// ── .xlsx ─────────────────────────────────────────────────────────────────────────────────────────────────────────
/** A table of { rowNumber, values[], links{colIndex: url}, image } from the first visible sheet of an .xlsx. */
export async function readXlsx(buffer) {
  let zip
  try { zip = await JSZip.loadAsync(buffer) } catch { throw new ImportError('That file is not a valid Excel workbook (.xlsx).') }
  const workbook = await readPart(zip, 'xl/workbook.xml')
  if (!workbook) throw new ImportError('That file is not a valid Excel workbook (.xlsx).')
  const warnings = []

  const wbRels = await readRels(zip, 'xl/workbook.xml')
  const sheets = [...workbook.matchAll(/<sheet\s[^>]*>/g)].map(m => ({
    name: attr(m[0], 'name') || 'Sheet', rid: attr(m[0], 'r:id'), hidden: /hidden/i.test(attr(m[0], 'state') || ''),
  }))
  const visible = sheets.filter(s => !s.hidden)
  const sheet = visible[0]
  const sheetPath = sheet && wbRels.get(sheet.rid)?.target
  const sheetXml = sheetPath && await readPart(zip, sheetPath)
  if (!sheetXml) throw new ImportError('The workbook has no sheet to read.')
  const otherSheets = visible.slice(1).map(s => s.name)
  if (otherSheets.length) warnings.push(`Only the first sheet, "${sheet.name}", is read. Ignored: ${otherSheets.map(n => `"${n}"`).join(', ')}.`)

  const ssRel = [...wbRels.values()].find(r => /\/sharedStrings$/.test(r.type))
  const ssXml = await readPart(zip, ssRel?.target || 'xl/sharedStrings.xml')
  const shared = ssXml ? [...elements(ssXml, 'si')].map(e => textOf(e.body)) : []

  // Cells, row by row. Row heights are kept: a picture is placed by height, not by row number.
  const defaultHeight = parseFloat(attr((/<sheetFormatPr\s[^>]*>/.exec(sheetXml) || [''])[0], 'defaultRowHeight')) || 15
  const rows = new Map()
  const heights = new Map()
  for (const rm of elements(sheetXml, 'row')) {
    const rowNumber = parseInt(attr(rm.attrs, 'r'), 10)
    if (!Number.isFinite(rowNumber) || rowNumber < 1 || rowNumber > MAX_SHEET_ROW) continue
    const ht = parseFloat(attr(rm.attrs, 'ht'))
    if (Number.isFinite(ht) && ht >= 0) heights.set(rowNumber, ht)
    const values = []
    for (const cm of elements(rm.body, 'c')) {
      const ref = /^([A-Z]{1,3})\d+$/.exec(attr(cm.attrs, 'r') || '')
      if (!ref) continue
      const type = attr(cm.attrs, 't'), body = cm.body
      const v = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(body)
      let text = ''
      if (type === 's') text = shared[parseInt(v?.[1], 10)] ?? ''
      else if (type === 'inlineStr') text = textOf(body)
      else if (type === 'str') text = v ? decode(v[1]) : ''
      else if (type === 'b') text = v?.[1] === '1' ? 'TRUE' : 'FALSE'
      else if (type === 'e') text = ''
      else text = v ? decode(v[1]) : ''
      values[colIndex(ref[1])] = text
    }
    rows.set(rowNumber, { rowNumber, values: Array.from(values, v => v ?? ''), links: {}, image: null })
  }

  // Hyperlinks: the cell shows text, the link is its own part of the sheet. A cell whose text is a label ("Link")
  // still gives its address.
  const sheetRels = await readRels(zip, sheetPath)
  for (const hm of sheetXml.matchAll(/<hyperlink\s[^>]*>/g)) {
    const ref = /^([A-Z]+)(\d+)$/.exec(attr(hm[0], 'ref') || '')
    const rel = sheetRels.get(attr(hm[0], 'r:id'))
    if (!ref || !rel?.external) continue
    const row = rows.get(parseInt(ref[2], 10))
    if (row) row.links[colIndex(ref[1])] = rel.target
  }

  // Pictures.
  const drawingRel = [...sheetRels.values()].find(r => /\/drawing$/.test(r.type) && !r.external)
  const drawingXml = drawingRel && await readPart(zip, drawingRel.target)
  if (drawingXml) {
    const drawRels = await readRels(zip, drawingRel.target)
    // Row n+1's top edge, in EMU: n rows of the default height, corrected for the rows that have their own (so the cost is
    // the rows in the sheet, never the row number a picture claims).
    const rowTop = n => { let y = n * defaultHeight; for (const [r, h] of heights) if (r <= n) y += h - defaultHeight; return y * 12700 }
    const rowAt = y => { let r = 1, top = 0; for (;;) { const h = (heights.get(r) ?? defaultHeight) * 12700; if (y < top + h || r > 5000) return r; top += h; r++ } }
    let unplaced = 0, seen = 0
    const anchors = [...elements(drawingXml, 'oneCellAnchor'), ...elements(drawingXml, 'twoCellAnchor'), ...elements(drawingXml, 'absoluteAnchor')].sort((a, b) => a.start - b.start)
    for (const am of anchors) {
      if (++seen > MAX_PICTURES) { warnings.push(`Only the first ${MAX_PICTURES} pictures are read.`); break }
      const anchor = am.body
      const embed = /\bembed="([^"]+)"/.exec(anchor)
      if (!embed) continue
      const pos = tag => {
        const el = elements(anchor, tag).next().value
        const row = el && /<(?:\w+:)?row>(\d+)</.exec(el.body), off = el && /<(?:\w+:)?rowOff>(-?\d+)</.exec(el.body)
        return row && off ? { row: parseInt(row[1], 10), off: parseInt(off[1], 10) } : null
      }
      const from = pos('from'), to = pos('to')
      if (!from || from.row > MAX_SHEET_ROW || (to && to.row > MAX_SHEET_ROW)) { unplaced++; continue }
      const top = rowTop(from.row) + from.off
      let bottom = to ? rowTop(to.row) + to.off : null
      if (bottom === null) { const ext = /<(?:\w+:)?ext\s[^>]*\bcy="(\d+)"/.exec(anchor); bottom = ext ? top + parseInt(ext[1], 10) : top }
      const rowNumber = rowAt((top + bottom) / 2)
      const row = rows.get(rowNumber)
      const media = drawRels.get(embed[1])
      if (!row || !media || media.external) { unplaced++; continue }
      if (row.image) { warnings.push(`Row ${rowNumber} has more than one picture; the first is used.`); continue }
      const ext = (media.target.split('.').pop() || '').toLowerCase()
      const file = zip.file(media.target)
      const size = file?._data?.uncompressedSize ?? 0
      if (!file) { unplaced++; continue }
      if (size > MAX_IMAGE_READ) { row.image = { mime: IMAGE_TYPES[ext] || null, ext, bytes: size, tooLarge: true }; continue }
      let data
      try { data = await readBounded(file, MAX_IMAGE_READ) } catch (err) {
        if (!(err instanceof ImportError)) throw err
        row.image = { mime: IMAGE_TYPES[ext] || null, ext, bytes: MAX_IMAGE_READ + 1, tooLarge: true }; continue
      }
      row.image = { mime: IMAGE_TYPES[ext] || null, ext, bytes: data.length, data }
    }
    if (unplaced) warnings.push(`${unplaced} picture${unplaced !== 1 ? 's' : ''} in the sheet could not be matched to a row.`)
  }
  // Pictures placed INSIDE a cell (Excel's "Place in Cell") live in a different part that is not read.
  if (Object.keys(zip.files).some(f => f.startsWith('xl/richData/'))) {
    warnings.push('Some pictures are placed inside cells, which are not read. Use Insert > Pictures > Place Over Cells, or give an image link instead.')
  }

  return { sheetName: sheet.name, otherSheets, rows: [...rows.values()].sort((a, b) => a.rowNumber - b.rowNumber), warnings }
}

// ── .csv ──────────────────────────────────────────────────────────────────────────────────────────────────────────
export function readCsv(buffer) {
  const text = buffer.toString('utf8').replace(/^﻿/, '')
  const parsed = Papa.parse(text, { skipEmptyLines: false })
  const rows = parsed.data
    .map((values, i) => ({ rowNumber: i + 1, values: values.map(v => String(v ?? '')), links: {}, image: null }))
    .filter(r => r.values.some(v => v.trim()))
  return { sheetName: null, otherSheets: [], rows, warnings: [] }
}

/** The table in a file, by its name's extension. */
export async function readTable(buffer, filename) {
  if (/\.xlsx$/i.test(filename)) return readXlsx(buffer)
  if (/\.csv$/i.test(filename)) return readCsv(buffer)
  throw new ImportError('Upload an Excel (.xlsx) or CSV (.csv) file.')
}

// ── Columns ───────────────────────────────────────────────────────────────────────────────────────────────────────
// A header is matched by its letters and digits only, so "Style No", "style_no" and "STYLE NO." are the same.
const ALIASES = {
  brand: ['brand'],
  styleNumber: ['styleno', 'stylenumber', 'styleid', 'style', 'customerstyleid', 'stylecode'],
  product: ['proddescription', 'productdescription', 'description', 'product', 'productname', 'stylename'],
  image: ['productimage', 'image', 'photo', 'picture', 'imageurl', 'photourl', 'imagelink'],
  ecommerceLink: ['amazonlink', 'ecommercelink', 'productlink', 'listinglink', 'weblink', 'link', 'url'],
  fabric: ['fabriccomposition', 'fabric', 'fabrics', 'fabricdetails'],
  stage: ['stage', 'phase', 'orderstage'],
  category: ['category'],
  techPackLink: ['techpacklink', 'techpack', 'techpackurl'],
  quantity: ['quantity', 'qty', 'totalqty'],
  colours: ['colours', 'colors', 'colourways', 'colorways'],
}
const COLUMN_LABELS = {
  brand: 'Brand', styleNumber: 'Style No', product: 'Description', image: 'Image', ecommerceLink: 'Amazon link', fabric: 'Fabric', stage: 'Stage',
  category: 'Category', techPackLink: 'Tech pack link', quantity: 'Quantity', colours: 'Colours',
}
// What a sheet must have as a column. Image and the links are checked per row.
const REQUIRED_COLUMNS = ['brand', 'styleNumber', 'product', 'fabric', 'stage']
const squash = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
const keyFor = header => Object.entries(ALIASES).find(([, names]) => names.includes(squash(header)))?.[0] || null

/** Where the header row is and which column is which: { headerIndex, columns{key: colIndex}, ignored[header texts] }. */
export function findColumns(table) {
  for (let i = 0; i < Math.min(table.rows.length, 10); i++) {
    const columns = {}
    table.rows[i].values.forEach((h, c) => { const k = keyFor(h); if (k && columns[k] === undefined) columns[k] = c })
    if (Object.keys(columns).length >= 3 && (columns.styleNumber !== undefined || columns.product !== undefined)) {
      const used = new Set(Object.values(columns))
      const ignored = table.rows[i].values.filter((h, c) => String(h).trim() && !used.has(c)).map(h => String(h).trim())
      return { headerIndex: i, columns, ignored }
    }
  }
  throw new ImportError('Could not find the header row. The sheet needs columns such as Style No, Description, Fabric and Stage.')
}

// ── Cells ─────────────────────────────────────────────────────────────────────────────────────────────────────────
/** A cell as one tidy line: stray spaces, non-breaking spaces and zero-width characters gone. */
export const tidy = v => String(v ?? '').replace(/[ ​-‍﻿]/g, ' ').replace(/\s+/g, ' ').trim()

const STAGES = [
  [/^(npd|new product development|new product|development|dev)$/i, 'development'],
  [/^replens?$|^replenish(ment)?s?$|^re-?order$/i, 'replen'],
]
// First match wins, so "shirt dress" is a dress and "smocked top" a top.
const CATEGORY_WORDS = [
  [/\bdress/i, 'DRESS'], [/\bskirt/i, 'SKIRT'], [/\bjump\s?suit|\bplaysuit|\bromper/i, 'JUMPSUIT'], [/\bjeans\b/i, 'JEANS'],
  [/\bjacket|\bblazer|\bcoat\b/i, 'JACKET'], [/\bhoodie|\bsweatshirt/i, 'HOODIE'], [/\bpolo\b/i, 'POLO'], [/\bt-?shirt|\btee\b/i, 'TSHRT'],
  [/\bshirt/i, 'SHIRT'], [/\bblouse|\btop\b|\btunic|\bkurti/i, 'TOP'], [/\bshorts?\b/i, 'SHORTS'], [/\btrouser|\bpants?\b|\bpalazzo/i, 'PANTS'],
]
const FIBRE = /\b\d{1,3}\s?%\s?(?:cotton|polyester|viscose|linen|rayon|wool|nylon|elastane|spandex|modal|lyocell|silk|acrylic)\b/i

const splitList = v => [...new Set(tidy(v).split(/[,;/|]/).map(s => s.trim()).filter(Boolean))]

// The table's cell for a column, with a link's own address when the cell only shows a label.
const cell = (row, columns, key) => columns[key] === undefined ? '' : tidy(row.values[columns[key]])
const linkCell = (row, columns, key) => {
  const text = cell(row, columns, key)
  return /^https?:\/\//i.test(text) ? text : (row.links[columns[key]] || text)
}

const photoProblem = image => {
  if (image.tooLarge || image.bytes > MAX_PHOTO_BYTES) return 'The picture is over 1MB. Shrink it and upload again.'
  if (!image.mime) return `The picture is a .${image.ext || 'unknown'} file. Use a JPEG, PNG or WebP picture.`
  return null
}

/**
 * One verdict per data row.
 *   status 'ok'     will be created
 *   status 'error'  has a problem that must be fixed in the sheet (listed in `problems`)
 *   status 'exists' this style number is already in the master order: skipped, never duplicated
 * `existing` is a Map of lower-cased style number -> id of the style already in the master order.
 * `requireTechPackForNpd`: a customer's sheet, where a new product (NPD) row must carry its tech pack link.
 */
// `defaultPhase` ('replen' or 'development'): the stage of a row whose sheet has no Stage, or whose Stage cell is blank. The
// Order replen and New product windows send it, since everything sent there is that stage (a brand's own sheet has no Stage).
export function analyseTable(table, { existing = new Map(), requireTechPackForNpd = false, defaultPhase = null } = {}) {
  if (!['replen', 'development'].includes(defaultPhase)) defaultPhase = null
  const { headerIndex, columns, ignored } = findColumns(table)
  const missing = REQUIRED_COLUMNS.filter(k => columns[k] === undefined && !(k === 'stage' && defaultPhase))
  if (missing.length) throw new ImportError(`The sheet is missing these columns: ${missing.map(k => COLUMN_LABELS[k]).join(', ')}.`)

  const dataRows = table.rows.slice(headerIndex + 1).filter(r => r.image || r.values.some(v => tidy(v)))
  if (!dataRows.length) throw new ImportError('The sheet has no styles under its header row.')
  if (dataRows.length > MAX_ROWS) throw new ImportError(`Too many rows (${dataRows.length}). Upload ${MAX_ROWS} or fewer at a time.`)

  const seen = new Map() // lower-cased style number -> row number of its first appearance in this file
  const rows = dataRows.map(row => {
    const problems = [], warnings = []
    const need = (value, label) => { if (!value) problems.push(`${label} is missing.`); return value }
    const brand = need(cell(row, columns, 'brand'), 'Brand')
    const styleNumber = need(cell(row, columns, 'styleNumber'), 'Style No')
    const product = need(cell(row, columns, 'product'), 'Description')
    const fabric = need(cell(row, columns, 'fabric'), 'Fabric')
    if (brand.length > 60) problems.push('Brand is too long (60 characters at most).')
    if (styleNumber.length > 60) problems.push('Style No is too long (60 characters at most).')
    if (product.length > 300) problems.push('Description is too long (300 characters at most).')
    if (fabric.length > 100) problems.push('Fabric is too long (100 characters at most).')

    // Stage: only the two that need no quantity or delivery date. A production style goes through Create Style.
    const stageText = cell(row, columns, 'stage')
    let phase = null
    if (!stageText && defaultPhase) phase = defaultPhase
    else if (!stageText) problems.push('Stage is missing (NPD or Replen).')
    else {
      phase = STAGES.find(([re]) => re.test(stageText))?.[1] || null
      if (!phase) problems.push(/^production$/i.test(stageText)
        ? 'Stage "Production" cannot be imported here, since a production style needs a quantity and delivery date. Tradio sets those up.'
        : `Stage "${stageText}" is not NPD or Replen.`)
    }

    // Links. The Amazon link is the style's page for a replen (the product is already on sale); a new product may have none yet.
    const ecom = cleanLink(linkCell(row, columns, 'ecommerceLink'), 'Amazon link')
    if (ecom.error) problems.push(ecom.error)
    else if (!ecom.link && phase === 'replen') problems.push('Amazon link is missing (needed for a replen).')
    const techPack = cleanLink(linkCell(row, columns, 'techPackLink'), 'Tech pack link')
    if (techPack.error) problems.push(techPack.error)
    else if (requireTechPackForNpd && phase === 'development' && !techPack.link) problems.push('Tech pack link is missing (needed for a new product).')

    // Image: the picture on this row, or an address in the Image column.
    let imageField = null, imagePreview = null, hasImage = false
    const imageText = linkCell(row, columns, 'image')
    if (row.image) {
      hasImage = true
      const bad = photoProblem(row.image)
      if (bad) problems.push(bad)
      else {
        imageField = `data:${row.image.mime};base64,${row.image.data.toString('base64')}`
        if (row.image.bytes <= PREVIEW_IMAGE_BYTES) imagePreview = imageField
      }
    } else if (imageText) {
      hasImage = true
      const r = cleanLink(imageText, 'Image link')
      if (r.error || !r.link) problems.push(r.error || 'The Image column has text that is not a picture or a web address.')
      else { imageField = r.link; imagePreview = r.link }
    } else problems.push('Image is missing (a picture on the row, or a link in the Image column).')

    // Category: given, else guessed from the description (and shown as a guess).
    let category = cell(row, columns, 'category').toUpperCase()
    let categoryGuessed = false
    if (!category) {
      category = CATEGORY_WORDS.find(([re]) => re.test(product))?.[1] || ''
      categoryGuessed = !!category
      if (!category) problems.push('Category is missing and could not be worked out from the description. Add a Category column value.')
    } else if (category.length > 50) problems.push('Category is too long.')

    // Quantity is optional for both stages.
    let totalQty = null
    const qtyText = cell(row, columns, 'quantity').replace(/,/g, '')
    if (qtyText) {
      const n = Number(qtyText)
      if (Number.isInteger(n) && n >= 1) totalQty = n
      else problems.push(`Quantity "${cell(row, columns, 'quantity')}" is not a whole number.`)
    }

    const colours = splitList(cell(row, columns, 'colours'))
    if (colours.length > 40) problems.push('Too many colours (40 at most).')
    if (colours.some(c => c.length > 60)) problems.push('A colour name is too long (60 characters at most).')

    // The same style number twice in the file, or already in the master order.
    let status = 'ok', existingId = null
    const key = styleNumber.toLowerCase()
    if (key) {
      if (seen.has(key)) problems.push(`Same style number as row ${seen.get(key)}.`)
      else seen.set(key, row.rowNumber)
      if (existing.has(key)) { status = 'exists'; existingId = existing.get(key) }
    }
    if (problems.length) status = 'error'

    return {
      row: row.rowNumber, status, problems, warnings, existingId,
      styleNumber, product, brand, stage: phase, category, categoryGuessed, fabric, quantity: totalQty, colours,
      ecommerceLink: ecom.link || '', techPackLink: techPack.link || '', hasImage, imagePreview,
      // What the commit hands to the order validator. Never sent to the browser.
      payload: status === 'ok' ? {
        product, styleNumber, brand, category, phase,
        ...(totalQty ? { totalQty } : {}),
        colourways: colours.map(name => ({ name })),
        fabricDetails: [{ name: fabric, composition: FIBRE.test(fabric) ? fabric : (FIBRE.exec(product)?.[0] || ''), gsm: '', supplier: '' }],
        ecommerceLink: ecom.link || '', techPackLink: techPack.link || '',
        photos: [{ image: imageField, colourway: '' }],
      } : null,
    }
  })

  const count = s => rows.filter(r => r.status === s).length
  return {
    sheetName: table.sheetName, warnings: table.warnings, ignoredColumns: ignored,
    summary: { total: rows.length, ok: count('ok'), errors: count('error'), exists: count('exists') },
    rows,
  }
}
