import { useEffect, useState } from 'react'
import { T } from '../../constants.js'
import { Alert, SectionLabel, LoadingScreen } from '../../components/ui.jsx'
import { inventoryApi } from '../../api.js'
import { fmtQty } from '../../lib/procurement.js'
import { sectionLabel } from '../../lib/bomUi.js'

const tone = pct => (pct === null || pct === undefined ? T.textMuted : pct > 5 ? T.danger : pct < -5 ? T.success : T.text)

/**
 * What an order was planned to use against what the store has issued to it, line by line: the frozen bill of
 * materials beside the net of issues and returns, per colour for cloth, and (once pieces have been cut) what each
 * piece really took beside what the plan allowed. It is how a factory learns what a style truly consumes.
 */
export function OrderUsage({ orderId, refreshKey = 0 }) {
  const [u, setU] = useState(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    let dead = false
    inventoryApi.usage(orderId).then(d => { if (!dead) { setU(d); setErr('') } }).catch(e => { if (!dead) setErr(e?.message || 'Could not work out what the order used') })
    return () => { dead = true }
  }, [orderId, refreshKey])

  if (err) return <Alert type="danger">{err}</Alert>
  if (!u) return <LoadingScreen message="Working out what the order used..." />

  const nothing = u.lines.length === 0 && u.extra.length === 0
  return (
    <div>
      <SectionLabel>Planned and used</SectionLabel>
      <div style={{ fontSize: 12, color: T.textLight, margin: '2px 0 10px' }}>
        {u.hasBom ? `The plan is version ${u.bomVersion} of the bill of materials, wastage included.` : 'Freeze a bill of materials for this order to compare what was issued with what it needs.'}
        {u.produced ? ` ${fmtQty(u.produced.pieces)}${u.produced.of ? ` of ${fmtQty(u.produced.of)}` : ''} pieces are done at ${u.produced.stage}.` : ''}
      </div>
      {nothing && <div style={{ fontSize: 13, color: T.textMuted, padding: '8px 0' }}>Nothing has been issued to this order yet.</div>}
      {u.lines.map(l => (
        <div key={l.lineId} style={{ padding: '10px 0', borderBottom: `1px solid ${T.border}` }}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'baseline' }}>
            <div style={{ flex: '2 1 200px', minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{l.item}{l.spec ? <span style={{ fontWeight: 500, color: T.textMuted }}>, {l.spec}</span> : null}</div>
              <div style={{ fontSize: 11, color: T.textLight }}>{sectionLabel(l.section)}</div>
            </div>
            <div style={{ fontSize: 12, color: T.textMuted, fontVariantNumeric: 'tabular-nums' }}>planned <strong style={{ color: T.text }}>{fmtQty(l.planned)} {l.unit}</strong></div>
            <div style={{ fontSize: 12, color: T.textMuted, fontVariantNumeric: 'tabular-nums' }}>issued <strong style={{ color: T.text }}>{fmtQty(l.issued)} {l.unit}</strong></div>
            <div style={{ fontSize: 13, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: l.difference > 0 ? T.danger : T.textMuted, minWidth: 110, textAlign: 'right' }}>
              {l.difference > 0 ? `${fmtQty(l.difference)} ${l.unit} over the plan` : l.difference < 0 ? `${fmtQty(-l.difference)} ${l.unit} still to issue` : 'exactly the plan'}
            </div>
          </div>
          {l.colours.length > 0 && (
            <div style={{ fontSize: 11, color: T.textLight, marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>
              {[...l.colours.map(c => `${c.colour || 'All'}: ${fmtQty(c.issued)} of ${fmtQty(c.planned)}`), l.anyColour > 0 ? `Not tied to a colour: ${fmtQty(l.anyColour)}` : null].filter(Boolean).join(' · ')}
            </div>
          )}
          {l.actualPerPiece !== null && (
            <div style={{ fontSize: 12, color: T.textMuted, marginTop: 4 }}>
              Per piece so far: <strong style={{ color: T.text }}>{l.actualPerPiece} {l.unit}</strong> against {Math.round(l.bomPerPiece * (1 + l.wastagePct / 100) * 10000) / 10000} {l.unit} planned
              {l.perPieceVariancePct !== null && <strong style={{ color: tone(l.perPieceVariancePct), marginLeft: 6 }}>{l.perPieceVariancePct > 0 ? '+' : ''}{l.perPieceVariancePct}%</strong>}
            </div>
          )}
        </div>
      ))}
      {u.extra.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Issued, but not on the bill of materials</div>
          {u.extra.map(e => <div key={e.itemId} style={{ fontSize: 13, color: T.text, padding: '3px 0' }}><strong style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtQty(e.issued)} {e.unit}</strong> <span style={{ color: T.textMuted }}>{e.name}</span></div>)}
        </div>
      )}
    </div>
  )
}
