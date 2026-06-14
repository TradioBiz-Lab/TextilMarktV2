import { useState, useMemo } from 'react'
import { T, DOC_TYPES, DOC_ICONS, getToday, isExpiringSoon, isExpired } from '../../constants.js'
import { Card, EmptyState, DocCard, PageHeader, LoadingScreen, StageDocGroup } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'
const COMPLIANCE_TYPES = ['compliance_cert', 'factory_audit', 'chemical_cert', 'environmental_cert', 'insurance']

function fmtDate(d) {
  if (!d) return '—'
  const dt = new Date(d)
  return `${String(dt.getDate()).padStart(2, '0')}-${String(dt.getMonth() + 1).padStart(2, '0')}-${dt.getFullYear()}`
}

function OrderGroup({ order, docs, users, getDocData }) {
  const [open, setOpen] = useState(false)
  const isGeneral = !order.id

  const hasStageDocs = docs.some(d => d.stageIndex != null)
  const mfrs = order.assignments || []

  const statusMap = { 'Processing': { bg: '#dbeafe', c: '#1d4ed8' }, 'Delayed': { bg: '#fee2e2', c: '#b91c1c' }, 'On Hold': { bg: '#f1f5f9', c: '#475569' }, 'Delivered': { bg: '#dcfce7', c: '#15803d' } }
  const overallStatus = () => {
    if (mfrs.some(a => a.status === 'Delayed')) return 'Delayed'
    if (mfrs.some(a => a.status === 'On Hold')) return 'On Hold'
    if (mfrs.every(a => a.status === 'Delivered')) return 'Delivered'
    return 'Processing'
  }
  const st = isGeneral ? null : (statusMap[overallStatus()] || { bg: '#f1f5f9', c: '#64748b' })

  return (
    <div style={{ border: `1px solid ${open && !isGeneral ? T.primary + '44' : T.border}`, borderRadius: 12, overflow: 'hidden', transition: 'border-color 0.15s' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{ width: '100%', border: 'none', cursor: 'pointer', fontFamily: 'inherit', padding: '11px 16px', background: open && !isGeneral ? T.primaryLight : '#f8fafc', display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left', transition: 'background 0.15s' }}
      >
        <span style={{ fontSize: 13, color: open ? T.primary : T.textMuted, transition: 'transform 0.15s', display: 'inline-block', transform: open ? 'rotate(90deg)' : 'rotate(0deg)', flexShrink: 0 }}>›</span>

        {isGeneral ? (
          <span style={{ fontSize: 12, fontWeight: 700, color: T.text, flex: 1 }}>📁 General Documents</span>
        ) : (
          <>
            <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 12, fontWeight: 800, color: T.primary, whiteSpace: 'nowrap' }}>{order.id}</span>
            <span style={{ fontSize: 12, fontWeight: 600, color: T.text, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{order.product}</span>
            {order.season && <span style={{ fontSize: 10, fontWeight: 700, color: '#0369a1', background: '#dbeafe', padding: '1px 6px', borderRadius: 4, flexShrink: 0 }}>{order.season}</span>}
            {st && <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 10, background: st.bg, color: st.c, flexShrink: 0 }}>{overallStatus()}</span>}
          </>
        )}

        <span style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, background: '#e2e8f0', padding: '1px 8px', borderRadius: 10, flexShrink: 0 }}>{docs.length}</span>
      </button>

      {open && (
        <div style={{ padding: '10px 12px', borderTop: `1px solid ${T.border}`, background: T.surface, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {hasStageDocs && !isGeneral
            ? <StageDocGroup docs={docs} stages={mfrs[0]?.stages || []} users={users} onGetData={getDocData} mfrLabel={mfrs.length > 1 ? null : mfrs[0]?.mfrCompany} />
            : docs.map(d => <DocCard key={d.id} doc={d} users={users} onGetData={getDocData} />)
          }
        </div>
      )}
    </div>
  )
}

export function BuyerDocuments() {
  const { orders, docs, currentUser: user, users, loading, getDocData, loadError } = useApp()
  const [filt, setFilt] = useState('all')

  if (loading) return <LoadingScreen />

  const myOrders = useMemo(() => orders.filter(o => String(o.buyerId) === String(user.id)), [orders, user])
  const myOrderIds = useMemo(() => new Set(myOrders.map(o => String(o.id))), [myOrders])
  const myMfrIds = useMemo(() => new Set(myOrders.flatMap(o => (o.assignments || []).map(a => String(a.mid)))), [myOrders])
  const myDocs = useMemo(() => docs.filter(d =>
    d.isActive !== false && (
      (d.orderId && myOrderIds.has(String(d.orderId))) ||
      // mfrId match only for docs without an orderId — avoids including another buyer's order docs
      (d.mfrId && myMfrIds.has(String(d.mfrId)) && !d.orderId) ||
      String(d.uploadedBy) === String(user.id)
    )
  ), [docs, myOrderIds, myMfrIds, user.id])

  // For non-all filters — flat filtered list
  const filteredFlat = useMemo(() => filt === 'all' ? myDocs
    : filt === 'compliance' ? myDocs.filter(d => COMPLIANCE_TYPES.includes(d.type))
    : myDocs.filter(d => d.type === filt), [myDocs, filt])

  // Buyer Docs = requirement docs uploaded by this buyer (Submit Requirement flow)
  const buyerDocs = useMemo(
    () => myDocs.filter(d => String(d.uploadedBy) === String(user.id)),
    [myDocs, user.id]
  )

  // For "all" — group by order, excluding the buyer's own submissions (they live in Buyer Docs)
  const orderGroups = useMemo(() => {
    if (filt !== 'all') return null
    const buyerDocIds = new Set(buyerDocs.map(d => d.id))
    const groups = {}
    for (const d of myDocs) {
      if (buyerDocIds.has(d.id)) continue
      const key = d.orderId || '__none__'
      if (!groups[key]) groups[key] = []
      groups[key].push(d)
    }
    return groups
  }, [myDocs, filt, buyerDocs])

  const ordersWithDocCount = useMemo(
    () => myOrders.filter(o => myDocs.some(d => String(d.orderId) === String(o.id))).length,
    [myOrders, myDocs]
  )

  const counts = useMemo(() => ({
    all: myDocs.length,
    PO: myDocs.filter(d => d.type === 'PO').length,
    tech_pack: myDocs.filter(d => d.type === 'tech_pack').length,
    cost_sheet: myDocs.filter(d => d.type === 'cost_sheet').length,
    compliance: myDocs.filter(d => COMPLIANCE_TYPES.includes(d.type)).length,
  }), [myDocs])

  const filters = [
    { v: 'all',        l: 'All',        icon: '📁' },
    { v: 'PO',         l: 'Purchase Orders', icon: '📋' },
    { v: 'tech_pack',  l: 'Tech Packs', icon: '📐' },
    { v: 'cost_sheet', l: 'Cost Sheets', icon: '💰' },
    { v: 'compliance', l: 'Compliance', icon: '🛡' },
  ]

  if (loadError) return (
    <Card><EmptyState icon="⚠️" title="Could not load documents" desc="Check your connection and refresh the page." /></Card>
  )

  return (
    <div>
      <PageHeader
        title="Documents"
        subtitle={`${myDocs.length} document${myDocs.length !== 1 ? 's' : ''} across ${ordersWithDocCount} order${ordersWithDocCount !== 1 ? 's' : ''}`}
      />

      {/* Filter pills */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
        {filters.map(f => {
          const cnt = counts[f.v]
          if (cnt === 0 && f.v !== 'all') return null
          const active = filt === f.v
          return (
            <button key={f.v} onClick={() => setFilt(f.v)}
              style={{
                display: 'flex', alignItems: 'center', gap: 5,
                padding: '5px 14px', borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                fontFamily: 'inherit', transition: 'all 0.15s',
                background: active ? T.primary : T.surface,
                color: active ? '#fff' : T.textMuted,
                border: active ? 'none' : `1px solid ${T.border}`,
                boxShadow: active ? `0 2px 8px ${T.primary}40` : 'none',
              }}>
              <span>{f.icon}</span>
              <span>{f.l}</span>
              <span style={{
                fontSize: 10, fontWeight: 800, marginLeft: 2,
                background: active ? 'rgba(255,255,255,0.25)' : '#f1f5f9',
                color: active ? '#fff' : T.textMuted,
                borderRadius: 10, padding: '0 6px',
              }}>{cnt}</span>
            </button>
          )
        })}
      </div>

      {/* ── ALL: grouped by order ── */}
      {filt === 'all' && orderGroups && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {myDocs.length === 0 && (
            <Card><EmptyState icon="📁" title="No documents yet" desc="Documents for your orders will appear here" /></Card>
          )}

          {/* Buyer Docs — requirement documents you submitted */}
          {buyerDocs.length > 0 && (
            <OrderGroup
              key="__buyer_docs__"
              order={{ id: null, product: '📥 Buyer Docs — Your Submissions', delivery: null, assignments: [] }}
              docs={buyerDocs}
              users={users}
              getDocData={getDocData}
            />
          )}

          {/* General docs (admin/mfr uploads not attached to a specific order) */}
          {orderGroups['__none__']?.length > 0 && (
            <OrderGroup
              key="__none__"
              order={{ id: null, product: 'General Documents', delivery: null, assignments: [] }}
              docs={orderGroups['__none__']}
              users={users}
              getDocData={getDocData}
            />
          )}

          {/* Order groups — collapsed by default */}
          {myOrders
            .filter(o => orderGroups[o.id]?.length > 0)
            .map(o => (
              <OrderGroup
                key={o.id}
                order={o}
                docs={orderGroups[o.id]}
                users={users}
                getDocData={getDocData}
              />
            ))
          }
        </div>
      )}

      {/* ── FILTERED: flat list ── */}
      {filt !== 'all' && (
        <div>
          {filteredFlat.length === 0
            ? <Card><EmptyState icon="📁" title="No documents" desc={`No ${filters.find(f => f.v === filt)?.l.toLowerCase()} documents found`} /></Card>
            : <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                {filteredFlat.map(d => <DocCard key={d.id} doc={d} users={users} onGetData={getDocData} />)}
              </div>
          }
        </div>
      )}
    </div>
  )
}
