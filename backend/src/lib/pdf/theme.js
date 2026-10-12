// What every generated document shares: the page, the fonts and the numbers.
//
// PDFs are drawn with pdfkit (pure JavaScript, no headless browser), so a document costs milliseconds
// and nothing extra to deploy. The standard PDF fonts have no rupee sign, so the documents use Noto
// Sans (SIL Open Font License, in assets/fonts); if the files are ever missing the document falls back
// to Helvetica and writes "Rs" instead of the rupee sign rather than failing.
import PDFDocument from 'pdfkit'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const FONT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../assets/fonts')
const REGULAR = path.join(FONT_DIR, 'NotoSans-Regular.ttf')
const BOLD = path.join(FONT_DIR, 'NotoSans-Bold.ttf')
const hasFonts = fs.existsSync(REGULAR) && fs.existsSync(BOLD)

export const COLORS = {
  navy: '#1D2D50', orange: '#C4622D', text: '#0F172A', muted: '#64748B', line: '#CBD5E1',
  band: '#F1F5F9', white: '#FFFFFF', danger: '#B91C1C',
}

/** The font names to pass to doc.font(). */
export const FONT = hasFonts ? { regular: 'Body', bold: 'Body-Bold' } : { regular: 'Helvetica', bold: 'Helvetica-Bold' }
export const RUPEE = hasFonts ? '₹' : 'Rs'

const inr = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const plain = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 3 })

/** 1,23,456.50 */
export const money = n => inr.format(Number(n) || 0)
/** 1,500 or 12.5: a quantity, no forced decimals */
export const quantity = n => plain.format(Number(n) || 0)
/** 12 Oct 2026, from a date or an ISO date string; blank when there is none. */
export function longDate(value) {
  if (!value) return ''
  const d = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00+05:30`) : new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })
}

/** A new A4 document with the fonts registered. Collect the result with toBuffer(). */
export function newDocument(info = {}) {
  const doc = new PDFDocument({
    size: 'A4', margins: { top: 40, bottom: 56, left: 40, right: 40 }, bufferPages: true,
    info: { Producer: 'TextilMarkt', Creator: 'TextilMarkt', ...info },
  })
  if (hasFonts) { doc.registerFont(FONT.regular, REGULAR); doc.registerFont(FONT.bold, BOLD) }
  doc.font(FONT.regular)
  return doc
}

/** Everything pdfkit writes, as one Buffer, once doc.end() has been called. */
export function toBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = []
    doc.on('data', c => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
  })
}

/** Write "Page n of N" and a short line on every page. Call once, after all the content. */
export function pageFooters(doc, left) {
  const range = doc.bufferedPageRange()
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i)
    const bottom = doc.page.margins.bottom
    doc.page.margins.bottom = 0                       // otherwise writing down here would start a new page
    const y = doc.page.height - 36
    doc.fontSize(7.5).font(FONT.regular).fillColor(COLORS.muted)
    doc.text(left, 40, y, { width: 360, lineBreak: false })
    doc.text(`Page ${i - range.start + 1} of ${range.count}`, doc.page.width - 40 - 120, y, { width: 120, align: 'right', lineBreak: false })
    doc.page.margins.bottom = bottom
  }
}
