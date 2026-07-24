import { useState, useEffect } from 'react'
import { T, ST, isExpiringSoon, isExpired, getToday, dayNumber } from '../../constants.js'
import { StatCard, Card, Grid, EmptyState, Mono, PageHeader, Badge, Btn, FlexRow, Modal, Select, Textarea, Input, Alert, LoadingScreen, DocCard } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'

const fmtDate = d => {
  if (!d) return '—'
  const dt = new Date(d)
  return `${String(dt.getDate()).padStart(2, '0')}-${String(dt.getMonth() + 1).padStart(2, '0')}-${dt.getFullYear()}`
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

// An order reads as delayed even if nobody has manually flipped its status: if the
// active (first not-yet-complete) stage's planned ETA has already passed, the
// deadline has silently slipped. Skips assignments already On Hold or Delivered —
// a deliberate pause isn't the same thing as a missed deadline.
function isScheduleOverdue(order, todayNum) {
  return (order.assignments || []).some(a => {
    if (a.status === 'On Hold' || a.status === 'Delivered') return false
    const stage = (a.stages || []).find(s => (s.unitsDone || 0) < (s.totalUnits || 0))
    if (!stage || !stage.eta || stage.eta === 'NA') return false
    return dayNumber(stage.eta) - todayNum < 0
  })
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
  const { orders, users, docs, masterOrders, actionItems, currentUser, loading, getDocData, listAllRibbons, createRibbon, updateRibbon, removeRibbon } = useApp()
  const [openSections, setOpenSections] = useState({ orders: false, requests: false, alerts: false, ribbons: false })
  const toggleSection = id => setOpenSections(p => ({ ...p, [id]: !p[id] }))

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

  const myOpenItems = (actionItems || []).filter(a => a.status === 'open' && String(a.assigneeId) === String(currentUser?.id)).map(a => ({ ...a, _kind: 'item' }))
  const todayNum = dayNumber(getToday())

  // TNA stages the logged-in admin is responsible for — one per assignment, its
  // currently active stage only (the first not-yet-complete one), not every future
  // stage still waiting its turn. Surfaced alongside real Action Items in the same
  // widget (see ActionItemsCenter.jsx for the matching read-only view).
  const myPendingStages = orders.flatMap(o => (o.assignments || []).map((asgn, ai) => {
      const stages = asgn.stages || []
      const si = stages.findIndex(s => (s.unitsDone || 0) < (s.totalUnits || 0))
      return si === -1 ? null : { s: stages[si], o, asgn, ai, si }
    }))
    .filter(Boolean)
    .filter(({ s }) => s.responsibleId && String(s.responsibleId) === String(currentUser?.id))
    .map(({ s, o, asgn, ai, si }) => ({
      id: `stage:${o.id}:${asgn.mid || ai}:${si}`,
      title: `${s.name} — ${o.product}`,
      buyerCompany: o.buyerCompany,
      eta: s.eta && s.eta !== 'NA' ? s.eta : null,
      orderId: o.id,
      priority: 'medium',
      _kind: 'stage',
    }))

  const combinedOpen = [...myOpenItems, ...myPendingStages]
  const overdueItems = combinedOpen.filter(a => a.eta && dayNumber(a.eta) - todayNum < 0)
  const dueTodayItems = combinedOpen.filter(a => a.eta && dayNumber(a.eta) - todayNum === 0)
  const priorityRank = { high: 0, medium: 1, low: 2 }
  const topActionItems = [...combinedOpen].sort((a, b) => {
    const aEta = a.eta ? dayNumber(a.eta) : Infinity, bEta = b.eta ? dayNumber(b.eta) : Infinity
    if (aEta !== bEta) return aEta - bEta
    return priorityRank[a.priority] - priorityRank[b.priority]
  }).slice(0, 5)

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

      {/* ── Orders by Status — one overall status per Master Order, not a per-item breakdown ── */}
      <Card pad={false} style={{ marginBottom: 14 }}>
        <SectionHeader icon="📦" label="Orders by Status" count={null} open={openSections.orders} onToggle={() => toggleSection('orders')} />
        {openSections.orders && (
          <div style={{ padding: '0 18px 18px' }}>
            {ordersByMO.length === 0 ? <EmptyState icon="📦" title="No orders yet" desc="" /> : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {ordersByMO.map(group => {
                  const groupTxns = flattenTxns(group.orders)
                  // Rollup priority (matches the buyer-facing 4-value overlay): any Delayed
                  // (manually flagged, or a stage deadline that's silently slipped) wins,
                  // then any On Hold, then all-Delivered, else Processing.
                  const overallStatus = (groupTxns.some(t => t.status === 'Delayed') || group.orders.some(o => isScheduleOverdue(o, todayNum))) ? 'Delayed'
                    : groupTxns.some(t => t.status === 'On Hold') ? 'On Hold'
                    : (groupTxns.length > 0 && groupTxns.every(t => t.status === 'Delivered')) ? 'Delivered'
                    : 'Processing'
                  const st = ST[overallStatus] || { bg: '#f1f5f9', c: '#475569' }
                  return (
                    <div key={group.key}
                      onClick={() => onNavigate && onNavigate('orders')}
                      style={{ border: `1px solid ${T.border}`, borderRadius: 10, padding: '12px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12, transition: 'all 0.15s', background: T.surface }}
                      onMouseEnter={e => { e.currentTarget.style.background = st.bg; e.currentTarget.style.borderColor = st.c + '55' }}
                      onMouseLeave={e => { e.currentTarget.style.background = T.surface; e.currentTarget.style.borderColor = T.border }}
                    >
                      <span style={{ fontSize: 13, fontWeight: 700, color: T.text, flex: 1 }}>{group.label}{group.season ? ` · ${group.season}` : ''}</span>
                      <span style={{ fontSize: 11, fontWeight: 600, color: T.textMuted, whiteSpace: 'nowrap' }}>{groupTxns.length} order{groupTxns.length !== 1 ? 's' : ''}</span>
                      <span style={{ padding: '3px 12px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: st.bg, color: st.c, border: `1px solid ${st.c}22`, whiteSpace: 'nowrap' }}>{overallStatus}</span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </Card>

      {/* ── Action Items Summary ── */}
      <Card style={{ marginBottom: 14 }}>
        <FlexRow justify="space-between" style={{ marginBottom: 14 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: T.text }}>🎯 My Action Items</span>
          <Btn size="sm" variant="secondary" onClick={() => onNavigate && onNavigate('action_items')}>Open Action Items →</Btn>
        </FlexRow>
        {combinedOpen.length === 0 ? (
          <EmptyState icon="✅" title="All caught up" desc="No open action items assigned to you" />
        ) : (
          <>
            <FlexRow gap={10} style={{ marginBottom: 14, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 8, background: '#f1f5f9', color: T.textMuted, border: `1px solid ${T.border}` }}>{combinedOpen.length} open</div>
              {overdueItems.length > 0 && <div style={{ fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 8, background: T.dangerBg, color: T.danger, border: `1px solid ${T.dangerBorder}` }}>{overdueItems.length} overdue</div>}
              {dueTodayItems.length > 0 && <div style={{ fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 8, background: T.warningBg, color: T.warning, border: `1px solid ${T.warningBorder}` }}>{dueTodayItems.length} due today</div>}
            </FlexRow>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {topActionItems.map(item => {
                const overdue = item.eta && dayNumber(item.eta) - todayNum < 0
                return (
                  <div key={item.id} onClick={() => item._kind === 'stage' ? (onOpen && onOpen(item.orderId)) : (onNavigate && onNavigate('action_items'))}
                    style={{ border: `1px solid ${overdue ? T.dangerBorder : T.border}`, borderRadius: 8, padding: '8px 12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, background: overdue ? T.dangerBg : '#fafbfc' }}>
                    {item._kind === 'stage' && <span style={{ fontSize: 9, fontWeight: 800, color: T.primaryDark, background: T.primaryLight, padding: '1px 6px', borderRadius: 4 }}>TNA</span>}
                    <span style={{ fontSize: 12, fontWeight: 600, color: T.text, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.title}</span>
                    <span style={{ fontSize: 11, color: T.textMuted, whiteSpace: 'nowrap' }}>{item.buyerCompany || 'Internal'}</span>
                    {item.eta && <span style={{ fontSize: 10, fontWeight: 700, color: overdue ? T.danger : T.textMuted, whiteSpace: 'nowrap' }}>{fmtDate(item.eta)}</span>}
                  </div>
                )
              })}
            </div>
          </>
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
