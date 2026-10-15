import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, ArrowRight, Folder, Package, Truck, Scissors, FlaskConical, PauseCircle, Trash2, Factory, Calendar, ChevronRight, Building2, BarChart3, LayoutGrid, Pencil, Plus, FileText, StickyNote } from '../../icons.jsx'
import { T, phaseOf, deliveryStatus, planProgress, styleOnHold, dayNumber, getToday, effectiveEta } from '../../constants.js'
import { Btn, Card, FlexRow, Mono, ProductThumb, EmptyState, LoadingScreen } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'
import { capsFor, canEditMasterOrder } from '../../caps.js'
import { EditMasterOrderModal } from './EditMasterOrderModal.jsx'
import { masterOrdersApi } from '../../api.js'

// The master order's own page: who it is for, how far along it is, and every style that was ever in it, the ones
// on hold and the dropped ones too (they leave the TNA, not the record). Each live style opens its own page.

const fmtDate = d => {
  if (!d) return '-'
  const dt = new Date(d)
  if (isNaN(dt.getTime())) return '-'
  return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

// The sections a style can sit in, in reading order. Colours follow the dashboard tiles.
const SECTIONS = [
  { id: 'production', label: 'In production', icon: Scissors, fg: '#92400e', bg: '#fef9c3', bd: '#fde68a' },
  { id: 'delivered', label: 'Delivered', icon: Truck, fg: '#166534', bg: '#dcfce7', bd: '#86efac' },
  { id: 'development', label: 'Sampling & Development', icon: FlaskConical, fg: '#5b21b6', bg: '#ede9fe', bd: '#c4b5fd' },
  { id: 'hold', label: 'On hold', icon: PauseCircle, fg: '#475569', bg: '#f1f5f9', bd: '#cbd5e1' },
  { id: 'dropped', label: 'Dropped', icon: Trash2, fg: '#991b1b', bg: '#fee2e2', bd: '#fca5a5' },
]
const SECTION = Object.fromEntries(SECTIONS.map(s => [s.id, s]))

// When a style is due, by its TNA: the Delivery step's current date, the latest across its splits. A style with no
// Delivery step yet (no manufacturer, or still in development) falls back to the order's delivery date.
const planDue = o => {
  const dates = (o.assignments || []).map(a => effectiveEta((a.stages || []).find(st => st.isDelivery))).filter(Boolean).sort()
  return dates.length ? dates[dates.length - 1] : (o.delivery || null)
}
// When a delivered style actually arrived: the last split's recorded delivery day, or null if none was recorded.
const deliveredOn = o => {
  const dates = (o.assignments || []).map(a => deliveryStatus(o, a)).filter(d => d.delivered && d.isActual).map(d => d.date).sort()
  return dates.length ? dates[dates.length - 1] : null
}
const dayOf = d => (d ? dayNumber(typeof d === 'string' ? d : new Date(d).toISOString()) : null)

const sectionOf = o => {
  if (styleOnHold(o)) return 'hold'
  if (phaseOf(o) === 'development') return 'development'
  const splits = o.assignments || []
  if (splits.length && splits.every(a => deliveryStatus(o, a).delivered)) return 'delivered'
  return 'production'
}

function Chip({ children, fg, bg, bd, title }) {
  return (
    <span title={title} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999, whiteSpace: 'nowrap', color: fg, background: bg, border: `1px solid ${bd}` }}>
      {children}
    </span>
  )
}

function Tile({ label, value, sub, icon: Icon, fg, bg }) {
  return (
    <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
      <div style={{ width: 38, height: 38, borderRadius: 10, background: bg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <Icon size={18} color={fg} />
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 22, fontWeight: 800, color: T.text, lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
        <div style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 3 }}>{label}</div>
        {sub && <div style={{ fontSize: 11, color: T.textLight, marginTop: 1 }}>{sub}</div>}
      </div>
    </div>
  )
}

function InfoRow({ icon: Icon, label, children }) {
  return (
    <div style={{ display: 'flex', gap: 10, padding: '10px 0', borderTop: `1px solid ${T.border}` }}>
      <Icon size={15} color={T.textLight} style={{ marginTop: 2, flexShrink: 0 }} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 10, fontWeight: 800, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</div>
        <div style={{ fontSize: 13, fontWeight: 600, color: T.text, marginTop: 2 }}>{children}</div>
      </div>
    </div>
  )
}

function StyleRow({ order, section, onOpen }) {
  const s = SECTION[section]
  const splits = order.assignments || []
  const stages = splits.flatMap(a => a.stages || [])
  const { done, total, pct } = planProgress(stages)
  const factories = [...new Set(splits.map(a => a.mfrCompany).filter(Boolean))]
  const heldSplits = splits.filter(a => a.status === 'On Hold').length
  const delayed = splits.some(a => a.status === 'Delayed')
  const open = () => onOpen(order.id)
  return (
    <div role="button" tabIndex={0} onClick={open} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() } }}
      className="mo-style-row"
      style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 14px', background: T.surface, border: `1px solid ${T.border}`, borderLeft: `4px solid ${s.bd}`, borderRadius: 10, cursor: 'pointer' }}>
      <ProductThumb order={order} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <FlexRow gap={8} style={{ flexWrap: 'wrap' }}>
          <span style={{ fontSize: 14, fontWeight: 800, color: '#0f172a' }}>{order.product}</span>
          {order.styleNumber && <span style={{ fontSize: 12, fontWeight: 600, color: T.textMuted }}>{order.styleNumber}</span>}
          {delayed && <Chip fg="#991b1b" bg="#fee2e2" bd="#fca5a5">Delayed</Chip>}
          {heldSplits > 0 && section !== 'hold' && <Chip fg="#475569" bg="#f1f5f9" bd="#cbd5e1">{heldSplits} split{heldSplits > 1 ? 's' : ''} on hold</Chip>}
        </FlexRow>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 4, fontSize: 12, color: T.textMuted }}>
          <Mono style={{ fontSize: 11 }}>{order.id}</Mono>
          <span>{(order.totalQty || 0).toLocaleString('en-IN')} pcs</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Factory size={12} /> {factories.length ? factories.join(', ') : 'No manufacturer yet'}</span>
          {section === 'delivered'
            ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#166534', fontWeight: 600 }}><Truck size={12} color="#166534" /> {deliveredOn(order) ? `Delivered on ${fmtDate(deliveredOn(order))}` : 'Delivered'}</span>
            : planDue(order) && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Calendar size={12} /> Due {fmtDate(planDue(order))}</span>}
        </div>
      </div>
      {total > 0 && (
        <div className="mo-style-progress" style={{ width: 150, flexShrink: 0 }}>
          <FlexRow justify="space-between" style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, marginBottom: 5 }}>
            <span>{done}/{total} steps</span><span>{pct}%</span>
          </FlexRow>
          <div style={{ height: 6, borderRadius: 3, background: '#e2e8f0', overflow: 'hidden' }}>
            <div style={{ width: `${pct}%`, height: '100%', background: section === 'delivered' ? '#16a34a' : section === 'hold' ? '#94a3b8' : T.primaryDeep, borderRadius: 3 }} />
          </div>
        </div>
      )}
      <ChevronRight size={16} color={T.textLight} style={{ flexShrink: 0 }} />
    </div>
  )
}

function DroppedRow({ r }) {
  const snap = r.style || {}
  const photo = typeof snap.imageUrl === 'string' && /^https?:\/\//.test(snap.imageUrl) ? snap.imageUrl : null
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 14px', background: '#fafafa', border: `1px dashed ${T.border}`, borderLeft: `4px solid ${SECTION.dropped.bd}`, borderRadius: 10 }}>
      <div style={{ width: 48, height: 48, borderRadius: 6, background: '#f1f5f9', border: `1px solid ${T.border}`, overflow: 'hidden', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', filter: 'grayscale(1)', opacity: 0.8 }}>
        {photo ? <img src={photo} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <Trash2 size={18} color={T.textLight} />}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 800, color: '#475569', textDecoration: 'line-through', textDecorationColor: '#cbd5e1' }}>{r.label}</div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 4, fontSize: 12, color: T.textMuted }}>
          <Mono style={{ fontSize: 11 }}>{r.refId}</Mono>
          {snap.totalQty ? <span>{Number(snap.totalQty).toLocaleString('en-IN')} pcs</span> : null}
          <span>Dropped {fmtDate(r.droppedAt)}{r.droppedByName ? ` by ${r.droppedByName}` : ''}</span>
        </div>
        {r.reason && <div style={{ fontSize: 12, color: '#334155', marginTop: 5, fontStyle: 'italic' }}>"{r.reason}"</div>}
      </div>
    </div>
  )
}

export function MasterOrderPage({ moId, onBack, onOpen, onNavigate }) {
  const { orders, masterOrders, users, currentUser, loading } = useApp()
  const caps = capsFor(currentUser)
  // Tradio and the master order's customer see what was dropped; a factory only ever sees its own splits.
  const seesDropped = currentUser?.role === 'admin' || currentUser?.role === 'buyer'
  const [dropped, setDropped] = useState(null)
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    if (!seesDropped || !moId) return
    let live = true
    masterOrdersApi.dropped(moId).then(rows => { if (live) setDropped(Array.isArray(rows) ? rows : []) }).catch(() => { if (live) setDropped([]) })
    return () => { live = false }
  }, [moId, seesDropped])

  const mo = (masterOrders || []).find(m => m.id === moId) || null
  const styles = useMemo(() => (orders || []).filter(o => o.masterOrderId === moId), [orders, moId])
  const grouped = useMemo(() => {
    const g = Object.fromEntries(SECTIONS.map(s => [s.id, []]))
    for (const o of styles) g[sectionOf(o)].push(o)
    const key = (o, sec) => dayOf(sec === 'delivered' ? (deliveredOn(o) || planDue(o)) : planDue(o)) ?? Infinity
    for (const k of Object.keys(g)) g[k].sort((a, b) => key(a, k) - key(b, k))
    return g
  }, [styles])

  if (loading) return <LoadingScreen />
  if (!mo) {
    return (
      <div>
        <Btn variant="secondary" size="sm" onClick={onBack} icon={<ArrowLeft size={13} />}>Back</Btn>
        <Card style={{ marginTop: 14 }}><EmptyState icon={<Folder size={26} color={T.textLight} />} title="Master order not found" desc="It may have been removed, or it is not shared with you." /></Card>
      </div>
    )
  }

  // Headline numbers. Pieces count live styles only; a style on hold is still part of the order, so it counts.
  // A factory sees only its own splits, so its pieces are its splits' quantities, not the styles' totals.
  const isMfr = currentUser?.role === 'manufacturer'
  const pieces = styles.reduce((n, o) => n + (isMfr ? (o.assignments || []).reduce((m, a) => m + (a.qty || 0), 0) : (o.totalQty || 0)), 0)
  const deliveredPieces = styles.reduce((n, o) => n + (o.assignments || []).reduce((m, a) => m + (deliveryStatus(o, a).delivered ? (a.deliveredQty ?? a.qty ?? 0) : 0), 0), 0)
  const deliveredPct = pieces ? Math.min(100, Math.round((deliveredPieces / pieces) * 100)) : 0
  const factories = [...new Set(styles.flatMap(o => (o.assignments || []).map(a => a.mfrCompany)).filter(Boolean))]
  // The delivery window runs over every style in production: the day it arrived if delivered, else its TNA date.
  const dates = [...grouped.production, ...grouped.delivered].map(o => deliveredOn(o) || planDue(o)).filter(Boolean).sort((a, b) => dayOf(a) - dayOf(b))
  const today = dayNumber(getToday())
  const next = grouped.production.find(o => planDue(o) && dayOf(planDue(o)) >= today) || null
  const creator = mo.createdByName || users?.find(u => String(u.id) === String(mo.createdBy))?.name || null
  const droppedRows = dropped || []
  const counts = { ...Object.fromEntries(SECTIONS.map(s => [s.id, grouped[s.id]?.length || 0])), dropped: droppedRows.length }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <style>{`
        .mo-style-row { transition: border-color .12s, box-shadow .12s, transform .12s; }
        .mo-style-row:hover { border-color: ${T.primaryDeep}; box-shadow: 0 4px 14px rgba(15,23,42,.08); }
        .mo-style-row:focus-visible { outline: 2px solid ${T.primaryDeep}; outline-offset: 2px; }
        .mo-tiles { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 12px; }
        @media (max-width: 1200px) { .mo-tiles { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
        @media (max-width: 560px) { .mo-tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
        .mo-layout { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 18px; align-items: start; }
        @media (max-width: 1100px) { .mo-layout { grid-template-columns: minmax(0, 1fr); } }
        @media (max-width: 640px) { .mo-style-progress { display: none; } }
      `}</style>

      {/* Rename, re-season, drop styles from or delete the master order. Deleting it leaves the page on "not found". */}
      {editing && <EditMasterOrderModal mo={mo} onClose={() => setEditing(false)} onDeleted={() => onNavigate('orders')} />}
      <FlexRow gap={8} style={{ flexWrap: 'wrap' }}>
        <Btn variant="secondary" size="sm" onClick={onBack} icon={<ArrowLeft size={13} />}>Back</Btn>
        <div style={{ flex: 1 }} />
        {/* The TNA tab the styles are on; Reports only covers styles in production. */}
        {styles.length > 0 && <Btn variant="secondary" size="sm" onClick={() => onNavigate('orders', { mo: moId, phase: grouped.development.length && !grouped.production.length && !grouped.delivered.length ? 'development' : undefined })} icon={<LayoutGrid size={13} />}>Open in TNA</Btn>}
        {(grouped.production.length > 0 || grouped.delivered.length > 0) && <Btn variant="secondary" size="sm" onClick={() => onNavigate('reports', { mo: moId })} icon={<BarChart3 size={13} />}>Open in Reports</Btn>}
        {caps.createOrders && <Btn variant="secondary" size="sm" onClick={() => onNavigate('orders', { mo: moId, newStyle: true })} icon={<Plus size={13} />}>Create Style</Btn>}
        {canEditMasterOrder(currentUser, mo) && <Btn size="sm" onClick={() => setEditing(true)} icon={<Pencil size={13} />}>Edit</Btn>}
      </FlexRow>

      {/* Hero: what the order is, for whom, and how much of it has shipped. */}
      <div style={{ background: T.heroGradient, borderRadius: 16, padding: '24px 26px', color: '#fff', display: 'flex', gap: 24, alignItems: 'center', flexWrap: 'wrap', boxShadow: '0 10px 30px rgba(0,43,91,0.18)' }}>
        <div style={{ flex: '1 1 320px', minWidth: 0 }}>
          <FlexRow gap={8} style={{ flexWrap: 'wrap', marginBottom: 10 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.75)' }}><Folder size={13} color="rgba(255,255,255,0.75)" /> Master order</span>
            <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 6, background: 'rgba(255,255,255,0.12)', color: '#fff' }}>{mo.id}</span>
            {mo.season && <span style={{ fontSize: 11, fontWeight: 800, padding: '2px 8px', borderRadius: 6, background: '#fff', color: T.primaryDeep }}>{mo.season}</span>}
          </FlexRow>
          <div style={{ fontSize: 26, fontWeight: 800, lineHeight: 1.15, letterSpacing: '-0.02em' }}>{mo.orderName}</div>
          <div style={{ fontSize: 14, color: 'rgba(255,255,255,0.82)', marginTop: 6, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Building2 size={14} color="rgba(255,255,255,0.82)" /> {mo.buyerCompany || mo.buyerName || 'Customer'}</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Calendar size={14} color="rgba(255,255,255,0.82)" /> Created {fmtDate(mo.createdAt)}{creator ? ` by ${creator}` : ''}</span>
          </div>
        </div>
        <div style={{ flex: '0 1 260px', minWidth: 220 }}>
          <FlexRow justify="space-between" style={{ fontSize: 12, fontWeight: 700, color: 'rgba(255,255,255,0.8)', marginBottom: 8 }}>
            <span>Pieces delivered</span><span>{deliveredPct}%</span>
          </FlexRow>
          <div style={{ height: 10, borderRadius: 5, background: 'rgba(255,255,255,0.18)', overflow: 'hidden' }}>
            <div style={{ width: `${deliveredPct}%`, height: '100%', borderRadius: 5, background: 'linear-gradient(90deg, #4ade80, #22c55e)' }} />
          </div>
          <div style={{ fontSize: 13, marginTop: 8, color: '#fff', fontVariantNumeric: 'tabular-nums' }}>
            <strong>{deliveredPieces.toLocaleString('en-IN')}</strong> <span style={{ color: 'rgba(255,255,255,0.7)' }}>of {pieces.toLocaleString('en-IN')} pcs</span>
          </div>
        </div>
      </div>

      {/* Counts by where the styles stand. */}
      <div className="mo-tiles">
        <Tile label="Styles" value={styles.length} sub={`${pieces.toLocaleString('en-IN')} pcs`} icon={Package} fg={T.primaryDeep} bg={T.primaryLight} />
        {SECTIONS.filter(s => s.id !== 'dropped' || seesDropped).map(s => (
          <Tile key={s.id} label={s.label} value={counts[s.id]} icon={s.icon} fg={s.fg} bg={s.bg} />
        ))}
      </div>

      <div className="mo-layout">
        {/* Every style, by section. */}
        <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 18 }}>
          {styles.length === 0 && droppedRows.length === 0 && (
            <Card><EmptyState icon={<Package size={26} color={T.textLight} />} title="No styles yet" desc={caps.createOrders ? 'Use Create Style above to add the first one.' : 'Styles show up here once they are added.'} /></Card>
          )}
          {SECTIONS.map(s => {
            const list = s.id === 'dropped' ? droppedRows : grouped[s.id]
            if (!list?.length) return null
            const Icon = s.icon
            return (
              <section key={s.id}>
                <FlexRow gap={8} style={{ marginBottom: 10 }}>
                  <span style={{ width: 26, height: 26, borderRadius: 8, background: s.bg, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><Icon size={14} color={s.fg} /></span>
                  <span style={{ fontSize: 14, fontWeight: 800, color: '#0f172a' }}>{s.label}</span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: s.fg, background: s.bg, border: `1px solid ${s.bd}`, borderRadius: 999, padding: '0 8px', lineHeight: '18px' }}>{list.length}</span>
                  <div style={{ flex: 1, height: 1, background: T.border }} />
                  {s.id === 'hold' && <span style={{ fontSize: 11, color: T.textLight }}>Not shown in the TNA</span>}
                  {s.id === 'dropped' && <span style={{ fontSize: 11, color: T.textLight }}>Kept as a record</span>}
                </FlexRow>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {s.id === 'dropped'
                    ? list.map(r => <DroppedRow key={r.id} r={r} />)
                    : list.map(o => <StyleRow key={o.id} order={o} section={s.id} onOpen={onOpen} />)}
                </div>
              </section>
            )
          })}
        </div>

        {/* The facts about the order. */}
        <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Card>
            <div style={{ fontSize: 13, fontWeight: 800, color: '#0f172a', marginBottom: 4 }}>Order details</div>
            {(mo.poNumber || mo.poDate) && <InfoRow icon={FileText} label="Customer PO">{mo.poNumber || 'No number'}{mo.poDate ? <span style={{ color: T.textMuted, fontWeight: 500 }}> · {fmtDate(mo.poDate)}</span> : null}</InfoRow>}
            {mo.shipBy && <InfoRow icon={Calendar} label="Ship by">{fmtDate(mo.shipBy)}</InfoRow>}
            <InfoRow icon={Building2} label="Customer">{mo.buyerCompany || '-'}{mo.buyerName ? <span style={{ color: T.textMuted, fontWeight: 500 }}> · {mo.buyerName}</span> : null}</InfoRow>
            <InfoRow icon={Factory} label={factories.length === 1 ? 'Manufacturer' : 'Manufacturers'}>{factories.length ? factories.join(', ') : 'None assigned yet'}</InfoRow>
            <InfoRow icon={Calendar} label="Delivery window">{dates.length ? (dates.length === 1 || fmtDate(dates[0]) === fmtDate(dates[dates.length - 1]) ? fmtDate(dates[0]) : `${fmtDate(dates[0])} to ${fmtDate(dates[dates.length - 1])}`) : 'No delivery dates yet'}</InfoRow>
            <InfoRow icon={Truck} label="Next delivery">
              {next
                ? <button onClick={() => onOpen(next.id)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 700, color: T.primaryDeep, display: 'inline-flex', alignItems: 'center', gap: 4, textAlign: 'left' }}>{next.product}, {fmtDate(planDue(next))} <ArrowRight size={12} /></button>
                : 'Nothing due'}
            </InfoRow>
            <InfoRow icon={Package} label="Quantity">{pieces.toLocaleString('en-IN')} pcs across {styles.length} style{styles.length === 1 ? '' : 's'}</InfoRow>
            {mo.notes && <InfoRow icon={StickyNote} label="Notes"><span style={{ fontWeight: 500, whiteSpace: 'pre-wrap' }}>{mo.notes}</span></InfoRow>}
          </Card>
        </div>
      </div>
    </div>
  )
}
