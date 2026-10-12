import { useState } from 'react'
import { ChevronDown, ChevronUp } from '../../icons.jsx'
import { T } from '../../constants.js'
import { Card, SectionLabel } from '../../components/ui.jsx'
import { fmtQty } from '../../lib/procurement.js'

/**
 * The measurement spec read from the tech pack: each point to measure, its tolerance and the target for every
 * size. Read-only here; QC measures against it, and the factory can correct it through the API if the reading
 * was off.
 */
export function SpecSheetPanel({ spec }) {
  const [open, setOpen] = useState(false)
  if (!spec?.points?.length) return null
  const tol = p => (p.tolPlus == null && p.tolMinus == null ? '' : p.tolMinus != null ? `+${fmtQty(p.tolPlus ?? 0)} / -${fmtQty(p.tolMinus)}` : `±${fmtQty(p.tolPlus)}`)
  const th = { padding: '7px 10px', fontSize: 10, fontWeight: 800, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', textAlign: 'right', whiteSpace: 'nowrap' }
  const td = { padding: '8px 10px', fontSize: 13, textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }
  return (
    <Card>
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open} style={{ display: 'flex', width: '100%', justifyContent: 'space-between', alignItems: 'center', background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', minHeight: 36 }}>
        <span>
          <SectionLabel>Measurements from the tech pack</SectionLabel>
          <span style={{ fontSize: 12, color: T.textMuted }}>{spec.points.length} points to measure, in cm{spec.header?.styleNo ? ` · ${spec.header.styleNo}` : ''}. Kept for quality checks.</span>
        </span>
        {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>
      {open && (
        <div style={{ overflowX: 'auto', marginTop: 12 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 420 }}>
            <thead>
              <tr style={{ background: T.bg }}>
                <th style={{ ...th, textAlign: 'left', width: 34 }}>#</th>
                <th style={{ ...th, textAlign: 'left' }}>Point</th>
                <th style={th}>Tolerance</th>
                {spec.sizes.map(s => <th key={s} style={th}>{s}</th>)}
              </tr>
            </thead>
            <tbody>
              {spec.points.map((p, i) => (
                <tr key={i} style={{ borderTop: `1px solid ${T.border}` }}>
                  <td style={{ ...td, textAlign: 'left', color: T.textLight, fontWeight: 700 }}>{p.code}</td>
                  <td style={{ ...td, textAlign: 'left', whiteSpace: 'normal', minWidth: 160 }}>{p.name}</td>
                  <td style={{ ...td, color: T.textMuted }}>{tol(p)}</td>
                  {spec.sizes.map((_, j) => <td key={j} style={td}>{p.values[j] == null ? '' : fmtQty(p.values[j])}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
