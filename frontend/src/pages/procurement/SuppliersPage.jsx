import { useMemo, useState } from 'react'
import { Plus, Upload, Search, Storefront } from '../../icons.jsx'
import { T } from '../../constants.js'
import { Btn, PageHeader, FlexRow, EmptyState, Alert, Mono, useToast } from '../../components/ui.jsx'
import { DataTable } from '../../components/DataTable.jsx'
import { SpreadsheetImport } from '../../components/SpreadsheetImport.jsx'
import { useApp } from '../../context.jsx'
import { capsFor } from '../../caps.js'
import { suppliersApi } from '../../api.js'
import { suppliersStore } from '../../stores/procurement.jsx'
import { SUPPLIER_TYPES, supplierTypeLabel } from '../../lib/procurement.js'
import { Pill } from './common.jsx'
import { SupplierFormModal } from './SupplierFormModal.jsx'
import { SupplierDetail } from './SupplierDetail.jsx'

const SUPPLIER_COLUMNS = [
  { key: 'name', header: 'Supplier', required: true, aliases: ['supplier name', 'name', 'company'] },
  { key: 'type', header: 'Type', type: 'enum', options: SUPPLIER_TYPES.map(t => t.id), aliases: ['kind'] },
  { key: 'email', header: 'Email' },
  { key: 'phone', header: 'Phone' },
  { key: 'gstin', header: 'GSTIN', aliases: ['gst', 'gst number'] },
  { key: 'address', header: 'Address' },
  { key: 'city', header: 'City' },
  { key: 'pincode', header: 'PIN code', aliases: ['pin', 'pincode'] },
  { key: 'paymentTerms', header: 'Payment terms' },
  { key: 'deliveryTerms', header: 'Delivery terms' },
]
const SUPPLIER_EXAMPLE = { name: 'Coimbatore Knit Fabrics', type: 'fabric_supplier', email: 'sales@cknit.com', phone: '+91 98430 11223', gstin: '33AABCC1234D1ZP', address: '14 Avinashi Road', city: 'Coimbatore', pincode: '641018', paymentTerms: '45 days from invoice', deliveryTerms: 'Ex-mill' }
const supplierPayload = r => Object.fromEntries(Object.entries(r).filter(([k, v]) => !k.startsWith('_') && v !== null && v !== ''))

/** The factory's supplier book. */
export function SuppliersPage({ initialSupplier, onNavigate }) {
  const toast = useToast()
  const { currentUser } = useApp()
  const caps = capsFor(currentUser)
  const { items: suppliers, loading, error, refresh } = suppliersStore.useStore()
  const [q, setQ] = useState('')
  const [type, setType] = useState('all')
  const [archived, setArchived] = useState(false)
  const [adding, setAdding] = useState(false)
  const [importing, setImporting] = useState(false)
  const [openId, setOpenId] = useState(initialSupplier || null)

  const active = suppliers.filter(s => s.isActive)
  const counts = useMemo(() => Object.fromEntries([['all', active.length], ...SUPPLIER_TYPES.map(t => [t.id, active.filter(s => s.type === t.id).length])]), [active])
  const shown = suppliers.filter(s => (archived || s.isActive)
    && (type === 'all' || s.type === type)
    && (!q.trim() || [s.name, s.city, s.gstin, s.email].some(v => (v || '').toLowerCase().includes(q.trim().toLowerCase()))))

  const columns = [
    { key: 'name', header: 'Supplier', primary: true, render: s => (
      <div style={{ opacity: s.isActive ? 1 : 0.55 }}>
        <div style={{ fontWeight: 700, color: T.text }}>{s.name}{!s.isActive && <span style={{ marginLeft: 8 }}><Pill>Archived</Pill></span>}</div>
        <div style={{ fontSize: 11, color: T.textLight, marginTop: 2 }}>{[s.city, s.stateName].filter(Boolean).join(', ') || 'Location not set'}</div>
      </div>
    ) },
    { key: 'type', header: 'Type', render: s => <Pill tone={s.type === 'fabric_supplier' ? 'info' : s.type === 'dyer' ? 'warn' : 'neutral'}>{supplierTypeLabel(s.type)}</Pill> },
    { key: 'gstin', header: 'GSTIN', hideOnMobile: true, render: s => (s.gstin ? <Mono style={{ fontSize: 11 }}>{s.gstin}</Mono> : <span style={{ color: T.textLight }}>Not set</span>) },
    { key: 'items', header: 'Items', numeric: true, render: s => s.itemCount },
    { key: 'terms', header: 'Payment terms', hideOnMobile: true, render: s => s.paymentTerms || '-' },
  ]

  const startPo = supplier => onNavigate('po_builder', { supplier: supplier.id })

  return (
    <div>
      <PageHeader title="Suppliers" subtitle="The mills, dyers and trims shops you buy from. Only your company sees this."
        action={caps.manageProcurement ? (
          <FlexRow gap={8}>
            <Btn variant="secondary" icon={<Upload size={13} />} onClick={() => setImporting(true)}>Import</Btn>
            <Btn icon={<Plus size={13} />} onClick={() => setAdding(true)}>Add supplier</Btn>
          </FlexRow>
        ) : null} />

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ position: 'relative', flex: '1 1 240px', maxWidth: 360 }}>
          <Search size={13} color={T.textLight} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search by name, city or GSTIN" aria-label="Search suppliers"
            style={{ width: '100%', border: `1px solid ${T.border}`, borderRadius: 8, padding: '10px 12px 10px 32px', fontSize: 14, color: T.text, background: '#f8fafc', fontFamily: 'inherit', boxSizing: 'border-box' }} />
        </div>
        <div role="group" aria-label="Filter by type" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {[{ id: 'all', label: 'All' }, ...SUPPLIER_TYPES].map(t => (
            <button key={t.id} type="button" aria-pressed={type === t.id} onClick={() => setType(t.id)}
              style={{ fontSize: 12, fontWeight: 700, padding: '8px 13px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit', border: `1px solid ${type === t.id ? T.primary : T.border}`, background: type === t.id ? T.primaryLight : T.surface, color: type === t.id ? T.primaryDark : T.textMuted }}>
              {t.label} ({counts[t.id] ?? 0})
            </button>
          ))}
        </div>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: T.textMuted, cursor: 'pointer', marginLeft: 'auto' }}>
          <input type="checkbox" checked={archived} onChange={e => setArchived(e.target.checked)} /> Show archived
        </label>
      </div>

      {error && suppliers.length === 0 && <Alert type="danger">{error.message}</Alert>}
      {!loading && suppliers.length === 0 && !error ? (
        <EmptyState icon={<Storefront size={26} color={T.textLight} />} title="No suppliers yet"
          desc={caps.manageProcurement ? 'Add the mills, dyers and trims shops you buy from. Then raising a purchase order is a few taps.' : 'This company has not added any suppliers yet.'} />
      ) : (
        <DataTable columns={columns} rows={shown} rowKey="id" onRowClick={s => setOpenId(s.id)} loading={loading && suppliers.length === 0}
          empty={q || type !== 'all' ? 'No supplier matches that.' : 'Nothing to show.'} />
      )}

      {adding && <SupplierFormModal onClose={() => setAdding(false)} onSaved={async s => { setAdding(false); toast(`${s.name} added`, 'success'); await refresh(); setOpenId(s.id) }} />}
      {importing && (
        <SpreadsheetImport title="Import suppliers" noun="suppliers" columns={SUPPLIER_COLUMNS} example={SUPPLIER_EXAMPLE} templateName="suppliers"
          toPayload={supplierPayload} onImport={rows => suppliersApi.bulk(rows)} onDone={refresh} onClose={() => setImporting(false)} />
      )}
      {openId && <SupplierDetail supplierId={openId} canWrite={caps.manageProcurement} onClose={() => setOpenId(null)} onNewPo={supplier => { setOpenId(null); startPo(supplier) }} onOpenPo={id => { setOpenId(null); onNavigate('po_detail', { po: id }) }} />}
    </div>
  )
}
