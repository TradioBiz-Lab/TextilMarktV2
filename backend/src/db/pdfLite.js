// Minimal text-only PDF writer for generated demo documents (no dependencies).
// Lines starting with "# " render as bold headings; everything else is
// monospaced so simple tables line up. Latin-1 text only.
const esc = s => String(s).replace(/[\\()]/g, m => '\\' + m).replace(/[^\x20-\x7e]/g, '?')

function wrap(line, width) {
  if (line.length <= width) return [line]
  const out = []
  let cur = ''
  for (const w of line.split(' ')) {
    if ((cur + ' ' + w).trim().length > width) { out.push(cur); cur = w } else cur = (cur + ' ' + w).trim()
  }
  if (cur) out.push(cur)
  return out
}

export function makePdf({ title, subtitle = '', lines = [] }) {
  const rows = []
  for (const l of lines) {
    if (l.startsWith('# ')) rows.push({ h: true, t: l.slice(2) })
    else for (const w of wrap(l, 92)) rows.push({ h: false, t: w })
  }
  const perPage = 52
  const pages = []
  for (let i = 0; i < Math.max(rows.length, 1); i += perPage) pages.push(rows.slice(i, i + perPage))

  const objs = []                       // index = object number - 1
  const add = body => { objs.push(body); return objs.length }
  const catalog = add('')               // 1, filled later
  const pagesObj = add('')              // 2
  const fHelv = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  const fBold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>')
  const fMono = add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>')
  const kids = []
  pages.forEach((rs, pi) => {
    let y = 800
    let c = ''
    if (pi === 0) {
      c += `BT /F2 18 Tf 50 ${y} Td (${esc(title)}) Tj ET\n`; y -= 20
      if (subtitle) { c += `BT /F1 10 Tf 50 ${y} Td (${esc(subtitle)}) Tj ET\n`; y -= 14 }
      c += `0.6 w 50 ${y} m 545 ${y} l S\n`; y -= 18
    }
    for (const r of rs) {
      c += r.h ? `BT /F2 11 Tf 50 ${y} Td (${esc(r.t)}) Tj ET\n` : `BT /F3 9 Tf 50 ${y} Td (${esc(r.t)}) Tj ET\n`
      y -= r.h ? 17 : 12.5
    }
    c += `BT /F1 8 Tf 50 30 Td (Sample document generated for demonstration. Page ${pi + 1} of ${pages.length}) Tj ET\n`
    const content = add(`<< /Length ${Buffer.byteLength(c, 'latin1')} >>\nstream\n${c}endstream`)
    const page = add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fHelv} 0 R /F2 ${fBold} 0 R /F3 ${fMono} 0 R >> >> /Contents ${content} 0 R >>`)
    kids.push(page)
  })
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`

  let out = '%PDF-1.4\n'
  const offsets = []
  objs.forEach((b, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${b}\nendobj\n` })
  const xref = Buffer.byteLength(out, 'latin1')
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}
