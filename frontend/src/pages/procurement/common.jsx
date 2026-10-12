import { T } from '../../constants.js'
import { PO_STATUS, poStatusLabel } from '../../lib/procurement.js'

const TONES = {
  neutral: { bg: '#f1f5f9', c: '#475569' },
  good: { bg: T.successBg, c: T.successDeep || T.success },
  warn: { bg: T.warningBg, c: T.warning },
  bad: { bg: T.dangerBg, c: T.dangerDeep || T.danger },
  info: { bg: T.infoBg, c: T.info },
}

/** A small rounded label. */
export function Pill({ tone = 'neutral', children, title }) {
  const t = TONES[tone] || TONES.neutral
  return <span title={title} style={{ display: 'inline-block', padding: '2px 9px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: t.bg, color: t.c, whiteSpace: 'nowrap' }}>{children}</span>
}

export const StatusPill = ({ status }) => <Pill tone={PO_STATUS[status]?.tone}>{poStatusLabel(status)}</Pill>

/** A thin progress bar: how much of a PO has arrived. */
export function Progress({ pct, tone = 'good' }) {
  const v = Math.max(0, Math.min(100, Number(pct) || 0))
  const color = tone === 'good' ? T.success : tone === 'warn' ? T.warning : T.primary
  return (
    <div role="progressbar" aria-valuenow={v} aria-valuemin={0} aria-valuemax={100} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1, height: 6, borderRadius: 3, background: '#e2e8f0', overflow: 'hidden', minWidth: 48 }}>
        <div style={{ width: `${v}%`, height: '100%', background: color }} />
      </div>
      <span style={{ fontSize: 11, color: T.textMuted, fontVariantNumeric: 'tabular-nums', minWidth: 28, textAlign: 'right' }}>{v}%</span>
    </div>
  )
}

/** A label above a value, for the small fact grids on detail screens. */
export function Fact({ label, children }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 10, fontWeight: 800, color: T.textLight, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 13, color: T.text, fontWeight: 600, overflowWrap: 'anywhere' }}>{children || <span style={{ color: T.textLight, fontWeight: 400 }}>-</span>}</div>
    </div>
  )
}

/** A hairline-separated row list, the way the Company page lists people. */
export function Line({ children }) {
  return <div style={{ padding: '10px 0', borderBottom: `1px solid ${T.border}` }}>{children}</div>
}
