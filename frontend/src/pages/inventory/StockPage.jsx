import { useMemo, useState } from 'react'
import { Plus, Search, Warehouse, ReceiveGoods, IssueGoods, Truck } from '../../icons.jsx'
import { T } from '../../constants.js'
import { Btn, PageHeader, FlexRow, EmptyState, Alert, Tabs, useToast } from '../../components/ui.jsx'
import { DataTable } from '../../components/DataTable.jsx'
import { useApp } from '../../context.jsx'
import { capsFor } from '../../caps.js'
import { stockStore, grnsStore, jobworkStore } from '../../stores/inventory.jsx'
import { suppliersStore } from '../../stores/procurement.jsx'
import { fmtQty, fmtDay } from '../../lib/procurement.js'
import { CATEGORIES, categoryLabel, grnStateLabel, GRN_STATE, JOBWORK_STATE } from '../../lib/inventory.js'
import { Pill } from '../procurement/common.jsx'
import { ItemFormModal, ItemModal, AdjustModal, CombineModal } from './ItemModals.jsx'
import { IssueModal } from './IssueModal.jsx'
import { JobWorkSendModal, JobWorkModal } from './JobWorkModals.jsx'

const chip = (on) => ({ fontSize: 12, fontWeight: 700, padding: '8px 13px', minHeight: 36, borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit', border: `1px solid ${on ? T.primary : T.border}`, background: on ? T.primaryLight : T.surface, color: on ? T.primaryDark : T.textMuted })

/** The factory's store: what is in stock, the goods received notes behind it, and what was issued to orders. */
export function StockPage({ initialTab = 'stock', onNavigate }) {
  const toast = useToast()
  const { currentUser, orders } = useApp()
  const caps = capsFor(currentUser)
  const { items: data, loading, error, refresh } = stockStore.useStore()
  const { items: grns, refresh: refreshGrns } = grnsStore.useStore()
  const { items: jobwork, refresh: refreshJobwork } = jobworkStore.useStore()
  const { items: suppliers } = suppliersStore.useStore()
  const [tab, setTab] = useState(initialTab)
  const [q, setQ] = useState('')
  const [category, setCategory] = useState('all')
  const [lowOnly, setLowOnly] = useState(false)
  const [archived, setArchived] = useState(false)
  const [grnFilter, setGrnFilter] = useState('all')
  const [dialog, setDialog] = useState(null)       // { kind: 'item' | 'form' | 'count' | 'issue' | 'combine' | 'send' | 'job', item?, id? }

  const items = data.items
  const active = items.filter(i => i.isActive)
  const lowCount = active.filter(i => i.low).length
  const drafts = grns.filter(g => g.status === 'draft').length
  const openJobs = jobwork.jobs.filter(j => j.status === 'open' || j.status === 'partially_returned')
  const overdueJobs = openJobs.filter(j => j.overdue).length

  const shown = useMemo(() => items.filter(i =>
    (archived || i.isActive)
    && (category === 'all' || i.category === category)
    && (!lowOnly || i.low)
    && (!q.trim() || i.name.toLowerCase().includes(q.trim().toLowerCase()))), [items, archived, category, lowOnly, q])

  const stockColumns = [
    { key: 'name', header: 'Item', primary: true, render: i => (
      <div style={{ opacity: i.isActive ? 1 : 0.55 }}>
        <div style={{ fontWeight: 700, color: T.text, overflowWrap: 'anywhere' }}>{i.name}</div>
        <div style={{ display: 'flex', gap: 6, marginTop: 3, flexWrap: 'wrap' }}>
          <Pill>{categoryLabel(i.category)}</Pill>
          {i.low && <Pill tone="bad">Low: time to buy</Pill>}
          {!i.isActive && <Pill>Archived</Pill>}
        </div>
      </div>
    ) },
    { key: 'onHand', header: 'In the store', numeric: true, render: i => <span style={{ fontWeight: 700, color: i.low ? T.danger : T.text }}>{fmtQty(i.onHand)} {i.unit}</span> },
    { key: 'atJobWork', header: 'With job workers', numeric: true, hideOnMobile: true, render: i => (i.atJobWork ? `${fmtQty(i.atJobWork)} ${i.unit}` : '-') },
    { key: 'reorderLevel', header: 'Keep at least', numeric: true, hideOnMobile: true, render: i => (i.reorderLevel ? `${fmtQty(i.reorderLevel)} ${i.unit}` : '-') },
  ]

  const shownGrns = grns.filter(g => grnFilter === 'all' || g.status === grnFilter)
  const grnColumns = [
    { key: 'number', header: 'Note', primary: true, render: g => (
      <div>
        <div style={{ fontWeight: 700, color: T.text }}>{g.number || 'Not posted yet'}</div>
        <div style={{ fontSize: 11, color: T.textLight, marginTop: 2 }}>{fmtDay(g.receivedOn || g.createdAt)}{g.challanNo ? ` · challan ${g.challanNo}` : ''}</div>
      </div>
    ) },
    { key: 'supplierName', header: 'From', render: g => g.supplierName || <span style={{ color: T.textLight }}>Not stated</span> },
    { key: 'items', header: 'Goods', hideOnMobile: true, render: g => (
      <div style={{ fontSize: 12, color: T.textMuted }}>{g.preview.join(', ')}{g.lineCount > g.preview.length ? ` +${g.lineCount - g.preview.length} more` : ''}</div>
    ) },
    { key: 'poId', header: 'Against', hideOnMobile: true, render: g => g.poId || <span style={{ color: T.textLight }}>No PO</span> },
    { key: 'photoCount', header: 'Photos', numeric: true, hideOnMobile: true, render: g => g.photoCount || '-' },
    { key: 'status', header: 'State', render: g => <Pill tone={GRN_STATE[g.status]?.tone}>{grnStateLabel(g.status)}</Pill> },
  ]

  const issueColumns = [
    { key: 'number', header: 'Slip', primary: true, render: s => (
      <div>
        <div style={{ fontWeight: 700, color: T.text }}>{s.number}{s.type === 'return' && <span style={{ marginLeft: 8 }}><Pill tone="info">Return</Pill></span>}</div>
        <div style={{ fontSize: 11, color: T.textLight, marginTop: 2 }}>{fmtDay(s.issuedOn || s.createdAt)}</div>
      </div>
    ) },
    { key: 'orderId', header: 'Order', render: s => s.orderId },
    { key: 'lines', header: 'Items', render: s => <div style={{ fontSize: 12, color: T.textMuted }}>{s.lines.map(l => `${l.name} ${fmtQty(l.qty)} ${l.unit}`).join(', ')}</div> },
  ]

  const jobColumns = [
    { key: 'number', header: 'Challan', primary: true, render: j => (
      <div>
        <div style={{ fontWeight: 700, color: T.text }}>{j.number}</div>
        <div style={{ fontSize: 11, color: T.textLight, marginTop: 2 }}>Sent {fmtDay(j.sentOn)}{j.orderId ? ` · ${j.orderId}` : ''}</div>
      </div>
    ) },
    { key: 'supplierName', header: 'Job worker', render: j => <div><div style={{ color: T.text }}>{j.supplierName}</div><div style={{ fontSize: 11, color: T.textLight }}>{j.process}</div></div> },
    { key: 'lines', header: 'Goods', hideOnMobile: true, render: j => <div style={{ fontSize: 12, color: T.textMuted }}>{j.lines.map(l => `${l.name} ${fmtQty(l.outstanding)}/${fmtQty(l.qty)} ${l.unit}`).join(', ')}</div> },
    { key: 'expectedBack', header: 'Due back', render: j => (j.expectedBack ? <span style={{ color: j.overdue ? T.danger : T.text, fontWeight: j.overdue ? 700 : 400 }}>{fmtDay(j.expectedBack)}</span> : <span style={{ color: T.textLight }}>-</span>) },
    { key: 'status', header: 'State', render: j => <Pill tone={j.overdue ? 'bad' : JOBWORK_STATE[j.status]?.tone}>{j.overdue ? 'Overdue' : JOBWORK_STATE[j.status]?.label}</Pill> },
  ]

  const done = async () => { setDialog(null); await Promise.all([refresh(), refreshGrns(), refreshJobwork()]) }

  return (
    <div>
      <PageHeader title="Stock" subtitle="What is in your store, what came in, and what went to which order. Only your company sees this."
        action={caps.manageInventory ? (
          <FlexRow gap={8} style={{ flexWrap: 'wrap' }}>
            <Btn icon={<ReceiveGoods size={15} />} onClick={() => onNavigate('grn', {})}>Receive goods</Btn>
            <Btn variant="secondary" icon={<IssueGoods size={14} />} onClick={() => setDialog({ kind: 'issue' })}>Issue to an order</Btn>
            <Btn variant="secondary" icon={<Truck size={14} />} onClick={() => setDialog({ kind: 'send' })}>Send for job work</Btn>
            <Btn variant="secondary" icon={<Plus size={13} />} onClick={() => setDialog({ kind: 'form' })}>Add item</Btn>
          </FlexRow>
        ) : null} />

      {(lowCount > 0 || drafts > 0 || overdueJobs > 0) && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
          {lowCount > 0 && <button type="button" onClick={() => { setTab('stock'); setLowOnly(true) }} style={{ ...chip(lowOnly), color: T.danger, borderColor: T.dangerBorder, background: T.dangerBg }}>{lowCount} item{lowCount === 1 ? '' : 's'} below the level to keep</button>}
          {overdueJobs > 0 && <button type="button" onClick={() => setTab('jobwork')} style={{ ...chip(false), color: T.danger, borderColor: T.dangerBorder, background: T.dangerBg }}>{overdueJobs} job work challan{overdueJobs === 1 ? '' : 's'} overdue</button>}
          {drafts > 0 && <button type="button" onClick={() => { setTab('grns'); setGrnFilter('draft') }} style={{ ...chip(false), color: T.warning, borderColor: T.warningBorder, background: T.warningBg }}>{drafts} delivery note{drafts === 1 ? '' : 's'} not posted yet</button>}
        </div>
      )}

      <Tabs tabs={[{ id: 'stock', label: `Stock (${active.length})` }, { id: 'grns', label: `Goods received (${grns.length})` }, { id: 'issues', label: `Issued to orders (${data.issues.length})` }, { id: 'jobwork', label: `Job work (${openJobs.length})` }]} active={tab} onChange={setTab} />
      <div style={{ height: 14 }} />

      {error && items.length === 0 && <Alert type="danger">{error.message}</Alert>}

      {tab === 'stock' && (
        <>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ position: 'relative', flex: '1 1 240px', maxWidth: 360 }}>
              <Search size={13} color={T.textLight} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} />
              <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search the stock" aria-label="Search the stock"
                style={{ width: '100%', border: `1px solid ${T.border}`, borderRadius: 8, padding: '10px 12px 10px 32px', fontSize: 14, color: T.text, background: '#f8fafc', fontFamily: 'inherit', boxSizing: 'border-box' }} />
            </div>
            <div role="group" aria-label="Filter by kind" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {[{ id: 'all', label: 'All' }, ...CATEGORIES].map(c => <button key={c.id} type="button" aria-pressed={category === c.id} onClick={() => setCategory(c.id)} style={chip(category === c.id)}>{c.label}</button>)}
            </div>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: T.textMuted, cursor: 'pointer' }}><input type="checkbox" checked={lowOnly} onChange={e => setLowOnly(e.target.checked)} /> Low stock only</label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: T.textMuted, cursor: 'pointer', marginLeft: 'auto' }}><input type="checkbox" checked={archived} onChange={e => setArchived(e.target.checked)} /> Show archived</label>
          </div>
          {!loading && items.length === 0 && !error ? (
            <EmptyState icon={<Warehouse size={26} color={T.textLight} />} title="Nothing in stock yet"
              desc={caps.manageInventory ? 'Receive your first delivery and the goods appear here, or add an item by hand.' : 'This company has not recorded any stock yet.'} />
          ) : (
            <DataTable columns={stockColumns} rows={shown} rowKey="id" onRowClick={i => setDialog({ kind: 'item', item: i })} loading={loading && items.length === 0}
              empty={q || category !== 'all' || lowOnly ? 'No item matches that.' : 'Nothing to show.'} />
          )}
        </>
      )}

      {tab === 'grns' && (
        <>
          <div role="group" aria-label="Filter notes" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
            {[['all', 'All'], ['draft', 'Drafts'], ['posted', 'Posted']].map(([id, label]) => <button key={id} type="button" aria-pressed={grnFilter === id} onClick={() => setGrnFilter(id)} style={chip(grnFilter === id)}>{label}</button>)}
          </div>
          {grns.length === 0 ? (
            <EmptyState icon={<ReceiveGoods size={26} color={T.textLight} />} title="No deliveries recorded"
              desc={caps.manageInventory ? 'When goods arrive, photograph the challan and record what came. It adds to stock and moves the purchase order on.' : 'Nothing has been received yet.'} />
          ) : (
            <DataTable columns={grnColumns} rows={shownGrns} rowKey="id" onRowClick={g => onNavigate('grn', { grn: g.id })} empty="No note matches that." />
          )}
        </>
      )}

      {tab === 'issues' && (
        data.issues.length === 0 ? (
          <EmptyState icon={<IssueGoods size={26} color={T.textLight} />} title="Nothing issued yet"
            desc={caps.manageInventory ? 'Issue stock to an order when it goes to cutting, so what each order really used is on record.' : 'Nothing has been issued yet.'} />
        ) : <DataTable columns={issueColumns} rows={data.issues} rowKey="id" />
      )}

      {tab === 'jobwork' && (
        <>
          {jobwork.outstanding.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: 10, marginBottom: 14 }}>
              {jobwork.outstanding.map(o => (
                <div key={o.supplierId} style={{ border: `1px solid ${o.overdue ? T.dangerBorder : T.border}`, borderRadius: 12, padding: '12px 14px', background: T.surface }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                    <div style={{ fontSize: 14, fontWeight: 800, color: T.text }}>{o.supplierName}</div>
                    {o.overdue > 0 && <Pill tone="bad">{o.overdue} overdue</Pill>}
                  </div>
                  <div style={{ fontSize: 12, color: T.textMuted, margin: '2px 0 6px' }}>{o.jobs} challan{o.jobs === 1 ? '' : 's'} open</div>
                  {o.items.map(i => <div key={`${i.itemId}${i.unit}`} style={{ fontSize: 13, color: T.text }}><strong style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtQty(i.qty)} {i.unit}</strong> <span style={{ color: T.textMuted }}>{i.name}</span></div>)}
                </div>
              ))}
            </div>
          )}
          {jobwork.jobs.length === 0 ? (
            <EmptyState icon={<Truck size={26} color={T.textLight} />} title="Nothing sent for job work"
              desc={caps.manageInventory ? 'Send fabric to a dyer or pieces to a printer and it is made into a delivery challan. What each job worker holds of yours is tracked until it comes back.' : 'Nothing has been sent for job work.'} />
          ) : <DataTable columns={jobColumns} rows={jobwork.jobs} rowKey="id" onRowClick={j => setDialog({ kind: 'job', id: j.id })} />}
        </>
      )}

      {dialog?.kind === 'send' && <JobWorkSendModal items={items} suppliers={suppliers} orders={orders} initialItem={dialog.item} onClose={() => setDialog(null)} onSent={() => { refresh(); refreshJobwork() }} />}
      {dialog?.kind === 'job' && <JobWorkModal jobId={dialog.id} canWrite={caps.manageInventory} items={items} onClose={() => setDialog(null)} onChanged={() => { refresh(); refreshJobwork() }} />}
      {dialog?.kind === 'item' && (
        <ItemModal itemId={dialog.item.id} canWrite={caps.manageInventory} onClose={() => setDialog(null)} onChanged={refresh}
          onEdit={item => setDialog({ kind: 'form', item })} onCount={item => setDialog({ kind: 'count', item })} onIssue={item => setDialog({ kind: 'issue', item })} onCombine={item => setDialog({ kind: 'combine', item })} onSendOut={item => setDialog({ kind: 'send', item })}
          onOpenGrn={id => { setDialog(null); onNavigate('grn', { grn: id }) }} />
      )}
      {dialog?.kind === 'form' && <ItemFormModal item={dialog.item} onClose={() => setDialog(null)} onSaved={done} />}
      {dialog?.kind === 'combine' && <CombineModal item={dialog.item} items={items} onClose={() => setDialog(null)} onDone={done} />}
      {dialog?.kind === 'count' && <AdjustModal item={dialog.item} onClose={() => setDialog(null)} onDone={done} />}
      {dialog?.kind === 'issue' && <IssueModal items={items} initialItem={dialog.item} onClose={() => setDialog(null)} onDone={() => { toast('Stock updated', 'success'); done() }} />}
    </div>
  )
}
