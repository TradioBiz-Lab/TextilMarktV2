// The purchase order PDF a factory sends its supplier.
//
// Drawn straight from the PO record (its frozen supplier and buyer details, its computed lines and
// totals), so the PDF can never disagree with what the system holds. A draft is stamped DRAFT on every
// page so a preview cannot be mistaken for the real thing.
import { COLORS, FONT, RUPEE, money, quantity, longDate, newDocument, toBuffer, pageFooters } from './theme.js'
import { stateName } from '../gst.js'
import { amountInWords } from '../words.js'

const M = 40                                   // page margin
const NOTE_COLOR = COLORS.muted

const TAX_LABEL = { intra: 'CGST + SGST (same state)', inter: 'IGST (another state)', unknown: 'GST' }

function lineOf(...parts) { return parts.filter(Boolean).join(', ') }

function partyLines(p = {}) {
  return [
    p.address,
    lineOf(p.city, p.pincode),
    p.stateCode ? `${stateName(p.stateCode)} (${p.stateCode})` : '',
    p.gstin ? `GSTIN: ${p.gstin}` : '',
    p.pan ? `PAN: ${p.pan}` : '',
    p.contactName ? `Attn: ${p.contactName}` : '',
    lineOf(p.phone, p.email),
  ].filter(Boolean)
}

function watermark(doc, text) {
  doc.save()
  doc.fillColor('#E2E8F0').opacity(0.55).font(FONT.bold).fontSize(text.length > 6 ? 78 : 120)
  const cx = doc.page.width / 2, cy = doc.page.height / 2
  doc.rotate(-35, { origin: [cx, cy] })
  doc.text(text, cx - 260, cy - 60, { width: 520, align: 'center', lineBreak: false })
  doc.restore()
}

/**
 * @param {object} po  a purchase order (plain object) with supplierSnapshot, buyerSnapshot, lines, totals
 * @returns {Promise<Buffer>}
 */
export async function renderPurchaseOrderPdf(po) {
  const doc = newDocument({ Title: `Purchase Order ${po._id}`, Author: po.buyerSnapshot?.name || 'TextilMarkt', Subject: `Purchase order to ${po.supplierSnapshot?.name || 'supplier'}` })
  const done = toBuffer(doc)
  const W = doc.page.width - M * 2
  const stamp = po.status === 'draft' || po.status === 'sending' ? 'DRAFT' : po.status === 'cancelled' ? 'CANCELLED' : ''
  const buyer = po.buyerSnapshot || {}, supplier = po.supplierSnapshot || {}
  const mark = () => { if (stamp) watermark(doc, stamp) }
  doc.on('pageAdded', () => { mark() })
  mark()

  // ── Header: who is buying, and what this is ──
  doc.font(FONT.bold).fontSize(15).fillColor(COLORS.navy).text(buyer.name || '', M, M, { width: W * 0.56 })
  const leftBottom = (() => {
    doc.font(FONT.regular).fontSize(8.5).fillColor(NOTE_COLOR)
    let y = doc.y + 2
    for (const l of partyLines({ ...buyer, contactName: '' })) { doc.text(l, M, y, { width: W * 0.56 }); y = doc.y + 1 }
    return doc.y
  })()
  doc.font(FONT.bold).fontSize(19).fillColor(COLORS.orange).text('PURCHASE ORDER', M + W * 0.5, M, { width: W * 0.5, align: 'right', lineBreak: false })
  doc.font(FONT.bold).fontSize(10).fillColor(COLORS.text).text(`No. ${po._id}`, M + W * 0.5, M + 27, { width: W * 0.5, align: 'right', lineBreak: false })
  doc.font(FONT.regular).fontSize(9).fillColor(COLORS.muted)
  doc.text(`Date: ${longDate(po.sentAt || po.createdAt) || longDate(new Date())}`, M + W * 0.5, M + 42, { width: W * 0.5, align: 'right', lineBreak: false })
  if (po.expectedDate) doc.text(`Delivery by: ${longDate(po.expectedDate)}`, M + W * 0.5, M + 55, { width: W * 0.5, align: 'right', lineBreak: false })

  let y = Math.max(leftBottom, M + 72) + 8
  doc.moveTo(M, y).lineTo(M + W, y).lineWidth(1.5).strokeColor(COLORS.navy).stroke()
  y += 12

  // ── Parties ──
  const colW = (W - 12) / 2
  const supplierText = [supplier.name, ...partyLines(supplier)]
  const shipText = po.shipTo ? po.shipTo.split('\n').map(s => s.trim()).filter(Boolean) : [buyer.name, ...partyLines({ ...buyer, contactName: '' })].filter(Boolean)
  const measure = (lines, first) => lines.reduce((h, l, i) => {
    doc.font(i === 0 && first ? FONT.bold : FONT.regular).fontSize(i === 0 && first ? 10.5 : 9)
    return h + doc.heightOfString(l, { width: colW - 20 }) + 1.5
  }, 0)
  const boxH = Math.max(measure(supplierText, true), measure(shipText, true)) + 30
  const box = (x, title, lines) => {
    doc.rect(x, y, colW, boxH).fill(COLORS.band)
    doc.font(FONT.bold).fontSize(7.5).fillColor(COLORS.muted).text(title, x + 10, y + 9, { characterSpacing: 0.6, lineBreak: false })
    let yy = y + 22
    lines.forEach((l, i) => {
      doc.font(i === 0 ? FONT.bold : FONT.regular).fontSize(i === 0 ? 10.5 : 9).fillColor(COLORS.text)
      doc.text(l, x + 10, yy, { width: colW - 20 })
      yy = doc.y + 1.5
    })
  }
  box(M, 'SUPPLIER', supplierText)
  box(M + colW + 12, 'DELIVER TO', shipText)
  y += boxH + 10

  // ── Terms strip ──
  const cells = [
    ['Payment terms', po.paymentTerms || supplier.paymentTerms || 'As agreed'],
    ['Place of supply', buyer.stateCode ? `${stateName(buyer.stateCode)} (${buyer.stateCode})` : 'Not stated'],
    ['Tax', TAX_LABEL[po.taxMode] || 'GST'],
  ]
  const cw = W / cells.length
  cells.forEach(([label, value], i) => {
    doc.font(FONT.regular).fontSize(7.5).fillColor(COLORS.muted).text(label.toUpperCase(), M + i * cw, y, { width: cw - 8, characterSpacing: 0.5, lineBreak: false })
    doc.font(FONT.bold).fontSize(9).fillColor(COLORS.text).text(value, M + i * cw, y + 11, { width: cw - 8, lineBreak: false, ellipsis: true })
  })
  y += 34

  // ── Lines ──
  const cols = [
    { key: 'n', label: '#', w: 22, align: 'left' },
    { key: 'desc', label: 'Description', w: 168, align: 'left' },
    { key: 'hsn', label: 'HSN', w: 48, align: 'left' },
    { key: 'qty', label: 'Qty', w: 54, align: 'right' },
    { key: 'unit', label: 'Unit', w: 32, align: 'left' },
    { key: 'rate', label: 'Rate', w: 56, align: 'right' },
    { key: 'disc', label: 'Disc %', w: 36, align: 'right' },
    { key: 'gst', label: 'GST %', w: 34, align: 'right' },
    { key: 'amt', label: `Amount (${RUPEE})`, w: 65, align: 'right' },
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

  ;(po.lines || []).forEach((l, idx) => {
    const desc = l.note ? `${l.description}\n${l.note}` : l.description
    doc.font(FONT.regular).fontSize(9)
    const h = Math.max(doc.heightOfString(desc, { width: cols[1].w - 8 }), 11) + 9
    if (y + h > bottomLimit()) { doc.addPage(); y = M; header() }
    const cells = {
      n: String(idx + 1), hsn: l.hsnCode || '', qty: quantity(l.qty), unit: l.unit || '',
      rate: money(l.rate), disc: l.discountPct ? quantity(l.discountPct) : '', gst: quantity(l.taxPct), amt: money(l.amount),
    }
    doc.fillColor(COLORS.text)
    cols.forEach((c, i) => {
      if (c.key === 'desc') {
        doc.font(FONT.regular).fontSize(9).fillColor(COLORS.text).text(l.description, xOf(i) + 4, y + 5, { width: c.w - 8 })
        if (l.note) doc.font(FONT.regular).fontSize(8).fillColor(NOTE_COLOR).text(l.note, xOf(i) + 4, doc.y, { width: c.w - 8 })
      } else {
        doc.font(FONT.regular).fontSize(9).fillColor(COLORS.text).text(cells[c.key], xOf(i) + 4, y + 5, { width: c.w - 8, align: c.align, lineBreak: false })
      }
    })
    y += h
    doc.moveTo(M, y).lineTo(M + W, y).lineWidth(0.5).strokeColor(COLORS.line).stroke()
  })
  y += 12

  // ── Totals ──
  const t = po.totals || {}
  const rows = []
  rows.push(['Subtotal', t.subtotal])
  if (t.discount) rows.push(['Discount', -t.discount])
  rows.push(['Taxable value', t.taxable])
  if (po.taxMode === 'intra') (t.byRate || []).filter(g => g.rate).forEach(g => { rows.push([`CGST @ ${quantity(g.rate / 2)}%`, g.cgst]); rows.push([`SGST @ ${quantity(g.rate / 2)}%`, g.sgst]) })
  else if (po.taxMode === 'inter') (t.byRate || []).filter(g => g.rate).forEach(g => rows.push([`IGST @ ${quantity(g.rate)}%`, g.igst]))
  else (t.byRate || []).filter(g => g.rate).forEach(g => rows.push([`GST @ ${quantity(g.rate)}%`, g.gst]))
  if (t.roundOff) rows.push(['Round off', t.roundOff])
  const tw = 230, tx = M + W - tw
  const need = rows.length * 15 + 60
  if (y + need > bottomLimit()) { doc.addPage(); y = M }
  rows.forEach(([label, value]) => {
    doc.font(FONT.regular).fontSize(9).fillColor(COLORS.muted).text(label, tx, y, { width: tw - 90, lineBreak: false })
    doc.fillColor(COLORS.text).text(`${value < 0 ? '-' : ''}${money(Math.abs(value))}`, tx + tw - 90, y, { width: 90, align: 'right', lineBreak: false })
    y += 15
  })
  doc.rect(tx, y + 2, tw, 24).fill(COLORS.navy)
  doc.font(FONT.bold).fontSize(10).fillColor(COLORS.white).text('Total', tx + 8, y + 9, { lineBreak: false })
  doc.text(`${RUPEE} ${money(t.grandTotal)}`, tx + tw - 130, y + 9, { width: 122, align: 'right', lineBreak: false })
  y += 36
  doc.font(FONT.regular).fontSize(8.5).fillColor(COLORS.text).text(amountInWords(t.grandTotal || 0), M, y, { width: W - tw - 20 })
  y = Math.max(y, doc.y) + 14

  // ── Terms and signature ──
  if (po.terms) {
    doc.font(FONT.regular).fontSize(8.5)
    const th = doc.heightOfString(po.terms, { width: W }) + 24
    if (y + th + 60 > bottomLimit()) { doc.addPage(); y = M }
    doc.font(FONT.bold).fontSize(8).fillColor(COLORS.muted).text('TERMS AND CONDITIONS', M, y, { characterSpacing: 0.6, lineBreak: false })
    doc.font(FONT.regular).fontSize(8.5).fillColor(COLORS.text).text(po.terms, M, y + 13, { width: W })
    y = doc.y + 14
  }
  if (y + 60 > bottomLimit()) { doc.addPage(); y = M }
  doc.font(FONT.regular).fontSize(8.5).fillColor(COLORS.muted).text(`For ${buyer.name || ''}`, M + W - 190, y, { width: 190, align: 'right', lineBreak: false })
  doc.moveTo(M + W - 190, y + 44).lineTo(M + W, y + 44).lineWidth(0.5).strokeColor(COLORS.line).stroke()
  doc.text('Authorised signatory', M + W - 190, y + 49, { width: 190, align: 'right', lineBreak: false })

  pageFooters(doc, `${po._id}  |  Generated with TextilMarkt`)
  doc.end()
  return done
}
