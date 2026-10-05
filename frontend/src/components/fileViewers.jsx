import { useMemo, useEffect, useState } from 'react'
import { T } from '../constants.js'

// Inline viewers for the document types the portal accepts beyond PDF and
// images. Everything is rendered through React elements (never innerHTML), so
// file contents cannot execute anything.

const decode = bytes => new TextDecoder('utf-8').decode(bytes)

// ── CSV ──────────────────────────────────────────────────────────────────────
function parseCsv(text) {
  const rows = []
  let row = [], cell = '', q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++ }
      else if (c === '"') q = false
      else cell += c
    } else if (c === '"') q = true
    else if (c === ',') { row.push(cell); cell = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(cell); cell = ''
      if (row.some(v => v !== '')) rows.push(row)
      row = []
    } else cell += c
  }
  row.push(cell)
  if (row.some(v => v !== '')) rows.push(row)
  return rows
}

export function CsvTable({ bytes, onReady }) {
  const rows = useMemo(() => parseCsv(decode(bytes)).slice(0, 1000), [bytes])
  useEffect(() => { onReady?.() }, [onReady])
  if (!rows.length) return <Msg>This file is empty.</Msg>
  const [head, ...body] = rows
  return (
    <div style={{ flex: 1, overflow: 'auto', background: '#fff', padding: 16 }}>
      <table style={{ borderCollapse: 'collapse', fontSize: 13, minWidth: '60%' }}>
        <thead>
          <tr>{head.map((h, i) => <th key={i} style={{ position: 'sticky', top: 0, background: '#f1f5f9', border: `1px solid ${T.border}`, padding: '6px 10px', textAlign: 'left', fontWeight: 700 }}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {body.map((r, ri) => <tr key={ri}>{head.map((_, ci) => <td key={ci} style={{ border: `1px solid ${T.border}`, padding: '5px 10px' }}>{r[ci] ?? ''}</td>)}</tr>)}
        </tbody>
      </table>
      {rows.length >= 1000 && <div style={{ fontSize: 11, color: T.textMuted, marginTop: 8 }}>Showing the first 1,000 rows. Download for the full file.</div>}
    </div>
  )
}

// ── XLSX (Excel workbooks) ───────────────────────────────────────────────────
// read-excel-file reads cell values only (no macros or formulas run); each
// sheet is drawn as a plain table through React elements.
export function XlsxTable({ bytes, onReady }) {
  const [sheets, setSheets] = useState(null)
  const [active, setActive] = useState(0)
  const [err, setErr] = useState(false)
  useEffect(() => {
    let live = true
    ;(async () => {
      try {
        const { default: readXlsx, readSheetNames } = await import('read-excel-file/browser')
        const names = await readSheetNames(new Blob([bytes]))
        const out = []
        for (const name of names) out.push({ name, rows: (await readXlsx(new Blob([bytes]), { sheet: name })).slice(0, 1000) })
        if (live) setSheets(out)
      } catch { if (live) setErr(true) }
      onReady?.()
    })()
    return () => { live = false }
  }, [bytes])
  if (err) return <Msg>Could not read this workbook. Use Download to open it in Excel.</Msg>
  if (!sheets) return <Msg>Loading workbook...</Msg>
  const rows = sheets[active]?.rows || []
  const cols = Math.max(0, ...rows.map(r => r.length))
  const fmt = v => (v == null ? '' : v instanceof Date ? v.toLocaleDateString('en-IN') : String(v))
  return (
    <div style={{ flex: 1, overflow: 'auto', background: '#fff', padding: 16 }}>
      {sheets.length > 1 && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
          {sheets.map((sh, i) => <button key={i} onClick={() => setActive(i)} style={{ padding: '4px 12px', borderRadius: 999, border: `1px solid ${T.border}`, background: i === active ? '#0f172a' : '#fff', color: i === active ? '#fff' : T.text, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>{sh.name}</button>)}
        </div>
      )}
      {!rows.length ? <Msg>This sheet is empty.</Msg> : (
        <table style={{ borderCollapse: 'collapse', fontSize: 13, minWidth: '60%' }}>
          <tbody>
            {rows.map((r, ri) => <tr key={ri}>{Array.from({ length: cols }, (_, ci) => ri === 0
              ? <th key={ci} style={{ background: '#f1f5f9', border: `1px solid ${T.border}`, padding: '6px 10px', textAlign: 'left', fontWeight: 700 }}>{fmt(r[ci])}</th>
              : <td key={ci} style={{ border: `1px solid ${T.border}`, padding: '5px 10px' }}>{fmt(r[ci])}</td>)}</tr>)}
          </tbody>
        </table>
      )}
    </div>
  )
}

// ── DXF (2D outlines) ────────────────────────────────────────────────────────
// Reads LINE, CIRCLE, LWPOLYLINE and POLYLINE/VERTEX entities and draws them
// as an SVG so a pattern file can be eyeballed without CAD software.
function parseDxf(text) {
  const t = text.split(/\r?\n/)
  const pairs = []
  for (let i = 0; i + 1 < t.length; i += 2) pairs.push([parseInt(t[i].trim(), 10), t[i + 1].trim()])
  const shapes = []
  let cur = null, inEntities = false
  const flush = () => { if (cur) shapes.push(cur); cur = null }
  for (const [code, val] of pairs) {
    if (code === 2 && val === 'ENTITIES') { inEntities = true; continue }
    if (code === 0 && val === 'ENDSEC') { flush(); inEntities = false; continue }
    if (!inEntities) continue
    if (code === 0) {
      if (val === 'VERTEX' && cur?.type === 'POLYLINE') { cur.pts.push({}); continue }
      if (val === 'SEQEND') { flush(); continue }
      flush()
      if (['LINE', 'CIRCLE', 'LWPOLYLINE', 'POLYLINE'].includes(val)) cur = { type: val, pts: [], layer: '0', closed: false }
      continue
    }
    if (!cur) continue
    const n = parseFloat(val)
    if (code === 8) cur.layer = val
    else if (cur.type === 'LINE') {
      if (!cur.pts[0]) cur.pts[0] = {}
      if (!cur.pts[1]) cur.pts[1] = {}
      if (code === 10) cur.pts[0].x = n; else if (code === 20) cur.pts[0].y = n
      else if (code === 11) cur.pts[1].x = n; else if (code === 21) cur.pts[1].y = n
    } else if (cur.type === 'CIRCLE') {
      if (code === 10) cur.cx = n; else if (code === 20) cur.cy = n; else if (code === 40) cur.r = n
    } else if (cur.type === 'LWPOLYLINE') {
      if (code === 10) cur.pts.push({ x: n }); else if (code === 20 && cur.pts.length) cur.pts[cur.pts.length - 1].y = n
      else if (code === 70) cur.closed = (parseInt(val, 10) & 1) === 1
    } else if (cur.type === 'POLYLINE') {
      const last = cur.pts[cur.pts.length - 1]
      if (last && code === 10) last.x = n; else if (last && code === 20) last.y = n
      else if (!last && code === 70) cur.closed = (parseInt(val, 10) & 1) === 1
    }
  }
  flush()
  return shapes.filter(s => (s.type === 'CIRCLE' ? Number.isFinite(s.cx) && Number.isFinite(s.cy) && Number.isFinite(s.r) : s.pts.length >= 2 && s.pts.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))))
}

const LAYER_COLORS = ['#0f172a', '#b45309', '#1d4ed8', '#15803d', '#b91c1c', '#7e22ce', '#0e7490']

export function DxfPreview({ bytes, onReady }) {
  const shapes = useMemo(() => parseDxf(decode(bytes)), [bytes])
  useEffect(() => { onReady?.() }, [onReady])
  if (!shapes.length) return <Msg>No drawable outlines found in this DXF. Download it to open in CAD software.</Msg>

  const xs = [], ys = []
  for (const s of shapes) {
    if (s.type === 'CIRCLE') { xs.push(s.cx - s.r, s.cx + s.r); ys.push(s.cy - s.r, s.cy + s.r) }
    else s.pts.forEach(p => { xs.push(p.x); ys.push(p.y) })
  }
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys)
  const w = maxX - minX || 1, h = maxY - minY || 1, pad = Math.max(w, h) * 0.04
  const layers = [...new Set(shapes.map(s => s.layer))]
  const color = l => LAYER_COLORS[layers.indexOf(l) % LAYER_COLORS.length]
  const fy = y => maxY - y + minY   // DXF y points up, SVG y points down
  return (
    <div style={{ flex: 1, overflow: 'auto', background: '#fff', padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <svg viewBox={`${minX - pad} ${minY - pad} ${w + pad * 2} ${h + pad * 2}`} style={{ width: '100%', maxHeight: '75vh', background: '#f8fafc', border: `1px solid ${T.border}`, borderRadius: 8 }}>
        {shapes.map((s, i) => s.type === 'CIRCLE'
          ? <circle key={i} cx={s.cx} cy={fy(s.cy)} r={s.r} fill="none" stroke={color(s.layer)} strokeWidth={Math.max(w, h) / 400} />
          : s.closed || s.type === 'LWPOLYLINE' && s.closed
            ? <polygon key={i} points={s.pts.map(p => `${p.x},${fy(p.y)}`).join(' ')} fill="none" stroke={color(s.layer)} strokeWidth={Math.max(w, h) / 400} />
            : <polyline key={i} points={s.pts.map(p => `${p.x},${fy(p.y)}`).join(' ')} fill="none" stroke={color(s.layer)} strokeWidth={Math.max(w, h) / 400} />)}
      </svg>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12, color: T.textMuted }}>
        {layers.map(l => <span key={l} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 10, height: 10, background: color(l), borderRadius: 2 }} />{l}</span>)}
        <span>Drawing extent: {w.toFixed(1)} x {h.toFixed(1)} units</span>
      </div>
    </div>
  )
}

// ── Audio ────────────────────────────────────────────────────────────────────
export function AudioPlayer({ url, onReady }) {
  useEffect(() => { onReady?.() }, [onReady])
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0f172a' }}>
      <audio controls src={url} style={{ width: 'min(520px, 90%)' }} />
    </div>
  )
}

// ── No inline preview ────────────────────────────────────────────────────────
export function Msg({ children }) {
  return <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#fff', padding: 24, textAlign: 'center', fontSize: 14, color: T.textMuted }}>{children}</div>
}
