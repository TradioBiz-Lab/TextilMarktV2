import { useMemo, useState } from 'react'
import { Plus, Search, Receipt } from '../../icons.jsx'
import { T, getToday } from '../../constants.js'
import { Btn, PageHeader, EmptyState, Alert, Mono } from '../../components/ui.jsx'
import { DataTable } from '../../components/DataTable.jsx'
import { useApp } from '../../context.jsx'
import { capsFor } from '../../caps.js'
import { posStore } from '../../stores/procurement.jsx'
import { OPEN_STATUSES, rupeesWhole, fmtDay } from '../../lib/procurement.js'
import { StatusPill, Progress, Pill } from './common.jsx'

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'draft', label: 'Drafts', statuses: ['draft', 'sending'] },
  { id: 'open', label: 'Awaiting goods', statuses: OPEN_STATUSES },
  { id: 'received', label: 'Received', statuses: ['closed'] },
  { id: 'cancelled', label: 'Cancelled', statuses: ['cancelled'] },
]

/** Every purchase order the factory has raised. */
export function PoListPage({ onNavigate }) {
  const { currentUser } = useApp()
  const caps = capsFor(currentUser)
  const { items: pos, loading, error } = posStore.useStore()
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState('all')
  const today = getToday()

  const counts = useMemo(() => Object.fromEntries(FILTERS.map(f => [f.id, f.statuses ? pos.filter(p => f.statuses.includes(p.status)).length : pos.length])), [pos])
  const active = FILTERS.find(f => f.id === filter)
  const shown = pos.filter(p => (!active.statuses || active.statuses.includes(p.status))
    && (!q.trim() || [p.id, p.supplierName].some(v => (v || '').toLowerCase().includes(q.trim().toLowerCase()))))
  const awaiting = pos.filter(p => OPEN_STATUSES.includes(p.status)).reduce((s, p) => s + p.grandTotal * (1 - p.receivedPct / 100), 0)

  const columns = [
    { key: 'id', header: 'PO number', primary: true, render: p => <Mono style={{ fontSize: 12, fontWeight: 700, color: T.primaryDeep }}>{p.id}</Mono> },
    { key: 'supplier', header: 'Supplier', render: p => <span style={{ fontWeight: 600, color: T.text }}>{p.supplierName || '-'}</span> },
    { key: 'status', header: 'Status', render: p => <StatusPill status={p.status} /> },
    { key: 'total', header: 'Total', numeric: true, render: p => <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{rupeesWhole(p.grandTotal)}</strong> },
    { key: 'due', header: 'Delivery by', render: p => {
      const late = p.expectedDate && p.expectedDate < today && OPEN_STATUSES.includes(p.status)
      return <span style={{ color: late ? T.danger : T.text, fontWeight: late ? 700 : 400 }}>{fmtDay(p.expectedDate)}{late && <span style={{ marginLeft: 6 }}><Pill tone="bad">Overdue</Pill></span>}</span>
    } },
    { key: 'received', header: 'Received', render: p => (OPEN_STATUSES.includes(p.status) || p.status === 'closed') ? <div style={{ minWidth: 110 }}><Progress pct={p.receivedPct} tone={p.status === 'closed' ? 'good' : 'warn'} /></div> : '-' },
  ]

  return (
    <div>
      <PageHeader title="Purchase Orders"
        subtitle={pos.length ? `${pos.length} in all${awaiting > 0 ? `, about ${rupeesWhole(awaiting)} still to come in` : ''}` : 'Order what the factory needs from your suppliers, and track it in.'}
        action={caps.manageProcurement ? <Btn icon={<Plus size={13} />} onClick={() => onNavigate('po_builder')}>New purchase order</Btn> : null} />

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ position: 'relative', flex: '1 1 240px', maxWidth: 360 }}>
          <Search size={13} color={T.textLight} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search by PO number or supplier" aria-label="Search purchase orders"
            style={{ width: '100%', border: `1px solid ${T.border}`, borderRadius: 8, padding: '10px 12px 10px 32px', fontSize: 14, color: T.text, background: '#f8fafc', fontFamily: 'inherit', boxSizing: 'border-box' }} />
        </div>
        <div role="group" aria-label="Filter by status" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {FILTERS.map(f => (
            <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}
              style={{ fontSize: 12, fontWeight: 700, padding: '8px 13px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit', border: `1px solid ${filter === f.id ? T.primary : T.border}`, background: filter === f.id ? T.primaryLight : T.surface, color: filter === f.id ? T.primaryDark : T.textMuted }}>
              {f.label} ({counts[f.id]})
            </button>
          ))}
        </div>
      </div>

      {error && pos.length === 0 && <Alert type="danger">{error.message}</Alert>}
      {!loading && pos.length === 0 && !error ? (
        <EmptyState icon={<Receipt size={26} color={T.textLight} />} title="No purchase orders yet"
          desc={caps.manageProcurement ? 'Start one from a supplier, or from the material lines on your orders.' : 'This company has not raised a purchase order yet.'} />
      ) : (
        <DataTable columns={columns} rows={shown} rowKey="id" onRowClick={p => onNavigate('po_detail', { po: p.id })} loading={loading && pos.length === 0}
          empty={q || filter !== 'all' ? 'No purchase order matches that.' : 'Nothing to show.'} />
      )}
    </div>
  )
}
