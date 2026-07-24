import { useState, useMemo } from 'react'
import { T, ORDER_STATUSES, getToday, dayNumber } from '../../constants.js'
import { StatCard, Card, Badge, EmptyState, Mono, Grid, PageHeader, LoadingScreen } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'


function fmtDate(d) {
  if (!d) return '—'
  const dt = new Date(d)
  const dd = String(dt.getDate()).padStart(2, '0')
  const mm = String(dt.getMonth() + 1).padStart(2, '0')
  return `${dd}-${mm}-${dt.getFullYear()}`
}

export function MfrDashboard({ onOpen }) {
  const { orders, currentUser: user, loading, loadError } = useApp()
  const [q, setQ] = useState('')
  const [sf, setSf] = useState('All')
  const [showSugg, setShowSugg] = useState(false)

  const myOrders = useMemo(
    () => (orders || []).map(o => ({ ...o, mine: (o.assignments || []).find(a => String(a.mid) === String(user.id)) })).filter(o => o.mine),
    [orders, user.id]
  )

  const suggestions = useMemo(() => {
    if (!q) return []
    const m = q.toLowerCase()
    return myOrders
      .filter(o => o.id.toLowerCase().includes(m) || o.product.toLowerCase().includes(m))
      .slice(0, 8)
  }, [myOrders, q])

  // One row per order — its currently active stage only (the first not-yet-complete
  // one), not every future stage still waiting its turn.
  const myPendingStages = useMemo(() => {
    const todayNum = dayNumber(getToday())
    return myOrders.flatMap(o => {
        const stages = o.mine.stages || []
        const si = stages.findIndex(s => (s.unitsDone || 0) < (s.totalUnits || 0))
        if (si === -1) return []
        const s = stages[si]
        return (s.responsibleId && String(s.responsibleId) === String(user.id)) ? [{ s, o, si }] : []
      })
      .map(({ s, o, si }) => ({
        id: `${o.id}:${si}`,
        title: `${s.name} — ${o.product}`,
        orderId: o.id,
        eta: s.eta && s.eta !== 'NA' ? s.eta : null,
        overdue: !!(s.eta && s.eta !== 'NA' && dayNumber(s.eta) - todayNum < 0),
      }))
      .sort((a, b) => {
        const aOver = a.overdue ? 0 : 1, bOver = b.overdue ? 0 : 1
        if (aOver !== bOver) return aOver - bOver
        const aEta = a.eta ? dayNumber(a.eta) : Infinity, bEta = b.eta ? dayNumber(b.eta) : Infinity
        return aEta - bEta
      })
  }, [myOrders, user.id])

  const stats = useMemo(() => ({
    total:        myOrders.length,
    inProduction: myOrders.filter(o => o.mine.status === 'Processing').length,
    onHold:       myOrders.filter(o => o.mine.status === 'On Hold').length,
    delayed:      myOrders.filter(o => o.mine.status === 'Delayed').length,
    delivered:    myOrders.filter(o => o.mine.status === 'Delivered').length,
  }), [myOrders])

  const filtered = useMemo(() => {
    const m = q.toLowerCase()
    return myOrders.filter(o => {
      const matchQ  = !q || o.id.toLowerCase().includes(m) || o.product.toLowerCase().includes(m)
      const matchSf = sf === 'All' || o.mine.status === sf
      return matchQ && matchSf
    })
  }, [myOrders, q, sf])

  if (loading) return <LoadingScreen />

  if (loadError) return (
    <Card>
      <EmptyState icon="⚠️" title="Could not load orders" desc="Check your connection and refresh the page." />
    </Card>
  )

  return (
    <div>
      <PageHeader title="My Orders" subtitle="View and update status for all orders assigned to you" />

      {/* ── Stat cards ── */}
      <Grid cols={5} style={{ marginBottom: 24 }}>
        <StatCard label="Total Assigned"  value={stats.total}        icon="📦" bg={T.primaryLight} />
        <StatCard label="In Production"   value={stats.inProduction} icon="⚙️" bg="#fef9c3" />
        <StatCard label="On Hold"         value={stats.onHold}       icon="⏸️" bg={T.infoBg} />
        <StatCard label="Delayed"         value={stats.delayed}      icon="⚠️" bg={T.dangerBg} />
        <StatCard label="Delivered"       value={stats.delivered}    icon="✅" bg={T.successBg} />
      </Grid>

      {/* ── My Pending Steps ── */}
      <Card style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: T.text, marginBottom: 12 }}>👤 My Pending Steps</div>
        {myPendingStages.length === 0 ? (
          <EmptyState icon="✅" title="All caught up" desc="No production stages assigned to you are pending" />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {myPendingStages.map(item => (
              <div key={item.id} onClick={() => onOpen(item.orderId)}
                style={{ border: `1px solid ${item.overdue ? T.dangerBorder : T.border}`, borderRadius: 8, padding: '8px 12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, background: item.overdue ? T.dangerBg : '#fafbfc' }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: T.text, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.title}</span>
                {item.eta && <span style={{ fontSize: 10, fontWeight: 700, color: item.overdue ? T.danger : T.textMuted, whiteSpace: 'nowrap' }}>{fmtDate(item.eta)}</span>}
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* ── Filter bar ── */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 220 }}>
          <span style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', fontSize: 13, color: T.textLight, pointerEvents: 'none', zIndex: 1 }}>🔍</span>
          <input
            value={q}
            onChange={e => { setQ(e.target.value); setShowSugg(true) }}
            onFocus={() => setShowSugg(true)}
            onBlur={() => setTimeout(() => setShowSugg(false), 150)}
            placeholder="Search by order ID or product…"
            style={{ width: '100%', border: `1px solid ${T.border}`, borderRadius: 8, padding: '7px 12px 7px 32px', fontSize: 13, color: T.text, background: T.surface, fontFamily: 'inherit', boxSizing: 'border-box' }}
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
                  {o.season && <span style={{ fontSize: 10, fontWeight: 600, color: '#0369a1', background: '#dbeafe', padding: '1px 6px', borderRadius: 4, flexShrink: 0 }}>{o.season}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
        <select
          value={sf}
          onChange={e => setSf(e.target.value)}
          style={{ border: `1px solid ${T.border}`, borderRadius: 8, padding: '7px 12px', fontSize: 13, color: T.text, background: T.surface, fontFamily: 'inherit', cursor: 'pointer' }}
        >
          <option value="All">All Statuses</option>
          {ORDER_STATUSES.map(s => <option key={s}>{s}</option>)}
        </select>
        <span style={{ fontSize: 12, color: T.textMuted, whiteSpace: 'nowrap' }}>
          {filtered.length} of {myOrders.length} order{myOrders.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* ── Order list ── */}
      {filtered.length === 0 ? (
        <Card>
          <EmptyState
            icon="📦"
            title={q || sf !== 'All' ? 'No matching orders' : 'No orders assigned'}
            desc={q || sf !== 'All' ? 'Try adjusting your search or filter' : 'Your assigned orders will appear here'}
          />
        </Card>
      ) : (
        <>
          {/* Desktop table */}
          <div className="order-table-list" style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, overflow: 'hidden' }}>
            <div className="table-scroll">
              <div style={{ display: 'grid', gridTemplateColumns: '1.8fr 2fr 1.2fr 0.6fr 0.9fr 1fr 30px', gap: 0, padding: '10px 18px', background: '#f8fafc', borderBottom: `1px solid ${T.border}`, minWidth: 700 }}>
                {['Order ID', 'Product', 'Buyer', 'Qty', 'Delivery', 'Status', ''].map(h => (
                  <span key={h} style={{ fontSize: 10, fontWeight: 800, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{h}</span>
                ))}
              </div>
              {filtered.map((o, ri) => {
                const overdue = new Date(o.delivery) < new Date(getToday()) && o.mine.status !== 'Delivered'
                const rowBg = o.mine.status === 'Delayed' ? '#fff8f8' : o.mine.status === 'On Hold' ? '#fefdf5' : T.surface
                return (
                  <div key={o.id} onClick={() => onOpen(o.id)}
                    style={{ display: 'grid', gridTemplateColumns: '1.8fr 2fr 1.2fr 0.6fr 0.9fr 1fr 30px', gap: 0, minWidth: 700, padding: '12px 18px', alignItems: 'center', cursor: 'pointer', background: rowBg, borderBottom: ri < filtered.length - 1 ? `1px solid ${T.border}` : 'none', transition: 'background 0.12s' }}
                    onMouseEnter={e => e.currentTarget.style.background = '#f8fafc'}
                    onMouseLeave={e => e.currentTarget.style.background = rowBg}>
                    <Mono style={{ fontSize: 12 }}>{o.id}-{o.mine.sub}</Mono>
                    <div style={{ minWidth: 0 }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{o.product}</span>
                      {o.category && <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, color: T.textLight, background: '#f1f5f9', padding: '1px 6px', borderRadius: 4 }}>{o.category}</span>}
                      {o.season && <span style={{ marginLeft: 4, fontSize: 10, fontWeight: 700, color: '#0369a1', background: '#dbeafe', padding: '1px 6px', borderRadius: 4 }}>{o.season}</span>}
                    </div>
                    <span style={{ fontSize: 13, fontWeight: 600, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.buyerCompany || '—'}</span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{o.mine.qty?.toLocaleString()}</span>
                    <span style={{ fontSize: 12, color: overdue ? T.danger : T.textMuted, fontWeight: overdue ? 700 : 500 }}>{fmtDate(o.delivery)}</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <Badge status={o.mine.status} />
                      {overdue && <span style={{ fontSize: 8, fontWeight: 800, color: T.danger, background: T.dangerBg, border: `1px solid ${T.dangerBorder}`, borderRadius: 3, padding: '1px 4px', letterSpacing: '0.04em' }}>LATE</span>}
                    </div>
                    <span style={{ color: T.textLight, fontSize: 16, textAlign: 'right' }}>›</span>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Mobile cards */}
          <div className="order-card-list" style={{ flexDirection: 'column', gap: 10 }}>
            {filtered.map(o => {
              const overdue = new Date(o.delivery) < new Date(getToday()) && o.mine.status !== 'Delivered'
              return (
                <div key={o.id} onClick={() => onOpen(o.id)}
                  style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: '14px 16px', cursor: 'pointer' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, marginBottom: 10 }}>
                    <div style={{ minWidth: 0 }}>
                      <Mono style={{ fontSize: 11 }}>{o.id}-{o.mine.sub}</Mono>
                      <div style={{ fontSize: 14, fontWeight: 700, color: T.text, marginTop: 3 }}>{o.product}</div>
                      <div style={{ fontSize: 12, color: T.textMuted, marginTop: 1 }}>{o.buyerCompany || '—'}</div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5, flexShrink: 0 }}>
                      <Badge status={o.mine.status} />
                      {overdue && <span style={{ fontSize: 9, fontWeight: 800, color: T.danger, background: T.dangerBg, border: `1px solid ${T.dangerBorder}`, borderRadius: 3, padding: '1px 5px' }}>LATE</span>}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 12, color: T.textMuted }}><b style={{ color: T.text }}>{o.mine.qty?.toLocaleString()}</b> pcs</span>
                    <span style={{ fontSize: 12, color: overdue ? T.danger : T.textMuted, fontWeight: overdue ? 700 : 400 }}>Due {fmtDate(o.delivery)}</span>
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
