import { useState, useMemo } from 'react'
import { T } from '../../constants.js'
import { Card, PageHeader, EmptyState, FlexRow, LoadingScreen } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'

const ACTION_META = {
  'Order Created':     { bg: '#dcfce7', c: '#15803d', border: '#86efac', icon: '📦' },
  'Status Update':     { bg: '#dbeafe', c: '#1d4ed8', border: '#93c5fd', icon: '🔄' },
  'Document Uploaded': { bg: '#ede9fe', c: '#6d28d9', border: '#c4b5fd', icon: '📎' },
  'User Created':      { bg: '#ccfbf1', c: '#0f766e', border: '#5eead4', icon: '👤' },
  'User Deactivated':  { bg: '#fee2e2', c: '#dc2626', border: '#fca5a5', icon: '🚫' },
  'User Activated':    { bg: '#dcfce7', c: '#16a34a', border: '#86efac', icon: '✅' },
  'Password Reset':    { bg: '#fef3c7', c: '#d97706', border: '#fde68a', icon: '🔑' },
}

const PAGE_SIZE = 20

function fmtDDMMYYYY(d) {
  if (!d) return '—'
  const dt = new Date(d)
  const dd = String(dt.getDate()).padStart(2, '0')
  const mm = String(dt.getMonth() + 1).padStart(2, '0')
  return `${dd}-${mm}-${dt.getFullYear()}`
}

function fmtTimestamp(d) {
  if (!d) return '—'
  const dt = new Date(d)
  return fmtDDMMYYYY(d) + ' · ' + dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

function relativeTime(d) {
  if (!d) return ''
  const diff = Date.now() - new Date(d).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days}d ago`
  return fmtDDMMYYYY(d)
}

function dateGroup(d) {
  if (!d) return 'Unknown'
  const dt = new Date(d)
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const yest = new Date(today); yest.setDate(yest.getDate() - 1)
  const entry = new Date(dt); entry.setHours(0, 0, 0, 0)
  if (entry.getTime() === today.getTime()) return 'Today'
  if (entry.getTime() === yest.getTime()) return 'Yesterday'
  return fmtDDMMYYYY(d)
}

export function AdminAuditLog() {
  const { audit, users, loading } = useApp()
  const [q, setQ] = useState('')
  const [actionFilt, setActionFilt] = useState('All')
  const [userFilt, setUserFilt] = useState('All')
  const [page, setPage] = useState(1)

  if (loading) return <LoadingScreen />

  const sorted = useMemo(
    () => [...audit].sort((a, b) => new Date(b.at) - new Date(a.at)),
    [audit]
  )

  const actionCounts = useMemo(
    () => Object.keys(ACTION_META).reduce((acc, key) => {
      acc[key] = audit.filter(a => a.action === key).length
      return acc
    }, {}),
    [audit]
  )

  const adminUsers = users.filter(u => u.role === 'admin')

  const filtered = useMemo(() => sorted.filter(a => {
    const u = users.find(x => x.id === a.by)
    const matchQ = !q
      || a.detail?.toLowerCase().includes(q.toLowerCase())
      || u?.name?.toLowerCase().includes(q.toLowerCase())
      || u?.company?.toLowerCase().includes(q.toLowerCase())
    const matchAction = actionFilt === 'All' || a.action === actionFilt
    const matchUser = userFilt === 'All' || String(a.by) === String(userFilt)
    return matchQ && matchAction && matchUser
  }), [sorted, q, actionFilt, userFilt, users])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const paginated = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  const groupOrder = [...new Set(paginated.map(e => dateGroup(e.at)))]
  const grouped = paginated.reduce((acc, entry) => {
    const g = dateGroup(entry.at)
    if (!acc[g]) acc[g] = []
    acc[g].push(entry)
    return acc
  }, {})

  const hasFilters = q || actionFilt !== 'All' || userFilt !== 'All'

  const resetFilters = () => { setQ(''); setActionFilt('All'); setUserFilt('All'); setPage(1) }
  const goPage = p => setPage(Math.max(1, Math.min(totalPages, p)))

  // ── Pagination page numbers (up to 5 visible) ──
  const pageNumbers = (() => {
    if (totalPages <= 5) return Array.from({ length: totalPages }, (_, i) => i + 1)
    if (safePage <= 3) return [1, 2, 3, 4, 5]
    if (safePage >= totalPages - 2) return [totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages]
    return [safePage - 2, safePage - 1, safePage, safePage + 1, safePage + 2]
  })()

  return (
    <div>
      <PageHeader
        title="Audit Log"
        subtitle={`${audit.length.toLocaleString()} total entries · complete record of all platform actions`}
      />

      {/* ── Action type summary pills ── */}
      {audit.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
          {Object.entries(ACTION_META).filter(([k]) => actionCounts[k] > 0).map(([key, meta]) => {
            const active = actionFilt === key
            return (
              <button key={key}
                onClick={() => { setActionFilt(active ? 'All' : key); setPage(1) }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '5px 12px', borderRadius: 20,
                  fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                  transition: 'all 0.15s',
                  background: active ? meta.c : meta.bg,
                  color: active ? '#fff' : meta.c,
                  border: `1.5px solid ${active ? meta.c : meta.border}`,
                  boxShadow: active ? `0 2px 8px ${meta.c}40` : 'none',
                }}>
                <span style={{ fontSize: 14 }}>{meta.icon}</span>
                <span>{key}</span>
                <span style={{
                  background: active ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.1)',
                  borderRadius: 10, padding: '0 6px', fontSize: 10, fontWeight: 800,
                }}>{actionCounts[key]}</span>
              </button>
            )
          })}
        </div>
      )}

      {/* ── Filter bar ── */}
      <Card pad={false} style={{ marginBottom: 16 }}>
        <div style={{ padding: '12px 16px', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            value={q}
            onChange={e => { setQ(e.target.value); setPage(1) }}
            placeholder="🔍  Search detail or user…"
            style={{ flex: 1, minWidth: 200, border: `1px solid ${T.border}`, borderRadius: 8, padding: '7px 12px', fontSize: 13, color: T.text, background: '#f8fafc', fontFamily: 'inherit', outline: 'none' }}
          />
          <select value={actionFilt} onChange={e => { setActionFilt(e.target.value); setPage(1) }}
            style={{ border: `1px solid ${T.border}`, borderRadius: 8, padding: '7px 12px', fontSize: 13, color: T.text, background: T.surface, fontFamily: 'inherit' }}>
            <option value="All">All Actions</option>
            {Object.keys(ACTION_META).map(a => <option key={a}>{a}</option>)}
          </select>
          {adminUsers.length > 1 && (
            <select value={userFilt} onChange={e => { setUserFilt(e.target.value); setPage(1) }}
              style={{ border: `1px solid ${T.border}`, borderRadius: 8, padding: '7px 12px', fontSize: 13, color: T.text, background: T.surface, fontFamily: 'inherit' }}>
              <option value="All">All Admins</option>
              {adminUsers.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          )}
          {hasFilters && (
            <button onClick={resetFilters}
              style={{ padding: '7px 12px', borderRadius: 8, border: `1px solid ${T.border}`, background: '#f1f5f9', color: T.textMuted, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
              Clear ×
            </button>
          )}
        </div>
        {hasFilters && (
          <div style={{ padding: '7px 16px', borderTop: `1px solid ${T.border}`, background: '#fafbfd', fontSize: 12, color: T.textMuted }}>
            Showing <strong style={{ color: T.text }}>{filtered.length}</strong> of {audit.length} entries
          </div>
        )}
      </Card>

      {/* ── Log feed ── */}
      {filtered.length === 0 ? (
        <Card>
          <EmptyState icon="🔍" title="No matching entries" desc="Try adjusting your search or filters" />
        </Card>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          {groupOrder.map(group => (
            <div key={group}>
              {/* Date group header */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
                <span style={{ fontSize: 11, fontWeight: 800, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.09em', whiteSpace: 'nowrap' }}>
                  {group}
                </span>
                <div style={{ flex: 1, height: 1, background: T.border }} />
                <span style={{ fontSize: 11, color: T.textLight, whiteSpace: 'nowrap' }}>
                  {grouped[group].length} {grouped[group].length === 1 ? 'entry' : 'entries'}
                </span>
              </div>

              {/* Entry cards */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {grouped[group].map(a => {
                  const u = users.find(x => x.id === a.by)
                  const meta = ACTION_META[a.action] || { bg: '#f1f5f9', c: '#475569', border: T.border, icon: '⚡' }
                  return (
                    <div key={a.id}
                      style={{ display: 'flex', gap: 0, background: T.surface, borderRadius: 10, border: `1px solid ${T.border}`, overflow: 'hidden', transition: 'box-shadow 0.15s, border-color 0.15s' }}
                      onMouseEnter={e => { e.currentTarget.style.boxShadow = '0 2px 10px rgba(0,0,0,0.07)'; e.currentTarget.style.borderColor = T.borderHover }}
                      onMouseLeave={e => { e.currentTarget.style.boxShadow = 'none'; e.currentTarget.style.borderColor = T.border }}
                    >
                      {/* Color accent bar */}
                      <div style={{ width: 4, flexShrink: 0, background: meta.c }} />

                      <div style={{ flex: 1, padding: '12px 16px', display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                        {/* Action icon */}
                        <div style={{
                          width: 36, height: 36, borderRadius: 10, flexShrink: 0,
                          background: meta.bg, border: `1px solid ${meta.border}`,
                          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 17,
                        }}>
                          {meta.icon}
                        </div>

                        {/* Main body */}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 5 }}>
                            <span style={{
                              fontSize: 10, fontWeight: 800, padding: '2px 9px', borderRadius: 20,
                              background: meta.bg, color: meta.c, border: `1px solid ${meta.border}`,
                              letterSpacing: '0.03em', textTransform: 'uppercase', whiteSpace: 'nowrap',
                            }}>{a.action}</span>
                            {u && (
                              <span style={{ fontSize: 12, color: T.textMuted }}>
                                by{' '}
                                <span style={{ fontWeight: 700, color: T.text }}>{u.name}</span>
                                {u.adminType === 'master' && (
                                  <span style={{ marginLeft: 5, fontSize: 10, fontWeight: 700, color: '#7c3aed', background: '#ede9fe', border: '1px solid #c4b5fd', padding: '1px 6px', borderRadius: 6 }}>
                                    👑 Master
                                  </span>
                                )}
                              </span>
                            )}
                          </div>
                          <div style={{ fontSize: 13, color: T.text, fontFamily: "'JetBrains Mono',monospace", wordBreak: 'break-word', lineHeight: 1.55, opacity: 0.85 }}>
                            {a.detail || '—'}
                          </div>
                        </div>

                        {/* Timestamp */}
                        <div style={{ textAlign: 'right', flexShrink: 0, paddingTop: 2 }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: T.textMuted, whiteSpace: 'nowrap' }}>
                            {relativeTime(a.at)}
                          </div>
                          <div style={{ fontSize: 10, color: T.textLight, whiteSpace: 'nowrap', marginTop: 3 }}>
                            {fmtTimestamp(a.at)}
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Pagination ── */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 6, marginTop: 28, paddingBottom: 8 }}>
          <PagBtn onClick={() => goPage(1)} disabled={safePage === 1}>«</PagBtn>
          <PagBtn onClick={() => goPage(safePage - 1)} disabled={safePage === 1}>‹</PagBtn>

          {pageNumbers[0] > 1 && (
            <>
              <PagBtn onClick={() => goPage(1)}>1</PagBtn>
              {pageNumbers[0] > 2 && <span style={{ color: T.textLight, fontSize: 13, padding: '0 2px' }}>…</span>}
            </>
          )}

          {pageNumbers.map(p => (
            <PagBtn key={p} onClick={() => goPage(p)} active={p === safePage}>{p}</PagBtn>
          ))}

          {pageNumbers[pageNumbers.length - 1] < totalPages && (
            <>
              {pageNumbers[pageNumbers.length - 1] < totalPages - 1 && <span style={{ color: T.textLight, fontSize: 13, padding: '0 2px' }}>…</span>}
              <PagBtn onClick={() => goPage(totalPages)}>{totalPages}</PagBtn>
            </>
          )}

          <PagBtn onClick={() => goPage(safePage + 1)} disabled={safePage === totalPages}>›</PagBtn>
          <PagBtn onClick={() => goPage(totalPages)} disabled={safePage === totalPages}>»</PagBtn>

          <span style={{ fontSize: 12, color: T.textMuted, marginLeft: 6, whiteSpace: 'nowrap' }}>
            {((safePage - 1) * PAGE_SIZE) + 1}–{Math.min(safePage * PAGE_SIZE, filtered.length)} of {filtered.length}
          </span>
        </div>
      )}
    </div>
  )
}

function PagBtn({ children, onClick, disabled, active }) {
  return (
    <button onClick={onClick} disabled={disabled}
      style={{
        minWidth: 34, height: 34, borderRadius: 8, padding: '0 10px',
        border: `1px solid ${active ? T.primary : T.border}`,
        background: active ? T.primary : disabled ? '#f8fafc' : T.surface,
        color: active ? '#fff' : disabled ? T.textLight : T.text,
        cursor: disabled ? 'default' : 'pointer',
        fontSize: 13, fontWeight: active ? 700 : 400,
        fontFamily: 'inherit', transition: 'all 0.15s',
        boxShadow: active ? `0 2px 8px ${T.primary}40` : 'none',
      }}>
      {children}
    </button>
  )
}
