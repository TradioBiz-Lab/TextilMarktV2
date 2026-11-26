import { useState } from 'react'
import { ChevronDown, History as HistoryIcon } from '../icons.jsx'
import { T, fmtDate, STAGE_STATUS_LABELS } from '../constants.js'
import { DocCard } from './ui.jsx'

// The plan a split had before the style moved to production, as it stood: read only. Move to production replaces the
// plan with the customer's standard one and keeps the earlier steps here, with what was written and filed on them.
// Sent to Tradio's admins only, so the list is simply absent for everyone else. Folded shut until asked for.
export function PriorPlan({ asgn, docs = [], users, onGetData }) {
  const [open, setOpen] = useState(false)
  const steps = asgn?.priorStages || []
  if (!steps.length) return null
  const done = steps.filter(s => s.status === 'done').length
  const filed = i => docs.filter(d => d.priorStageIndex === i && String(d.mfrId) === String(asgn.mid) && d.isActive !== false)
  return (
    <div style={{ marginTop: 16, border: `1px solid ${T.border}`, borderRadius: 10, background: '#f8fafc', overflow: 'hidden' }}>
      <button type="button" onClick={() => setOpen(v => !v)} aria-expanded={open}
        style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '10px 14px', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}>
        <HistoryIcon size={14} color={T.textMuted} />
        <span style={{ fontSize: 13, fontWeight: 600, color: T.text }}>Before production</span>
        <span style={{ fontSize: 12, color: T.textMuted, flex: 1 }}>
          {steps.length} steps, {done} done{asgn.priorStagesAt ? ` · replaced by the standard plan on ${fmtDate(asgn.priorStagesAt)}${asgn.priorStagesByName ? ` by ${asgn.priorStagesByName}` : ''}` : ''}
        </span>
        <ChevronDown size={14} color={T.textMuted} style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} />
      </button>
      {open && steps.map((s, i) => {
        const last = (s.updates || []).slice(-1)[0]
        const said = s.note || last?.text || ''
        return (
          <div key={i} style={{ padding: '9px 14px', borderTop: `1px solid ${T.border}`, background: '#fff' }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: T.text, flex: '1 1 200px', minWidth: 0 }}>{i + 1}. {s.name}</span>
              <span style={{ fontSize: 11.5, color: T.textMuted }}>
                {s.status === 'done' && s.actualEnd ? `finished ${fmtDate(s.actualEnd)}` : s.eta && s.eta !== 'NA' ? `planned ${fmtDate(s.eta)}` : 'no date'}
              </span>
              <span style={{ fontSize: 11, fontWeight: 600, padding: '1px 8px', borderRadius: 8, border: `1px solid ${T.border}`, background: s.status === 'done' ? T.successBg : '#f1f5f9', color: s.status === 'done' ? T.successDeep : T.textMuted }}>
                {STAGE_STATUS_LABELS[s.status] || s.status}
              </span>
            </div>
            {said && <div style={{ fontSize: 12, color: T.textMuted, marginTop: 3 }}>{said}</div>}
            {filed(i).map(d => <div key={d.id} style={{ marginTop: 6 }}><DocCard doc={d} users={users} onGetData={onGetData} stageName={s.name} compact /></div>)}
          </div>
        )
      })}
    </div>
  )
}
