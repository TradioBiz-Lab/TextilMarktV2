import { useState, useEffect, useMemo, useCallback } from 'react'
import { Search, Plus, X, Factory, Layers, Sparkles, FileSpreadsheet, Filter, AlertTriangle } from '../../icons.jsx'
import { T } from '../../constants.js'
import { PageHeader, Btn, Card, EmptyState, LoadingScreen, Alert, useToast } from '../../components/ui.jsx'
import { PartnerCard } from '../../components/PartnerCard.jsx'
import { PartnerFormModal } from './PartnerFormModal.jsx'
import { PartnerCsvImportModal } from './PartnerCsvImportModal.jsx'
import { useApp } from '../../context.jsx'
import { useKriyaaChat } from '../../kriyaaChatContext.jsx'
import {
  TYPE_TABS, CATEGORIES, CATEGORY_LABEL, CLUSTERS, STATUSES, PRIORITIES, CLUSTER_LABEL, STATUS_BY, labelOf, sortsFor, PAGE_SIZE,
  emptyQuery, queryToParams, activeFilterCount, kriyaaPromptFor,
} from '../../partners.js'

// Partners: Tradio's internal sourcing directory of garment manufacturers, fabric suppliers and trims suppliers.
// Admin only (the nav item is hidden by caps.js, and the server refuses every other role regardless).

const toggle = (list, v) => (list.includes(v) ? list.filter(x => x !== v) : [...list, v])

function RailSection({ title, children }) {
  return (
    <div style={{ paddingBottom: 14, marginBottom: 14, borderBottom: `1px solid ${T.border}` }}>
      <div style={{ fontSize: 11, fontWeight: 800, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  )
}

function CheckRow({ checked, onChange, label, count }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', cursor: 'pointer', fontSize: T.fontSize.body, color: T.text }}>
      <input type="checkbox" checked={checked} onChange={onChange} style={{ accentColor: T.primaryDeep, margin: 0 }} />
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      {count !== undefined && <span style={{ fontSize: T.fontSize.xs, color: T.textLight }}>{count}</span>}
    </label>
  )
}

function SwitchRow({ checked, onChange, label, hint }) {
  return (
    <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '4px 0', cursor: 'pointer' }}>
      <input type="checkbox" checked={checked} onChange={onChange} style={{ accentColor: T.primaryDeep, margin: '3px 0 0' }} />
      <span>
        <span style={{ display: 'block', fontSize: T.fontSize.body, color: T.text, fontWeight: 600 }}>{label}</span>
        {hint && <span style={{ display: 'block', fontSize: T.fontSize.xs, color: T.textLight }}>{hint}</span>}
      </span>
    </label>
  )
}

const numInput = { width: '100%', border: `1px solid ${T.border}`, borderRadius: 6, padding: '5px 8px', fontSize: 12, fontFamily: 'inherit', color: T.text, background: '#fff' }

// Show the first few of a long list, the rest behind "Show all".
function ShortList({ items, render, initial = 6 }) {
  const [all, setAll] = useState(false)
  const shown = all ? items : items.slice(0, initial)
  return (
    <>
      {shown.map(render)}
      {items.length > initial && (
        <button type="button" onClick={() => setAll(a => !a)} style={{ background: 'none', border: 'none', padding: '4px 0', cursor: 'pointer', fontSize: T.fontSize.sm, fontWeight: 700, color: T.primaryDeep, fontFamily: 'inherit' }}>{all ? 'Show fewer' : `Show all ${items.length}`}</button>
      )}
    </>
  )
}

export function PartnersPage({ onNavigate }) {
  const { partners, partnerFacets, partnerQuery: q, setPartnerQuery, loadPartners, loadPartnerFacets } = useApp()
  const chat = useKriyaaChat()
  const toast = useToast()
  const [searchText, setSearchText] = useState(q.search)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState(null)       // { type } while the Add partner modal is open
  const [importing, setImporting] = useState(false)
  const [railOpen, setRailOpen] = useState(false) // the filter rail on a phone

  const patch = useCallback(p => setPartnerQuery(cur => ({ ...cur, limit: PAGE_SIZE, ...p })), [setPartnerQuery])

  // Typing waits a moment before it asks the server.
  useEffect(() => {
    if (searchText === q.search) return undefined
    const t = setTimeout(() => patch({ search: searchText, ...(searchText && !q.search ? { sort: 'relevance' } : {}), ...(!searchText && q.sort === 'relevance' ? { sort: 'score' } : {}) }), 300)
    return () => clearTimeout(t)
  }, [searchText, q.search, q.sort, patch])

  const params = useMemo(() => queryToParams(q), [q])
  const key = JSON.stringify(params)
  useEffect(() => {
    let live = true
    setBusy(true); setError('')
    loadPartners(params)
      .catch(e => { if (live) setError(e?.message || 'Could not load the partners') })
      .finally(() => { if (live) setBusy(false) })
    return () => { live = false }
  }, [key, loadPartners])
  useEffect(() => { loadPartnerFacets().catch(() => {}) }, [loadPartnerFacets])

  const f = partnerFacets
  const filters = activeFilterCount(q)
  const tab = TYPE_TABS.find(t => t.id === q.tab) || TYPE_TABS[0]
  const tabCount = t => (f ? (t.types.length ? t.types.reduce((n, ty) => n + (f.byType[ty] || 0), 0) : f.total) : null)
  const reset = () => { setSearchText(''); setPartnerQuery(cur => ({ ...emptyQuery(), tab: cur.tab })) }
  const items = partners?.items || []
  const total = partners?.total ?? 0
  const searching = !!q.search.trim()
  const directoryEmpty = f && f.total === 0 && f.inactive === 0
  const tabEmpty = f && tabCount(tab) === 0 && q.tab !== 'all' && !searching && filters === 0

  const askKriyaa = () => {
    if (!chat) return
    chat.send(kriyaaPromptFor(q, searchText))
    onNavigate('kriyaa')
  }

  const rail = (
    <div className="partners-rail" style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.radius.md, padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ fontSize: T.fontSize.md, fontWeight: 800, color: T.text }}>Filters</div>
        {filters > 0 && <button type="button" onClick={reset} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: T.fontSize.sm, fontWeight: 700, color: T.primaryDeep, fontFamily: 'inherit' }}>Clear all</button>}
      </div>
      <RailSection title="Category">
        {CATEGORIES.map(c => <CheckRow key={c.v} label={c.label} checked={q.category.includes(c.v)} onChange={() => patch({ category: toggle(q.category, c.v) })} count={f?.byCategory?.[c.v] || 0} />)}
        <div style={{ fontSize: T.fontSize.xs, color: T.textLight, marginTop: 4 }}>A partner in several shows under each.</div>
      </RailSection>
      <RailSection title="Cluster">
        {CLUSTERS.map(c => <CheckRow key={c.v} label={c.label} checked={q.cluster.includes(c.v)} onChange={() => patch({ cluster: toggle(q.cluster, c.v) })} count={f?.byCluster[c.v] || 0} />)}
      </RailSection>
      {(f?.fabrics.length > 0 || q.fabric.length > 0) && (
        <RailSection title="Fabric">
          <ShortList items={[...new Set([...q.fabric, ...(f?.fabrics.map(x => x.value) || [])])]} render={v => (
            <CheckRow key={v} label={labelOf(v)} checked={q.fabric.includes(v)} onChange={() => patch({ fabric: toggle(q.fabric, v) })} count={f?.fabrics.find(x => x.value === v)?.count || 0} />
          )} />
        </RailSection>
      )}
      <RailSection title="Status">
        {STATUSES.map(s => <CheckRow key={s.v} label={s.label} checked={q.status.includes(s.v)} onChange={() => patch({ status: toggle(q.status, s.v) })} count={f?.byStatus[s.v] || 0} />)}
      </RailSection>
      <RailSection title="Priority">
        <div style={{ display: 'flex', gap: 6 }}>
          {PRIORITIES.map(p => {
            const on = q.priority.includes(p.v)
            return (
              <button key={p.v} type="button" onClick={() => patch({ priority: toggle(q.priority, p.v) })} title={`Priority ${p.v}: ${p.hint}`} aria-pressed={on}
                style={{ flex: 1, padding: '5px 0', borderRadius: 7, cursor: 'pointer', fontWeight: 800, fontSize: T.fontSize.body, fontFamily: 'inherit', border: `1px solid ${on ? T.primaryDeep : T.border}`, background: on ? T.primaryLight : '#fff', color: on ? T.primaryDeep : T.textMuted }}>{p.v}</button>
            )
          })}
        </div>
      </RailSection>
      <RailSection title="Verification score">
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
          {[['70+', 70, ''], ['50 to 69', 50, 69], ['Under 50', '', 49]].map(([label, lo, hi]) => {
            const on = q.minScore === lo && q.maxScore === hi
            return (
              <button key={label} type="button" onClick={() => patch(on ? { minScore: '', maxScore: '' } : { minScore: lo, maxScore: hi })} aria-pressed={on}
                style={{ padding: '3px 10px', borderRadius: T.radius.pill, cursor: 'pointer', fontSize: T.fontSize.sm, fontWeight: 700, fontFamily: 'inherit', border: `1px solid ${on ? T.primaryDeep : T.border}`, background: on ? T.primaryLight : '#fff', color: on ? T.primaryDeep : T.textMuted }}>{label}</button>
            )
          })}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="number" min={0} max={100} placeholder="From" aria-label="Lowest score" value={q.minScore} onChange={e => patch({ minScore: e.target.value === '' ? '' : Math.min(100, Math.max(0, Number(e.target.value))) })} style={numInput} />
          <span style={{ color: T.textLight, fontSize: T.fontSize.sm }}>to</span>
          <input type="number" min={0} max={100} placeholder="To" aria-label="Highest score" value={q.maxScore} onChange={e => patch({ maxScore: e.target.value === '' ? '' : Math.min(100, Math.max(0, Number(e.target.value))) })} style={numInput} />
        </div>
        <div style={{ fontSize: T.fontSize.xs, color: T.textLight, marginTop: 5 }}>Partners not scored yet are left out of a range.</div>
      </RailSection>
      <SwitchRow checked={q.verifiedOnly} onChange={e => patch({ verifiedOnly: e.target.checked })} label="Verified only" hint="GST checked or a sample approved" />
      <SwitchRow checked={q.onPlatform} onChange={e => patch({ onPlatform: e.target.checked })} label="On platform" hint="Also has a TextilMarkt account" />
      <SwitchRow checked={q.includeInactive} onChange={e => patch({ includeInactive: e.target.checked })} label="Show archived" hint={f?.inactive ? `${f.inactive} kept on file, out of the way` : 'Service providers, brands, individuals'} />
    </div>
  )

  const chips = []
  for (const c of q.category) chips.push([`category:${c}`, CATEGORY_LABEL[c], () => patch({ category: q.category.filter(x => x !== c) })])
  for (const c of q.cluster) chips.push([`cluster:${c}`, CLUSTER_LABEL[c], () => patch({ cluster: q.cluster.filter(x => x !== c) })])
  for (const v of q.fabric) chips.push([`fabric:${v}`, `${labelOf(v)} fabric`, () => patch({ fabric: q.fabric.filter(x => x !== v) })])
  for (const v of q.status) chips.push([`status:${v}`, STATUS_BY[v]?.label, () => patch({ status: q.status.filter(x => x !== v) })])
  for (const v of q.priority) chips.push([`priority:${v}`, `Priority ${v}`, () => patch({ priority: q.priority.filter(x => x !== v) })])
  if (q.minScore !== '' || q.maxScore !== '') chips.push(['score', `Score ${q.minScore === '' ? 0 : q.minScore} to ${q.maxScore === '' ? 100 : q.maxScore}`, () => patch({ minScore: '', maxScore: '' })])
  if (q.verifiedOnly) chips.push(['verified', 'Verified only', () => patch({ verifiedOnly: false })])
  if (q.onPlatform) chips.push(['platform', 'On platform', () => patch({ onPlatform: false })])
  if (q.includeInactive) chips.push(['inactive', 'Archived shown', () => patch({ includeInactive: false })])

  return (
    <div>
      <PageHeader
        title="Partners"
        subtitle="Tradio's sourcing directory: garment manufacturers, fabric suppliers and trims suppliers. Visible to admins only."
        action={(
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Btn variant="secondary" icon={<FileSpreadsheet size={14} />} onClick={() => setImporting(true)}>Import CSV</Btn>
            <Btn icon={<Plus size={14} />} onClick={() => setForm({ type: tab.addType })}>Add partner</Btn>
          </div>
        )}
      />

      {/* Sticky search bar */}
      <div style={{ position: 'sticky', top: 8, zIndex: 30, background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.radius.md, boxShadow: T.shadow.md, padding: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
        <div style={{ position: 'relative', flex: '1 1 260px', minWidth: 0 }}>
          <Search size={16} color={T.textLight} style={{ position: 'absolute', left: 12, top: 11 }} />
          <input value={searchText} onChange={e => setSearchText(e.target.value)} placeholder="Search name, city, products, fabrics, keywords" aria-label="Search partners"
            style={{ width: '100%', border: `1px solid ${T.border}`, borderRadius: 9, padding: '9px 34px 9px 36px', fontSize: 14, fontFamily: 'inherit', color: T.text, background: '#fff' }} />
          {searchText && <button type="button" onClick={() => setSearchText('')} aria-label="Clear search" style={{ position: 'absolute', right: 8, top: 8, background: '#f1f5f9', border: 'none', borderRadius: 6, width: 22, height: 22, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><X size={12} color={T.textMuted} /></button>}
        </div>
        <select value={searching || q.sort !== 'relevance' ? q.sort : 'score'} onChange={e => patch({ sort: e.target.value })} aria-label="Sort"
          style={{ border: `1px solid ${T.border}`, borderRadius: 9, padding: '9px 10px', fontSize: 13, fontFamily: 'inherit', color: T.text, background: '#fff', cursor: 'pointer' }}>
          {sortsFor(searching).map(s => <option key={s.v} value={s.v}>Sort: {s.label}</option>)}
        </select>
        <Btn variant="outline" icon={<Sparkles size={14} />} onClick={askKriyaa} disabled={!chat}>Ask Kriyaa</Btn>
        <button type="button" className="partners-filter-btn" onClick={() => setRailOpen(o => !o)} aria-expanded={railOpen}
          style={{ border: `1px solid ${T.border}`, borderRadius: 9, padding: '8px 12px', fontSize: 13, fontWeight: 700, fontFamily: 'inherit', color: T.text, background: '#fff', cursor: 'pointer', alignItems: 'center', gap: 6 }}>
          <Filter size={14} />Filters{filters ? ` (${filters})` : ''}
        </button>
      </div>

      {/* Type tabs */}
      <div role="tablist" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
        {TYPE_TABS.map(t => {
          const on = q.tab === t.id
          const n = tabCount(t)
          return (
            <button key={t.id} type="button" role="tab" aria-selected={on} onClick={() => patch({ tab: t.id })}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 16px', borderRadius: T.radius.pill, cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit', border: `1px solid ${on ? T.primaryDeep : T.border}`, background: on ? T.primaryDeep : T.surface, color: on ? '#fff' : T.textMuted }}>
              {t.label}
              {n !== null && <span style={{ fontSize: T.fontSize.xs, fontWeight: 800, padding: '0 7px', borderRadius: T.radius.pill, background: on ? 'rgba(255,255,255,0.22)' : '#f1f5f9', color: on ? '#fff' : T.textMuted }}>{n}</span>}
            </button>
          )
        })}
      </div>

      <div className="partners-layout">
        <div className={`partners-rail-wrap${railOpen ? ' open' : ''}`}>{rail}</div>

        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12, minHeight: 28 }}>
            <div style={{ fontSize: T.fontSize.body, fontWeight: 700, color: T.text }} aria-live="polite">
              {partners ? `${total} partner${total === 1 ? '' : 's'}` : 'Loading'}
              {searching && partners?.mode === 'regex' && <span style={{ fontWeight: 500, color: T.textLight }}> (matching part of a word)</span>}
            </div>
            {chips.map(([k, label, off]) => (
              <button key={k} type="button" onClick={off} title="Remove this filter"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 6px 2px 10px', borderRadius: T.radius.pill, border: `1px solid ${T.warningBorder}`, background: T.primaryLight, color: T.primaryDeep, fontSize: T.fontSize.sm, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
                {label}<X size={11} />
              </button>
            ))}
          </div>

          {error && <div style={{ marginBottom: 12 }}><Alert type="danger">{error}</Alert></div>}

          {!partners && !error && <LoadingScreen message="Loading partners…" />}

          {partners && directoryEmpty && (
            <Card><EmptyState icon={<Factory size={36} />} title="No partners yet" desc={<>Add the first one, or <button type="button" onClick={() => setImporting(true)} style={linkBtn}>import a CSV</button> to bring in a list.</>} /></Card>
          )}
          {partners && !directoryEmpty && tabEmpty && (
            <Card>
              <EmptyState icon={<Layers size={36} />} title={`No ${tab.noun || tab.label.toLowerCase()}s on file yet`}
                desc={<><button type="button" onClick={() => setForm({ type: tab.addType })} style={linkBtn}>Add the first {tab.noun || 'partner'}</button> to start this list.</>} />
            </Card>
          )}
          {partners && !directoryEmpty && !tabEmpty && items.length === 0 && (
            <Card>
              <EmptyState icon={<AlertTriangle size={36} />} title="No partners match" desc={<>Try fewer filters or other words. <button type="button" onClick={reset} style={linkBtn}>Clear filters and search</button></>} />
            </Card>
          )}

          {items.length > 0 && (
            <>
              <div className="partners-grid" style={{ opacity: busy ? 0.6 : 1, transition: 'opacity 0.15s' }}>
                {items.map(p => <PartnerCard key={p.id} partner={p} onOpen={() => onNavigate('partner_detail', { id: p.id })} />)}
              </div>
              {items.length < total && (
                <div style={{ textAlign: 'center', marginTop: 16 }}>
                  <Btn variant="secondary" onClick={() => setPartnerQuery(cur => ({ ...cur, limit: (cur.limit || PAGE_SIZE) + PAGE_SIZE }))}>Show more ({total - items.length} left)</Btn>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {form && (
        <PartnerFormModal initialType={form.type} onClose={() => setForm(null)}
          onSaved={p => { setForm(null); toast(`${p.name} added`, 'success'); loadPartners(params).catch(() => {}) }} />
      )}
      {importing && (
        <PartnerCsvImportModal onClose={() => setImporting(false)}
          onDone={r => { setImporting(false); toast(`${r.created} partner${r.created === 1 ? '' : 's'} imported`, 'success'); loadPartners(params).catch(() => {}) }} />
      )}
    </div>
  )
}

const linkBtn = { background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: T.primaryDeep, fontWeight: 700, fontSize: 'inherit', fontFamily: 'inherit', textDecoration: 'underline' }
