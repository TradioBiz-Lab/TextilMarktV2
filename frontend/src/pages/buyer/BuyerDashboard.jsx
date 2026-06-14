import { useState, useMemo } from 'react'
import { T, ORDER_STATUSES, getToday, isExpiringSoon, isExpired } from '../../constants.js'
import { Badge, Card, EmptyState, Mono, Btn, LoadingScreen, MfrProfileLink } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'
import { ordersApi } from '../../api.js'

// 4-value order-level status
function orderStatus(o) {
  const asgns = o.assignments || []
  if (asgns.length === 0) return 'Processing'
  if (asgns.some(a => a.status === 'Delayed'))    return 'Delayed'
  if (asgns.some(a => a.status === 'On Hold'))    return 'On Hold'
  if (asgns.every(a => a.status === 'Delivered')) return 'Delivered'
  return 'Processing'
}


function isOverdue(o) {
  return new Date(o.delivery) < new Date(getToday()) && orderStatus(o) !== 'Delivered'
}

function fmtDate(d) {
  if (!d) return '—'
  const dt = new Date(d)
  const dd = String(dt.getDate()).padStart(2, '0')
  const mm = String(dt.getMonth() + 1).padStart(2, '0')
  return `${dd}-${mm}-${dt.getFullYear()}`
}

function EscalateModal({ order, onClose, onSuccess }) {
  const [reason, setReason]   = useState('')
  const [loading, setLoading] = useState(false)
  const [err, setErr]         = useState(null)

  async function submit() {
    if (!reason.trim()) { setErr('Please describe the issue before escalating.'); return }
    setLoading(true); setErr(null)
    try {
      await ordersApi.escalate(order.id, reason.trim())
      onSuccess()
    } catch (e) {
      setErr(typeof e === 'string' ? e : 'Escalation failed. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 900, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.45)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{ background: T.surface, borderRadius: 14, width: 480, maxWidth: '92vw', boxShadow: '0 24px 60px rgba(0,0,0,0.18)' }}>
        <div style={{ padding: '20px 24px', borderBottom: `1px solid ${T.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: T.text }}>🚨 Escalate Order</div>
            <div style={{ fontSize: 12, color: T.textMuted, marginTop: 3 }}>
              <Mono style={{ fontSize: 12 }}>{order.id}</Mono> · {order.product}
            </div>
          </div>
          <button onClick={onClose} style={{ background: '#f1f5f9', border: 'none', cursor: 'pointer', width: 28, height: 28, borderRadius: 6, fontSize: 16, color: T.textMuted, marginTop: 1 }}>×</button>
        </div>
        <div style={{ padding: '20px 24px' }}>
          <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 12, lineHeight: 1.6 }}>
            This will alert all master admins immediately. Describe the issue so they can act quickly.
          </div>
          <div style={{ fontSize: 12, fontWeight: 600, color: T.text, marginBottom: 6 }}>
            Reason <span style={{ color: T.danger }}>*</span>
          </div>
          <textarea
            value={reason}
            onChange={e => { setReason(e.target.value); setErr(null) }}
            rows={4}
            placeholder="e.g. Raw material shortage, missed milestone, no update from manufacturer…"
            style={{ width: '100%', border: `1px solid ${err ? T.danger : T.border}`, borderRadius: 8, padding: '10px 12px', fontSize: 13, color: T.text, fontFamily: 'inherit', resize: 'vertical', boxSizing: 'border-box', outline: 'none' }}
          />
          {err && <div style={{ fontSize: 12, color: T.danger, marginTop: 5 }}>{err}</div>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
            <Btn variant="secondary" onClick={onClose} disabled={loading}>Cancel</Btn>
            <Btn
              onClick={submit}
              disabled={loading || !reason.trim()}
              style={{ background: '#dc2626', color: '#fff', border: 'none' }}
            >
              {loading ? 'Sending…' : '🚨 Escalate to Admin'}
            </Btn>
          </div>
        </div>
      </div>
    </div>
  )
}

export function BuyerDashboard({ onOpen, onSubmitReq }) {
  const { orders, docs, currentUser, loading, loadError, getDocData } = useApp()
  const [q,             setQ]             = useState('')
  const [sf,            setSf]            = useState('All')
  const [showSugg,      setShowSugg]      = useState(false)
  const [escalateOrder, setEscalateOrder] = useState(null)
  const [escalatedIds, setEscalatedIds] = useState(() => new Set())

  const addEscalated = id => setEscalatedIds(prev => new Set([...prev, id]))

  const myOrders = useMemo(
    () => (orders || []).filter(o => String(o.buyerId) === String(currentUser?.id)),
    [orders, currentUser]
  )

  const myTxns = useMemo(() => {
    return myOrders.flatMap(o => {
      const asgns = o.assignments || []
      if (asgns.length === 0) return [{ order: o, mfr: null, status: 'Processing' }]
      return asgns.map(a => ({ order: o, mfr: a, status: a.status }))
    })
  }, [myOrders])

  // ── Stats ──
  const stats = useMemo(() => {
    const total = myTxns.length
    const delayed = myTxns.filter(t => t.status === 'Delayed').length
    const onHold = myTxns.filter(t => t.status === 'On Hold').length
    const delivered = myTxns.filter(t => t.status === 'Delivered').length
    const processing = myTxns.filter(t => t.status === 'Processing').length
    const overdue = myTxns.filter(t => new Date(t.order.delivery) < new Date(getToday()) && t.status !== 'Delivered').length
    const onTime = myTxns.filter(t => t.status === 'Processing' && !(new Date(t.order.delivery) < new Date(getToday()))).length

    const myOrderIds = new Set(myOrders.map(o => o.id))
    const myMfrIds = new Set(myOrders.flatMap(o => (o.assignments || []).map(a => String(a.mid))))
    const myDocs = (docs || []).filter(d =>
      d.isActive !== false && (
        (d.orderId && myOrderIds.has(String(d.orderId))) ||
        (d.mfrId && myMfrIds.has(String(d.mfrId)) && !d.orderId)
      )
    )
    const certsExpired = myDocs.filter(d => d.expiryDate && isExpired(d.expiryDate)).length
    const certsExpiring = myDocs.filter(d => d.expiryDate && isExpiringSoon(d.expiryDate) && !isExpired(d.expiryDate)).length

    return { total, delayed, onHold, delivered, processing, overdue, onTime, certsExpired, certsExpiring }
  }, [myTxns, myOrders, docs, currentUser])

  const suggestions = useMemo(() => {
    if (!q || q.length < 1) return []
    const m = q.toLowerCase()
    return myOrders
      .filter(o => o.id.toLowerCase().includes(m) || o.product.toLowerCase().includes(m))
      .slice(0, 8)
  }, [myOrders, q])


  const filtered = useMemo(() => {
    const m = q.toLowerCase()
    return myTxns.filter(t => {
      const matchQ  = !q || t.order.id.toLowerCase().includes(m) || t.order.product.toLowerCase().includes(m)
      const matchSf = sf === 'All' || t.status === sf
      return matchQ && matchSf
    })
  }, [myTxns, q, sf])

  if (loading) return <LoadingScreen />

  if (loadError) return (
    <Card>
      <EmptyState icon="⚠️" title="Could not load orders" desc="Check your connection and refresh the page. If the problem persists, contact support." />
    </Card>
  )

  // Order health summary
  const healthPct = stats.total > 0 ? Math.round((stats.delivered / stats.total) * 100) : 0
  const atRiskCount = stats.delayed + stats.overdue + stats.onHold

  return (
    <div>
      {/* ── Welcome Header ── */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 22, fontWeight: 800, color: T.text, letterSpacing: '-0.02em', lineHeight: 1.2 }}>
          Welcome back, {currentUser?.name?.split(' ')[0] || 'there'}
        </div>
        <div style={{ fontSize: 13, color: T.textMuted, marginTop: 4 }}>
          {currentUser?.company || 'Your'} order management hub — monitor production, compliance, and deliveries
        </div>
      </div>

      {/* ── Submit Requirement Banner ── */}
      <div
        onClick={onSubmitReq}
        style={{ background: 'linear-gradient(135deg, #003B73 0%, #0a4f8a 100%)', borderRadius: 14, padding: '20px 26px', marginBottom: 24, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, transition: 'transform 0.15s, box-shadow 0.15s', position: 'relative', overflow: 'hidden' }}
        onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = '0 8px 28px rgba(0,59,115,0.3)' }}
        onMouseLeave={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = 'none' }}
      >
        <div style={{ position: 'absolute', top: -30, right: -30, width: 140, height: 140, borderRadius: '50%', background: 'rgba(255,255,255,0.04)' }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, zIndex: 1 }}>
          <div style={{ width: 42, height: 42, borderRadius: 10, background: 'rgba(255,255,255,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontSize: 22, lineHeight: 1 }}>📋</span>
          </div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#fff' }}>Submit a New Requirement</div>
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)', marginTop: 2 }}>Upload RFQ, Tech Pack, or Buyer Order</div>
          </div>
        </div>
        <div style={{ background: 'rgba(255,255,255,0.15)', borderRadius: 8, padding: '7px 16px', fontSize: 13, fontWeight: 700, color: '#fff', whiteSpace: 'nowrap', zIndex: 1 }}>Get Started →</div>
      </div>

      {/* ── Hero Stat Tiles ── */}
      <div className="hero-tiles">
        {[
          { value: stats.delivered, label: 'Delivered', icon: '✅', color: T.success, bg: T.successBg, border: T.successBorder },
          { value: stats.processing, label: 'In Production', icon: '🏭', color: '#1d4ed8', bg: '#dbeafe', border: '#bfdbfe' },
          { value: stats.delayed,   label: 'Delayed',   icon: '⚠️', color: T.danger,  bg: T.dangerBg, border: T.dangerBorder },
          { value: stats.onHold,    label: 'On Hold',   icon: '⏸️', color: '#92400e', bg: '#fffbeb', border: '#fde68a' },
        ].map(s => (
          <div key={s.label} style={{ background: s.bg, border: `1px solid ${s.border}`, borderRadius: 14, padding: '18px 20px' }}>
            <div style={{ fontSize: 22, marginBottom: 6 }}>{s.icon}</div>
            <div style={{ fontSize: 32, fontWeight: 800, color: s.color, lineHeight: 1 }}>{s.value}</div>
            <div style={{ fontSize: 12, fontWeight: 600, color: s.color, marginTop: 4, opacity: 0.8 }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* ── Delivery progress bar + Alerts ── */}
      <div className="grid-responsive-2" style={{ gap: 16, marginBottom: 24 }}>
        {/* Left: Order Health Summary */}
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 14, padding: '22px 24px' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 16 }}>Order Health</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 14 }}>
            <span style={{ fontSize: 36, fontWeight: 800, color: T.text, lineHeight: 1 }}>{stats.total}</span>
            <span style={{ fontSize: 13, color: T.textMuted }}>total orders</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: T.success, flexShrink: 0 }} />
              <span style={{ fontSize: 13, color: T.text }}><b>{stats.delivered}</b> Delivered</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#3b82f6', flexShrink: 0 }} />
              <span style={{ fontSize: 13, color: T.text }}><b>{stats.processing}</b> In Production</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#f59e0b', flexShrink: 0 }} />
              <span style={{ fontSize: 13, color: T.text }}><b>{stats.onHold}</b> On Hold</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: T.danger, flexShrink: 0 }} />
              <span style={{ fontSize: 13, color: T.text }}><b>{stats.delayed}</b> Delayed</span>
            </div>
          </div>
          {stats.total > 0 && (
            <div style={{ marginTop: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
                <span style={{ fontSize: 11, color: T.textMuted }}>Delivery completion</span>
                <span style={{ fontSize: 11, fontWeight: 700, color: healthPct >= 70 ? T.success : healthPct >= 40 ? '#f59e0b' : T.textMuted }}>{healthPct}%</span>
              </div>
              <div style={{ height: 6, borderRadius: 3, background: '#f1f5f9', overflow: 'hidden' }}>
                <div style={{ height: '100%', borderRadius: 3, width: `${healthPct}%`, background: healthPct >= 70 ? T.success : healthPct >= 40 ? '#f59e0b' : '#94a3b8', transition: 'width 0.4s ease' }} />
              </div>
            </div>
          )}
        </div>

        {/* Right: Alerts & Certificates */}
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 14, padding: '22px 24px' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 16 }}>Alerts & Compliance</div>
          {atRiskCount === 0 && stats.certsExpired === 0 && stats.certsExpiring === 0 ? (
            <div style={{ textAlign: 'center', padding: '20px 0' }}>
              <span style={{ fontSize: 28 }}>✅</span>
              <div style={{ fontSize: 14, fontWeight: 700, color: T.success, marginTop: 8 }}>All Clear</div>
              <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>No alerts or compliance issues</div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {stats.overdue > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#fef2f2', borderRadius: 8, padding: '10px 14px' }}>
                  <span style={{ fontSize: 16 }}>🚨</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#b91c1c' }}>{stats.overdue} order{stats.overdue > 1 ? 's' : ''} overdue</div>
                    <div style={{ fontSize: 11, color: T.textMuted }}>Past delivery date — escalate or follow up</div>
                  </div>
                </div>
              )}
              {stats.delayed > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#fef2f2', borderRadius: 8, padding: '10px 14px' }}>
                  <span style={{ fontSize: 16 }}>⚠️</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: T.danger }}>{stats.delayed} order{stats.delayed > 1 ? 's' : ''} delayed</div>
                    <div style={{ fontSize: 11, color: T.textMuted }}>Behind schedule — review progress</div>
                  </div>
                </div>
              )}
              {stats.certsExpired > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#fef2f2', borderRadius: 8, padding: '10px 14px' }}>
                  <span style={{ fontSize: 16 }}>🛡</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: T.danger }}>{stats.certsExpired} cert{stats.certsExpired > 1 ? 's' : ''} expired</div>
                    <div style={{ fontSize: 11, color: T.textMuted }}>Contact manufacturer to renew</div>
                  </div>
                </div>
              )}
              {stats.certsExpiring > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#fffbeb', borderRadius: 8, padding: '10px 14px' }}>
                  <span style={{ fontSize: 16 }}>⏳</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#92400e' }}>{stats.certsExpiring} cert{stats.certsExpiring > 1 ? 's' : ''} expiring soon</div>
                    <div style={{ fontSize: 11, color: T.textMuted }}>Within 30 days</div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Orders Section Header + Search/Filter ── */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: T.text, letterSpacing: '-0.02em' }}>My Orders</div>
          <span style={{ fontSize: 12, color: T.textMuted, fontWeight: 600 }}>
            {myTxns.length} order{myTxns.length !== 1 ? 's' : ''}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{ position: 'relative', flex: 1 }}>
            <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: 13, color: T.textLight, pointerEvents: 'none', zIndex: 1 }}>🔍</span>
            <input
              value={q}
              onChange={e => { setQ(e.target.value); setShowSugg(true) }}
              onFocus={() => setShowSugg(true)}
              onBlur={() => setTimeout(() => setShowSugg(false), 150)}
              placeholder="Search by order ID or product…"
              style={{ width: '100%', border: `1px solid ${T.border}`, borderRadius: 9, padding: '9px 14px 9px 36px', fontSize: 13, color: T.text, background: T.surface, fontFamily: 'inherit', boxSizing: 'border-box' }}
            />
            {showSugg && suggestions.length > 0 && (
              <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 200, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.12)', marginTop: 3, overflow: 'hidden' }}>
                {suggestions.map(o => (
                  <div
                    key={o.id}
                    onMouseDown={() => { setQ(o.id); setShowSugg(false) }}
                    style={{ padding: '8px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, borderBottom: `1px solid ${T.border}` }}
                    onMouseEnter={e => e.currentTarget.style.background = '#f1f5f9'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  >
                    <span style={{ fontSize: 11, fontWeight: 800, color: T.primary, fontFamily: "'JetBrains Mono',monospace", whiteSpace: 'nowrap' }}>{o.id}</span>
                    <span style={{ fontSize: 12, color: T.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.product}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <select
            value={sf}
            onChange={e => setSf(e.target.value)}
            style={{ border: `1px solid ${T.border}`, borderRadius: 9, padding: '9px 12px', fontSize: 13, color: T.text, background: T.surface, fontFamily: 'inherit', cursor: 'pointer', flexShrink: 0 }}
          >
            <option value="All">All Statuses</option>
            {ORDER_STATUSES.map(s => <option key={s}>{s}</option>)}
          </select>
        </div>
      </div>

      {/* ── Order list ── */}
      {filtered.length === 0 ? (
        <Card>
          <EmptyState
            icon="📦"
            title={q || sf !== 'All' ? 'No matching orders' : 'No orders yet'}
            desc={q || sf !== 'All' ? 'Try adjusting your search or filter' : 'Orders assigned to you will appear here'}
          />
        </Card>
      ) : (
        <>
          {/* Desktop table */}
          <div className="order-table-list" style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, overflow: 'hidden' }}>
            <div className="table-scroll">
              <div style={{ display: 'grid', gridTemplateColumns: '190px 1.4fr 1.1fr 80px 110px 120px 120px', gap: 0, padding: '12px 22px', background: '#f8fafc', borderBottom: `1px solid ${T.border}`, minWidth: 820 }}>
                {['Order ID', 'Product', 'Manufacturer', 'Qty', 'Delivery', 'Status', ''].map(h => (
                  <span key={h} style={{ fontSize: 10, fontWeight: 800, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{h}</span>
                ))}
              </div>
              {filtered.map((t, i) => {
                const o = t.order; const a = t.mfr; const rowStatus = t.status
                const overdue = new Date(o.delivery) < new Date(getToday()) && rowStatus !== 'Delivered'
                const rowBg = rowStatus === 'Delayed' ? '#fff8f8' : rowStatus === 'On Hold' ? '#fefdf5' : T.surface
                return (
                  <div key={`${o.id}-${a ? a.sub : 'm'}-${i}`} onClick={() => onOpen(o.id, a?.mid)}
                    style={{ display: 'grid', gridTemplateColumns: '190px 1.4fr 1.1fr 80px 110px 120px 120px', gap: 0, minWidth: 820, padding: '14px 22px', alignItems: 'center', cursor: 'pointer', background: rowBg, borderBottom: `1px solid ${T.border}`, transition: 'background 0.12s' }}
                    onMouseEnter={e => e.currentTarget.style.background = '#f8fafc'}
                    onMouseLeave={e => e.currentTarget.style.background = rowBg}>
                    <Mono style={{ fontSize: 12, flexShrink: 0 }}>{o.id}{a ? `-${a.sub}` : ''}</Mono>
                    <div style={{ minWidth: 0 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{o.product}</span>
                      {o.category && <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 600, color: T.textLight, background: '#f1f5f9', padding: '1px 5px', borderRadius: 4 }}>{o.category}</span>}
                      {o.season && <span style={{ marginLeft: 4, fontSize: 10, fontWeight: 600, color: '#0369a1', background: '#dbeafe', padding: '1px 5px', borderRadius: 4 }}>{o.season}</span>}
                    </div>
                    <div style={{ minWidth: 0 }} onClick={e => e.stopPropagation()}>
                      {a ? <MfrProfileLink mfrId={a.mid} mfrName={a.mfrCompany || 'Manufacturer'} docs={docs} onGetData={getDocData} />
                        : <span style={{ fontSize: 12, color: T.textMuted }}>—</span>}
                    </div>
                    <span style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{a ? a.qty?.toLocaleString() : o.totalQty?.toLocaleString()}</span>
                    <span style={{ fontSize: 12, color: overdue ? T.danger : T.textMuted, fontWeight: overdue ? 700 : 400 }}>{fmtDate(o.delivery)}</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <Badge status={rowStatus} />
                      {overdue && <span style={{ fontSize: 8, fontWeight: 800, color: T.danger, background: T.dangerBg, border: `1px solid ${T.dangerBorder}`, borderRadius: 3, padding: '1px 4px', letterSpacing: '0.04em' }}>LATE</span>}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                      {escalatedIds.has(o.id) ? (
                        <span style={{ fontSize: 11, fontWeight: 700, color: T.success, background: T.successBg, border: `1px solid ${T.successBorder}`, borderRadius: 6, padding: '3px 8px' }}>✓ Escalated</span>
                      ) : rowStatus !== 'Delivered' && (
                        <button onClick={e => { e.stopPropagation(); setEscalateOrder(o) }}
                          style={{ background: T.dangerBg, border: `1px solid ${T.dangerBorder}`, color: T.danger, borderRadius: 6, padding: '3px 9px', fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
                          🚨 Escalate
                        </button>
                      )}
                      <span style={{ color: T.textLight, fontSize: 16 }}>›</span>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Mobile cards */}
          <div className="order-card-list" style={{ flexDirection: 'column', gap: 10 }}>
            {filtered.map((t, i) => {
              const o = t.order; const a = t.mfr; const rowStatus = t.status
              const overdue = new Date(o.delivery) < new Date(getToday()) && rowStatus !== 'Delivered'
              return (
                <div key={`c-${o.id}-${i}`} onClick={() => onOpen(o.id, a?.mid)}
                  style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: '14px 16px', cursor: 'pointer' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, marginBottom: 10 }}>
                    <div style={{ minWidth: 0 }}>
                      <Mono style={{ fontSize: 11 }}>{o.id}{a ? `-${a.sub}` : ''}</Mono>
                      <div style={{ fontSize: 14, fontWeight: 700, color: T.text, marginTop: 3 }}>{o.product}</div>
                      <div style={{ fontSize: 12, color: T.textMuted, marginTop: 1 }} onClick={e => e.stopPropagation()}>
                        {a ? <MfrProfileLink mfrId={a.mid} mfrName={a.mfrCompany || 'Manufacturer'} docs={docs} onGetData={getDocData} /> : '—'}
                      </div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5, flexShrink: 0 }}>
                      <Badge status={rowStatus} />
                      {overdue && <span style={{ fontSize: 9, fontWeight: 800, color: T.danger, background: T.dangerBg, border: `1px solid ${T.dangerBorder}`, borderRadius: 3, padding: '1px 5px' }}>LATE</span>}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 12, color: T.textMuted }}><b style={{ color: T.text }}>{a ? a.qty?.toLocaleString() : o.totalQty?.toLocaleString()}</b> pcs</span>
                    <span style={{ fontSize: 12, color: overdue ? T.danger : T.textMuted, fontWeight: overdue ? 700 : 400 }}>Due {fmtDate(o.delivery)}</span>
                    {rowStatus !== 'Delivered' && !escalatedIds.has(o.id) && (
                      <button onClick={e => { e.stopPropagation(); setEscalateOrder(o) }}
                        style={{ background: T.dangerBg, border: `1px solid ${T.dangerBorder}`, color: T.danger, borderRadius: 6, padding: '3px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
                        🚨 Escalate
                      </button>
                    )}
                    {escalatedIds.has(o.id) && (
                      <span style={{ fontSize: 11, fontWeight: 700, color: T.success }}>✓ Escalated</span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}

      {/* ── Escalation modal ── */}
      {escalateOrder && (
        <EscalateModal
          order={escalateOrder}
          onClose={() => setEscalateOrder(null)}
          onSuccess={() => {
            addEscalated(escalateOrder.id)
            setEscalateOrder(null)
          }}
        />
      )}
    </div>
  )
}
