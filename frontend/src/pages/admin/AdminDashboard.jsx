import { useState, useEffect } from 'react'
import { T, ST, ORDER_STATUSES, isExpiringSoon, isExpired } from '../../constants.js'
import { StatCard, Card, Grid, EmptyState, Mono, PageHeader, Badge, Btn, FlexRow, Modal, Select, Textarea, Input, Alert, LoadingScreen, Tabs, DocCard } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'

export function AdminDashboard({ onNavigate }) {
  const { orders, users, docs, currentUser, loading, getDocData, listAllRibbons, createRibbon, updateRibbon, removeRibbon } = useApp()
  const [tab, setTab] = useState('orders')

  // ── Ribbon management state ──
  const [allRibbons, setAllRibbons] = useState([])
  const [ribbonsLoaded, setRibbonsLoaded] = useState(false)
  const [showRibbon, setShowRibbon] = useState(false)
  const [rf, setRf] = useState({ message: '', type: 'info', audience: 'all', expiresAt: '', targetUserIds: [] })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (currentUser?.role === 'admin' && listAllRibbons) {
      listAllRibbons().then(r => { setAllRibbons(r); setRibbonsLoaded(true) }).catch(() => setRibbonsLoaded(true))
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
  const stCounts = ORDER_STATUSES.map(s => ({ s, c: allTxns.filter(t => t.status === s).length })).filter(x => x.c > 0)

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

  // Auto-delete expired ribbons when ribbons tab is opened
  const handleTabChange = async (newTab) => {
    setTab(newTab)
    if (newTab === 'ribbons') {
      const expired = allRibbons.filter(r => r.expiresAt && new Date(r.expiresAt) < new Date())
      for (const r of expired) {
        try { await removeRibbon(r.id) } catch {}
      }
      if (expired.length > 0) {
        const updated = await listAllRibbons()
        setAllRibbons(updated)
      }
    }
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

      {/* ── Tabbed sections ── */}
      <Card pad={false}>
        <Tabs
          tabs={[
            { id: 'orders',   label: `📦 Orders by Status` },
            { id: 'requests', label: `📋 Buyer Requests (${buyerRequests.length})` },
            { id: 'alerts',   label: `🚨 Alerts (${delayed.length + expDocs.length})` },
            { id: 'ribbons',  label: `📢 Ribbons (${allRibbons.length})` },
          ]}
          active={tab}
          onChange={handleTabChange}
        />

        <div style={{ padding: 20 }}>
          {/* ── TAB: Orders by Status ── */}
          {tab === 'orders' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {stCounts.length === 0 ? <EmptyState icon="📦" title="No orders yet" desc="" /> : stCounts.map(({ s, c }) => {
                const st = ST[s] || { bg: '#f1f5f9', c: '#475569' }
                const pct = allTxns.length > 0 ? Math.round((c / allTxns.length) * 100) : 0
                const statusTxns = allTxns.filter(t => t.status === s)
                return (
                  <div key={s}
                    onClick={() => onNavigate && onNavigate('orders', { status: s })}
                    style={{ border: `1px solid ${T.border}`, borderRadius: 12, padding: '14px 16px', cursor: 'pointer', transition: 'all 0.15s', background: T.surface }}
                    onMouseEnter={e => { e.currentTarget.style.background = st.bg; e.currentTarget.style.borderColor = st.c + '55' }}
                    onMouseLeave={e => { e.currentTarget.style.background = T.surface; e.currentTarget.style.borderColor = T.border }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span style={{ padding: '3px 12px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: st.bg, color: st.c, border: `1px solid ${st.c}22`, whiteSpace: 'nowrap' }}>{s}</span>
                        <span style={{ fontSize: 22, fontWeight: 800, color: st.c, lineHeight: 1 }}>{c}</span>
                        <span style={{ fontSize: 12, color: T.textMuted }}>order{c !== 1 ? 's' : ''} · {pct}%</span>
                      </div>
                      <span style={{ fontSize: 13, color: T.textMuted, fontWeight: 600 }}>View all →</span>
                    </div>
                    <div style={{ height: 6, background: '#f1f5f9', borderRadius: 4, overflow: 'hidden', marginBottom: 10 }}>
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

          {/* ── TAB: Buyer Requests ── */}
          {tab === 'requests' && (
            <div>
              {buyerRequests.length === 0 ? (
                <EmptyState icon="📋" title="No buyer requests yet" desc="Buyer-submitted RFQs, Tech Packs, and Buyer Orders will appear here" />
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                  {buyerRequests.map(d => <DocCard key={d.id} doc={d} users={users} onGetData={getDocData} />)}
                </div>
              )}
            </div>
          )}

          {/* ── TAB: Active Alerts ── */}
          {tab === 'alerts' && (
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
          )}

          {/* ── TAB: Ribbon Notifications ── */}
          {tab === 'ribbons' && (
            <div>
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
        </div>
      </Card>
    </div>
  )
}
