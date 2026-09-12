import { useMemo, useState, Fragment } from 'react'
import { AlertTriangle, Plus, RotateCw, Ban, CircleDot, CalendarClock, Search, User, Building2, Package, MessageCircle, Check, ChevronUp, ChevronDown } from 'lucide-react'
import {
  T, dayNumber, getToday, fmtN,
  stageKindOf, stageStatusOf, stageIsOverdue, stageVariance, inFlightStages,
  deliveryOverrunDays, STAGE_STATUS_LABELS,
} from '../../constants.js'
import {
  Btn, Card, EmptyState, FlexRow, LoadingScreen, Modal, Mono, PageHeader,
  Select, Input, Textarea, StatCard, useToast, activateOnKey,
} from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'

// Action Items and the daily update, as one page — because they were always the
// same job. Laid out like the "Action Item Updates" sheet the team maintains by
// hand: grouped per line item, each style carrying its expected delivery and
// callout, with its open steps beneath showing planned vs revised date, status,
// and a box to type today's update.

const OWNER_FILTERS = [
  { id: 'all', label: 'Everyone' },
  { id: 'admin', label: 'Tradio' },
  { id: 'manufacturer', label: 'Manufacturer' },
  { id: 'buyer', label: 'Customer' },
  // A step with no owner is nobody's job — the most useful filter on this page
  // until every step has someone against it.
  { id: 'none', label: 'Unassigned' },
]

const WINDOWS = [
  { days: 3, label: '±3 days' },
  { days: 7, label: '±7 days' },
  { days: 14, label: '±14 days' },
  { days: 3650, label: 'Everything open' },
]

function fmtWhen(d) {
  if (!d) return ''
  const dt = new Date(d)
  if (isNaN(dt.getTime())) return ''
  const dd = String(dt.getDate()).padStart(2, '0')
  const mm = String(dt.getMonth() + 1).padStart(2, '0')
  const hh = String(dt.getHours()).padStart(2, '0')
  const mi = String(dt.getMinutes()).padStart(2, '0')
  return `${dd}-${mm}-${dt.getFullYear()} ${hh}:${mi}`
}

function fmtDate(d) {
  if (!d || d === 'NA') return '—'
  const s = typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : null
  const [y, m, day] = s ? s.split('-') : (() => {
    const dt = new Date(d)
    return isNaN(dt.getTime()) ? [] : [dt.getFullYear(), String(dt.getMonth() + 1).padStart(2, '0'), String(dt.getDate()).padStart(2, '0')]
  })()
  return y ? `${day}-${m}-${y}` : '—'
}

const cellInput = {
  width: '100%', border: `1px solid ${T.border}`, borderRadius: 6,
  padding: '5px 7px', fontSize: 12, fontFamily: 'inherit', color: T.text,
  background: T.surface, boxSizing: 'border-box',
}

function Variance({ days }) {
  if (days == null || days === 0) return <span style={{ fontSize: 11, color: T.textLight }}>—</span>
  const late = days > 0
  return (
    <span style={{ fontSize: 11, fontWeight: 700, padding: '1px 6px', borderRadius: 4, whiteSpace: 'nowrap', color: late ? '#b91c1c' : '#047857', background: late ? '#fee2e2' : '#d1fae5' }}>
      {late ? '+' : ''}{days}d
    </span>
  )
}

export function ActionItemsPage({ onOpen, onNavigate }) {
  const {
    orders, masterOrders, users, actionItems, currentUser, loading, loadError,
    bulkUpdateStages, updateStage, addStageUpdate,
    createActionItem, updateActionItem, addActionItemUpdate, removeActionItem,
  } = useApp()
  const toast = useToast()

  const [q, setQ] = useState('')
  const [owner, setOwner] = useState('all')
  const [windowDays, setWindowDays] = useState(3)
  const [includeOverdue, setIncludeOverdue] = useState(true)
  const [onlyMine, setOnlyMine] = useState(false)
  const [edits, setEdits] = useState({})
  const [saving, setSaving] = useState(false)
  const [collapsed, setCollapsed] = useState({})
  const [showCreate, setShowCreate] = useState(false)
  const [customDrafts, setCustomDrafts] = useState({})
  const [busy, setBusy] = useState(false)
  const [openThread, setOpenThread] = useState(null)

  // An update posts on its own, immediately — it isn't a pending edit waiting on
  // Save like a date or status change. Typing what happened and having it land
  // is the single most common thing anyone does on this page.
  const postUpdateNow = async (row) => {
    const text = (edits[row.key]?.updateText || '').trim()
    if (!text) return
    setBusy(true)
    try {
      await addStageUpdate(row.order.id, row.asgn.mid, row.index, text)
      setEdits(p => ({ ...p, [row.key]: { ...p[row.key], updateText: '' } }))
      setOpenThread(row.key)   // show it landing in the thread
    } catch (err) {
      toast(err?.message || 'Could not post update', 'error')
    } finally { setBusy(false) }
  }

  const isAdmin = currentUser?.role === 'admin'
  const todayNum = dayNumber(getToday())

  // ── Rows: one per open step, carrying its order so it can be grouped by line item.
  const rows = useMemo(() => {
    const out = []
    for (const o of orders || []) {
      for (const a of o.assignments || []) {
        if (a.status === 'Delivered' || a.status === 'On Hold') continue
        for (const { stage, index } of inFlightStages(a, { windowDays, includeOverdue })) {
          if (currentUser?.role === 'buyer' && String(stage.responsibleId) !== String(currentUser.id)) continue
          out.push({
            key: `${o.id}|${a.mid}|${index}`,
            order: o, asgn: a, stage, index,
            kind: stageKindOf(stage),
            status: stageStatusOf(stage),
            overdue: stageIsOverdue(stage),
            variance: stageVariance(stage),
            ownerRole: stage.responsibleRole || null,
            mine: String(stage.responsibleId || '') === String(currentUser?.id || ''),
          })
        }
      }
    }
    return out
  }, [orders, windowDays, includeOverdue, currentUser])

  const filtered = useMemo(() => {
    const m = q.trim().toLowerCase()
    return rows.filter(r => {
      if (onlyMine && !r.mine) return false
      if (owner === 'none' ? !!r.ownerRole : (owner !== 'all' && r.ownerRole !== owner)) return false
      if (!m) return true
      return r.order.product.toLowerCase().includes(m)
        || r.order.id.toLowerCase().includes(m)
        || r.stage.name.toLowerCase().includes(m)
        || (r.order.buyerCompany || '').toLowerCase().includes(m)
        || (r.stage.responsibleName || '').toLowerCase().includes(m)
    })
  }, [rows, q, owner, onlyMine])

  // Custom (non-TNA) action items — the commercial to-dos that don't map onto a
  // production step. Kept in the same page, bucketed under their customer.
  const customItems = useMemo(() => {
    if (!isAdmin) return []
    const m = q.trim().toLowerCase()
    return (actionItems || [])
      .filter(it => it.status === 'open')
      .filter(it => !onlyMine || String(it.assigneeId) === String(currentUser?.id))
      .filter(it => owner === 'all' || owner === 'admin')
      .filter(it => !m || it.title.toLowerCase().includes(m) || (it.buyerCompany || '').toLowerCase().includes(m))
  }, [actionItems, q, owner, onlyMine, isAdmin, currentUser])

  // ── Group: customer → line item (style). Mirrors the update sheet exactly.
  const groups = useMemo(() => {
    const byBuyer = new Map()
    const bucket = (buyerKey, buyerCompany) => {
      if (!byBuyer.has(buyerKey)) byBuyer.set(buyerKey, { key: buyerKey, buyerCompany, lines: new Map(), custom: [] })
      return byBuyer.get(buyerKey)
    }
    for (const r of filtered) {
      const b = bucket(r.order.buyerId || '__none__', r.order.buyerCompany || 'Unknown customer')
      const lineKey = `${r.order.id}|${r.asgn.mid}`
      if (!b.lines.has(lineKey)) {
        b.lines.set(lineKey, {
          key: lineKey, order: r.order, asgn: r.asgn,
          mo: (masterOrders || []).find(m => m.id === r.order.masterOrderId) || null,
          overrun: deliveryOverrunDays(r.order, r.asgn),
          rows: [],
        })
      }
      b.lines.get(lineKey).rows.push(r)
    }
    for (const it of customItems) {
      bucket(it.buyerId || '__internal', it.buyerCompany || 'Internal').custom.push(it)
    }
    const result = [...byBuyer.values()]
    for (const b of result) {
      b.lineList = [...b.lines.values()]
      for (const l of b.lineList) {
        l.rows.sort((x, y) => {
          if (x.overdue !== y.overdue) return x.overdue ? -1 : 1
          const ex = x.stage.eta && x.stage.eta !== 'NA' ? dayNumber(x.stage.eta) : Infinity
          const ey = y.stage.eta && y.stage.eta !== 'NA' ? dayNumber(y.stage.eta) : Infinity
          return ex - ey || x.index - y.index
        })
      }
      b.lineList.sort((x, y) => x.order.product.localeCompare(y.order.product))
      b.openCount = b.lineList.reduce((n, l) => n + l.rows.length, 0) + b.custom.length
    }
    result.sort((a, b) => a.buyerCompany.localeCompare(b.buyerCompany))
    return result
  }, [filtered, customItems, masterOrders])

  const stats = useMemo(() => ({
    open: rows.length + customItems.length,
    blocked: rows.filter(r => r.stage.blocked).length,
    overdue: rows.filter(r => r.overdue).length,
    dueToday: rows.filter(r => r.stage.eta && r.stage.eta !== 'NA' && dayNumber(r.stage.eta) === todayNum).length,
  }), [rows, customItems, todayNum])

  const setEdit = (key, patch) => setEdits(p => ({ ...p, [key]: { ...p[key], ...patch } }))
  const dirtyKeys = Object.keys(edits).filter(k => {
    const e = edits[k]
    return e && Object.values(e).some(v => v !== undefined && v !== '')
  })

  async function saveAll() {
    if (dirtyKeys.length === 0) return
    setSaving(true)
    let ok = 0
    const failures = []
    try {
      const byAsgn = new Map()
      const unitRows = []
      const noteRows = []

      for (const key of dirtyKeys) {
        const row = rows.find(r => r.key === key)
        if (!row) continue
        const e = edits[key]
        if (e.updateText?.trim()) noteRows.push({ row, text: e.updateText.trim() })

        const patch = { index: row.index }
        let hasPatch = false
        if (e.eta && e.eta !== row.stage.eta) { patch.eta = e.eta; hasPatch = true }
        if (e.status && e.status !== row.status && row.kind !== 'quantity') { patch.status = e.status; hasPatch = true }
        if (e.unitsDone !== undefined && e.unitsDone !== '' && Number(e.unitsDone) !== row.stage.unitsDone)
          unitRows.push({ row, units: Number(e.unitsDone) })

        if (hasPatch) {
          const k = `${row.order.id}|${row.asgn.mid}`
          if (!byAsgn.has(k)) byAsgn.set(k, { orderId: row.order.id, mid: row.asgn.mid, stages: [] })
          byAsgn.get(k).stages.push(patch)
        }
      }

      for (const { orderId, mid, stages } of byAsgn.values()) {
        try { await bulkUpdateStages(orderId, mid, stages); ok += stages.length }
        catch (err) { failures.push(`${orderId}: ${err?.message || 'failed'}`) }
      }
      for (const { row, units } of unitRows) {
        try { await updateStage(row.order.id, row.asgn.mid, row.index, { unitsDone: units }); ok++ }
        catch (err) { failures.push(`${row.order.id} ${row.stage.name}: ${err?.message || 'failed'}`) }
      }
      for (const { row, text } of noteRows) {
        try { await addStageUpdate(row.order.id, row.asgn.mid, row.index, text) }
        catch (err) { failures.push(`${row.order.id} ${row.stage.name}: ${err?.message || 'failed'}`) }
      }

      if (failures.length) toast(`Saved ${ok}, ${failures.length} failed — ${failures[0]}`, 'warning')
      else { toast(`Saved ${dirtyKeys.length} update${dirtyKeys.length !== 1 ? 's' : ''}`, 'success'); setEdits({}) }
    } finally { setSaving(false) }
  }

  const postCustomUpdate = async (item) => {
    const text = (customDrafts[item.id] || '').trim()
    if (!text) return
    setBusy(true)
    try {
      await addActionItemUpdate(item.id, text)
      setCustomDrafts(d => ({ ...d, [item.id]: '' }))
    } catch (err) { toast(err?.message || 'Could not post update', 'error') }
    finally { setBusy(false) }
  }

  if (loading) return <LoadingScreen />
  if (loadError) return <Card><EmptyState icon={<AlertTriangle size={26} color={T.textLight} />} title="Could not load" desc="Check your connection and refresh." /></Card>

  return (
    <div>
      <PageHeader
        title="Action Items"
        subtitle="Every open step by line item — update the status and leave today's note, all in one place"
        action={
          <FlexRow gap={8}>
            {isAdmin && <Btn variant="secondary" onClick={() => setShowCreate(true)} icon={<Plus size={13} />}>New Action Item</Btn>}
            <Btn onClick={saveAll} disabled={saving || dirtyKeys.length === 0}>
              {saving ? 'Saving…' : dirtyKeys.length ? `Save ${dirtyKeys.length} change${dirtyKeys.length !== 1 ? 's' : ''}` : 'Save'}
            </Btn>
          </FlexRow>
        }
      />

      <div className="grid-responsive-4" style={{ gap: 12, marginBottom: 14 }}>
        <StatCard icon={<RotateCw size={19} color={T.primary} />} label="Open items" value={stats.open} color={T.primary} />
        <StatCard icon={<Ban size={19} color={T.danger} />} label="Blocked" value={stats.blocked} color={T.danger} />
        <StatCard icon={<CircleDot size={19} color={T.danger} />} label="Past deadline" value={stats.overdue} color={T.danger} />
        <StatCard icon={<CalendarClock size={19} color={T.warning} />} label="Due today" value={stats.dueToday} color={T.warning} />
      </div>

      <FlexRow gap={8} style={{ marginBottom: 8, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 220 }}>
          <Search size={14} color={T.textLight} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} />
          <input
            value={q} onChange={e => setQ(e.target.value)}
            placeholder="Search style, step, owner, order ID, or customer…"
            style={{ width: '100%', border: `1px solid ${T.border}`, borderRadius: 9, padding: '9px 14px 9px 34px', fontSize: 13, color: T.text, background: T.surface, fontFamily: 'inherit', boxSizing: 'border-box' }}
          />
        </div>
        <select value={windowDays} onChange={e => setWindowDays(Number(e.target.value))}
          style={{ border: `1px solid ${T.border}`, borderRadius: 9, padding: '9px 12px', fontSize: 13, color: T.text, background: T.surface, fontFamily: 'inherit', cursor: 'pointer' }}>
          {WINDOWS.map(w => <option key={w.days} value={w.days}>{w.label}</option>)}
        </select>
        <Btn variant={includeOverdue ? 'primary' : 'secondary'} onClick={() => setIncludeOverdue(v => !v)} icon={<CircleDot size={13} />}>Past deadline</Btn>
        <Btn variant={onlyMine ? 'primary' : 'secondary'} onClick={() => setOnlyMine(v => !v)} icon={<User size={13} />}>Mine only</Btn>
      </FlexRow>

      {/* Whose action it is — Tradio, the factory, or the customer. A third of a
          real TNA sits with the buyer, so this is a first-class filter. */}
      <FlexRow gap={6} style={{ marginBottom: 14, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Owner:</span>
        {OWNER_FILTERS.map(f => (
          <button key={f.id} onClick={() => setOwner(f.id)}
            style={{ fontSize: 11, fontWeight: 700, padding: '4px 11px', borderRadius: 14, cursor: 'pointer', fontFamily: 'inherit',
              border: `1px solid ${owner === f.id ? T.primary : T.border}`,
              background: owner === f.id ? T.primaryLight : T.surface,
              color: owner === f.id ? T.primaryDark : T.textMuted }}>
            {f.label}
          </button>
        ))}
      </FlexRow>

      {groups.length === 0 ? (
        <Card>
          <EmptyState icon={<Check size={26} color={T.success} strokeWidth={2.5} />}
            title={q || onlyMine || owner !== 'all' ? 'Nothing matches' : 'Nothing needs an update'}
            desc={q || onlyMine || owner !== 'all' ? 'Try widening the search, owner, or date range.' : 'No steps are open, blocked, or due in this window.'} />
        </Card>
      ) : groups.map(g => {
        const open = !collapsed[g.key]
        return (
          <Card key={g.key} pad={false} style={{ marginBottom: 14 }}>
            <FlexRow gap={10} onClick={() => setCollapsed(p => ({ ...p, [g.key]: open }))}
              style={{ padding: '11px 16px', background: '#eef2f7', borderRadius: '12px 12px 0 0', cursor: 'pointer' }}>
              <span style={{ color: T.textMuted, transform: open ? 'none' : 'rotate(-90deg)', display: 'inline-flex' }}><ChevronDown size={13} /></span>
              <span style={{ fontSize: 14, fontWeight: 800, color: T.text, display: 'inline-flex', alignItems: 'center', gap: 6 }}><Building2 size={14} /> {g.buyerCompany}</span>
              <span style={{ fontSize: 11, color: T.textMuted, marginLeft: 'auto' }}>{g.openCount} open</span>
            </FlexRow>

            {open && (
              <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 12 }}>
                {g.lineList.map(line => (
                  <div key={line.key} style={{ border: `1px solid ${T.border}`, borderRadius: 10, overflow: 'hidden' }}>
                    {/* Line-item header — the style's own delivery date and callout,
                        exactly the two per-style columns from the update sheet. */}
                    <div style={{ padding: '9px 13px', background: '#f8fafc', borderBottom: `1px solid ${T.border}` }}>
                      <FlexRow gap={10} style={{ flexWrap: 'wrap' }}>
                        <span onClick={() => onOpen?.(line.order.id, line.asgn.mid)} role="button" tabIndex={0} onKeyDown={activateOnKey(() => onOpen?.(line.order.id, line.asgn.mid))}
                          style={{ fontSize: 13, fontWeight: 700, color: T.text, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                          <Package size={13} /> {line.order.product}
                        </span>
                        <Mono style={{ fontSize: 10 }}>{line.order.id}</Mono>
                        {line.mo && <span style={{ fontSize: 10, color: T.textLight }}>{line.mo.orderName}</span>}
                        <span style={{ marginLeft: 'auto', fontSize: 11, color: T.textMuted }}>
                          {line.asgn.mfrCompany} · {fmtN(line.asgn.qty)} pcs
                        </span>
                        <span style={{ fontSize: 11, fontWeight: 700, color: T.text, whiteSpace: 'nowrap' }}>
                          Delivery {fmtDate(line.order.delivery)}
                        </span>
                        {line.overrun != null && (
                          <span title="The last planned step finishes after the promised delivery date"
                            style={{ fontSize: 10, fontWeight: 800, color: '#b91c1c', background: '#fee2e2', padding: '2px 7px', borderRadius: 4, whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                            <AlertTriangle size={9} /> plan overruns delivery by {line.overrun}d
                          </span>
                        )}
                      </FlexRow>
                      {line.order.callout && (
                        <div style={{ fontSize: 11, color: '#b45309', background: '#fef3c7', borderRadius: 5, padding: '4px 8px', marginTop: 6, display: 'flex', alignItems: 'flex-start', gap: 5 }}>
                          <AlertTriangle size={11} style={{ flexShrink: 0, marginTop: 1 }} /> {line.order.callout}
                        </div>
                      )}
                    </div>

                    <div className="table-scroll">
                      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 940 }}>
                        <thead>
                          <tr style={{ background: T.surface }}>
                            {['Step', 'Owner', 'Planned', 'Revised', 'Δ', 'Actual', 'Status', "Today's update", ''].map(h => (
                              <th key={h} style={{ padding: '7px 10px', textAlign: 'left', fontSize: 9, fontWeight: 800, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', whiteSpace: 'nowrap' }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {line.rows.map(r => {
                            const e = edits[r.key] || {}
                            const dirty = Object.values(e).some(v => v !== undefined && v !== '')
                            const revised = e.eta ?? (r.stage.eta && r.stage.eta !== 'NA' ? r.stage.eta : '')
                            const thread = r.stage.updates || []
                            const last = thread.slice(-1)[0]
                            const threadOpen = openThread === r.key
                            return (
                              <Fragment key={r.key}>
                              <tr style={{ borderTop: `1px solid ${T.border}`, background: dirty ? '#fffbeb' : r.stage.blocked ? '#fef2f2' : 'transparent' }}>
                                <td style={{ padding: '6px 10px', fontSize: 12, color: T.text, maxWidth: 230 }}>
                                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.stage.name}>
                                    {r.index + 1}. {r.stage.name}
                                  </div>
                                  <FlexRow gap={4} style={{ marginTop: 2, flexWrap: 'wrap' }}>
                                    {r.stage.blocked && <span style={{ fontSize: 8, fontWeight: 800, color: '#b91c1c', background: '#fee2e2', padding: '1px 4px', borderRadius: 3 }}>BLOCKED</span>}
                                    {r.overdue && <span style={{ fontSize: 8, fontWeight: 800, color: '#b91c1c', background: '#fee2e2', padding: '1px 4px', borderRadius: 3 }}>LATE</span>}
                                    {r.kind === 'checklist' && (r.stage.itemsTotal || 0) > 0 &&
                                      <span style={{ fontSize: 9, fontWeight: 700, color: T.textMuted }}>{r.stage.itemsDone}/{r.stage.itemsTotal} items</span>}
                                  </FlexRow>
                                  {last && (
                                    <div onClick={() => setOpenThread(threadOpen ? null : r.key)} role="button" tabIndex={0} onKeyDown={activateOnKey(() => setOpenThread(threadOpen ? null : r.key))}
                                      title="Show all updates"
                                      style={{ fontSize: 9, color: T.textLight, marginTop: 3, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 3 }}>
                                      <MessageCircle size={9} style={{ flexShrink: 0 }} /> {last.text}
                                    </div>
                                  )}
                                </td>
                                <td style={{ padding: '6px 10px', fontSize: 11, color: r.mine ? T.primary : T.textMuted, whiteSpace: 'nowrap' }}>
                                  {r.stage.responsibleName || '—'}
                                  {r.ownerRole && <div style={{ fontSize: 9, color: T.textLight }}>{r.ownerRole === 'admin' ? 'Tradio' : r.ownerRole === 'buyer' ? 'customer' : 'factory'}</div>}
                                </td>
                                <td style={{ padding: '6px 10px', fontSize: 11, color: T.textMuted, whiteSpace: 'nowrap', fontFamily: "'JetBrains Mono',monospace" }}>
                                  {fmtDate(r.stage.baselineEta)}
                                </td>
                                <td style={{ padding: '6px 10px', width: 128 }}>
                                  <input type="date" value={revised} onChange={ev => setEdit(r.key, { eta: ev.target.value })} style={cellInput} />
                                </td>
                                <td style={{ padding: '6px 10px' }}><Variance days={r.variance} /></td>
                                <td style={{ padding: '6px 10px', fontSize: 11, fontWeight: 700, color: T.success, whiteSpace: 'nowrap', fontFamily: "'JetBrains Mono',monospace" }}>
                                  {r.stage.actualEnd ? fmtDate(r.stage.actualEnd) : <span style={{ color: T.textLight, fontWeight: 400 }}>—</span>}
                                </td>
                                <td style={{ padding: '6px 10px', width: 146 }}>
                                  {r.kind === 'quantity' ? (
                                    <FlexRow gap={4}>
                                      <input type="number" min={0} max={r.stage.totalUnits}
                                        value={e.unitsDone ?? r.stage.unitsDone ?? 0}
                                        onChange={ev => setEdit(r.key, { unitsDone: ev.target.value })}
                                        style={{ ...cellInput, width: 70 }} />
                                      <span style={{ fontSize: 10, color: T.textLight, whiteSpace: 'nowrap' }}>/ {fmtN(r.stage.totalUnits)}</span>
                                    </FlexRow>
                                  ) : (
                                    <select value={e.status ?? r.status} onChange={ev => setEdit(r.key, { status: ev.target.value })}
                                      style={{ ...cellInput, cursor: 'pointer' }}>
                                      {Object.entries(STAGE_STATUS_LABELS).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                                    </select>
                                  )}
                                </td>
                                <td style={{ padding: '6px 10px', minWidth: 230 }}>
                                  <FlexRow gap={5}>
                                    <input
                                      value={e.updateText ?? ''}
                                      onChange={ev => setEdit(r.key, { updateText: ev.target.value })}
                                      onKeyDown={ev => { if (ev.key === 'Enter') { ev.preventDefault(); postUpdateNow(r) } }}
                                      placeholder="Add an update…" style={cellInput} />
                                    <Btn size="sm" disabled={busy || !(e.updateText || '').trim()} onClick={() => postUpdateNow(r)}>Post</Btn>
                                  </FlexRow>
                                </td>
                                <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>
                                  <button onClick={() => setOpenThread(threadOpen ? null : r.key)}
                                    title={thread.length ? `${thread.length} update${thread.length !== 1 ? 's' : ''}` : 'No updates yet'}
                                    style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 10, color: thread.length ? T.primary : T.textLight, fontWeight: 700, fontFamily: 'inherit', padding: 2, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                                    <MessageCircle size={11} /> {thread.length} {threadOpen ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                                  </button>
                                </td>
                              </tr>

                              {threadOpen && (
                                <tr>
                                  <td colSpan={9} style={{ padding: '8px 14px 12px', background: '#f8fafc', borderTop: `1px solid ${T.border}` }}>
                                    <div style={{ fontSize: 9, fontWeight: 800, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                                      Update history — {r.stage.name}
                                    </div>
                                    {thread.length === 0 ? (
                                      <div style={{ fontSize: 11, color: T.textLight, fontStyle: 'italic' }}>Nothing posted yet. Type above and hit Post.</div>
                                    ) : (
                                      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, maxHeight: 220, overflowY: 'auto' }}>
                                        {thread.slice().reverse().map((u, ui) => (
                                          <div key={ui} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 6, padding: '6px 10px' }}>
                                            <div style={{ fontSize: 11, color: T.text }}>{u.text}</div>
                                            <div style={{ fontSize: 9, color: T.textLight, marginTop: 2 }}>{u.byUserName || 'Someone'} · {fmtWhen(u.at)}</div>
                                          </div>
                                        ))}
                                      </div>
                                    )}
                                  </td>
                                </tr>
                              )}
                              </Fragment>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}

                {g.custom.length > 0 && (
                  <div style={{ border: `1px dashed ${T.border}`, borderRadius: 10, padding: '10px 13px' }}>
                    <div style={{ fontSize: 11, fontWeight: 800, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
                      Other action items
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {g.custom.map(it => {
                        const over = it.eta && dayNumber(it.eta.slice(0, 10)) < todayNum
                        return (
                          <div key={it.id} style={{ border: `1px solid ${over ? T.dangerBorder : T.border}`, borderRadius: 8, padding: '8px 11px', background: over ? '#fffaf9' : T.surface }}>
                            <FlexRow gap={8} style={{ flexWrap: 'wrap' }}>
                              <span style={{ fontSize: 12, fontWeight: 600, color: T.text, flex: 1, minWidth: 150 }}>{it.title}</span>
                              <span style={{ fontSize: 11, color: T.textMuted }}>{it.assigneeName || '—'}</span>
                              {it.eta && <span style={{ fontSize: 10, fontWeight: over ? 700 : 400, color: over ? T.danger : T.textMuted }}>{fmtDate(it.eta)}</span>}
                              <Btn size="sm" variant="success" disabled={busy} onClick={async () => {
                                setBusy(true)
                                try { await updateActionItem(it.id, { status: 'done' }); toast('Marked done', 'success') }
                                catch (err) { toast(err?.message || 'Failed', 'error') } finally { setBusy(false) }
                              }} icon={<Check size={12} strokeWidth={3} />}>Done</Btn>
                            </FlexRow>
                            {(it.updates || []).slice(-1).map((u, ui) => (
                              <div key={ui} style={{ fontSize: 10, color: T.textLight, marginTop: 4, display: 'flex', alignItems: 'flex-start', gap: 3 }}><MessageCircle size={9} style={{ flexShrink: 0, marginTop: 1 }} /> {u.text} — {u.byUserName}</div>
                            ))}
                            <FlexRow gap={6} style={{ marginTop: 6 }}>
                              <input value={customDrafts[it.id] || ''} onChange={ev => setCustomDrafts(d => ({ ...d, [it.id]: ev.target.value }))}
                                onKeyDown={ev => { if (ev.key === 'Enter') postCustomUpdate(it) }}
                                placeholder="Add an update…" style={{ ...cellInput, flex: 1 }} />
                              <Btn size="sm" disabled={busy || !(customDrafts[it.id] || '').trim()} onClick={() => postCustomUpdate(it)}>Post</Btn>
                            </FlexRow>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}
          </Card>
        )
      })}

      {showCreate && (
        <CreateActionItemModal
          users={users}
          onClose={() => setShowCreate(false)}
          onCreate={async data => { await createActionItem(data); setShowCreate(false) }}
        />
      )}
    </div>
  )
}

function CreateActionItemModal({ users, onClose, onCreate }) {
  const toast = useToast()
  const [f, setF] = useState({ title: '', detail: '', assigneeId: '', buyerId: '', priority: 'medium', eta: '' })
  const [saving, setSaving] = useState(false)
  const admins = (users || []).filter(u => u.role === 'admin' && u.isActive)
  const buyers = (users || []).filter(u => u.role === 'buyer' && u.isActive)

  const submit = async () => {
    if (!f.title.trim()) { toast('Title is required', 'error'); return }
    if (!f.assigneeId) { toast('Assignee is required', 'error'); return }
    setSaving(true)
    try {
      await onCreate({ ...f, title: f.title.trim(), buyerId: f.buyerId || null, eta: f.eta || null })
    } catch (err) { toast(err?.message || 'Could not create', 'error') }
    finally { setSaving(false) }
  }

  return (
    <Modal title="New Action Item" subtitle="For work that isn't a production step — pricing, commercial, follow-ups" size="lg" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Input label="Title *" value={f.title} onChange={e => setF({ ...f, title: e.target.value })} placeholder="e.g. Close pricing for Poplin Lycra" />
        <Textarea label="Detail" value={f.detail} onChange={e => setF({ ...f, detail: e.target.value })} />
        <div className="form-grid-2" style={{ gap: 12 }}>
          <Select label="Assignee *" value={f.assigneeId} onChange={e => setF({ ...f, assigneeId: e.target.value })}>
            <option value="">— Select —</option>
            {admins.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
          </Select>
          <Select label="Customer" value={f.buyerId} onChange={e => setF({ ...f, buyerId: e.target.value })}>
            <option value="">Internal (no customer)</option>
            {buyers.map(u => <option key={u.id} value={u.id}>{u.company}</option>)}
          </Select>
        </div>
        <div className="form-grid-2" style={{ gap: 12 }}>
          <Select label="Priority" value={f.priority} onChange={e => setF({ ...f, priority: e.target.value })}>
            <option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
          </Select>
          <Input label="Due date" type="date" value={f.eta} onChange={e => setF({ ...f, eta: e.target.value })} />
        </div>
        <FlexRow justify="flex-end" gap={8}>
          <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
          <Btn disabled={saving} onClick={submit}>{saving ? 'Creating…' : 'Create'}</Btn>
        </FlexRow>
      </div>
    </Modal>
  )
}
