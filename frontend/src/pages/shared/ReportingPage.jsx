import { useMemo, useState } from 'react'
import {
  T, dayNumber, getToday, fmtN,
  stageStatusOf, stageIsOverdue, isStageDone, inFlightStages, stageProgressLabel, stageVariance,
} from '../../constants.js'
import { Btn, Card, EmptyState, FlexRow, Mono, LoadingScreen, PageHeader, ProductThumb, StatCard } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'

// This page answers one question per row: WHERE IS THIS ORDER?
//
// It follows the live action items — the steps actually in play — rather than
// laying out the plan. The full TNA grid lives on the order detail page, which
// is where you go when you want the plan itself.

function fmtDate(d) {
  if (!d || d === 'NA') return '—'
  const dt = new Date(d)
  if (isNaN(dt.getTime())) return '—'
  const dd = String(dt.getDate()).padStart(2, '0')
  const mm = String(dt.getMonth() + 1).padStart(2, '0')
  return `${dd}-${mm}-${dt.getFullYear()}`
}

function toCsvCell(v) {
  const s = String(v ?? '')
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function downloadCsv(rows, filename) {
  const csv = rows.map(r => r.map(toCsvCell).join(',')).join('\r\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

const HEALTH = {
  blocked: { label: 'Blocked', bg: '#fee2e2', fg: '#b91c1c' },
  late:    { label: 'Late',    bg: '#fee2e2', fg: '#b91c1c' },
  risk:    { label: 'At risk', bg: '#fef3c7', fg: '#b45309' },
  ontrack: { label: 'On track', bg: '#d1fae5', fg: '#047857' },
  done:    { label: 'Complete', bg: '#e0e7ff', fg: '#4338ca' },
}

const Chip = ({ tone, children, title }) => (
  <span title={title} style={{
    fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 4,
    background: tone.bg, color: tone.fg, whiteSpace: 'nowrap',
  }}>{children}</span>
)

export function ReportingPage({ onOpen }) {
  const { orders, masterOrders, currentUser, loading, loadError } = useApp()
  const [q, setQ] = useState('')
  const [healthFilter, setHealthFilter] = useState('All')
  const [collapsed, setCollapsed] = useState({})
  const isBuyer = currentUser?.role === 'buyer'
  const todayNum = dayNumber(getToday())

  // One row per order × manufacturer split, summarizing where it stands.
  const rows = useMemo(() => {
    return (orders || []).flatMap(o => (o.assignments || []).map(a => {
      const stages = a.stages || []
      const doneCount = stages.filter(isStageDone).length
      const pct = stages.length ? Math.round((doneCount / stages.length) * 100) : 0

      // The live action items — what someone is (or should be) doing right now.
      const live = inFlightStages(a, { windowDays: 3650 })
      const blocked = live.filter(({ stage }) => stage.blocked)
      const late = live.filter(({ stage }) => stageIsOverdue(stage))
      const working = live.filter(({ stage }) => stageStatusOf(stage) === 'in_progress')

      // Next thing due that isn't already late.
      const upcoming = live
        .filter(({ stage }) => stage.eta && stage.eta !== 'NA' && dayNumber(stage.eta) >= todayNum)
        .sort((x, y) => dayNumber(x.stage.eta) - dayNumber(y.stage.eta))[0] || null

      const deliveryDay = o.delivery ? dayNumber(new Date(o.delivery).toISOString()) : null
      const daysToDelivery = deliveryDay != null ? deliveryDay - todayNum : null

      const health = doneCount === stages.length && stages.length > 0 ? 'done'
        : blocked.length ? 'blocked'
        : late.length ? 'late'
        : (daysToDelivery != null && daysToDelivery < 0) ? 'late'
        : (daysToDelivery != null && daysToDelivery <= 7) ? 'risk'
        : 'ontrack'

      // The freshest word on this style, regardless of which stage it's on —
      // the "Updates" half of the Excel sheet's Planned/New/Actual/Updates row.
      const allUpdates = stages.flatMap(s => (s.updates || []).map(u => ({ ...u, stageName: s.name })))
      const lastUpdate = allUpdates.length
        ? allUpdates.reduce((a, b) => new Date(b.at) > new Date(a.at) ? b : a)
        : null

      return { order: o, asgn: a, stages, doneCount, pct, live, blocked, late, working, upcoming, daysToDelivery, health, lastUpdate }
    }))
  }, [orders, todayNum])

  const filtered = useMemo(() => {
    const m = q.trim().toLowerCase()
    return rows.filter(r => {
      if (healthFilter !== 'All' && r.health !== healthFilter) return false
      if (!m) return true
      return r.order.id.toLowerCase().includes(m)
        || r.order.product.toLowerCase().includes(m)
        || (r.order.buyerCompany || '').toLowerCase().includes(m)
        || (r.asgn.mfrCompany || '').toLowerCase().includes(m)
    })
  }, [rows, q, healthFilter])

  const stats = useMemo(() => ({
    orders: rows.length,
    blocked: rows.filter(r => r.health === 'blocked').length,
    late: rows.filter(r => r.health === 'late').length,
    risk: rows.filter(r => r.health === 'risk').length,
    ontrack: rows.filter(r => r.health === 'ontrack' || r.health === 'done').length,
  }), [rows])

  const groups = useMemo(() => {
    const map = new Map()
    for (const r of filtered) {
      const moId = r.order.masterOrderId || '__none__'
      const key = `${r.order.buyerId || '__none__'}:${moId}`
      if (!map.has(key)) {
        map.set(key, {
          key, moId,
          buyerCompany: r.order.buyerCompany || 'Unknown customer',
          mo: moId !== '__none__' ? (masterOrders || []).find(m => m.id === moId) : null,
          rows: [],
        })
      }
      map.get(key).rows.push(r)
    }
    const result = [...map.values()]
    // Worst-first inside a group: blocked, then late, then nearest delivery.
    const rank = { blocked: 0, late: 1, risk: 2, ontrack: 3, done: 4 }
    for (const g of result) {
      g.rows.sort((a, b) => (rank[a.health] - rank[b.health])
        || ((a.daysToDelivery ?? 9e9) - (b.daysToDelivery ?? 9e9)))
    }
    result.sort((a, b) => a.buyerCompany.localeCompare(b.buyerCompany)
      || new Date(b.mo?.createdAt || 0) - new Date(a.mo?.createdAt || 0))
    return result
  }, [filtered, masterOrders])

  const exportCsv = () => {
    const header = ['Customer', 'Master order', 'Order ID', 'Style', 'Manufacturer', 'Qty',
      'Steps done', 'Total steps', '% complete', 'Health', 'Open now', 'Blocked', 'Past deadline',
      'Next due', 'Next due date', 'Delivery', 'Days to delivery', 'Callout', 'Latest update']
    const body = filtered.map(r => [
      r.order.buyerCompany || '',
      (r.order.masterOrderId && (masterOrders || []).find(m => m.id === r.order.masterOrderId)?.orderName) || '',
      r.order.id, r.order.product, r.asgn.mfrCompany || '', r.asgn.qty ?? '',
      r.doneCount, r.stages.length, r.pct, HEALTH[r.health].label,
      r.live.map(({ stage }) => stage.name).join(' | '),
      r.blocked.length, r.late.length,
      r.upcoming?.stage.name || '', r.upcoming ? fmtDate(r.upcoming.stage.eta) : '',
      fmtDate(r.order.delivery), r.daysToDelivery ?? '', r.order.callout || '',
      r.lastUpdate ? `${r.lastUpdate.stageName}: ${r.lastUpdate.text}` : '',
    ])
    downloadCsv([header, ...body], `order-status-${getToday()}.csv`)
  }

  if (loading) return <LoadingScreen />
  if (loadError) return (
    <Card><EmptyState icon="⚠️" title="Could not load report" desc="Check your connection and refresh the page." /></Card>
  )

  return (
    <div>
      <PageHeader
        title="Order Status"
        subtitle="Where every order stands right now — what's open, what's stuck, what's next"
        action={<Btn variant="secondary" icon="⬇" onClick={exportCsv} disabled={filtered.length === 0}>Export CSV</Btn>}
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12, marginBottom: 14 }} className="grid-responsive-4">
        <StatCard icon="📦" label="Live orders" value={stats.orders} color={T.primary} />
        <StatCard icon="⛔" label="Blocked" value={stats.blocked} color={T.danger} />
        <StatCard icon="🔴" label="Late" value={stats.late} color={T.danger} />
        <StatCard icon="⚠️" label="At risk" value={stats.risk} color={T.warning} />
        <StatCard icon="✅" label="On track" value={stats.ontrack} color={T.success} />
      </div>

      <FlexRow gap={8} style={{ marginBottom: 14 }}>
        <input
          value={q} onChange={e => setQ(e.target.value)}
          placeholder="🔍  Search by customer, order ID, style, or manufacturer…"
          style={{ flex: 1, border: `1px solid ${T.border}`, borderRadius: 9, padding: '9px 14px', fontSize: 13, color: T.text, background: T.surface, fontFamily: 'inherit', boxSizing: 'border-box' }}
        />
        <select
          value={healthFilter} onChange={e => setHealthFilter(e.target.value)}
          style={{ border: `1px solid ${T.border}`, borderRadius: 9, padding: '9px 12px', fontSize: 13, color: T.text, background: T.surface, fontFamily: 'inherit', cursor: 'pointer' }}
        >
          <option value="All">All orders</option>
          {Object.entries(HEALTH).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
      </FlexRow>

      {groups.length === 0 ? (
        <Card><EmptyState icon="📊" title={q || healthFilter !== 'All' ? 'No matching orders' : 'No orders'} desc={q || healthFilter !== 'All' ? 'Try adjusting the search or filter' : 'Orders will appear here'} /></Card>
      ) : groups.map(g => {
        const isOpen = !collapsed[g.key]
        return (
          <Card key={g.key} pad={false} style={{ marginBottom: 12 }}>
            <FlexRow
              gap={10}
              onClick={() => setCollapsed(p => ({ ...p, [g.key]: isOpen }))}
              style={{ padding: '10px 16px', background: '#f1f5f9', borderRadius: '12px 12px 0 0', cursor: 'pointer' }}
            >
              <span style={{ fontSize: 11, color: T.textMuted, transform: isOpen ? 'none' : 'rotate(-90deg)', display: 'inline-block' }}>▾</span>
              <span style={{ fontSize: 13, fontWeight: 800, color: T.text }}>
                📁 {!isBuyer ? `${g.buyerCompany} — ` : ''}{g.mo?.orderName || (g.moId === '__none__' ? 'Other orders' : g.moId)}
              </span>
              {g.mo?.season && <span style={{ fontSize: 10, fontWeight: 700, color: '#0369a1', background: '#dbeafe', padding: '1px 7px', borderRadius: 4 }}>{g.mo.season}</span>}
              <span style={{ fontSize: 11, color: T.textMuted, marginLeft: 'auto' }}>{g.rows.length} order{g.rows.length !== 1 ? 's' : ''}</span>
            </FlexRow>

            {isOpen && (
              <div className="table-scroll">
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1020 }}>
                  <thead>
                    <tr style={{ background: '#f8fafc' }}>
                      {['Style', 'Progress', 'Open right now', 'Next due', 'Delivery', ''].map(h => (
                        <th key={h} style={{ padding: '9px 14px', textAlign: 'left', fontSize: 10, fontWeight: 800, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.07em', whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {g.rows.map(r => {
                      const tone = HEALTH[r.health]
                      const multi = (r.order.assignments || []).length > 1
                      return (
                        <tr
                          key={`${r.order.id}-${r.asgn.mid}`}
                          onClick={() => onOpen?.(r.order.id, r.asgn.mid)}
                          style={{ borderTop: `1px solid ${T.border}`, cursor: 'pointer', background: r.health === 'blocked' || r.health === 'late' ? '#fffbfb' : 'transparent' }}
                        >
                          <td style={{ padding: '10px 14px', minWidth: 230 }}>
                            <FlexRow gap={8}>
                              <ProductThumb order={r.order} size="sm" />
                              <div style={{ minWidth: 0 }}>
                                <div style={{ fontSize: 13, fontWeight: 600, color: T.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 190 }}>
                                  {r.order.product}
                                </div>
                                <Mono style={{ fontSize: 10 }}>{r.order.id}{multi ? `-${r.asgn.sub}` : ''}</Mono>
                                <div style={{ fontSize: 10, color: T.textLight }}>{r.asgn.mfrCompany || '—'} · {fmtN(r.asgn.qty)} pcs</div>
                              </div>
                            </FlexRow>
                          </td>

                          <td style={{ padding: '10px 14px', minWidth: 140 }}>
                            <FlexRow gap={6}>
                              <Chip tone={tone}>{tone.label}</Chip>
                              <span style={{ fontSize: 11, fontWeight: 700, color: T.textMuted }}>{r.pct}%</span>
                            </FlexRow>
                            <div style={{ height: 4, background: '#e2e8f0', borderRadius: 3, marginTop: 5, overflow: 'hidden' }}>
                              <div style={{ width: `${r.pct}%`, height: '100%', background: tone.fg }} />
                            </div>
                            <div style={{ fontSize: 10, color: T.textLight, marginTop: 3 }}>{r.doneCount}/{r.stages.length} steps done</div>
                          </td>

                          <td style={{ padding: '10px 14px', minWidth: 260 }}>
                            {r.live.length === 0 ? (
                              <span style={{ fontSize: 11, color: T.textLight, fontStyle: 'italic' }}>Nothing open</span>
                            ) : (
                              <>
                                <FlexRow gap={4} style={{ flexWrap: 'wrap' }}>
                                  {r.blocked.length > 0 && <Chip tone={HEALTH.blocked} title={r.blocked.map(({ stage }) => stage.blockedReason || stage.name).join('\n')}>⛔ {r.blocked.length} blocked</Chip>}
                                  {r.late.length > 0 && <Chip tone={HEALTH.late}>🔴 {r.late.length} past deadline</Chip>}
                                  {r.working.length > 0 && <Chip tone={{ bg: '#dbeafe', fg: '#1d4ed8' }}>▶ {r.working.length} in progress</Chip>}
                                </FlexRow>
                                <div style={{ fontSize: 11, color: T.text, marginTop: 4, lineHeight: 1.45 }}>
                                  {r.live.slice(0, 2).map(({ stage, index }) => {
                                    const v = stageVariance(stage)
                                    const dueStr = stage.eta && stage.eta !== 'NA' ? fmtDate(stage.eta) : null
                                    return (
                                      <div key={index} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 250 }}>
                                        · {stage.name} <span style={{ color: T.textLight }}>({stageProgressLabel(stage)})</span>
                                        {dueStr && (
                                          <span style={{ color: T.textLight }}>
                                            {' '}— due {dueStr}{v != null && v !== 0 ? `, ${v > 0 ? '+' : ''}${v}d` : ''}
                                          </span>
                                        )}
                                      </div>
                                    )
                                  })}
                                  {r.live.length > 2 && <div style={{ color: T.textLight }}>+{r.live.length - 2} more</div>}
                                </div>
                              </>
                            )}
                            {r.order.callout && (
                              <div style={{ fontSize: 10, color: '#b45309', background: '#fef3c7', borderRadius: 4, padding: '3px 6px', marginTop: 5 }} title={r.order.callout}>
                                ⚠ {r.order.callout.length > 60 ? `${r.order.callout.slice(0, 60)}…` : r.order.callout}
                              </div>
                            )}
                            {r.lastUpdate && (
                              <div style={{ fontSize: 10, color: T.textMuted, marginTop: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 250 }}
                                title={`${r.lastUpdate.stageName}: ${r.lastUpdate.text}`}>
                                💬 {r.lastUpdate.text.length > 60 ? `${r.lastUpdate.text.slice(0, 60)}…` : r.lastUpdate.text}
                              </div>
                            )}
                          </td>

                          <td style={{ padding: '10px 14px', minWidth: 170 }}>
                            {r.upcoming ? (
                              <>
                                <div style={{ fontSize: 12, color: T.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 160 }}>{r.upcoming.stage.name}</div>
                                <div style={{ fontSize: 11, color: T.textMuted, fontFamily: "'JetBrains Mono',monospace" }}>{fmtDate(r.upcoming.stage.eta)}</div>
                              </>
                            ) : <span style={{ fontSize: 11, color: T.textLight }}>—</span>}
                          </td>

                          <td style={{ padding: '10px 14px', whiteSpace: 'nowrap' }}>
                            <div style={{ fontSize: 12, color: T.text, fontFamily: "'JetBrains Mono',monospace" }}>{fmtDate(r.order.delivery)}</div>
                            {r.daysToDelivery != null && (
                              <div style={{ fontSize: 11, fontWeight: 700, color: r.daysToDelivery < 0 ? T.danger : r.daysToDelivery <= 7 ? '#b45309' : T.textMuted }}>
                                {r.daysToDelivery < 0 ? `${Math.abs(r.daysToDelivery)}d overdue` : `${r.daysToDelivery}d left`}
                              </div>
                            )}
                          </td>

                          <td style={{ padding: '10px 14px', textAlign: 'right', color: T.textLight }}>›</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )
      })}
    </div>
  )
}
