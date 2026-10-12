import { useEffect, useMemo, useState } from 'react'
import { Search, Eye, Factory, Building2, LockKey, ShieldCheck } from '../../icons.jsx'
import { T } from '../../constants.js'
import { Btn, PageHeader, EmptyState, Alert, LoadingScreen } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'
import { viewAsApi } from '../../api.js'
import { switchTo } from '../../viewAsSwitch.js'

// The master admin's home in the standalone product: every company on the platform, and a way into
// each. Opening one shows its account exactly as it sees it, read-only. For a manufacturer Tradio
// manages (tradioEnabled) there is also "Act for", which lets Tradio make changes on its behalf. A
// company that switched Tradio's view access off is listed, but cannot be opened.

const FILTERS = [['all', 'All'], ['buyer', 'Brands'], ['manufacturer', 'Manufacturers'], ['managed', 'Tradio managed']]

function Pill({ children, tone = 'neutral', icon }) {
  const t = {
    neutral: { bg: '#f1f5f9', c: '#475569' },
    good: { bg: T.successBg, c: T.successDeep },
    private: { bg: '#f1f5f9', c: '#334155' },
    master: { bg: T.masterBg, c: T.master },
  }[tone]
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 9px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: t.bg, color: t.c, whiteSpace: 'nowrap' }}>{icon}{children}</span>
}

function CompanyCard({ c, orderCount, busy, onOpen }) {
  const isMfr = c.role === 'manufacturer'
  const blocked = c.tradioCanView === false
  const Icon = isMfr ? Factory : Building2
  return (
    <div className="company-card" style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 14, padding: 16, display: 'flex', flexDirection: 'column', gap: 12, opacity: blocked ? 0.78 : 1, boxShadow: T.shadow?.sm }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <div aria-hidden="true" style={{ width: 40, height: 40, borderRadius: 11, background: isMfr ? T.warningBg : T.infoBg, color: isMfr ? T.warning : T.info, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <Icon size={20} />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.company}</div>
          <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>{isMfr ? 'Manufacturer' : 'Brand'} ·<span className="num">{c.code}</span>{c.name ? ` · ${c.name}` : ''}</div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {c.tradioEnabled && <Pill tone="good" icon={<ShieldCheck size={11} />}>Tradio managed</Pill>}
        {blocked && <Pill tone="private" icon={<LockKey size={11} />}>Private</Pill>}
        <span style={{ fontSize: 12, color: T.textLight }} className="num">{blocked ? 'Hidden from Tradio' : `${orderCount} order${orderCount === 1 ? '' : 's'}`}</span>
      </div>
      {blocked ? (
        <div style={{ fontSize: 12, color: T.textMuted, lineHeight: 1.5 }}>This company has turned off Tradio access. Only its own team can see its account.</div>
      ) : (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Btn size="sm" disabled={busy} icon={<Eye size={13} />} onClick={() => onOpen(c, false)}>View</Btn>
          {c.tradioEnabled && isMfr && <Btn size="sm" variant="warning" disabled={busy} onClick={() => onOpen(c, true)}>Act for</Btn>}
        </div>
      )}
    </div>
  )
}

export function ViewerHome() {
  const { orders } = useApp()
  const [companies, setCompanies] = useState(null)
  const [error, setError] = useState('')
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState('all')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    viewAsApi.options().then(o => { if (live) setCompanies(o) }).catch(e => { if (live) setError(e?.message || 'Could not load companies') })
    return () => { live = false }
  }, [])

  const counts = useMemo(() => {
    const m = new Map()
    for (const o of orders || []) {
      m.set(o.buyerId, (m.get(o.buyerId) || 0) + 1)
      for (const a of o.assignments || []) m.set(a.mid, (m.get(a.mid) || 0) + 1)
    }
    return m
  }, [orders])

  const shown = useMemo(() => (companies || []).filter(c => {
    if (filter === 'buyer' && c.role !== 'buyer') return false
    if (filter === 'manufacturer' && c.role !== 'manufacturer') return false
    if (filter === 'managed' && !c.tradioEnabled) return false
    const needle = q.trim().toLowerCase()
    return !needle || [c.company, c.code, c.name].some(v => String(v || '').toLowerCase().includes(needle))
  }), [companies, q, filter])

  const open = async (c, act) => {
    setBusy(true); setError('')
    try { await switchTo(() => viewAsApi.start(c.id, { act })) }
    catch (e) { setError(e?.message || 'Could not open that company'); setBusy(false) }
  }

  if (!companies && !error) return <LoadingScreen message="Loading companies…" />

  const total = companies?.length || 0
  const managed = (companies || []).filter(c => c.tradioEnabled).length
  const priv = (companies || []).filter(c => c.tradioCanView === false).length

  return (
    <div>
      <PageHeader
        title="Companies"
        subtitle={`${total} compan${total === 1 ? 'y' : 'ies'} on the platform · ${managed} Tradio managed${priv ? ` · ${priv} private` : ''}. Open one to see its account exactly as it sees it.`}
      />
      {error && <div style={{ marginBottom: 14 }}><Alert type="danger">{error}</Alert></div>}

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16 }}>
        <label className="company-search" style={{ display: 'flex', alignItems: 'center', gap: 8, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, padding: '0 12px', flex: '1 1 240px', maxWidth: 380, minHeight: 40 }}>
          <Search size={15} color={T.textLight} />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search by name or code" aria-label="Search companies"
            style={{ border: 'none', outline: 'none', background: 'transparent', flex: 1, fontSize: 13, fontFamily: 'inherit', color: T.text, minWidth: 0 }} />
        </label>
        <div role="group" aria-label="Filter companies" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {FILTERS.map(([id, text]) => (
            <button key={id} type="button" onClick={() => setFilter(id)} aria-pressed={filter === id}
              style={{ fontSize: 12, fontWeight: 700, padding: '7px 13px', minHeight: 36, borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit', border: `1px solid ${filter === id ? T.primary : T.border}`, background: filter === id ? T.primaryLight : T.surface, color: filter === id ? T.primaryDark : T.textMuted }}>
              {text}
            </button>
          ))}
        </div>
      </div>

      {shown.length === 0
        ? <EmptyState icon={<Building2 size={26} color={T.textLight} />} title={total ? 'No company matches' : 'No companies yet'} desc={total ? 'Try a different search or filter.' : 'Create one from User Setup.'} />
        : <div className="company-grid">{shown.map(c => <CompanyCard key={c.id} c={c} orderCount={counts.get(c.id) || 0} busy={busy} onOpen={open} />)}</div>}
    </div>
  )
}
