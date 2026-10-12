// The delivery challan for goods a factory sends to a job worker: what went, to whom, what it is worth, what is to be
// done to it and when it is due back. Drawn from the job work record, so it can never disagree with the stock ledger.
import { COLORS, FONT, RUPEE, money, quantity, longDate, newDocument, toBuffer, pageFooters } from './theme.js'
import { stateName } from '../gst.js'
import { amountInWords } from '../words.js'

const M = 40

const lineOf = (...parts) => parts.filter(Boolean).join(', ')
const partyLines = (p = {}) => [
  p.address, lineOf(p.city, p.pincode), p.stateCode ? `${stateName(p.stateCode)} (${p.stateCode})` : '', p.gstin ? `GSTIN: ${p.gstin}` : '',
  p.contactName ? `Attn: ${p.contactName}` : '', p.phone,
].filter(Boolean)

function watermark(doc, text) {
  doc.save()
  doc.fillColor('#E2E8F0').opacity(0.55).font(FONT.bold).fontSize(86)
  const cx = doc.page.width / 2, cy = doc.page.height / 2
  doc.rotate(-35, { origin: [cx, cy] })
  doc.text(text, cx - 260, cy - 50, { width: 520, align: 'center', lineBreak: false })
  doc.restore()
}

/**
 * @param {object} job  a job work record (plain object): supplierSnapshot, consignorSnapshot, lines, ...
 * @returns {Promise<Buffer>}
 */
export async function renderJobworkChallanPdf(job) {
  const consignor = job.consignorSnapshot || {}, consignee = job.supplierSnapshot || {}
  const doc = newDocument({ Title: `Delivery challan ${job.number}`, Author: consignor.name || 'TextilMarkt', Subject: `Goods sent to ${consignee.name || 'a job worker'} for ${job.process || 'job work'}` })
  const done = toBuffer(doc)
  const W = doc.page.width - M * 2
  const stamp = job.status === 'cancelled' ? 'CANCELLED' : ''
  const mark = () => { if (stamp) watermark(doc, stamp) }
  doc.on('pageAdded', () => { mark() })
  mark()

  doc.font(FONT.bold).fontSize(15).fillColor(COLORS.navy).text(consignor.name || '', M, M, { width: W * 0.54 })
  doc.font(FONT.regular).fontSize(8.5).fillColor(COLORS.muted)
  let y = doc.y + 2
  for (const l of partyLines({ ...consignor, contactName: '', phone: '' })) { doc.text(l, M, y, { width: W * 0.54 }); y = doc.y + 1 }
  const leftBottom = doc.y
  doc.font(FONT.bold).fontSize(17).fillColor(COLORS.orange).text('DELIVERY CHALLAN', M + W * 0.4, M, { width: W * 0.6, align: 'right', lineBreak: false })
  doc.font(FONT.regular).fontSize(9).fillColor(COLORS.muted).text('Goods sent for job work', M + W * 0.4, M + 22, { width: W * 0.6, align: 'right', lineBreak: false })
  doc.font(FONT.bold).fontSize(10).fillColor(COLORS.text).text(`No. ${job.number}`, M + W * 0.5, M + 36, { width: W * 0.5, align: 'right', lineBreak: false })
  doc.font(FONT.regular).fontSize(9).fillColor(COLORS.muted).text(`Date: ${longDate(job.sentOn)}`, M + W * 0.5, M + 50, { width: W * 0.5, align: 'right', lineBreak: false })
  if (job.expectedBack) doc.text(`Due back by: ${longDate(job.expectedBack)}`, M + W * 0.5, M + 63, { width: W * 0.5, align: 'right', lineBreak: false })

  y = Math.max(leftBottom, M + 80) + 8
  doc.moveTo(M, y).lineTo(M + W, y).lineWidth(1.5).strokeColor(COLORS.navy).stroke()
  y += 12

  const colW = (W - 12) / 2
  const consigneeText = [consignee.name, ...partyLines(consignee)]
  const consignorText = [consignor.name, ...partyLines({ ...consignor, contactName: '', phone: '' })]
  const measure = lines => lines.reduce((h, l, i) => {
    doc.font(i === 0 ? FONT.bold : FONT.regular).fontSize(i === 0 ? 10.5 : 9)
    return h + doc.heightOfString(l, { width: colW - 20 }) + 1.5
  }, 0)
  const boxH = Math.max(measure(consigneeText), measure(consignorText)) + 30
  const box = (x, label, lines) => {
    doc.rect(x, y, colW, boxH).fill(COLORS.band)
    doc.font(FONT.bold).fontSize(7.5).fillColor(COLORS.muted).text(label, x + 10, y + 9, { characterSpacing: 0.6, lineBreak: false })
    let yy = y + 22
    lines.forEach((l, i) => {
      doc.font(i === 0 ? FONT.bold : FONT.regular).fontSize(i === 0 ? 10.5 : 9).fillColor(COLORS.text)
      doc.text(l, x + 10, yy, { width: colW - 20 })
      yy = doc.y + 1.5
    })
  }
  box(M, 'SENT BY (CONSIGNOR)', consignorText)
  box(M + colW + 12, 'SENT TO (JOB WORKER)', consigneeText)
  y += boxH + 10

  const cells = [['Work to be done', job.process || 'As agreed'], ['Vehicle', job.vehicleNo || 'Not stated'], ['Place of supply', consignee.stateCode ? `${stateName(consignee.stateCode)} (${consignee.stateCode})` : 'Not stated']]
  const cw = W / cells.length
  cells.forEach(([label, value], i) => {
    doc.font(FONT.regular).fontSize(7.5).fillColor(COLORS.muted).text(label.toUpperCase(), M + i * cw, y, { width: cw - 8, characterSpacing: 0.5, lineBreak: false })
    doc.font(FONT.bold).fontSize(9).fillColor(COLORS.text).text(value, M + i * cw, y + 11, { width: cw - 8, lineBreak: false, ellipsis: true })
  })
  y += 34

  const cols = [
    { key: 'n', label: '#', w: 22, align: 'left' }, { key: 'desc', label: 'Description of goods', w: 190, align: 'left' },
    { key: 'hsn', label: 'HSN', w: 48, align: 'left' }, { key: 'qty', label: 'Qty', w: 58, align: 'right' }, { key: 'unit', label: 'Unit', w: 34, align: 'left' },
    { key: 'rate', label: 'Rate', w: 56, align: 'right' }, { key: 'val', label: `Value (${RUPEE})`, w: 70, align: 'right' },
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
  let total = 0
  ;(job.lines || []).forEach((l, idx) => {
    const value = Math.round((l.qty || 0) * (l.rate || 0) * 100) / 100
    total += value
    doc.font(FONT.regular).fontSize(9)
    const h = Math.max(doc.heightOfString(l.name, { width: cols[1].w - 8 }), 11) + 9
    if (y + h > bottomLimit()) { doc.addPage(); y = M; header() }
    const cellsOf = { n: String(idx + 1), hsn: l.hsnCode || '', qty: quantity(l.qty), unit: l.unit || '', rate: l.rate ? money(l.rate) : '', val: l.rate ? money(value) : '' }
    cols.forEach((c, i) => {
      if (c.key === 'desc') doc.font(FONT.regular).fontSize(9).fillColor(COLORS.text).text(l.name, xOf(i) + 4, y + 5, { width: c.w - 8 })
      else doc.font(FONT.regular).fontSize(9).fillColor(COLORS.text).text(cellsOf[c.key], xOf(i) + 4, y + 5, { width: c.w - 8, align: c.align, lineBreak: false })
    })
    y += h
    doc.moveTo(M, y).lineTo(M + W, y).lineWidth(0.5).strokeColor(COLORS.line).stroke()
  })
  y += 10
  if (total > 0) {
    const tw = 230, tx = M + W - tw
    if (y + 60 > bottomLimit()) { doc.addPage(); y = M }
    doc.rect(tx, y, tw, 24).fill(COLORS.navy)
    doc.font(FONT.bold).fontSize(10).fillColor(COLORS.white).text('Total value of goods', tx + 8, y + 7, { lineBreak: false })
    doc.text(`${RUPEE} ${money(total)}`, tx + tw - 130, y + 7, { width: 122, align: 'right', lineBreak: false })
    doc.font(FONT.regular).fontSize(8.5).fillColor(COLORS.text).text(amountInWords(Math.round(total)), M, y + 4, { width: W - tw - 20 })
    y += 38
  }

  if (y + 130 > bottomLimit()) { doc.addPage(); y = M }
  doc.font(FONT.regular).fontSize(8.5).fillColor(COLORS.text)
  doc.text(`These goods are sent for ${job.process ? job.process.toLowerCase() : 'job work'} and are not sold. They remain the property of ${consignor.name || 'the sender'} and are to be returned after processing${job.expectedBack ? ` by ${longDate(job.expectedBack)}` : ''}.`, M, y, { width: W })
  y = doc.y + 6
  if (job.note) { doc.fillColor(COLORS.muted).text(`Note: ${job.note}`, M, y, { width: W }); y = doc.y + 6 }
  y += 28
  const sig = (x, label) => {
    doc.moveTo(x, y + 20).lineTo(x + 170, y + 20).lineWidth(0.5).strokeColor(COLORS.line).stroke()
    doc.font(FONT.regular).fontSize(8.5).fillColor(COLORS.muted).text(label, x, y + 25, { width: 170, lineBreak: false })
  }
  sig(M, `For ${consignor.name || 'the sender'}`)
  sig(M + W - 170, 'Received by the job worker')

  pageFooters(doc, `${job.number}  |  Generated with TextilMarkt`)
  doc.end()
  return done
}
