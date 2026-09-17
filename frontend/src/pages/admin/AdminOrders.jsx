import { useState, useRef, useEffect } from 'react'
import { Plus, List, LayoutGrid, Search, Folder, Package, Check, Ban, AlertTriangle, ChevronDown, ChevronUp, ArrowRight } from 'lucide-react'
import {
  T, SEASONS, ORDER_STATUSES,
  isStageDone, stageIsOverdue, stageKindOf, stageProgressLabel, stageVariance, stageActualVariance, stagePct, fmtStageDate, effectiveEta,
  CELL_STATE, cellState, buildMatrixSpine, withBuyerPrefix,
} from '../../constants.js'
import { Badge, Btn, Card, EmptyState, Mono, FlexRow, PageHeader, Select, Input, FileUpload, LoadingScreen, useToast, fileUploadPayload, ProductThumb, Modal, activateOnKey } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'
import { ordersApi } from '../../api.js'
import { EditOrderModal } from './EditOrderModal.jsx'
import { DeleteOrderModal } from './DeleteOrderModal.jsx'
import { QuickStageModal } from './QuickStageModal.jsx'
import { CreateStyleWizard } from './CreateStyleWizard.jsx'

function fmtDate(d) {
  if (!d) return '—'
  const dt = new Date(d)
  const dd = String(dt.getDate()).padStart(2, '0')
  const mm = String(dt.getMonth() + 1).padStart(2, '0')
  return `${dd}-${mm}-${dt.getFullYear()}`
}

// ── Matrix view: styles across the top, TNA steps down the side ────────────
// The shape the team already keeps by hand in the Summary TNA sheet — one
// glance at a whole master order's plan, rather than one row per order.

// "Fitleasure — Core Series" rather than just "Core Series" — the master-order
// name alone doesn't say whose order it is. A real master-order group always
// belongs to one buyer; the "Other Orders" catch-all can span several, so it
// only gets a client prefix when every order in it happens to share one.
function groupDisplayLabel(g) {
  const base = g.mo?.orderName || (g.moId === '__none__' ? 'Other Orders' : g.moId)
  return withBuyerPrefix(base, g.orders)
}

export function AdminOrders({ onOpen, initialStatus }) {
  const { orders, users, loading, createOrder, uploadDoc, masterOrders, createMasterOrder, editOrder, deleteOrder } = useApp()
  const toast = useToast()
  const [q, setQ] = useState('')
  const [showSugg, setShowSugg] = useState(false)
  const [sfilt, setSfilt] = useState(initialStatus || 'All')
  const [sortCol, setSortCol] = useState(null)
  const [sortDir, setSortDir] = useState('asc')
  // Groups start collapsed — an admin managing many master orders shouldn't have to
  // scroll past every line item of every group just to find one. Tracks which groups
  // have been explicitly expanded, rather than which are collapsed.
  const [expandedGroups, setExpandedGroups] = useState(() => new Set())
  const toggleGroup = moId => setExpandedGroups(prev => {
    const next = new Set(prev)
    next.has(moId) ? next.delete(moId) : next.add(moId)
    return next
  })

  // List vs Matrix (styles across, TNA steps down). Both read the SAME
  // expandedGroups Set, keyed by master-order id — so a group left open in one
  // view stays open switching to the other; only the rendering changes.
  const [view, setView] = useState('matrix')
  // Native `title` tooltips are slow to appear (~1s browser delay) and easy to
  // miss entirely — a custom one shows the instant the cursor lands, following
  // the mouse so it never gets clipped by the scrolling matrix container.
  const [matrixTip, setMatrixTip] = useState(null) // { x, y, lines: string[] }
  // Clicking a date cell opens the update modal IN PLACE — no navigation, so
  // saving and closing leaves the admin exactly on Order Management.
  const [quickStage, setQuickStage] = useState(null) // { orderId, mfrId, stageIndex }
  // A short delay before showing (not on hiding) is what makes a tooltip feel
  // intentional rather than jumpy — it only appears once the cursor actually
  // settles on a cell, so sweeping across a row doesn't flash one per cell.
  const matrixTipTimerRef = useRef(null)
  const showMatrixTip = (x, y, lines) => {
    clearTimeout(matrixTipTimerRef.current)
    matrixTipTimerRef.current = setTimeout(() => setMatrixTip({ x, y, lines }), 350)
  }
  const hideMatrixTip = () => {
    clearTimeout(matrixTipTimerRef.current)
    setMatrixTip(null)
  }

  // ── Edit / Delete modal state ──
  const [editTarget, setEditTarget] = useState(null)
  const [deleteTarget, setDeleteTarget] = useState(null)

  // ── Create Style wizard state ──
  const [showWizard, setShowWizard] = useState(false)

  // ── Create Master Order state ──
  const [showMO, setShowMO] = useState(false)
  const [mo, setMo] = useState({ buyerId: '', orderName: '', season: 'SS26' })
  const [moFile, setMoFile] = useState(null)
  const [moFileErr, setMoFileErr] = useState('')
  const [moErr, setMoErr] = useState('')
  const [moSaving, setMoSaving] = useState(false)

  if (loading) return <LoadingScreen />

  const buyerUsers = users.filter(u => u.role === 'buyer' && u.isActive)  // used in Master Order modal

  const toggleSort = col => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
  }

  const filtered = orders.filter(o => {
    const qm = !q || (o.id.toLowerCase().includes(q.toLowerCase()) || o.product.toLowerCase().includes(q.toLowerCase()))
    const sm = sfilt === 'All' || (o.assignments || []).some(a => a.status === sfilt)
    return qm && sm
  }).sort((a, b) => {
    if (!sortCol) return 0
    const dir = sortDir === 'asc' ? 1 : -1
    if (sortCol === 'buyer') return dir * (a.buyerCompany || '').localeCompare(b.buyerCompany || '')
    if (sortCol === 'manufacturer') {
      const am = (a.assignments || []).map(x => x.mfrCompany).filter(Boolean).join(', ')
      const bm = (b.assignments || []).map(x => x.mfrCompany).filter(Boolean).join(', ')
      return dir * am.localeCompare(bm)
    }
    if (sortCol === 'status') return dir * orderStatus(a).localeCompare(orderStatus(b))
    if (sortCol === 'delivery') return dir * (new Date(a.delivery) - new Date(b.delivery))
    return 0
  })

  // Cluster orders under their Master Order (📁 grouping) — same pattern as the buyer
  // dashboard's order list. Orders with no masterOrderId fall into "Other Orders" last.
  const groupedOrders = (() => {
    const groups = new Map()
    filtered.forEach(o => {
      const moId = o.masterOrderId || '__none__'
      if (!groups.has(moId)) groups.set(moId, [])
      groups.get(moId).push(o)
    })
    const result = [...groups.entries()].map(([moId, ords]) => ({
      moId, mo: moId !== '__none__' ? masterOrders.find(m => m.id === moId) : null, orders: ords,
    }))
    result.sort((a, b) => {
      if (a.moId === '__none__') return 1
      if (b.moId === '__none__') return -1
      return new Date(b.mo?.createdAt || 0) - new Date(a.mo?.createdAt || 0)
    })
    return result
  })()

  // A small account has one or two master orders, and collapsing those meant the
  // page opened as column headers above nothing — reading as an empty table
  // rather than a tidy one. Auto-expand once, on first load, only when the list
  // is short enough that the scroll argument above doesn't apply. Runs a single
  // time so every later toggle is purely the user's.
  const [autoExpanded, setAutoExpanded] = useState(false)
  useEffect(() => {
    if (autoExpanded || groupedOrders.length === 0) return
    if (groupedOrders.length <= 3) setExpandedGroups(new Set(groupedOrders.map(g => g.moId)))
    setAutoExpanded(true)
  }, [groupedOrders.length, autoExpanded])

  const genMoId = () => {
    const b = users.find(u => u.id === mo.buyerId)
    if (!b) return null
    const prefix = `MO-${b.code}-`
    const maxN = masterOrders
      .filter(m => m.buyerId === mo.buyerId && m.id.startsWith(prefix))
      .reduce((max, m) => {
        const n = parseInt(m.id.slice(m.id.lastIndexOf('-') + 1), 10)
        return Number.isFinite(n) && n > max ? n : max
      }, 0)
    return `${prefix}${mo.season || 'XX'}-${String(maxN + 1).padStart(3, '0')}`
  }

  const resetMoForm = () => {
    setMo({ buyerId: '', orderName: '', season: 'SS26' })
    setMoFile(null); setMoFileErr(''); setMoErr('')
  }

  const orderStatus = (o) => {
    if (o.assignments.some(a => a.status === 'Delayed')) return 'Delayed'
    if (o.assignments.some(a => a.status === 'On Hold')) return 'On Hold'
    if (o.assignments.every(a => a.status === 'Delivered')) return 'Delivered'
    return 'Processing'
  }

  return (
    <div>
      {editTarget && (
        <EditOrderModal
          order={editTarget}
          onClose={() => setEditTarget(null)}
          onSave={async (id, data) => {
            await editOrder(id, data)
            toast(`Order ${id} updated`, 'success')
            setEditTarget(null)
          }}
        />
      )}
      {deleteTarget && (
        <DeleteOrderModal
          order={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onConfirm={async (id) => {
            await deleteOrder(id)
            toast(`Order ${id} deleted`, 'success')
            setDeleteTarget(null)
          }}
        />
      )}
      {showWizard && (
        <CreateStyleWizard
          masterOrders={masterOrders}
          onClose={() => setShowWizard(false)}
          onNewMasterOrder={() => setShowMO(true)}
          onCreated={firstStyleId => {
            setShowWizard(false)
            toast(`Style${firstStyleId ? ` ${firstStyleId}` : ''} created`, 'success')
            onOpen(firstStyleId)
          }}
        />
      )}

      {/* ── Create Master Order Modal ── */}
      {showMO && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, backdropFilter: 'blur(2px)' }} onClick={e => e.target === e.currentTarget && (setShowMO(false), resetMoForm())}>
          <div style={{ background: '#fff', borderRadius: 14, border: `1px solid ${T.border}`, width: '100%', maxWidth: 560, boxShadow: '0 24px 64px rgba(0,0,0,0.18)' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '20px 24px 16px', borderBottom: `1px solid ${T.border}` }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 700, color: T.text }}>Create Master Order</div>
                <div style={{ fontSize: 12, color: T.textMuted, marginTop: 3 }}>A master order groups all products for a buyer's order</div>
              </div>
              <button onClick={() => { setShowMO(false); resetMoForm() }} style={{ background: '#f1f5f9', border: 'none', cursor: 'pointer', width: 28, height: 28, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, color: T.textMuted }}>×</button>
            </div>
            <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
              <Select label="Buyer *" value={mo.buyerId} onChange={e => setMo({ ...mo, buyerId: e.target.value })}>
                <option value="">Select buyer…</option>
                {buyerUsers.map(b => <option key={b.id} value={b.id}>{b.company} ({b.code})</option>)}
              </Select>
              <Input label="Order Name *" value={mo.orderName} onChange={e => setMo({ ...mo, orderName: e.target.value })} placeholder="e.g. H1, H26, Core Series" hint="The buyer name is added automatically wherever this shows — e.g. Cocoblu — H1." />
              <Select label="Season" value={mo.season} onChange={e => setMo({ ...mo, season: e.target.value })}>
                {SEASONS.map(s => <option key={s}>{s}</option>)}
              </Select>
              <div>
                <label style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 8 }}>PO / RFQ Attachment (optional)</label>
                <FileUpload file={moFile} onFile={f => { setMoFile(f); setMoFileErr('') }} error={moFileErr} onError={setMoFileErr} />
              </div>
              {genMoId() && (
                <div style={{ background: T.primaryLight, border: '1px solid #c7d2fe', borderRadius: 8, padding: '8px 14px' }}>
                  <div style={{ fontSize: 10, color: T.primary, fontWeight: 700, marginBottom: 2 }}>GENERATED ID</div>
                  <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 13, color: T.primaryDark }}>{genMoId()}</span>
                </div>
              )}
              {moErr && <div style={{ fontSize: 12, color: T.danger, fontWeight: 600, background: T.dangerBg, border: `1px solid ${T.dangerBorder}`, borderRadius: 8, padding: '8px 12px' }}>⚠ {moErr}</div>}
              <FlexRow justify="flex-end" gap={8}>
                <Btn variant="secondary" onClick={() => { setShowMO(false); resetMoForm() }}>Cancel</Btn>
                <Btn disabled={!mo.buyerId || !mo.orderName.trim() || moSaving} onClick={async () => {
                  const moId = genMoId()
                  if (!moId) return
                  setMoErr('')
                  setMoSaving(true)
                  try {
                    await createMasterOrder({ id: moId, buyerId: mo.buyerId, orderName: mo.orderName.trim(), season: mo.season })
                    // Upload attached file as PO/RFQ linked to this master order
                    if (moFile) {
                      try {
                        await uploadDoc({
                          type: 'PO', name: `PO — ${moId}`, issuer: '', issueDate: new Date().toISOString().slice(0, 10),
                          expiryDate: null, orderId: null, mfrId: null,
                          ...fileUploadPayload(moFile),
                        })
                      } catch { /* ignore upload errors */ }
                    }
                    toast(`Master Order ${moId} created`, 'success')
                    setShowMO(false)
                    resetMoForm()
                  } catch (err) {
                    setMoErr(typeof err === 'string' ? err : (err?.message || 'Failed to create master order'))
                  } finally { setMoSaving(false) }
                }}>{moSaving ? 'Creating…' : 'Create Master Order'}</Btn>
              </FlexRow>
            </div>
          </div>
        </div>
      )}

      <PageHeader title="Order Management" subtitle="Create styles, assign manufacturers, and manage the full order lifecycle" action={
        <FlexRow gap={8}>
          <Btn variant="secondary" onClick={() => setShowMO(true)} icon="📁">New Master Order</Btn>
          <Btn onClick={() => setShowWizard(true)} icon={<Plus size={13} />}>Create Style</Btn>
        </FlexRow>
      } />

      {/* List = one row per order, for day-to-day management. Matrix = styles
          across the top, TNA steps down the side, for "where does the whole
          book stand" at a glance — the shape of the Summary TNA sheet. */}
      <FlexRow gap={6} style={{ marginBottom: 14 }}>
        {[['list', 'List', List], ['matrix', 'Matrix', LayoutGrid]].map(([id, label, Icon]) => (
          <button key={id} onClick={() => setView(id)}
            style={{ fontSize: 12, fontWeight: 700, padding: '6px 14px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit',
              border: `1px solid ${view === id ? T.primary : T.border}`,
              background: view === id ? T.primaryLight : T.surface,
              color: view === id ? T.primaryDark : T.textMuted,
              display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Icon size={13} /> {label}
          </button>
        ))}
      </FlexRow>

      <Card pad={false}>
        <div style={{ padding: '14px 18px', borderBottom: `1px solid ${T.border}`, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {/* Search with order-ID autocomplete */}
          {(() => {
            const sugg = q.trim().length > 0
              ? orders.filter(o =>
                  o.id.toLowerCase().includes(q.toLowerCase()) ||
                  o.product.toLowerCase().includes(q.toLowerCase())
                ).slice(0, 8)
              : []
            return (
              <div style={{ flex: 1, minWidth: 200, position: 'relative' }}>
                <Search size={13} color={T.textLight} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} />
                <input
                  value={q}
                  onChange={e => { setQ(e.target.value); setShowSugg(true) }}
                  onFocus={() => setShowSugg(true)}
                  onBlur={() => setTimeout(() => setShowSugg(false), 150)}
                  placeholder="Search by product or order ID…"
                  style={{ width: '100%', boxSizing: 'border-box', border: `1px solid ${T.border}`, borderRadius: 8, padding: '7px 12px 7px 32px', fontSize: 13, color: T.text, background: '#f8fafc', fontFamily: 'inherit' }}
                />
                {showSugg && sugg.length > 0 && (
                  <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.1)', zIndex: 200, overflow: 'hidden' }}>
                    {sugg.map((o, i) => (
                      <div key={o.id}
                        onMouseDown={() => { setQ(o.id); setShowSugg(false) }}
                        style={{ padding: '9px 14px', cursor: 'pointer', borderBottom: i < sugg.length - 1 ? `1px solid ${T.border}` : 'none', display: 'flex', gap: 10, alignItems: 'center', background: 'transparent' }}
                        onMouseEnter={e => e.currentTarget.style.background = '#f8fafc'}
                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                      >
                        <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 12, color: T.primary, fontWeight: 700, whiteSpace: 'nowrap' }}>{o.id}</span>
                        <span style={{ fontSize: 12, color: T.text, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.product}</span>
                        <span style={{ fontSize: 11, color: T.textLight, whiteSpace: 'nowrap' }}>{o.buyerCompany}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })()}
          <select value={sfilt} onChange={e => setSfilt(e.target.value)}
            style={{ border: `1px solid ${T.border}`, borderRadius: 8, padding: '7px 12px', fontSize: 13, color: T.text, background: T.surface, fontFamily: 'inherit' }}>
            <option value="All">All Statuses</option>
            {ORDER_STATUSES.map(s => <option key={s}>{s}</option>)}
          </select>
        </div>
        {view === 'list' && (
        <div className="table-scroll">
          {/* 8 columns at minWidth 700 left ~87px each, so "Slim Fit Jeans" and
              "H&M Sourcing" wrapped to two lines and every row grew taller than
              its thumbnail. The wrapper already scrolls horizontally — giving the
              table its natural width is what that scroll is for. */}
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 920 }}>
            <thead>
              <tr style={{ background: '#f8fafc' }}>
                {[
                  { key: 'id', label: 'Order ID' },
                  { key: 'product', label: 'Product' },
                  { key: 'buyer', label: 'Buyer', sortable: true },
                  { key: 'manufacturer', label: 'Manufacturer(s)', sortable: true },
                  { key: 'qty', label: 'Qty' },
                  { key: 'status', label: 'Status' },
                  { key: 'delivery', label: 'Delivery', sortable: true },
                  { key: 'action', label: '' },
                ].map(h => (
                  <th key={h.key} onClick={h.sortable ? () => toggleSort(h.key) : undefined} role={h.sortable ? 'button' : undefined} tabIndex={h.sortable ? 0 : undefined} onKeyDown={h.sortable ? activateOnKey(() => toggleSort(h.key)) : undefined}
                    style={{ padding: '10px 16px', textAlign: 'left', fontSize: 10, fontWeight: 800, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.07em', whiteSpace: 'nowrap', cursor: h.sortable ? 'pointer' : 'default', userSelect: h.sortable ? 'none' : undefined }}>
                    {h.sortable ? (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 8px', borderRadius: 6, background: sortCol === h.key ? T.primaryLight : '#f1f5f9', color: sortCol === h.key ? T.primaryDark : T.textMuted, border: `1px solid ${sortCol === h.key ? '#fed7aa' : T.border}`, transition: 'all 0.15s' }}>
                        {h.label}
                        <span style={{ display: 'inline-flex', flexDirection: 'column', lineHeight: 0, gap: 0, marginLeft: -2 }}>
                          <ChevronUp size={11} color={sortCol === h.key && sortDir === 'asc' ? T.primaryDark : '#cbd5e1'} style={{ marginBottom: -3 }} />
                          <ChevronDown size={11} color={sortCol === h.key && sortDir === 'desc' ? T.primaryDark : '#cbd5e1'} />
                        </span>
                      </span>
                    ) : h.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groupedOrders.flatMap((g, gi) => {
                const collapsed = !expandedGroups.has(g.moId)
                const groupLabel = groupDisplayLabel(g)
                const spacerRow = gi > 0 ? (
                  <tr key={`sp-${g.moId}`} aria-hidden="true"><td colSpan={8} style={{ padding: 0, height: 12, border: 'none', background: T.bg }} /></tr>
                ) : null
                const headerRow = (
                  <tr key={`h-${g.moId}`} onClick={() => toggleGroup(g.moId)} role="button" tabIndex={0} onKeyDown={activateOnKey(() => toggleGroup(g.moId))} style={{ cursor: 'pointer', background: '#f1f5f9' }}>
                    <td colSpan={8} style={{ padding: '10px 16px' }}>
                      <FlexRow gap={10}>
                        <span style={{ color: T.textMuted, transition: 'transform 0.15s', transform: collapsed ? 'rotate(-90deg)' : 'none', display: 'inline-flex' }}><ChevronDown size={13} /></span>
                        <span style={{ fontSize: 13, fontWeight: 800, color: T.text, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Folder size={13} /> {groupLabel}</span>
                        {g.mo?.season && <span style={{ fontSize: 10, fontWeight: 700, color: '#0369a1', background: '#dbeafe', padding: '2px 7px', borderRadius: 4 }}>{g.mo.season}</span>}
                        <span style={{ fontSize: 11, color: T.textMuted, marginLeft: 'auto' }}>{g.orders.length} order{g.orders.length !== 1 ? 's' : ''}</span>
                      </FlexRow>
                    </td>
                  </tr>
                )
                if (collapsed) return [spacerRow, headerRow].filter(Boolean)
                const rows = g.orders.flatMap(o => {
                  const visibleAsgns = sfilt === 'All'
                    ? (o.assignments.length > 0 ? o.assignments : [null])
                    : o.assignments.filter(a => a.status === sfilt)
                  return visibleAsgns.map((a, ai) => (
                    <tr key={`${o.id}-${ai}`}
                      style={{ borderTop: `1px solid ${T.border}`, cursor: 'pointer' }}
                      onClick={() => onOpen(o.id, a?.mid)} role="button" tabIndex={0} onKeyDown={activateOnKey(() => onOpen(o.id, a?.mid))}
                      onMouseEnter={e => e.currentTarget.style.background = '#f8fafc'}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                    >
                      <td style={{ padding: '11px 16px' }}>
                        <Mono style={{ fontSize: 11 }}>{o.id}{a ? `-${a.sub}` : ''}</Mono>
                      </td>
                      <td style={{ padding: '11px 16px', fontWeight: 600, color: T.text, fontSize: 13 }}>
                        <FlexRow gap={10}><ProductThumb order={o} size="sm" onClick={e => { e.stopPropagation(); setEditTarget(o) }} />{o.product}</FlexRow>
                      </td>
                      <td style={{ padding: '11px 16px', color: T.textMuted, fontSize: 13 }}>{o.buyerCompany || '—'}</td>
                      <td style={{ padding: '11px 16px' }}>
                        {a ? (
                          <span style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{a.mfrCompany || '—'}</span>
                        ) : <span style={{ fontSize: 11, fontWeight: 800, color: T.textLight, letterSpacing: '0.04em' }}>TBD</span>}
                      </td>
                      <td style={{ padding: '11px 16px', color: T.textMuted, fontSize: 13 }}>{a ? a.qty?.toLocaleString() : o.totalQty?.toLocaleString()}</td>
                      <td style={{ padding: '11px 16px' }}>{a ? <Badge status={a.status} /> : <span style={{ fontSize: 11, fontWeight: 800, color: T.textLight, letterSpacing: '0.04em' }}>TBD</span>}</td>
                      <td style={{ padding: '11px 16px', color: T.textMuted, fontSize: 13 }}>
                        <FlexRow gap={5}>
                          {fmtDate(o.delivery)}
                          {typeof o.deliveryVarianceDays === 'number' && o.deliveryVarianceDays !== 0 && (
                            <span
                              title={`Originally promised ${fmtDate(o.baselineDelivery)}`}
                              style={{ fontSize: 10, fontWeight: 800, color: o.deliveryVarianceDays > 0 ? T.danger : T.success }}
                            >
                              {o.deliveryVarianceDays > 0 ? '+' : ''}{o.deliveryVarianceDays}d
                            </span>
                          )}
                        </FlexRow>
                      </td>
                      <td style={{ padding: '11px 16px' }}>
                        <FlexRow gap={6}>
                          <Btn size="sm" onClick={(e) => { e.stopPropagation(); onOpen(o.id, a?.mid) }}>Manage <ArrowRight size={12} style={{ marginLeft: -2 }} /></Btn>
                          <Btn size="sm" variant="secondary" onClick={(e) => { e.stopPropagation(); setEditTarget(o) }}>Edit</Btn>
                          <button
                            onClick={(e) => { e.stopPropagation(); setDeleteTarget(o) }}
                            style={{ padding: '4px 10px', fontSize: 11, fontWeight: 700, borderRadius: 6, border: `1px solid ${T.dangerBorder}`, background: T.dangerBg, color: T.danger, cursor: 'pointer', fontFamily: 'inherit' }}
                          >Delete</button>
                        </FlexRow>
                      </td>
                    </tr>
                  ))
                })
                return [spacerRow, headerRow, ...rows].filter(Boolean)
              })}
              {filtered.length === 0 && <tr><td colSpan={8}><EmptyState icon={<Package size={26} color={T.textLight} />} title="No orders" desc="Create your first order above" /></td></tr>}
            </tbody>
          </table>
        </div>
        )}

        {view === 'matrix' && (
          // No standalone legend here — it's the one thing List doesn't have,
          // so it made switching views feel like landing on a different page.
          // Each cell's state is still named in its hover tooltip; the color
          // is a glanceable summary of exactly that.
          <div style={{ padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>

            {groupedOrders.length === 0 && <EmptyState icon={<Package size={26} color={T.textLight} />} title="No orders" desc="Create your first order above" />}

            {groupedOrders.map(g => {
              // Earliest delivery first — the style due soonest is the one that
              // most needs eyes, so it belongs leftmost, not wherever it happened
              // to land in creation order.
              // A style with no manufacturer yet still needs its own column —
              // asgn: null — so it isn't invisible in the matrix while TBD.
              const entries = g.orders.flatMap(o => (o.assignments || []).length > 0
                ? o.assignments.map(a => ({ order: o, asgn: a }))
                : [{ order: o, asgn: null }])
                .sort((x, y) => {
                  const dx = x.order.delivery ? new Date(x.order.delivery).getTime() : Infinity
                  const dy = y.order.delivery ? new Date(y.order.delivery).getTime() : Infinity
                  return dx - dy
                })
              if (entries.length === 0) return null
              const spine = buildMatrixSpine(entries)
              const groupLabel = groupDisplayLabel(g)
              const isOpen = expandedGroups.has(g.moId)
              return (
                <div key={g.moId} style={{ border: `1px solid ${T.border}`, borderRadius: 10, overflow: 'hidden' }}>
                  <FlexRow gap={10} onClick={() => toggleGroup(g.moId)}
                    style={{ padding: '9px 14px', background: '#f1f5f9', cursor: 'pointer' }}>
                    <span style={{ color: T.textMuted, transform: isOpen ? 'none' : 'rotate(-90deg)', display: 'inline-flex' }}><ChevronDown size={13} /></span>
                    <span style={{ fontSize: 13, fontWeight: 800, color: T.text, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Folder size={13} /> {groupLabel}</span>
                    {g.mo?.season && <span style={{ fontSize: 10, fontWeight: 700, color: '#0369a1', background: '#dbeafe', padding: '1px 7px', borderRadius: 4 }}>{g.mo.season}</span>}
                    <span style={{ fontSize: 11, color: T.textMuted, marginLeft: 'auto' }}>{entries.length} style{entries.length !== 1 ? 's' : ''} · {spine.length} steps</span>
                  </FlexRow>

                  {isOpen && (
                    <div className="table-scroll">
                      <table style={{ borderCollapse: 'collapse', minWidth: 340 + entries.length * 150 }}>
                        <thead>
                          <tr style={{ background: '#f8fafc' }}>
                            <th style={{ padding: '9px 14px', textAlign: 'left', fontSize: 10, fontWeight: 800, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.07em', position: 'sticky', left: 0, zIndex: 2, background: '#f8fafc', minWidth: 220 }}>
                              Step
                            </th>
                            {entries.map(({ order, asgn }) => (
                              <th key={`${order.id}-${asgn?.mid ?? 'unassigned'}`} onClick={() => onOpen(order.id, asgn?.mid)} role="button" tabIndex={0} onKeyDown={activateOnKey(() => onOpen(order.id, asgn?.mid))}
                                title={`${order.product} — ${order.id}${asgn ? '' : ' (no manufacturer assigned yet)'}`}
                                style={{ padding: '9px 10px', textAlign: 'left', minWidth: 150, cursor: 'pointer', borderLeft: `1px solid ${T.border}` }}>
                                <FlexRow gap={6}>
                                  <ProductThumb order={order} size="sm" />
                                  <div style={{ minWidth: 0 }}>
                                    <div style={{ fontSize: 11, fontWeight: 700, color: T.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 110 }}>
                                      {order.product}
                                    </div>
                                    {asgn
                                      ? <Mono style={{ fontSize: 9 }}>{asgn.qty?.toLocaleString()} pcs</Mono>
                                      : <span style={{ fontSize: 9, fontWeight: 800, color: T.textLight, letterSpacing: '0.04em' }}>TBD</span>}
                                  </div>
                                </FlexRow>
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {spine.map((step, ri) => {
                            const key = step.toLowerCase()
                            return (
                              <tr key={step} style={{ borderTop: `1px solid ${T.border}` }}>
                                <td style={{ padding: '7px 14px', fontSize: 12, fontWeight: 600, color: T.text, position: 'sticky', left: 0, zIndex: 1, background: T.surface, whiteSpace: 'nowrap' }}>
                                  <span style={{ color: T.textLight, fontSize: 10, marginRight: 6 }}>{ri + 1}</span>{step}
                                </td>
                                {entries.map(({ order, asgn }) => {
                                  const stageIdx = (asgn?.stages || []).findIndex(s => s.name.trim().toLowerCase() === key)
                                  const stage = stageIdx >= 0 ? asgn.stages[stageIdx] : null
                                  const state = cellState(stage)
                                  const st = state ? CELL_STATE[state] : null
                                  const planVariance = stage ? stageVariance(stage) : null
                                  const actualVariance = stage ? stageActualVariance(stage) : null
                                  // Once a stage is done, the story shifts from "did the plan move"
                                  // to "did we hit it" — show actualEnd against eta instead of eta
                                  // against baseline. isStageDone (not just state==='done') so this
                                  // also covers blocked-but-done edge cases the same way.
                                  const done = stage && isStageDone(stage) && stage.actualEnd
                                  const variance = done ? actualVariance : planVariance
                                  // Everything trimmed from the visible cell (start date, planned
                                  // vs revised, exact progress) lives in the hover tooltip instead —
                                  // full detail on hover, nothing lost. A CUSTOM tooltip, not the
                                  // native `title` attribute: browsers delay `title` by ~1s and it's
                                  // easy to move off the cell before it ever appears.
                                  const tipLines = stage ? [
                                    `${step} — ${st.label}`,
                                    `Start: ${fmtStageDate(stage.startDate)}`,
                                    `Planned: ${fmtStageDate(stage.baselineEta)}  →  Revised: ${stage.eta && stage.eta === stage.baselineEta ? 'NA' : fmtStageDate(stage.eta)}${planVariance != null && planVariance !== 0 ? `  (${planVariance > 0 ? '+' : ''}${planVariance}d)` : ''}`,
                                    `Actual: ${fmtStageDate(stage.actualEnd)}${actualVariance != null && actualVariance !== 0 ? `  (${actualVariance > 0 ? '+' : ''}${actualVariance}d vs plan)` : ''}`,
                                    `Progress: ${stageProgressLabel(stage)}`,
                                    stage.blockedReason ? `Blocked: ${stage.blockedReason}` : null,
                                  ].filter(Boolean) : null
                                  return (
                                    <td key={`${order.id}-${asgn?.mid ?? 'unassigned'}`} onClick={() => stage && setQuickStage({ orderId: order.id, mfrId: asgn.mid, stageIndex: stageIdx })} role={stage ? 'button' : undefined} tabIndex={stage ? 0 : undefined} onKeyDown={stage ? activateOnKey(() => setQuickStage({ orderId: order.id, mfrId: asgn.mid, stageIndex: stageIdx })) : undefined}
                                      onMouseEnter={e => tipLines && showMatrixTip(e.clientX, e.clientY, tipLines)}
                                      onMouseMove={e => tipLines && setMatrixTip(tip => tip && { ...tip, x: e.clientX, y: e.clientY })}
                                      onMouseLeave={hideMatrixTip}
                                      style={{ padding: '5px 8px', borderLeft: `1px solid ${T.border}`, cursor: stage ? 'pointer' : 'default', verticalAlign: 'top' }}>
                                      {!stage ? (
                                        <span style={{ fontSize: 11, color: '#cbd5e1' }}>{asgn ? 'NA' : 'TBD'}</span>
                                      ) : (
                                        <div style={{ background: st.bg, borderRadius: 5, padding: '4px 7px' }}>
                                          {/* The date is what answers "where are things" — primary and
                                              legible. Units/percent are secondary, kept small below;
                                              raw counts aren't shown at all (only on hover). */}
                                          <FlexRow gap={5} style={{ justifyContent: 'space-between' }}>
                                            <span style={{ fontSize: 12, fontWeight: 800, color: st.fg, whiteSpace: 'nowrap', fontFamily: "'JetBrains Mono',monospace" }}>
                                              {state === 'done' ? <Check size={10} strokeWidth={3} style={{ verticalAlign: -1 }} /> : state === 'blocked' ? <Ban size={10} style={{ verticalAlign: -1 }} /> : state === 'overdue' ? <AlertTriangle size={10} style={{ verticalAlign: -1 }} /> : ''} {fmtStageDate(done ? stage.actualEnd : effectiveEta(stage))}
                                            </span>
                                            {variance != null && variance !== 0 && (
                                              <span style={{ fontSize: 9, fontWeight: 800, color: variance > 0 ? '#b91c1c' : '#047857', whiteSpace: 'nowrap' }}>
                                                {variance > 0 ? '+' : ''}{variance}d
                                              </span>
                                            )}
                                          </FlexRow>
                                          <div style={{ fontSize: 9, color: st.fg, opacity: 0.75, marginTop: 1 }}>
                                            {stagePct(stage)}%
                                          </div>
                                        </div>
                                      )}
                                    </td>
                                  )
                                })}
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </Card>

      {/* Custom matrix-cell tooltip — position: fixed so it's never clipped by
          the scrolling table, and pointer-events: none so it can't itself
          become the mouseleave target. */}
      {matrixTip && (
        <div style={{
          position: 'fixed', left: matrixTip.x + 14, top: matrixTip.y + 16, zIndex: 1000,
          pointerEvents: 'none', background: '#1e293b', color: '#f1f5f9', borderRadius: 8,
          padding: '8px 12px', fontSize: 11, lineHeight: 1.6, whiteSpace: 'pre',
          boxShadow: '0 8px 24px rgba(0,0,0,0.25)', maxWidth: 320,
        }}>
          {matrixTip.lines.join('\n')}
        </div>
      )}

      {quickStage && (
        <QuickStageModal
          orderId={quickStage.orderId} mfrId={quickStage.mfrId} stageIndex={quickStage.stageIndex}
          onClose={() => setQuickStage(null)} onOpenOrder={onOpen}
        />
      )}
    </div>
  )
}
