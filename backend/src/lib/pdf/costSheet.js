// The open cost sheet a factory shares with its customer.
//
// Drawn from the figures the server worked out and stored (lib/costing.js), so the PDF can never disagree
// with what the system holds. The whole build-up is shown, as on the factory's approved costing sheet:
// each block's lines, labour, and the overhead, rejection, margin and (where it applies) Tradio lines down
// to the price. A draft is stamped DRAFT on every page.
import { COLORS, FONT, RUPEE, money, quantity, longDate, newDocument, toBuffer, pageFooters } from './theme.js'
import { computeCostSheet, MATERIAL_SECTIONS } from '../costing.js'

const M = 40
const BLOCKS = { fabric: 'FABRIC', process: 'PROCESS (BRANDING, ELASTICS, TRANSFERS)', trims: 'TRIMS', labelsPackaging: 'LABELS, TAGS AND PACKAGING' }

function watermark(doc, text) {
  doc.save()
  doc.fillColor('#E2E8F0').opacity(0.55).font(FONT.bold).fontSize(120)
  const cx = doc.page.width / 2, cy = doc.page.height / 2
  doc.rotate(-35, { origin: [cx, cy] })
  doc.text(text, cx - 260, cy - 60, { width: 520, align: 'center', lineBreak: false })
  doc.restore()
}

/**
 * @param {object} sheet  a cost sheet (plain object)
 * @param {{ factoryName: string, brandName: string, address?: string }} names
 * @returns {Promise<Buffer>}
 */
export async function renderCostSheetPdf(sheet, { factoryName = '', brandName = '', address = '' } = {}) {
  const label = `${sheet.chainId} v${sheet.version}`
  const doc = newDocument({ Title: `Cost sheet ${label}`, Author: factoryName || 'TextilMarkt', Subject: `${sheet.styleName} for ${brandName}` })
  const done = toBuffer(doc)
  const W = doc.page.width - M * 2
  const draft = sheet.status === 'draft'
  doc.on('pageAdded', () => { if (draft) watermark(doc, 'DRAFT') })
  if (draft) watermark(doc, 'DRAFT')
  const c = sheet.status === 'draft' || !sheet.computed ? computeCostSheet(sheet) : sheet.computed
  const bottomLimit = () => doc.page.height - doc.page.margins.bottom - 4

  // ── Header ──
  doc.font(FONT.bold).fontSize(15).fillColor(COLORS.navy).text(factoryName, M, M, { width: W * 0.56 })
  doc.font(FONT.regular).fontSize(8.5).fillColor(COLORS.muted)
  if (address) doc.text(address, M, doc.y + 2, { width: W * 0.56 })
  const leftBottom = doc.y
  doc.font(FONT.bold).fontSize(19).fillColor(COLORS.orange).text('COST SHEET', M + W * 0.5, M, { width: W * 0.5, align: 'right', lineBreak: false })
  doc.font(FONT.bold).fontSize(10).fillColor(COLORS.text).text(`No. ${label}`, M + W * 0.5, M + 27, { width: W * 0.5, align: 'right', lineBreak: false })
  doc.font(FONT.regular).fontSize(9).fillColor(COLORS.muted)
  doc.text(`Date: ${longDate(sheet.sharedAt || sheet.createdAt) || longDate(new Date())}`, M + W * 0.5, M + 42, { width: W * 0.5, align: 'right', lineBreak: false })

  let y = Math.max(leftBottom, M + 62) + 8
  doc.moveTo(M, y).lineTo(M + W, y).lineWidth(1.5).strokeColor(COLORS.navy).stroke()
  y += 12

  // ── The style ──
  const facts = [
    ['Style', sheet.styleName + (sheet.styleCode ? ` (${sheet.styleCode})` : '')],
    ['Prepared for', brandName],
    ['Quantity', sheet.qty ? `${quantity(sheet.qty)} pcs` : 'Per piece'],
    ['Status', sheet.status === 'approved' ? `Approved${sheet.approvedAt ? ` on ${longDate(sheet.approvedAt)}` : ''}` : draft ? 'Draft' : 'Shared for approval'],
  ]
  const fw = W / facts.length
  facts.forEach(([k, v], i) => {
    doc.font(FONT.regular).fontSize(7.5).fillColor(COLORS.muted).text(k.toUpperCase(), M + i * fw, y, { width: fw - 8, characterSpacing: 0.5, lineBreak: false })
    doc.font(FONT.bold).fontSize(9).fillColor(COLORS.text).text(v, M + i * fw, y + 11, { width: fw - 8, lineBreak: false, ellipsis: true })
  })
  y += 36

  // ── Columns ──
  const cols = [
    { label: 'Item', w: 210, align: 'left' },
    { label: 'Qty per pc', w: 70, align: 'right' },
    { label: 'Rate', w: 62, align: 'right' },
    { label: 'Wastage', w: 50, align: 'right' },
    { label: `Per piece (${RUPEE})`, w: 83, align: 'right' },
  ]
  const scale = W / cols.reduce((s, col) => s + col.w, 0)
  cols.forEach(col => { col.w *= scale })
  const xOf = i => M + cols.slice(0, i).reduce((s, col) => s + col.w, 0)
  const need = h => { if (y + h > bottomLimit()) { doc.addPage(); y = M } }
  const band = title => {
    need(40)
    doc.rect(M, y, W, 18).fill(COLORS.navy)
    doc.font(FONT.bold).fontSize(8).fillColor(COLORS.white).text(title, M + 6, y + 5.5, { characterSpacing: 0.5, lineBreak: false })
    cols.slice(1).forEach((col, i) => doc.text(col.label, xOf(i + 1) + 4, y + 5.5, { width: col.w - 8, align: col.align, lineBreak: false }))
    y += 18
  }
  const row = (cells, { bold = false, rule = true } = {}) => {
    const first = cells[0]
    doc.font(bold ? FONT.bold : FONT.regular).fontSize(9)
    const h = Math.max(doc.heightOfString(first, { width: cols[0].w - 8 }), 11) + 8
    need(h)
    cells.forEach((cell, i) => {
      doc.font(bold ? FONT.bold : FONT.regular).fontSize(9).fillColor(COLORS.text).text(cell, xOf(i) + 4, y + 4, { width: cols[i].w - 8, align: cols[i].align, ...(i === 0 ? {} : { lineBreak: false }) })
    })
    y += h
    if (rule) doc.moveTo(M, y).lineTo(M + W, y).lineWidth(0.5).strokeColor(COLORS.line).stroke()
  }

  for (const key of MATERIAL_SECTIONS) {
    const lines = sheet[key] || []
    if (!lines.length) continue
    band(BLOCKS[key])
    lines.forEach((l, i) => {
      const name = [l.name, l.spec, l.note ? `(${l.note})` : ''].filter(Boolean).join(', ')
      row([name, `${quantity(l.consumption)}${l.unit ? ` ${l.unit}` : ''}`, l.rate || l.freight || l.dutyPct ? money(l.rate) : '', l.wastagePct ? `${quantity(l.wastagePct)}%` : '', money(c.lines?.[key]?.[i])])
    })
    row([`Total ${BLOCKS[key].split(' (')[0].toLowerCase()}`, '', '', '', money(c[key])], { bold: true })
    y += 6
  }

  band('LABOUR')
  row(['Cutting and threads', '', '', '', money(c.cuttingThreads)])
  row(['Making', '', '', '', money(c.making)])
  row(['Finishing and packing', '', '', '', money(c.finishingPacking)])
  row(['Total labour', '', '', '', money(c.labour)], { bold: true })
  y += 10

  // ── The build-up to the price ──
  const rows = [
    ['Raw material', c.materials], ['Labour', c.labour], ['Total labour and raw material', c.base, true],
    [`Overhead (${quantity(sheet.overheadPct)}%)`, c.overhead], [`Rejection (${quantity(sheet.rejectionPct)}%)`, c.rejection], [`Margin (${quantity(sheet.marginPct)}%)`, c.margin],
  ]
  if (sheet.tradioPct > 0) rows.push([`Tradio fee (${quantity(sheet.tradioPct)}%)`, c.tradio])
  const tw = 250, tx = M + W - tw
  need(rows.length * 15 + 110)
  rows.forEach(([lbl, value, strong]) => {
    doc.font(strong ? FONT.bold : FONT.regular).fontSize(9).fillColor(strong ? COLORS.text : COLORS.muted).text(lbl, tx, y, { width: tw - 90, lineBreak: false })
    doc.fillColor(COLORS.text).text(money(value), tx + tw - 90, y, { width: 90, align: 'right', lineBreak: false })
    y += 15
  })
  doc.rect(tx, y + 2, tw, 24).fill(COLORS.navy)
  doc.font(FONT.bold).fontSize(10).fillColor(COLORS.white).text('Price per piece', tx + 8, y + 9, { lineBreak: false })
  doc.text(`${RUPEE} ${money(c.price)}`, tx + tw - 130, y + 9, { width: 122, align: 'right', lineBreak: false })
  y += 32
  if (sheet.discountPct > 0) {
    doc.font(FONT.regular).fontSize(9).fillColor(COLORS.muted).text(`Negotiated discount (${quantity(sheet.discountPct)}%)`, tx, y, { width: tw - 90, lineBreak: false })
    doc.fillColor(COLORS.text).text(`-${money(c.price - c.negotiated)}`, tx + tw - 90, y, { width: 90, align: 'right', lineBreak: false })
    y += 15
    doc.rect(tx, y + 2, tw, 24).fill(COLORS.orange)
    doc.font(FONT.bold).fontSize(10).fillColor(COLORS.white).text('Negotiated price per piece', tx + 8, y + 9, { lineBreak: false })
    doc.text(`${RUPEE} ${money(c.negotiated)}`, tx + tw - 130, y + 9, { width: 122, align: 'right', lineBreak: false })
    y += 32
  }
  if (c.orderValue) {
    const value = sheet.discountPct > 0 ? c.negotiatedValue : c.orderValue
    doc.font(FONT.regular).fontSize(9).fillColor(COLORS.muted).text(`Order value (${quantity(sheet.qty)} pcs)`, tx, y, { width: tw - 110, lineBreak: false })
    doc.font(FONT.bold).fillColor(COLORS.text).text(`${RUPEE} ${money(value)}`, tx + tw - 110, y, { width: 110, align: 'right', lineBreak: false })
    y += 20
  }

  pageFooters(doc, `${label}  |  Generated with TextilMarkt`)
  doc.end()
  return done
}
