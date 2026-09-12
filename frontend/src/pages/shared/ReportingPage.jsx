import { useMemo, useState } from 'react'
import { CalendarClock, AlertTriangle, Package, Ban, CircleDot, CheckCircle2, Search, BarChart3, Folder, MessageCircle, Calendar, ChevronDown, ChevronRight, Play, Download, ArrowRight } from 'lucide-react'
import {
  T, dayNumber, getToday, fmtN,
  stageStatusOf, stageIsOverdue, isStageDone, inFlightStages, stageProgressLabel, stageVariance,
} from '../../constants.js'
import { Btn, Card, EmptyState, FlexRow, Modal, Mono, LoadingScreen, PageHeader, ProductThumb, StatCard, activateOnKey } from '../../components/ui.jsx'
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

const GANTT_LEGEND = [
  ['Done', 'success'],
  ['In progress', 'primary'],
  ['Blocked', 'blocked'],
  ['Late', 'danger'],
  ['Upcoming', 'pending'],
]

// Plain HTML/CSS timeline — one row per stage, a bar from its planned start to
// its eta on a shared day-scale, colored by current state. A stage whose
// startDate equals its eta (a milestone like "Dyeing Start"/"Production
// Start", or any other single-day step) renders as a diamond instead of an
// invisible zero-width bar — the standard Gantt convention for a
// zero-duration item. A thin line marks today so slippage reads at a glance.
function GanttChart({ asgn }) {
  const stages = asgn.stages || []
  const todayNum = dayNumber(getToday())

  const validDays = stages
    .flatMap(s => [s.startDate, s.eta])
    .filter(d => d && d !== 'NA')
    .map(dayNumber)
    .filter(d => d != null)

  const colorFor = key => key === 'success' ? T.success : key === 'primary' ? T.primary
    : key === 'blocked' ? '#7c3aed' : key === 'danger' ? T.danger : '#cbd5e1'

  if (validDays.length === 0) {
    return <EmptyState icon={<CalendarClock size={26} color={T.textLight} />} title="No dates on this timeline" desc="This order's stages don't have start/end dates set yet." />
  }

  const minDay = Math.min(...validDays, todayNum)
  const maxDay = Math.max(...validDays, todayNum)
  const span = Math.max(1, maxDay - minDay)
  const pctForDay = day => ((day - minDay) / span) * 100
  const todayPct = pctForDay(todayNum)

  return (
    <div>
      <FlexRow gap={16} style={{ marginBottom: 16, flexWrap: 'wrap' }}>
        {GANTT_LEGEND.map(([label, key]) => (
          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: colorFor(key), display: 'inline-block', flexShrink: 0 }} />
            <span style={{ fontSize: 11, fontWeight: 600, color: T.textMuted }}>{label}</span>
          </div>
        ))}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
          <span style={{ width: 1, height: 12, background: T.textLight, display: 'inline-block' }} />
          <span style={{ fontSize: 11, fontWeight: 600, color: T.textMuted }}>Today ({fmtDate(getToday())})</span>
        </div>
      </FlexRow>

      <div style={{ overflowX: 'auto' }}>
        <div style={{ minWidth: 620, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {stages.map((s, i) => {
            const done = isStageDone(s)
            const hasDates = s.startDate && s.startDate !== 'NA' && s.eta && s.eta !== 'NA'
            const overdue = !done && hasDates && stageIsOverdue(s)
            const colorKey = done ? 'success' : s.blocked ? 'blocked' : overdue ? 'danger'
              : stageStatusOf(s) === 'in_progress' ? 'primary' : 'pending'
            const left = hasDates ? pctForDay(dayNumber(s.startDate)) : 0
            const rawWidth = hasDates ? pctForDay(dayNumber(s.eta)) - left : 0
            const isMilestone = hasDates && (s.startDate === s.eta || rawWidth < 0.6)
            const width = Math.max(1.5, rawWidth)
            const tip = hasDates
              ? `${s.name}: ${fmtDate(s.startDate)}${isMilestone ? '' : ` → ${fmtDate(s.eta)}`} · ${stageProgressLabel(s)}`
              : s.name
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 0' }}>
                <div
                  title={s.name}
                  style={{ width: 190, flexShrink: 0, fontSize: 12, fontWeight: colorKey === 'primary' ? 700 : 500, color: colorKey === 'primary' ? T.text : T.textMuted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                >
                  {i + 1}. {s.name}
                </div>
                <div style={{ flex: 1, position: 'relative', height: 22, background: '#f8fafc', borderRadius: 5 }}>
                  <div style={{ position: 'absolute', left: `${todayPct}%`, top: -3, bottom: -3, width: 1, background: T.textLight }} />
                  {hasDates ? (
                    isMilestone ? (
                      <div
                        title={tip}
                        style={{ position: 'absolute', left: `calc(${left}% - 5px)`, top: '50%', width: 10, height: 10, background: colorFor(colorKey), borderRadius: 2, transform: 'translateY(-50%) rotate(45deg)' }}
                      />
                    ) : (
                      <div
                        title={tip}
                        style={{ position: 'absolute', left: `${left}%`, width: `${width}%`, top: 3, bottom: 3, minWidth: 6, background: colorFor(colorKey), borderRadius: 4 }}
                      />
                    )
                  ) : (
                    <span style={{ position: 'absolute', left: 6, top: 3, fontSize: 10, color: T.textLight, fontStyle: 'italic' }}>No date</span>
                  )}
                </div>
                <span style={{ fontSize: 10, color: T.textMuted, width: 76, flexShrink: 0, textAlign: 'right', fontFamily: "'JetBrains Mono',monospace" }}>
                  {hasDates ? fmtDate(s.eta) : '—'}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function GanttModal({ order, asgn, onClose, onOpen }) {
  const multi = (order.assignments || []).length > 1
  return (
    <Modal
      title={order.product}
      subtitle={`${order.id}${multi ? `-${asgn.sub}` : ''} · ${asgn.mfrCompany || 'Manufacturer'} · ${asgn.qty?.toLocaleString() || 0} pcs`}
      size="xxl"
      onClose={onClose}
    >
      <GanttChart asgn={asgn} />
      <FlexRow justify="flex-end" gap={8} style={{ marginTop: 20 }}>
        <Btn variant="secondary" onClick={onClose}>Close</Btn>
        {onOpen && <Btn onClick={() => { onClose(); onOpen(order.id, asgn.mid) }}>Open Order <ArrowRight size={13} style={{ marginLeft: -2 }} /></Btn>}
      </FlexRow>
    </Modal>
  )
}

export function ReportingPage({ onOpen }) {
  const { orders, masterOrders, currentUser, loading, loadError } = useApp()
  const [q, setQ] = useState('')
  const [healthFilter, setHealthFilter] = useState('All')
  const [collapsed, setCollapsed] = useState({})
  const [ganttTarget, setGanttTarget] = useState(null)
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
    <Card><EmptyState icon={<AlertTriangle size={26} color={T.textLight} />} title="Could not load report" desc="Check your connection and refresh the page." /></Card>
  )

  return (
    <div>
      <PageHeader
        title="Order Status"
        subtitle="Where every order stands right now — what's open, what's stuck, what's next"
        action={<Btn variant="secondary" icon={<Download size={16} />} onClick={exportCsv} disabled={filtered.length === 0}>Export CSV</Btn>}
      />

      <div style={{ gap: 12, marginBottom: 14 }} className="grid-responsive-5">
        <StatCard icon={<Package size={19} color={T.primary} />} label="Live orders" value={stats.orders} color={T.primary} />
        <StatCard icon={<Ban size={19} color={T.danger} />} label="Blocked" value={stats.blocked} color={T.danger} />
        <StatCard icon={<CircleDot size={19} color={T.danger} />} label="Late" value={stats.late} color={T.danger} />
        <StatCard icon={<AlertTriangle size={19} color={T.warning} />} label="At risk" value={stats.risk} color={T.warning} />
        <StatCard icon={<CheckCircle2 size={19} color={T.success} />} label="On track" value={stats.ontrack} color={T.success} />
      </div>

      <FlexRow gap={8} style={{ marginBottom: 14 }}>
        <div style={{ position: 'relative', flex: 1 }}>
          <Search size={14} color={T.textLight} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} />
          <input
            value={q} onChange={e => setQ(e.target.value)}
            placeholder="Search by customer, order ID, style, or manufacturer…"
            style={{ width: '100%', border: `1px solid ${T.border}`, borderRadius: 9, padding: '9px 14px 9px 34px', fontSize: 13, color: T.text, background: T.surface, fontFamily: 'inherit', boxSizing: 'border-box' }}
          />
        </div>
        <select
          value={healthFilter} onChange={e => setHealthFilter(e.target.value)}
          style={{ border: `1px solid ${T.border}`, borderRadius: 9, padding: '9px 12px', fontSize: 13, color: T.text, background: T.surface, fontFamily: 'inherit', cursor: 'pointer' }}
        >
          <option value="All">All orders</option>
          {Object.entries(HEALTH).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
      </FlexRow>

      {groups.length === 0 ? (
        <Card><EmptyState icon={<BarChart3 size={26} color={T.textLight} />} title={q || healthFilter !== 'All' ? 'No matching orders' : 'No orders'} desc={q || healthFilter !== 'All' ? 'Try adjusting the search or filter' : 'Orders will appear here'} /></Card>
      ) : groups.map(g => {
        const isOpen = !collapsed[g.key]
        return (
          <Card key={g.key} pad={false} style={{ marginBottom: 12 }}>
            <FlexRow
              gap={10}
              onClick={() => setCollapsed(p => ({ ...p, [g.key]: isOpen }))}
              style={{ padding: '10px 16px', background: '#f1f5f9', borderRadius: '12px 12px 0 0', cursor: 'pointer' }}
            >
              <span style={{ color: T.textMuted, transform: isOpen ? 'none' : 'rotate(-90deg)', display: 'inline-flex' }}><ChevronDown size={13} /></span>
              <span style={{ fontSize: 13, fontWeight: 800, color: T.text, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <Folder size={13} /> {!isBuyer ? `${g.buyerCompany} — ` : ''}{g.mo?.orderName || (g.moId === '__none__' ? 'Other orders' : g.moId)}
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
                          onClick={() => onOpen?.(r.order.id, r.asgn.mid)} role="button" tabIndex={0} onKeyDown={activateOnKey(() => onOpen?.(r.order.id, r.asgn.mid))}
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
                                  {r.blocked.length > 0 && <Chip tone={HEALTH.blocked} title={r.blocked.map(({ stage }) => stage.blockedReason || stage.name).join('\n')}><Ban size={9} style={{ marginRight: 3, verticalAlign: -1 }} />{r.blocked.length} blocked</Chip>}
                                  {r.late.length > 0 && <Chip tone={HEALTH.late}><CircleDot size={9} style={{ marginRight: 3, verticalAlign: -1 }} />{r.late.length} past deadline</Chip>}
                                  {r.working.length > 0 && <Chip tone={{ bg: '#dbeafe', fg: '#1d4ed8' }}><Play size={8} style={{ marginRight: 3, verticalAlign: -1 }} fill="#1d4ed8" />{r.working.length} in progress</Chip>}
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
                              <div style={{ fontSize: 10, color: '#b45309', background: '#fef3c7', borderRadius: 4, padding: '3px 6px', marginTop: 5, display: 'flex', alignItems: 'flex-start', gap: 3 }} title={r.order.callout}>
                                <AlertTriangle size={10} style={{ flexShrink: 0, marginTop: 1 }} /> {r.order.callout.length > 60 ? `${r.order.callout.slice(0, 60)}…` : r.order.callout}
                              </div>
                            )}
                            {r.lastUpdate && (
                              <div style={{ fontSize: 10, color: T.textMuted, marginTop: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 250, display: 'flex', alignItems: 'center', gap: 3 }}
                                title={`${r.lastUpdate.stageName}: ${r.lastUpdate.text}`}>
                                <MessageCircle size={10} style={{ flexShrink: 0 }} /> {r.lastUpdate.text.length > 60 ? `${r.lastUpdate.text.slice(0, 60)}…` : r.lastUpdate.text}
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

                          <td style={{ padding: '10px 14px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                            <button
                              onClick={e => { e.stopPropagation(); setGanttTarget({ order: r.order, asgn: r.asgn }) }}
                              title="View timeline"
                              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, marginRight: 4, display: 'inline-flex', verticalAlign: 'middle', color: T.textMuted }}
                            ><Calendar size={15} /></button>
                            <ChevronRight size={14} color={T.textLight} />
                          </td>
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

      {ganttTarget && (
        <GanttModal order={ganttTarget.order} asgn={ganttTarget.asgn} onClose={() => setGanttTarget(null)} onOpen={onOpen} />
      )}
    </div>
  )
}
