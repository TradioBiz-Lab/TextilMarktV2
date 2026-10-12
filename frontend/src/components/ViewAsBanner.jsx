import { useState } from 'react'
import { Eye, AlertTriangle, ArrowLeft } from '../icons.jsx'
import { T } from '../constants.js'
import { Btn } from './ui.jsx'
import { useApp } from '../context.jsx'
import { viewAsApi } from '../api.js'
import { switchTo } from '../viewAsSwitch.js'

/**
 * Always visible while a master admin is looking at a company, so nobody forgets whose account they
 * are in or whether changes are real.
 *
 *   purple  read-only: the standalone product's default. Nothing can be changed.
 *   amber   acting for a Tradio-enabled manufacturer: every change is real and recorded under the
 *           master admin's name.
 *   purple  the Tradio portal's sandbox view-as (full powers as that user, as it has always been).
 */
export function ViewAsBanner() {
  const { currentUser: u } = useApp()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  if (!u?.viewAsBy) return null

  const standalone = u.platformMode === 'standalone'
  const acting = standalone && !!u.actingFor
  const canAct = standalone && !u.actingFor && u.role === 'manufacturer' && !!u.tradioEnabled
  const tone = acting
    ? { bg: T.warningBg, border: T.warningBorder, text: '#7C2D12', Icon: AlertTriangle }
    : { bg: T.masterBg, border: '#c4b5fd', text: '#4C1D95', Icon: Eye }

  const run = async call => {
    setBusy(true); setErr('')
    try { await switchTo(call) } catch (e) { setErr(e?.message || 'Could not switch'); setBusy(false) }
  }

  return (
    <div role="status" className="view-as-banner" style={{ background: tone.bg, borderBottom: `1px solid ${tone.border}`, color: tone.text }}>
      <tone.Icon size={16} style={{ flexShrink: 0 }} />
      <div className="view-as-banner-text">
        {acting
          ? <><strong>Acting for {u.company}.</strong> Every change you make is real and is recorded under your name.</>
          : standalone
            ? <><strong>Viewing {u.company}</strong> as {u.viewAsByName || 'Tradio'}. This is read-only: nothing you do here changes their data.</>
            : <><strong>Viewing as {u.name}</strong> ({u.company}).</>}
        {err && <span style={{ color: T.danger, marginLeft: 8 }}>{err}</span>}
      </div>
      <div className="view-as-banner-actions">
        {canAct && <Btn size="sm" variant="warning" disabled={busy} onClick={() => run(() => viewAsApi.start(u.id, { act: true }))}>Act for this manufacturer</Btn>}
        {acting && <Btn size="sm" variant="secondary" disabled={busy} onClick={() => run(() => viewAsApi.start(u.id))}>Stop acting</Btn>}
        <Btn size="sm" variant="secondary" disabled={busy} icon={<ArrowLeft size={12} />} onClick={() => run(viewAsApi.exit)}>
          {standalone ? 'Back to companies' : 'Back to my admin view'}
        </Btn>
      </div>
    </div>
  )
}
