import { useMemo, useState } from 'react'
import { T, ST, REPORT_STATUSES, dayNumber, getToday } from '../../constants.js'
import { Badge, Btn, Card, EmptyState, FlexRow, Mono, LoadingScreen, PageHeader, Modal, ProductThumb } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'

function fmtDate(d) {
  if (!d || d === 'NA') return '—'
  const dt = new Date(d)
  const dd = String(dt.getDate()).padStart(2, '0')
  const mm = String(dt.getMonth() + 1).padStart(2, '0')
  return `${dd}-${mm}-${dt.getFullYear()}`
}

// First stage not yet complete — the one actually "in progress" right now.
function activeStage(stages) {
  return (stages || []).find(s => (s.unitsDone || 0) < (s.totalUnits || 0)) || null
}

// Schedule-derived status: Delayed if the active stage's planned ETA has passed,
// On Track if it's still ahead, In Progress if no ETA has been set to judge against.
function computeStatus(stage) {
  if (!stage) return 'Complete'
  if (!stage.eta || stage.eta === 'NA') return 'In Progress'
  const etaDay = dayNumber(stage.eta)
  if (etaDay == null) return 'In Progress'
  return etaDay < dayNumber(getToday()) ? 'Delayed' : 'On Track'
}

function latestUpdate(stage) {
  const updates = stage?.updates || []
  return updates.length ? updates[updates.length - 1] : null
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

const GANTT_LEGEND = [
  ['Done', 'success'],
  ['On Track', 'primary'],
  ['Delayed', 'danger'],
  ['Pending', 'pending'],
]

// Plain HTML/CSS timeline — one row per stage, a bar from its planned start to its
// ETA on a shared day-scale, colored by state (done / active-on-track / overdue /
// not-yet-started). A thin line marks today so schedule slippage reads at a glance.
function GanttChart({ asgn }) {
  const stages = asgn.stages || []
  const todayNum = dayNumber(getToday())
  const activeIdx = stages.findIndex(s => (s.unitsDone || 0) < (s.totalUnits || 0))

  const validDays = stages
    .flatMap(s => [s.startDate, s.eta])
    .filter(d => d && d !== 'NA')
    .map(dayNumber)
    .filter(d => d != null)

  const colorFor = key => key === 'success' ? T.success : key === 'primary' ? T.primary : key === 'danger' ? T.danger : '#cbd5e1'

  if (validDays.length === 0) {
    return <EmptyState icon="📅" title="No dates on this timeline" desc="This order's stages don't have start/end dates set yet." />
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
            const done = s.totalUnits > 0 && s.unitsDone >= s.totalUnits
            const isActive = i === activeIdx
            const hasDates = s.startDate && s.startDate !== 'NA' && s.eta && s.eta !== 'NA'
            const overdue = !done && hasDates && dayNumber(s.eta) - todayNum < 0
            const colorKey = done ? 'success' : overdue ? 'danger' : isActive ? 'primary' : 'pending'
            const left = hasDates ? pctForDay(dayNumber(s.startDate)) : 0
            const rawWidth = hasDates ? pctForDay(dayNumber(s.eta)) - left : 0
            // Many TNA stages are single-day milestones (start === end) — a task bar
            // would render as an invisible sliver, so those get a diamond marker
            // instead, the standard Gantt convention for a zero-duration stage.
            const isMilestone = hasDates && rawWidth < 0.6
            const width = Math.max(1.5, rawWidth)
            const tip = hasDates ? `${s.name}: ${fmtDate(s.startDate)}${isMilestone ? '' : ` → ${fmtDate(s.eta)}`} · ${s.unitsDone || 0}/${s.totalUnits || 0} units` : s.name
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 0' }}>
                <div
                  title={s.name}
                  style={{ width: 190, flexShrink: 0, fontSize: 12, fontWeight: isActive ? 700 : 500, color: isActive ? T.text : T.textMuted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
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
        {onOpen && <Btn onClick={() => { onClose(); onOpen(order.id, asgn.mid) }}>Open Order →</Btn>}
      </FlexRow>
    </Modal>
  )
}

export function ReportingPage({ onOpen }) {
  const { orders, masterOrders, currentUser, loading, loadError } = useApp()
  const [q, setQ] = useState('')
  const [sf, setSf] = useState('All')
  const [expandedGroups, setExpandedGroups] = useState(() => new Set())
  const [ganttTarget, setGanttTarget] = useState(null)
  const isBuyer = currentUser?.role === 'buyer'

  const lineItems = useMemo(() => {
    return (orders || []).flatMap(o => (o.assignments || [])
      .filter(a => a.status !== 'On Hold' && a.status !== 'Delivered')
      .map(a => {
        const stage = activeStage(a.stages)
        return { order: o, asgn: a, stage, status: computeStatus(stage), update: latestUpdate(stage) }
      }))
  }, [orders])

  const filtered = useMemo(() => {
    const m = q.toLowerCase()
    return lineItems.filter(li => {
      const matchQ = !q
        || li.order.id.toLowerCase().includes(m)
        || li.order.product.toLowerCase().includes(m)
        || (li.order.buyerCompany || '').toLowerCase().includes(m)
      const matchSf = sf === 'All' || li.status === sf
      return matchQ && matchSf
    })
  }, [lineItems, q, sf])

  // One group per Master Order (customer name folded into the header, not repeated
  // on every row) — orders with no master order fall into a per-customer "Other
  // Orders" bucket.
  const groups = useMemo(() => {
    const map = new Map()
    filtered.forEach(li => {
      const buyerKey = li.order.buyerId || '__none__'
      const moId = li.order.masterOrderId || '__none__'
      const key = `${buyerKey}:${moId}`
      if (!map.has(key)) {
        map.set(key, {
          key, buyerCompany: li.order.buyerCompany || 'Unknown Customer', moId,
          mo: moId !== '__none__' ? (masterOrders || []).find(m => m.id === moId) : null,
          items: [],
        })
      }
      map.get(key).items.push(li)
    })
    const result = [...map.values()]
    result.sort((a, b) => {
      const c = a.buyerCompany.localeCompare(b.buyerCompany)
      if (c !== 0) return c
      if (a.moId === '__none__') return 1
      if (b.moId === '__none__') return -1
      return new Date(b.mo?.createdAt || 0) - new Date(a.mo?.createdAt || 0)
    })
    return result
  }, [filtered, masterOrders])

  const toggleGroup = key => setExpandedGroups(prev => {
    const next = new Set(prev)
    next.has(key) ? next.delete(key) : next.add(key)
    return next
  })

  const exportCsv = () => {
    const header = ['Customer', 'Master Order', 'Order ID', 'Product', 'Manufacturer', 'Qty', 'Current Stage', 'Stage ETA', 'Status', 'Latest Update', 'Updated By', 'Updated At']
    const rows = filtered.map(({ order: o, asgn: a, stage, status, update }) => [
      o.buyerCompany || '',
      (o.masterOrderId && (masterOrders || []).find(m => m.id === o.masterOrderId)?.orderName) || '',
      `${o.id}${(o.assignments || []).length > 1 ? `-${a.sub}` : ''}`,
      o.product,
      a.mfrCompany || '',
      a.qty ?? '',
      stage?.name || 'Complete',
      stage?.eta && stage.eta !== 'NA' ? fmtDate(stage.eta) : '',
      status,
      update?.text || '',
      update?.byUserName || '',
      update?.at ? fmtDate(update.at) : '',
    ])
    downloadCsv([header, ...rows], `production-report-${getToday()}.csv`)
  }

  if (loading) return <LoadingScreen />
  if (loadError) return (
    <Card>
      <EmptyState icon="⚠️" title="Could not load report" desc="Check your connection and refresh the page." />
    </Card>
  )

  return (
    <div>
      <PageHeader
        title="Production Report"
        subtitle="All active orders by master order, with current stage and latest update"
        action={<Btn variant="secondary" icon="⬇" onClick={exportCsv} disabled={filtered.length === 0}>Export CSV</Btn>}
      />

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14 }}>
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="🔍  Search by customer, order ID, or product…"
          style={{ flex: 1, border: `1px solid ${T.border}`, borderRadius: 9, padding: '9px 14px', fontSize: 13, color: T.text, background: T.surface, fontFamily: 'inherit', boxSizing: 'border-box' }}
        />
        <select
          value={sf}
          onChange={e => setSf(e.target.value)}
          style={{ border: `1px solid ${T.border}`, borderRadius: 9, padding: '9px 12px', fontSize: 13, color: T.text, background: T.surface, fontFamily: 'inherit', cursor: 'pointer', flexShrink: 0 }}
        >
          <option value="All">All Statuses</option>
          {REPORT_STATUSES.map(s => <option key={s}>{s}</option>)}
        </select>
      </div>

      {groups.length === 0 ? (
        <Card>
          <EmptyState icon="📊" title={q || sf !== 'All' ? 'No matching orders' : 'No active orders'} desc={q || sf !== 'All' ? 'Try adjusting your search or filter' : 'Orders in progress will appear here'} />
        </Card>
      ) : (
        <Card pad={false}>
          <div className="table-scroll">
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 900 }}>
              <thead>
                <tr style={{ background: '#f8fafc' }}>
                  {['Order ID', 'Product', 'Manufacturer', 'Qty', 'Current Stage', 'ETA', 'Status', 'Latest Update'].map(h => (
                    <th key={h} style={{ padding: '10px 16px', textAlign: 'left', fontSize: 10, fontWeight: 800, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.07em', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {groups.flatMap((g, gi) => {
                  const expanded = expandedGroups.has(g.key)
                  const label = `${!isBuyer ? g.buyerCompany + ' — ' : ''}${g.mo?.orderName || (g.moId === '__none__' ? 'Other Orders' : g.moId)}`
                  const spacerRow = gi > 0 ? <tr key={`sp-${g.key}`} aria-hidden="true"><td colSpan={8} style={{ padding: 0, height: 10, border: 'none', background: T.bg }} /></tr> : null
                  const headerRow = (
                    <tr key={`h-${g.key}`} onClick={() => toggleGroup(g.key)} style={{ cursor: 'pointer', background: '#f1f5f9' }}>
                      <td colSpan={8} style={{ padding: '10px 16px' }}>
                        <FlexRow gap={10}>
                          <span style={{ fontSize: 11, color: T.textMuted, transition: 'transform 0.15s', transform: expanded ? 'none' : 'rotate(-90deg)', display: 'inline-block' }}>▾</span>
                          <span style={{ fontSize: 13, fontWeight: 800, color: T.text }}>📁 {label}</span>
                          {g.mo?.season && <span style={{ fontSize: 10, fontWeight: 700, color: '#0369a1', background: '#dbeafe', padding: '1px 7px', borderRadius: 4 }}>{g.mo.season}</span>}
                          <span style={{ fontSize: 11, color: T.textMuted, marginLeft: 'auto' }}>{g.items.length} item{g.items.length !== 1 ? 's' : ''}</span>
                        </FlexRow>
                      </td>
                    </tr>
                  )
                  if (!expanded) return [spacerRow, headerRow].filter(Boolean)
                  const rows = g.items.map((li, i) => {
                    const { order: o, asgn: a, stage, status, update } = li
                    const multi = (o.assignments || []).length > 1
                    return (
                      <tr key={`${o.id}-${a.mid}-${i}`}
                        onClick={() => setGanttTarget({ order: o, asgn: a })}
                        style={{ borderTop: `1px solid ${T.border}`, cursor: 'pointer' }}
                        onMouseEnter={e => e.currentTarget.style.background = '#f8fafc'}
                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                      >
                        <td style={{ padding: '10px 16px' }}><Mono style={{ fontSize: 11 }}>{o.id}{multi ? `-${a.sub}` : ''}</Mono></td>
                        <td style={{ padding: '10px 16px', fontSize: 13, fontWeight: 600, color: T.text }}>
                          <FlexRow gap={8}><ProductThumb order={o} size="sm" />{o.product}</FlexRow>
                        </td>
                        <td style={{ padding: '10px 16px', fontSize: 13, color: T.text }}>{a.mfrCompany || '—'}</td>
                        <td style={{ padding: '10px 16px', fontSize: 13, color: T.textMuted }}>{a.qty?.toLocaleString() || '—'}</td>
                        <td style={{ padding: '10px 16px', fontSize: 13, color: T.text }}>{stage?.name || 'Complete'}</td>
                        <td style={{ padding: '10px 16px', fontSize: 12, color: T.textMuted, whiteSpace: 'nowrap' }}>{stage?.eta && stage.eta !== 'NA' ? fmtDate(stage.eta) : '—'}</td>
                        <td style={{ padding: '10px 16px' }}><Badge status={status} /></td>
                        <td style={{ padding: '10px 16px', fontSize: 12, color: update ? T.text : T.textLight, fontStyle: update ? 'normal' : 'italic', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={update?.text}>
                          {update ? update.text : 'No updates yet'}
                        </td>
                      </tr>
                    )
                  })
                  return [spacerRow, headerRow, ...rows].filter(Boolean)
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {ganttTarget && (
        <GanttModal order={ganttTarget.order} asgn={ganttTarget.asgn} onClose={() => setGanttTarget(null)} onOpen={onOpen} />
      )}
    </div>
  )
}
