// The goods received note PDF: what came in from a supplier, what was accepted and what was turned away.
//
// Drawn from the GRN record, so the document can never disagree with what the stock ledger was told. A draft
// is stamped DRAFT on every page so a preview cannot be mistaken for the posted note.
import { COLORS, FONT, quantity, longDate, newDocument, toBuffer, pageFooters } from './theme.js'
import { stateName } from '../gst.js'

const M = 40

const lineOf = (...parts) => parts.filter(Boolean).join(', ')
const acceptedOf = l => Math.max(0, (l.qty || 0) - (l.rejectedQty || 0))

function partyLines(p = {}) {
  return [
    p.address,
    lineOf(p.city, p.pincode),
    p.stateCode ? `${stateName(p.stateCode)} (${p.stateCode})` : '',
    p.gstin ? `GSTIN: ${p.gstin}` : '',
  ].filter(Boolean)
}

function watermark(doc, text) {
  doc.save()
  doc.fillColor('#E2E8F0').opacity(0.55).font(FONT.bold).fontSize(120)
  const cx = doc.page.width / 2, cy = doc.page.height / 2
  doc.rotate(-35, { origin: [cx, cy] })
  doc.text(text, cx - 260, cy - 60, { width: 520, align: 'center', lineBreak: false })
  doc.restore()
}

/**
 * @param {object} grn  a goods received note (plain object)
 * @param {{ name: string, profile?: object }} org  the company that received the goods
 * @param {{ poNumber?: string, receivedBy?: string }} extra
 * @returns {Promise<Buffer>}
 */
export async function renderGrnPdf(grn, org, extra = {}) {
  const title = grn.number || 'Draft goods received note'
  const company = { name: org?.profile?.legalName || org?.name || '', ...(org?.profile || {}) }
  const doc = newDocument({ Title: `Goods received note ${title}`, Author: company.name || 'TextilMarkt', Subject: `Goods received from ${grn.supplierName || 'a supplier'}` })
  const done = toBuffer(doc)
  const W = doc.page.width - M * 2
  const stamp = grn.status === 'posted' ? '' : 'DRAFT'
  const mark = () => { if (stamp) watermark(doc, stamp) }
  doc.on('pageAdded', () => { mark() })
  mark()

  // Header: the company on the left, what this is on the right.
  doc.font(FONT.bold).fontSize(15).fillColor(COLORS.navy).text(company.name, M, M, { width: W * 0.56 })
  doc.font(FONT.regular).fontSize(8.5).fillColor(COLORS.muted)
  let y = doc.y + 2
  for (const l of partyLines(company)) { doc.text(l, M, y, { width: W * 0.56 }); y = doc.y + 1 }
  const leftBottom = doc.y
  doc.font(FONT.bold).fontSize(17).fillColor(COLORS.orange).text('GOODS RECEIVED NOTE', M + W * 0.4, M, { width: W * 0.6, align: 'right', lineBreak: false })
  doc.font(FONT.bold).fontSize(10).fillColor(COLORS.text).text(`No. ${grn.number || 'not yet numbered'}`, M + W * 0.5, M + 26, { width: W * 0.5, align: 'right', lineBreak: false })
  doc.font(FONT.regular).fontSize(9).fillColor(COLORS.muted)
  doc.text(`Received on: ${longDate(grn.receivedOn || grn.postedAt || grn.createdAt)}`, M + W * 0.5, M + 41, { width: W * 0.5, align: 'right', lineBreak: false })
  if (extra.poNumber || grn.poId) doc.text(`Against PO: ${extra.poNumber || grn.poId}`, M + W * 0.5, M + 54, { width: W * 0.5, align: 'right', lineBreak: false })

  y = Math.max(leftBottom, M + 72) + 8
  doc.moveTo(M, y).lineTo(M + W, y).lineWidth(1.5).strokeColor(COLORS.navy).stroke()
  y += 12

  // Two boxes: who sent it, and how it arrived.
  const colW = (W - 12) / 2
  const supplierText = [grn.supplierName || 'Not stated', grn.supplierGstin ? `GSTIN: ${grn.supplierGstin}` : ''].filter(Boolean)
  const arrivalText = [
    grn.challanNo ? `Challan / invoice no: ${grn.challanNo}` : 'Challan / invoice no: not given',
    grn.challanDate ? `Challan date: ${longDate(grn.challanDate)}` : '',
    grn.vehicleNo ? `Vehicle: ${grn.vehicleNo}` : '',
    extra.receivedBy ? `Received by: ${extra.receivedBy}` : '',
  ].filter(Boolean)
  const measure = (lines, first) => lines.reduce((h, l, i) => {
    doc.font(i === 0 && first ? FONT.bold : FONT.regular).fontSize(i === 0 && first ? 10.5 : 9)
    return h + doc.heightOfString(l, { width: colW - 20 }) + 1.5
  }, 0)
  const boxH = Math.max(measure(supplierText, true), measure(arrivalText, false)) + 30
  const box = (x, label, lines, boldFirst) => {
    doc.rect(x, y, colW, boxH).fill(COLORS.band)
    doc.font(FONT.bold).fontSize(7.5).fillColor(COLORS.muted).text(label, x + 10, y + 9, { characterSpacing: 0.6, lineBreak: false })
    let yy = y + 22
    lines.forEach((l, i) => {
      doc.font(i === 0 && boldFirst ? FONT.bold : FONT.regular).fontSize(i === 0 && boldFirst ? 10.5 : 9).fillColor(COLORS.text)
      doc.text(l, x + 10, yy, { width: colW - 20 })
      yy = doc.y + 1.5
    })
  }
  box(M, 'RECEIVED FROM', supplierText, true)
  box(M + colW + 12, 'ARRIVAL', arrivalText, false)
  y += boxH + 12

  // Lines.
  const cols = [
    { key: 'n', label: '#', w: 22, align: 'left' },
    { key: 'desc', label: 'Description', w: 190, align: 'left' },
    { key: 'unit', label: 'Unit', w: 34, align: 'left' },
    { key: 'ordered', label: 'Ordered', w: 52, align: 'right' },
    { key: 'qty', label: 'Received', w: 56, align: 'right' },
    { key: 'rej', label: 'Rejected', w: 54, align: 'right' },
    { key: 'acc', label: 'Accepted', w: 56, align: 'right' },
    { key: 'lot', label: 'Lot', w: 50, align: 'left' },
  ]
  const scale = W / cols.reduce((s, c) => s + c.w, 0)
  cols.forEach(c => { c.w *= scale })
  const xOf = i => M + cols.slice(0, i).reduce((s, c) => s + c.w, 0)
  const bottomLimit = () => doc.page.height - doc.page.margins.bottom - 4
  const header = () => {
    doc.rect(M, y, W, 20).fill(COLORS.navy)
    doc.font(FONT.bold).fontSize(8).fillColor(COLORS.white)
    cols.forEach((c, i) => doc.text(c.label, xOf(i) + 4, y + 6, { width: c.w - 8, align: c.align, lineBreak: false }))
    y += 20
  }
  header()
  ;(grn.lines || []).forEach((l, idx) => {
    const extraText = [l.rejectReason ? `Rejected: ${l.rejectReason}` : '', l.note].filter(Boolean).join('. ')
    doc.font(FONT.regular).fontSize(9)
    const h = Math.max(doc.heightOfString(l.description, { width: cols[1].w - 8 }) + (extraText ? doc.heightOfString(extraText, { width: cols[1].w - 8 }) : 0), 11) + 9
    if (y + h > bottomLimit()) { doc.addPage(); y = M; header() }
    const cells = {
      n: String(idx + 1), unit: l.unit || '', ordered: l.orderedQty == null ? '' : quantity(l.orderedQty),
      qty: quantity(l.qty), rej: l.rejectedQty ? quantity(l.rejectedQty) : '', acc: quantity(acceptedOf(l)), lot: l.lot || '',
    }
    cols.forEach((c, i) => {
      if (c.key === 'desc') {
        doc.font(FONT.regular).fontSize(9).fillColor(COLORS.text).text(l.description, xOf(i) + 4, y + 5, { width: c.w - 8 })
        if (extraText) doc.font(FONT.regular).fontSize(8).fillColor(COLORS.muted).text(extraText, xOf(i) + 4, doc.y, { width: c.w - 8 })
      } else {
        doc.font(c.key === 'acc' ? FONT.bold : FONT.regular).fontSize(9).fillColor(COLORS.text).text(cells[c.key], xOf(i) + 4, y + 5, { width: c.w - 8, align: c.align, lineBreak: false })
      }
    })
    y += h
    doc.moveTo(M, y).lineTo(M + W, y).lineWidth(0.5).strokeColor(COLORS.line).stroke()
  })
  y += 14

  if (grn.note) {
    doc.font(FONT.regular).fontSize(8.5)
    const nh = doc.heightOfString(grn.note, { width: W }) + 24
    if (y + nh + 70 > bottomLimit()) { doc.addPage(); y = M }
    doc.font(FONT.bold).fontSize(8).fillColor(COLORS.muted).text('NOTES', M, y, { characterSpacing: 0.6, lineBreak: false })
    doc.font(FONT.regular).fontSize(8.5).fillColor(COLORS.text).text(grn.note, M, y + 13, { width: W })
    y = doc.y + 14
  }

  if (y + 70 > bottomLimit()) { doc.addPage(); y = M }
  y += 24
  const sig = (x, label) => {
    doc.moveTo(x, y + 20).lineTo(x + 170, y + 20).lineWidth(0.5).strokeColor(COLORS.line).stroke()
    doc.font(FONT.regular).fontSize(8.5).fillColor(COLORS.muted).text(label, x, y + 25, { width: 170, lineBreak: false })
  }
  sig(M, 'Received by')
  sig(M + W - 170, 'Store in-charge')

  pageFooters(doc, `${title}  |  Generated with TextilMarkt`)
  doc.end()
  return done
}
