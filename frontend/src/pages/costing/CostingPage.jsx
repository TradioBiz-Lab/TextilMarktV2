import { useMemo, useState } from 'react'
import { Plus, Calculator } from '../../icons.jsx'
import { T } from '../../constants.js'
import { Btn, PageHeader, EmptyState, Alert } from '../../components/ui.jsx'
import { DataTable } from '../../components/DataTable.jsx'
import { useApp } from '../../context.jsx'
import { capsFor } from '../../caps.js'
import { costSheetsStore } from '../../stores/costing.jsx'
import { costStatus, awaitingReview } from '../../lib/costing.js'
import { rupees, fmtDay } from '../../lib/procurement.js'
import { Pill } from '../procurement/common.jsx'
import { NewCostSheetModal } from './NewCostSheetModal.jsx'

/**
 * Every cost sheet: a factory's own, drafts included, or for a brand what its factories have shared with it
 * (the ones waiting for its review first).
 */
export function CostingPage({ onNavigate }) {
  const { currentUser } = useApp()
  const caps = capsFor(currentUser)
  const brand = !caps.isMfr
  const { items: rows, loading, error } = costSheetsStore.useStore()
  const [filter, setFilter] = useState('all')
  const [creating, setCreating] = useState(false)

  const filters = brand
    ? [{ id: 'all', label: 'All' }, { id: 'review', label: `Needs your review (${awaitingReview(rows).length})`, test: r => r.status === 'shared' }, { id: 'approved', label: 'Approved', test: r => r.status === 'approved' }]
    : [{ id: 'all', label: 'All' }, { id: 'draft', label: 'Drafts', test: r => r.status === 'draft' }, { id: 'shared', label: 'Shared', test: r => r.status === 'shared' || r.status === 'commented' }, { id: 'approved', label: 'Approved', test: r => r.status === 'approved' }]
  const shown = useMemo(() => { const f = filters.find(x => x.id === filter); return f?.test ? rows.filter(f.test) : rows }, [rows, filter, brand]) // eslint-disable-line react-hooks/exhaustive-deps
  const open = r => onNavigate('cost_sheet', { cost: r.id })

  const columns = [
    { key: 'styleName', header: 'Style', primary: true, render: r => (
      <div>
        <div style={{ fontWeight: 700, fontSize: 13, color: T.text }}>{r.styleName}{r.styleCode ? ` (${r.styleCode})` : ''}</div>
        <div style={{ fontSize: 11, color: T.textLight, marginTop: 2, fontFamily: 'ui-monospace, monospace' }}>{r.chainId} v{r.version}</div>
      </div>
    ) },
    { key: 'party', header: brand ? 'Factory' : 'Customer', render: r => (brand ? r.factoryName : r.brandName) },
    { key: 'status', header: 'Status', render: r => { const s = costStatus(r.status, { brand }); return <Pill tone={s.tone}>{s.label}</Pill> } },
    { key: 'price', header: 'Price per piece', numeric: true, render: r => (r.discountPct > 0 && r.negotiated != null ? <span><strong>{rupees(r.negotiated)}</strong> <span style={{ color: T.textLight, fontSize: 11 }}>was {rupees(r.price)}</span></span> : <strong>{rupees(r.price)}</strong>) },
    { key: 'when', header: 'Updated', render: r => fmtDay(r.updatedAt) },
  ]

  return (
    <div style={{ maxWidth: 1100 }}>
      <PageHeader
        title="Cost sheets"
        subtitle={brand ? 'What your factories have shared with you. Review, comment and approve.' : 'Build the price of a style line by line, share it with the customer, and track their approval.'}
        action={caps.manageCosting && <Btn icon={<Plus size={14} />} onClick={() => setCreating(true)}>New cost sheet</Btn>}
      />
      {error && <div style={{ marginBottom: 12 }}><Alert type="danger">Could not load your cost sheets: {error.message}</Alert></div>}

      {brand && awaitingReview(rows).length > 0 && filter === 'all' && (
        <div style={{ marginBottom: 14 }}><Alert type="info">{awaitingReview(rows).length === 1 ? '1 cost sheet is' : `${awaitingReview(rows).length} cost sheets are`} waiting for your review.</Alert></div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
        {filters.map(f => (
          <button key={f.id} type="button" onClick={() => setFilter(f.id)} aria-pressed={filter === f.id}
            style={{ padding: '7px 14px', borderRadius: 20, fontSize: 13, fontWeight: 600, border: `1px solid ${filter === f.id ? T.primary : T.border}`, background: filter === f.id ? T.primaryLight : T.surface, color: filter === f.id ? T.primaryDeep : T.text, cursor: 'pointer', fontFamily: 'inherit', minHeight: 36 }}>{f.label}</button>
        ))}
      </div>

      {!loading && rows.length === 0 ? (
        <EmptyState icon={<Calculator size={28} color={T.textLight} />} title="No cost sheets yet"
          desc={brand ? 'When a factory shares a cost sheet with you it appears here, and you are told.' : 'Start one from a customer and a style, or from a frozen bill of materials, then share it for approval.'} />
      ) : (
        <DataTable columns={columns} rows={shown} rowKey="id" onRowClick={open} loading={loading && rows.length === 0} empty="No cost sheet matches that." />
      )}

      {creating && <NewCostSheetModal onClose={() => setCreating(false)} onCreated={s => { setCreating(false); onNavigate('cost_sheet', { cost: s.id }) }} />}
    </div>
  )
}
