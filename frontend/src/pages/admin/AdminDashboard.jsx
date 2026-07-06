import { useState, useEffect } from 'react'
import { T, ST, ORDER_STATUSES, isExpiringSoon, isExpired, getToday, dayNumber } from '../../constants.js'
import { StatCard, Card, Grid, EmptyState, Mono, PageHeader, Badge, Btn, FlexRow, Modal, Select, Textarea, Input, Alert, LoadingScreen, DocCard } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'

const UPCOMING_WINDOW_DAYS = 5

// Buyer-grouped "upcoming" (due within the next N days) + "missed deadline" (overdue)
// stages/orders, sorted busiest-buyer-first.
function buildPriorities(orders) {
  const todayNum = dayNumber(getToday())
  const byBuyer = {}

  const bucket = buyer => (byBuyer[buyer] ??= { upcoming: [], missed: [] })
  const daysFromToday = dateStr => dayNumber(dateStr) - todayNum

  orders.forEach(o => {
    const buyer = o.buyerCompany || 'Unknown Buyer'
    const allDelivered = (o.assignments || []).every(a => a.status === 'Delivered')

    if (!allDelivered && o.delivery) {
      const diff = daysFromToday(o.delivery)
      if (diff != null && diff < 0) {
        bucket(buyer).missed.push({
          orderId: o.id, product: o.product, stageName: 'Order Delivery',
          mfrCompany: null, date: o.delivery, daysOverdue: -diff,
        })
      }
    }

    ;(o.assignments || []).forEach(a => {
      if (a.status === 'Delivered') return
      ;(a.stages || []).forEach(s => {
        if (!s.eta || s.eta === 'NA') return
        const diff = daysFromToday(s.eta)
        if (diff == null) return
        if (s.unitsDone < s.totalUnits && diff >= 0 && diff <= UPCOMING_WINDOW_DAYS) {
          bucket(buyer).upcoming.push({ orderId: o.id, product: o.product, stageName: s.name, mfrCompany: a.mfrCompany, date: s.eta, daysUntil: diff })
        } else if (s.unitsDone < s.totalUnits && diff < 0) {
          bucket(buyer).missed.push({ orderId: o.id, product: o.product, stageName: s.name, mfrCompany: a.mfrCompany, date: s.eta, daysOverdue: -diff })
        }
      })
    })
  })

  return Object.entries(byBuyer)
    .map(([buyer, { upcoming, missed }]) => ({ buyer, upcoming, missed, total: upcoming.length + missed.length }))
    .sort((a, b) => {
      if (b.total !== a.total) return b.total - a.total
      const earliest = list => list.reduce((min, x) => Math.min(min, new Date(x.date).getTime()), Infinity)
      return earliest(a.missed) - earliest(b.missed)
    })
}

// Orders grouped by their Master Order (in the master orders' own list order), with
// orders lacking a masterOrderId collected into a trailing "No Master Order" group.
function buildOrdersByMasterOrder(orders, masterOrders) {
  const groups = {}
  orders.forEach(o => {
    const key = o.masterOrderId || '__unassigned__'
    ;(groups[key] ??= []).push(o)
  })
  const orderedKeys = masterOrders.map(mo => mo.id).filter(id => groups[id])
  Object.keys(groups).forEach(k => { if (k !== '__unassigned__' && !orderedKeys.includes(k)) orderedKeys.push(k) })
  if (groups.__unassigned__) orderedKeys.push('__unassigned__')

  return orderedKeys.map(key => {
    const mo = masterOrders.find(m => m.id === key)
    return {
      key,
      label: key === '__unassigned__' ? 'No Master Order' : (mo?.orderName || key),
      season: mo?.season || null,
      orders: groups[key],
    }
  })
}

function flattenTxns(orders) {
  return orders.flatMap(o => (o.assignments || []).length > 0
    ? (o.assignments || []).map(a => ({ orderId: o.id, sub: a.sub, status: a.status }))
    : [{ orderId: o.id, sub: null, status: 'Processing' }]
  )
}

function SectionHeader({ icon, label, count, open, onToggle }) {
  return (
    <button onClick={onToggle}
      style={{ width: '100%', border: 'none', cursor: 'pointer', padding: '14px 18px', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 10, background: '#fff', textAlign: 'left' }}>
      <span style={{ fontSize: 14, fontWeight: 700, color: T.text, flex: 1 }}>{icon} {label}</span>
      {count != null && <span style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, background: '#f1f5f9', border: `1px solid ${T.border}`, borderRadius: 10, padding: '2px 9px' }}>{count}</span>}
      <span style={{ fontSize: 14, color: T.textMuted, transition: 'transform 0.2s', transform: open ? 'rotate(90deg)' : 'rotate(0deg)', flexShrink: 0 }}>›</span>
    </button>
  )
}

export function AdminDashboard({ onNavigate, onOpen }) {
  const { orders, users, docs, masterOrders, currentUser, loading, getDocData, listAllRibbons, createRibbon, updateRibbon, removeRibbon } = useApp()
  const [openSections, setOpenSections] = useState({ orders: false, priorities: false, requests: false, alerts: false, ribbons: false })
  const toggleSection = id => setOpenSections(p => ({ ...p, [id]: !p[id] }))
  const [collapsedBuyers, setCollapsedBuyers] = useState({})
  const [collapsedMasterOrders, setCollapsedMasterOrders] = useState({})

  // ── Ribbon management state ──
  const [allRibbons, setAllRibbons] = useState([])
  const [ribbonsLoaded, setRibbonsLoaded] = useState(false)
  const [showRibbon, setShowRibbon] = useState(false)
  const [rf, setRf] = useState({ message: '', type: 'info', audience: 'all', expiresAt: '', targetUserIds: [] })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (currentUser?.role === 'admin' && listAllRibbons) {
      listAllRibbons().then(async r => {
        const expired = r.filter(x => x.expiresAt && new Date(x.expiresAt) < new Date())
        if (expired.length > 0) {
          for (const x of expired) { try { await removeRibbon(x.id) } catch {} }
          r = await listAllRibbons()
        }
        setAllRibbons(r)
        setRibbonsLoaded(true)
      }).catch(() => setRibbonsLoaded(true))
    }
  }, [currentUser, listAllRibbons])

  if (loading) return <LoadingScreen />

  const buyerRequests = docs.filter(d => d.isActive !== false && ['RFQ', 'tech_pack', 'buyer_order'].includes(d.type) && users.find(u => String(u.id) === String(d.uploadedBy) && u.role === 'buyer')).sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))

  const buyers = users.filter(u => u.role === 'buyer' && u.isActive)
  const mfrs = users.filter(u => u.role === 'manufacturer' && u.isActive)
  const delayed = orders.filter(o => (o.assignments || []).some(a => a.status === 'Delayed' || a.status === 'On Hold'))
  const expDocs = docs.filter(d => d.isActive !== false && (isExpiringSoon(d.expiryDate) || isExpired(d.expiryDate)))
  // Flatten to individual buyer-mfr transactions (matches AdminOrders row count)
  const allTxns = orders.flatMap(o => (o.assignments || []).length > 0
    ? (o.assignments || []).map(a => ({ orderId: o.id, sub: a.sub, status: a.status }))
    : [{ orderId: o.id, sub: null, status: 'Processing' }]
  )
  const ordersByMO = buildOrdersByMasterOrder(orders, masterOrders)
  const priorityBuyers = buildPriorities(orders)
  const priorityTotal = priorityBuyers.reduce((sum, b) => sum + b.total, 0)

  const resetRibbonForm = () => setRf({ message: '', type: 'info', audience: 'all', expiresAt: '', targetUserIds: [] })

  const submitRibbon = async () => {
    if (!rf.message.trim()) return
    setSaving(true)
    try {
      await createRibbon({ message: rf.message.trim(), type: rf.type, audience: rf.audience, expiresAt: rf.expiresAt || null, targetUserIds: rf.targetUserIds.length > 0 ? rf.targetUserIds : undefined })
      const updated = await listAllRibbons()
      setAllRibbons(updated)
      setShowRibbon(false)
      resetRibbonForm()
    } finally { setSaving(false) }
  }

  const toggleRibbon = async (ribbon) => {
    setSaving(true)
    try {
      await updateRibbon(ribbon.id, { isActive: !ribbon.isActive })
      const updated = await listAllRibbons()
      setAllRibbons(updated)
    } finally { setSaving(false) }
  }

  const deleteRibbon = async (id) => {
    setSaving(true)
    try {
      await removeRibbon(id)
      setAllRibbons(p => p.filter(r => r.id !== id))
    } finally { setSaving(false) }
  }

  const audienceLabel = a => ({ all: 'All Users', buyer: 'Buyers Only', manufacturer: 'Manufacturers Only' }[a] || a)
  const typeColors = { urgent: { bg: '#fff1f2', c: '#9f1239', border: '#fecdd3' }, warning: { bg: '#fffbeb', c: '#92400e', border: '#fde68a' }, info: { bg: '#eff6ff', c: '#1e40af', border: '#bfdbfe' } }

  return (
    <div>
      <PageHeader title="Admin Dashboard" subtitle="Platform overview, alerts, and ribbon notifications" />

      {/* ── Ribbon Publish Modal ── */}
      {showRibbon && (
        <Modal title="Publish Ribbon Notification" subtitle="Only one active ribbon per audience — previous active ribbon will be deactivated" onClose={() => { setShowRibbon(false); resetRibbonForm() }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Textarea label="Message *" value={rf.message} onChange={e => setRf({ ...rf, message: e.target.value })} placeholder="Enter the notification message (max 160 chars)…" hint={`${rf.message.length}/160`} />
            <div className="form-grid-2">
              <Select label="Type" value={rf.type} onChange={e => setRf({ ...rf, type: e.target.value })}>
                <option value="info">Info</option>
                <option value="warning">Warning</option>
                <option value="urgent">Urgent</option>
              </Select>
              <Select label="Audience" value={rf.audience} onChange={e => setRf({ ...rf, audience: e.target.value, targetUserIds: [] })}>
                <option value="all">All Users</option>
                <option value="buyer">Buyers Only</option>
                <option value="manufacturer">Manufacturers Only</option>
              </Select>
            </div>
            {/* Multi-select: target specific users by name */}
            {rf.audience !== 'all' && (() => {
              const targetUsers = users.filter(u => u.role === rf.audience && u.isActive)
              return targetUsers.length > 0 ? (
                <div>
                  <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 5 }}>Target Specific {rf.audience === 'buyer' ? 'Buyers' : 'Manufacturers'} (optional)</label>
                  <div style={{ border: `1px solid ${T.border}`, borderRadius: 8, padding: '8px', maxHeight: 140, overflowY: 'auto', background: '#f8fafc' }}>
                    {targetUsers.map(u => {
                      const checked = rf.targetUserIds.includes(u.id)
                      return (
                        <label key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px', cursor: 'pointer', borderRadius: 6, background: checked ? T.primaryLight : 'transparent', fontSize: 12, color: T.text }}>
                          <input type="checkbox" checked={checked} onChange={() => {
                            setRf(prev => ({ ...prev, targetUserIds: checked ? prev.targetUserIds.filter(id => id !== u.id) : [...prev.targetUserIds, u.id] }))
                          }} style={{ accentColor: T.primary }} />
                          <span style={{ fontWeight: 600 }}>{u.company}</span>
                          <span style={{ color: T.textMuted }}>({u.name})</span>
                        </label>
                      )
                    })}
                  </div>
                  <div style={{ fontSize: 11, color: T.textLight, marginTop: 3 }}>{rf.targetUserIds.length === 0 ? 'Leave empty to target all ' + (rf.audience === 'buyer' ? 'buyers' : 'manufacturers') : `${rf.targetUserIds.length} selected`}</div>
                </div>
              ) : null
            })()}
            <Input label="Expiry Date (optional)" type="date" value={rf.expiresAt} onChange={e => setRf({ ...rf, expiresAt: e.target.value })} hint="Leave blank for no auto-expiry" />
            <Alert type="info">Publishing will deactivate any existing active ribbon for the same audience.</Alert>
            <FlexRow justify="flex-end" gap={8}>
              <Btn variant="secondary" onClick={() => { setShowRibbon(false); resetRibbonForm() }}>Cancel</Btn>
              <Btn disabled={!rf.message.trim() || rf.message.length > 160 || saving} onClick={submitRibbon}>{saving ? 'Publishing…' : 'Publish Ribbon'}</Btn>
            </FlexRow>
          </div>
        </Modal>
      )}

      {/* ── Stat Cards ── */}
      <Grid cols={4} style={{ marginBottom: 22 }}>
        <StatCard label="Active Buyers" value={buyers.length} icon="🛍" bg="#dbeafe" />
        <StatCard label="Manufacturers" value={mfrs.length} icon="🏭" bg="#fef9c3" />
        <StatCard label="Total Orders" value={allTxns.length} icon="📦" bg={T.primaryLight} />
        <StatCard label="Active Alerts" value={delayed.length + expDocs.length} icon="🚨" bg={T.dangerBg} />
      </Grid>

      {/* ── Orders by Status (nested under Master Order) ── */}
      <Card pad={false} style={{ marginBottom: 14 }}>
        <SectionHeader icon="📦" label="Orders by Status" count={null} open={openSections.orders} onToggle={() => toggleSection('orders')} />
        {openSections.orders && (
          <div style={{ padding: '0 18px 18px' }}>
            {ordersByMO.length === 0 ? <EmptyState icon="📦" title="No orders yet" desc="" /> : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {ordersByMO.map(group => {
                  const isOpen = !collapsedMasterOrders[group.key]
                  const groupTxns = flattenTxns(group.orders)
                  const groupStCounts = ORDER_STATUSES.map(s => ({ s, c: groupTxns.filter(t => t.status === s).length })).filter(x => x.c > 0)
                  return (
                    <div key={group.key} style={{ border: `1px solid ${T.border}`, borderRadius: 10, overflow: 'hidden' }}>
                      <button
                        onClick={() => setCollapsedMasterOrders(p => ({ ...p, [group.key]: !p[group.key] }))}
                        style={{ width: '100%', border: 'none', cursor: 'pointer', padding: '10px 14px', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 10, background: '#f8fafc' }}
                      >
                        <span style={{ fontSize: 13, fontWeight: 700, color: T.text, flex: 1, textAlign: 'left' }}>{group.label}{group.season ? ` · ${group.season}` : ''}</span>
                        <span style={{ fontSize: 10, fontWeight: 700, color: T.textMuted, background: '#fff', border: `1px solid ${T.border}`, borderRadius: 10, padding: '2px 8px', whiteSpace: 'nowrap' }}>{groupTxns.length} txn{groupTxns.length !== 1 ? 's' : ''}</span>
                        <span style={{ fontSize: 12, color: T.textMuted, transition: 'transform 0.2s', transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)', flexShrink: 0 }}>›</span>
                      </button>
                      {isOpen && (
                        <div style={{ padding: '10px 12px', borderTop: `1px solid ${T.border}`, display: 'flex', flexDirection: 'column', gap: 8 }}>
                          {groupStCounts.map(({ s, c }) => {
                            const st = ST[s] || { bg: '#f1f5f9', c: '#475569' }
                            const pct = groupTxns.length > 0 ? Math.round((c / groupTxns.length) * 100) : 0
                            const statusTxns = groupTxns.filter(t => t.status === s)
                            return (
                              <div key={s}
                                onClick={() => onNavigate && onNavigate('orders', { status: s })}
                                style={{ border: `1px solid ${T.border}`, borderRadius: 10, padding: '12px 14px', cursor: 'pointer', transition: 'all 0.15s', background: T.surface }}
                                onMouseEnter={e => { e.currentTarget.style.background = st.bg; e.currentTarget.style.borderColor = st.c + '55' }}
                                onMouseLeave={e => { e.currentTarget.style.background = T.surface; e.currentTarget.style.borderColor = T.border }}
                              >
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                    <span style={{ padding: '3px 12px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: st.bg, color: st.c, border: `1px solid ${st.c}22`, whiteSpace: 'nowrap' }}>{s}</span>
                                    <span style={{ fontSize: 20, fontWeight: 800, color: st.c, lineHeight: 1 }}>{c}</span>
                                    <span style={{ fontSize: 12, color: T.textMuted }}>order{c !== 1 ? 's' : ''} · {pct}%</span>
                                  </div>
                                  <span style={{ fontSize: 12, color: T.textMuted, fontWeight: 600 }}>View all →</span>
                                </div>
                                <div style={{ height: 6, background: '#f1f5f9', borderRadius: 4, overflow: 'hidden', marginBottom: 8 }}>
                                  <div style={{ height: 6, background: st.c, borderRadius: 4, width: `${pct}%`, transition: 'width 0.3s' }} />
                                </div>
                                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                  {statusTxns.slice(0, 5).map((t) => (
                                    <span key={t.orderId + (t.sub || '')} style={{ fontSize: 10, fontFamily: "'JetBrains Mono',monospace", fontWeight: 600, color: st.c, background: st.bg, border: `1px solid ${st.c}33`, padding: '2px 7px', borderRadius: 4 }}>{t.orderId}{t.sub ? `-${t.sub}` : ''}</span>
                                  ))}
                                  {statusTxns.length > 5 && (
                                    <span style={{ fontSize: 10, color: T.textLight, padding: '2px 7px' }}>+{statusTxns.length - 5} more</span>
                                  )}
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </Card>

      {/* ── Upcoming Priorities ── */}
      <Card pad={false} style={{ marginBottom: 14 }}>
        <SectionHeader icon="🎯" label="Upcoming Priorities" count={priorityTotal} open={openSections.priorities} onToggle={() => toggleSection('priorities')} />
        {openSections.priorities && (
          <div style={{ padding: '0 18px 18px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {priorityBuyers.length === 0 ? (
                <EmptyState icon="✅" title={`All caught up — nothing due in the next ${UPCOMING_WINDOW_DAYS} days`} desc="" />
              ) : priorityBuyers.map(({ buyer, upcoming, missed }) => {
                const isOpen = !collapsedBuyers[buyer]
                return (
                  <div key={buyer} style={{ border: `1px solid ${T.border}`, borderRadius: 10, overflow: 'hidden' }}>
                    <button
                      onClick={() => setCollapsedBuyers(p => ({ ...p, [buyer]: !p[buyer] }))}
                      style={{ width: '100%', border: 'none', cursor: 'pointer', padding: '12px 16px', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 10, background: '#f8fafc' }}
                    >
                      <span style={{ fontSize: 13, fontWeight: 700, color: T.text, flex: 1, textAlign: 'left' }}>{buyer}</span>
                      {missed.length > 0 && <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: T.dangerBg, color: T.danger, border: `1px solid ${T.dangerBorder}`, whiteSpace: 'nowrap' }}>{missed.length} missed</span>}
                      {upcoming.length > 0 && <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: T.warningBg, color: T.warning, border: `1px solid ${T.warningBorder}`, whiteSpace: 'nowrap' }}>{upcoming.length} upcoming</span>}
                      <span style={{ fontSize: 12, color: T.textMuted, transition: 'transform 0.2s', transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)', flexShrink: 0 }}>›</span>
                    </button>
                    {isOpen && (
                      <div style={{ padding: '10px 12px', borderTop: `1px solid ${T.border}`, display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {missed.map((item, i) => (
                          <div key={`m${i}`} onClick={() => onOpen && onOpen(item.orderId)}
                            style={{ background: T.dangerBg, border: `1px solid ${T.dangerBorder}`, borderRadius: 8, padding: '8px 12px', cursor: onOpen ? 'pointer' : 'default' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                              <Mono style={{ fontSize: 10 }}>{item.orderId}</Mono>
                              <span style={{ fontSize: 10, fontWeight: 700, color: T.danger, whiteSpace: 'nowrap' }}>{item.daysOverdue}d overdue</span>
                            </div>
                            <div style={{ fontSize: 12, color: T.danger, marginTop: 2 }}>{item.product} — {item.stageName}{item.mfrCompany ? ` · ${item.mfrCompany}` : ''}</div>
                          </div>
                        ))}
                        {upcoming.map((item, i) => (
                          <div key={`u${i}`} onClick={() => onOpen && onOpen(item.orderId)}
                            style={{ background: T.warningBg, border: `1px solid ${T.warningBorder}`, borderRadius: 8, padding: '8px 12px', cursor: onOpen ? 'pointer' : 'default' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                              <Mono style={{ fontSize: 10 }}>{item.orderId}</Mono>
                              <span style={{ fontSize: 10, fontWeight: 700, color: T.warning, whiteSpace: 'nowrap' }}>{item.daysUntil === 0 ? 'due today' : `in ${item.daysUntil}d`}</span>
                            </div>
                            <div style={{ fontSize: 12, color: T.warning, marginTop: 2 }}>{item.product} — {item.stageName}{item.mfrCompany ? ` · ${item.mfrCompany}` : ''}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </Card>

      {/* ── Buyer Requests ── */}
      <Card pad={false} style={{ marginBottom: 14 }}>
        <SectionHeader icon="📋" label="Buyer Requests" count={buyerRequests.length} open={openSections.requests} onToggle={() => toggleSection('requests')} />
        {openSections.requests && (
          <div style={{ padding: '0 18px 18px' }}>
            {buyerRequests.length === 0 ? (
              <EmptyState icon="📋" title="No buyer requests yet" desc="Buyer-submitted RFQs, Tech Packs, and Buyer Orders will appear here" />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                {buyerRequests.map(d => <DocCard key={d.id} doc={d} users={users} onGetData={getDocData} />)}
              </div>
            )}
          </div>
        )}
      </Card>

      {/* ── Active Alerts ── */}
      <Card pad={false} style={{ marginBottom: 14 }}>
        <SectionHeader icon="🚨" label="Alerts" count={delayed.length + expDocs.length} open={openSections.alerts} onToggle={() => toggleSection('alerts')} />
        {openSections.alerts && (
          <div style={{ padding: '0 18px 18px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {delayed.map(o => (
                <div key={o.id} style={{ background: T.dangerBg, border: `1px solid ${T.dangerBorder}`, borderRadius: 8, padding: '8px 12px' }}>
                  <Mono style={{ fontSize: 10 }}>{o.id}</Mono>
                  <div style={{ fontSize: 12, color: T.danger, marginTop: 2 }}>{o.product} — {o.assignments.find(a => a.status === 'Delayed' || a.status === 'On Hold')?.status}</div>
                </div>
              ))}
              {expDocs.map(d => (
                <div key={d.id} style={{ background: T.warningBg, border: `1px solid ${T.warningBorder}`, borderRadius: 8, padding: '8px 12px' }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: T.warning }}>{d.name}</div>
                  <div style={{ fontSize: 11, color: '#92400e' }}>{isExpired(d.expiryDate) ? 'Expired' : 'Expiring soon'} — {d.expiryDate}</div>
                </div>
              ))}
              {delayed.length === 0 && expDocs.length === 0 && <EmptyState icon="✅" title="No active alerts" desc="All orders and documents are in good standing" />}
            </div>
          </div>
        )}
      </Card>

      {/* ── Ribbon Notifications ── */}
      <Card pad={false} style={{ marginBottom: 14 }}>
        <SectionHeader icon="📢" label="Ribbons" count={allRibbons.length} open={openSections.ribbons} onToggle={() => toggleSection('ribbons')} />
        {openSections.ribbons && (
          <div style={{ padding: '0 18px 18px' }}>
            <FlexRow justify="flex-end" style={{ marginBottom: 14 }}>
              <Btn onClick={() => setShowRibbon(true)} icon="📢" size="sm">Publish Ribbon</Btn>
            </FlexRow>
            {!ribbonsLoaded ? (
              <div style={{ padding: 24, textAlign: 'center', color: T.textMuted, fontSize: 13 }}>Loading ribbons…</div>
            ) : allRibbons.length === 0 ? (
              <EmptyState icon="📢" title="No ribbons published" desc="Publish a ribbon notification to display a banner to your users" />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {allRibbons.map(r => {
                  const tc = typeColors[r.type] || typeColors.info
                  const expired = r.expiresAt && new Date(r.expiresAt) < new Date()
                  const isActive = r.isActive && !expired
                  return (
                    <div key={r.id} style={{ border: `1px solid ${isActive ? tc.border : T.border}`, borderRadius: 10, padding: '14px 16px', background: isActive ? tc.bg : '#f8fafc', opacity: !r.isActive || expired ? 0.65 : 1 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: T.text, marginBottom: 8, wordBreak: 'break-word', lineHeight: 1.4 }}>{r.message}</div>
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                            <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: tc.bg, color: tc.c, border: `1px solid ${tc.border}` }}>{r.type}</span>
                            <span style={{ fontSize: 11, color: T.textMuted, padding: '2px 0' }}>{audienceLabel(r.audience)}</span>
                            <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: isActive ? T.successBg : '#e2e8f0', color: isActive ? T.success : T.textLight, border: `1px solid ${isActive ? T.successBorder : T.border}` }}>
                              {expired ? 'Expired' : r.isActive ? 'Active' : 'Inactive'}
                            </span>
                            {r.expiresAt && <span style={{ fontSize: 10, color: T.textMuted }}>Expires {r.expiresAt}</span>}
                          </div>
                        </div>
                        <FlexRow gap={6} style={{ flexShrink: 0, alignSelf: 'center' }}>
                          <Btn size="sm" variant={r.isActive ? 'warning' : 'success'} disabled={saving} onClick={() => toggleRibbon(r)}>
                            {r.isActive ? 'Deactivate' : 'Activate'}
                          </Btn>
                          <Btn size="sm" variant="danger" disabled={saving} onClick={() => deleteRibbon(r.id)}>Delete</Btn>
                        </FlexRow>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  )
}
