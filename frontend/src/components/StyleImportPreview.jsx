import { Check } from '../icons.jsx'
import { T } from '../constants.js'
import { FlexRow } from './ui.jsx'
import { STAGE_LABELS } from '../styleImport.js'

const TH = { textAlign: 'left', fontSize: 10.5, fontWeight: 800, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', padding: '6px 8px', borderBottom: `1px solid ${T.border}`, whiteSpace: 'nowrap' }
const TD = { fontSize: 12.5, color: T.text, padding: '7px 8px', borderBottom: `1px solid ${T.border}`, verticalAlign: 'top' }
const STAGE_STYLE = {
  replen: { background: '#ccfbf1', color: '#0f766e', border: '1px solid #5eead4' },
  development: { background: T.infoBg, color: T.info, border: `1px solid ${T.infoBorder}` },
}

function Pill({ tone, children }) {
  const t = tone === 'ok' ? { background: T.successBg, color: '#047857', border: `1px solid ${T.successBorder}` }
    : tone === 'bad' ? { background: T.dangerBg, color: T.danger, border: `1px solid ${T.dangerBorder}` }
    : { background: T.bg, color: T.textMuted, border: `1px solid ${T.border}` }
  return <span style={{ ...t, fontSize: 12, fontWeight: 800, padding: '3px 10px', borderRadius: 999 }}>{children}</span>
}

// The checked rows of a style sheet: totals, the file's own notes, and one line per row with its picture and verdict. Used
// by the Import styles window and by the master admin's review of a customer's sheet.
export function StyleImportPreview({ preview }) {
  const s = preview.summary
  return (
    <>
      <FlexRow gap={8} style={{ flexWrap: 'wrap' }}>
        <Pill tone="ok">{s.ok} ready</Pill>
        {s.exists > 0 && <Pill>{s.exists} already in this master order, skipped</Pill>}
        {s.errors > 0 && <Pill tone="bad">{s.errors} need fixing</Pill>}
      </FlexRow>
      {preview.warnings?.length > 0 && (
        <div style={{ fontSize: 12, color: T.textMuted, lineHeight: 1.6 }}>
          {preview.warnings.map((w, i) => <div key={i}>{w}</div>)}
        </div>
      )}
      <div style={{ overflowX: 'auto', border: `1px solid ${T.border}`, borderRadius: 8 }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 860 }}>
          <thead><tr>{['Row', 'Photo', 'Brand', 'Style No', 'Description', 'Stage', 'Category', 'Fabric', 'Result'].map(h => <th key={h} style={TH}>{h}</th>)}</tr></thead>
          <tbody>
            {preview.rows.map(r => (
              <tr key={r.row} style={{ background: r.status === 'error' ? T.dangerBg : r.status === 'exists' ? T.bg : 'transparent' }}>
                <td style={TD}>{r.row}</td>
                <td style={TD}>{r.imagePreview
                  ? <img src={r.imagePreview} alt="" style={{ width: 34, height: 44, objectFit: 'cover', borderRadius: 4, border: `1px solid ${T.border}`, display: 'block' }} />
                  : <span style={{ fontSize: 11, color: r.hasImage ? T.textMuted : T.danger }}>{r.hasImage ? 'Yes' : 'None'}</span>}</td>
                <td style={TD}>{r.brand || '-'}</td>
                <td style={{ ...TD, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{r.styleNumber || '-'}</td>
                <td style={{ ...TD, maxWidth: 260 }}>{r.product || '-'}</td>
                <td style={TD}>{r.stage ? <span style={{ ...STAGE_STYLE[r.stage], fontSize: 11, fontWeight: 800, padding: '2px 8px', borderRadius: 10 }}>{STAGE_LABELS[r.stage]}</span> : '-'}</td>
                <td style={TD}>{r.category || '-'}{r.categoryGuessed && <span style={{ fontSize: 10.5, color: T.textLight, marginLeft: 4 }}>(guessed)</span>}</td>
                <td style={TD}>{r.fabric || '-'}</td>
                <td style={{ ...TD, minWidth: 190 }}>
                  {r.status === 'ok' && <span style={{ color: '#047857', fontWeight: 700 }}><Check size={12} style={{ verticalAlign: -2, marginRight: 4 }} />Ready</span>}
                  {r.status === 'exists' && <span style={{ color: T.textMuted }}>Already exists as {r.existingId}</span>}
                  {r.status === 'error' && r.problems.map((p, i) => <div key={i} style={{ color: T.danger, fontWeight: 600 }}>{p}</div>)}
                  {r.status === 'ok' && r.warnings.map((w, i) => <div key={i} style={{ color: T.textLight, fontSize: 11.5 }}>{w}</div>)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
