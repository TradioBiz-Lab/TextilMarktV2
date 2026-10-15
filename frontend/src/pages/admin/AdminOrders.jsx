import { useState, useRef, useEffect } from 'react'
import { Plus, Search, Folder, Package, Check, Ban, AlertTriangle, ChevronDown, ChevronUp, ArrowRight, X } from '../../icons.jsx'
import {
  T, SEASONS, ORDER_STATUSES,
  isStageDone, stageIsOverdue, stageKindOf, stageProgressLabel, stageVariance, stageActualVariance, stagePct, fmtStageDate, effectiveEta,
  CELL_STATE, cellState, buildMatrixSpine, withBuyerPrefix, getToday, PHASES, phaseOf, styleOnHold
} from '../../constants.js'
import { Badge, Btn, Card, EmptyState, Mono, FlexRow, PageHeader, Select, Input, Textarea, FileUpload, LoadingScreen, useToast, fileUploadPayload, ProductThumb, Modal, activateOnKey } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'
import { capsFor, orderCaps } from '../../caps.js'
import { usePartners } from '../../lib/usePartners.js'
import { OwnerChip } from '../../components/OwnerChip.jsx'
import { ordersApi } from '../../api.js'
import { PromoteModal } from '../../components/PromoteModal.jsx'
import { EditOrderModal } from './EditOrderModal.jsx'
import { QuickStageModal } from './QuickStageModal.jsx'
import { CreateStyleWizard } from './CreateStyleWizard.jsx'

function fmtDate(d) {
  if (!d) return '—'
  const dt = new Date(d)
  const dd = String(dt.getDate()).padStart(2, '0')
  const mm = String(dt.getMonth() + 1).padStart(2, '0')
  return `${dd}-${mm}-${dt.getFullYear()}`
}

// ── Matrix view: styles across the top, TNA steps down the side ────────────
// The shape the team already keeps by hand in the Summary TNA sheet — one
// glance at a whole master order's plan, rather than one row per order.

// "Fitleasure — Core Series" rather than just "Core Series" — the master-order
// name alone doesn't say whose order it is. A real master-order group always
// belongs to one buyer; the "Other Orders" catch-all can span several, so it
// only gets a client prefix when every order in it happens to share one.
function groupDisplayLabel(g) {
  const base = g.mo?.orderName || (g.moId === '__none__' ? 'Other Orders' : g.moId)
  // A master order with no styles yet has no orders to read the buyer from: use its own.
  const source = g.orders.length === 0 && g.mo?.buyerCompany ? [{ buyerCompany: g.mo.buyerCompany }] : g.orders
  return withBuyerPrefix(base, source)
}

export function AdminOrders({ onOpen, onOpenMo, initialStatus, initialMo, initialPhase, openWizardFor, onSubmitReq }) {
  const { orders, users, loading, createOrder, uploadDoc, masterOrders, createMasterOrder, editOrder, currentUser } = useApp()
  // One Orders page for every role; caps decides which actions each sees (see caps.js).
  const caps = capsFor(currentUser)
  const toast = useToast()
  const [q, setQ] = useState('')
  const [showSugg, setShowSugg] = useState(false)
  const [sfilt, setSfilt] = useState(initialStatus || 'All')
  // Styles still being sampled and developed are kept apart from the ones in production.
  const [phase, setPhase] = useState(initialPhase || 'production')
  // Moving styles out of New Product Development: tick the ones that are ready and move them in one go.
  const [promoteOpen, setPromoteOpen] = useState(false)
  const [picked, setPicked] = useState(() => new Set())
  const [moving, setMoving] = useState(false)
  const [askDate, setAskDate] = useState(false)
  // The TNA counts what it shows: a style on hold is listed on its master order's page instead.
  const phaseCount = Object.fromEntries(PHASES.map(([v]) => [v, orders.filter(o => phaseOf(o) === v && !styleOnHold(o)).length]))
  // Groups start collapsed — an admin managing many master orders shouldn't have to
  // scroll past every line item of every group just to find one. Tracks which groups
  // have been explicitly expanded, rather than which are collapsed.
  const [expandedGroups, setExpandedGroups] = useState(() => new Set())
  const toggleGroup = moId => setExpandedGroups(prev => {
    const next = new Set(prev)
    next.has(moId) ? next.delete(moId) : next.add(moId)
    return next
  })

  // Native `title` tooltips are slow to appear (~1s browser delay) and easy to
  // miss entirely — a custom one shows the instant the cursor lands, following
  // the mouse so it never gets clipped by the scrolling matrix container.
  const [matrixTip, setMatrixTip] = useState(null) // { x, y, lines: string[] }
  // Clicking a date cell opens the update modal IN PLACE — no navigation, so
  // saving and closing leaves the admin exactly on Order Management.
  const [quickStage, setQuickStage] = useState(null) // { orderId, mfrId, stageIndex }
  // A short delay before showing (not on hiding) is what makes a tooltip feel
  // intentional rather than jumpy — it only appears once the cursor actually
  // settles on a cell, so sweeping across a row doesn't flash one per cell.
  const matrixTipTimerRef = useRef(null)
  const showMatrixTip = (x, y, lines) => {
    clearTimeout(matrixTipTimerRef.current)
    matrixTipTimerRef.current = setTimeout(() => setMatrixTip({ x, y, lines }), 350)
  }
  const hideMatrixTip = () => {
    clearTimeout(matrixTipTimerRef.current)
    setMatrixTip(null)
  }

  // ── Edit / Delete modal state ──
  const [editTarget, setEditTarget] = useState(null)

  // ── Create Style wizard state ──
  const [showWizard, setShowWizard] = useState(!!openWizardFor)
  // The master order the wizard opens on: the one a page asked for, or one just created from inside the wizard.
  const [wizardMo, setWizardMo] = useState(openWizardFor || '')
  const [moFromWizard, setMoFromWizard] = useState(false)

  // ── Create Master Order state ──
  const [showMO, setShowMO] = useState(false)
  const BLANK_MO = { buyerId: '', orderName: '', season: 'SS26', poNumber: '', poDate: '', shipBy: '', notes: '' }
  const [mo, setMo] = useState(BLANK_MO)
  const [moFile, setMoFile] = useState(null)
  const [moFileErr, setMoFileErr] = useState('')
  const [moErr, setMoErr] = useState('')
  const [moSaving, setMoSaving] = useState(false)

  // Who a master order can be for. A brand: itself, always. A manufacturer (standalone): only the
  // brands it is connected with. Tradio staff: any active brand.
  const { partners, loading: partnersLoading } = usePartners(caps.standalone && caps.isCompany)
  const customerChoices = caps.standalone && caps.isMfr
    ? partners.filter(p => p.role === 'buyer')
    : users.filter(u => u.role === 'buyer' && u.isActive)
  const noConnectedBrands = caps.standalone && caps.isMfr && !partnersLoading && customerChoices.length === 0
  const moBuyerId = caps.isBuyer ? currentUser.id : mo.buyerId

  const filtered = orders.filter(o => {
    const qm = !q || [o.id, o.product, o.styleNumber].some(v => (v || '').toLowerCase().includes(q.toLowerCase()))
    const sm = sfilt === 'All' || (o.assignments || []).some(a => a.status === sfilt)
    return qm && sm && phaseOf(o) === phase
  })

  // Cluster orders under their Master Order (📁 grouping) — same pattern as the buyer
  // dashboard's order list. Orders with no masterOrderId fall into "Other Orders" last.
  const groupedOrders = (() => {
    const groups = new Map()
    filtered.forEach(o => {
      const moId = o.masterOrderId || '__none__'
      if (!groups.has(moId)) groups.set(moId, [])
      groups.get(moId).push(o)
    })
    const result = [...groups.entries()].map(([moId, ords]) => ({
      moId, mo: moId !== '__none__' ? masterOrders.find(m => m.id === moId) : null, orders: ords,
    }))
    // A master order with no styles yet still shows, otherwise one you just created looks lost and an
    // empty one could never be opened or deleted. Hidden while searching or filtering, when only
    // matching styles are wanted.
    if (!q && sfilt === 'All' && phase === 'production') {
      masterOrders.forEach(m => { if (!orders.some(o => o.masterOrderId === m.id)) result.push({ moId: m.id, mo: m, orders: [] }) })
    }
    result.sort((a, b) => {
      if (a.moId === '__none__') return 1
      if (b.moId === '__none__') return -1
      return new Date(b.mo?.createdAt || 0) - new Date(a.mo?.createdAt || 0)
    })
    return result
  })()

  // A small account has one or two master orders, and collapsing those meant the
  // page opened as column headers above nothing — reading as an empty table
  // rather than a tidy one. Auto-expand once, on first load, only when the list
  // is short enough that the scroll argument above doesn't apply. Runs a single
  // time so every later toggle is purely the user's.
  // Everything starts collapsed. The one exception is arriving from the
  // dashboard on a specific master order: open that group (only) and scroll to it.
  // Runs once per target: the group count is a dependency only so it retries until the group has
  // loaded. Without the `handledMo` guard it fired again on every search or filter (the count
  // changes) and collapsed everything except the target group.
  const handledMo = useRef(null)
  useEffect(() => {
    if (!initialMo || handledMo.current === initialMo || !groupedOrders.some(g => g.moId === initialMo)) return
    handledMo.current = initialMo
    setExpandedGroups(new Set([initialMo]))
    const t = setTimeout(() => document.getElementById(`mo-group-${initialMo}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 80)
    return () => clearTimeout(t)
  }, [initialMo, groupedOrders.length])

  const resetMoForm = () => {
    setMo(BLANK_MO)
    setMoFile(null); setMoFileErr(''); setMoErr('')
  }

  // Hooks above must run on every render, so the loading gate sits after them.
  if (loading) return <LoadingScreen />

  return (
    <div>
      {editTarget && (
        <EditOrderModal
          order={editTarget}
          onClose={() => setEditTarget(null)}
          onSave={async (id, data) => {
            await editOrder(id, data)
            toast(`Order ${id} updated`, 'success')
            setEditTarget(null)
          }}
        />
      )}
      {showWizard && (
        <CreateStyleWizard
          masterOrders={masterOrders}
          presetMasterOrderId={wizardMo}
          onClose={() => { setShowWizard(false); setWizardMo('') }}
          onNewMasterOrder={() => { setMoFromWizard(true); setShowMO(true) }}
          onCreated={firstStyleId => {
            setShowWizard(false)
            toast(`Style${firstStyleId ? ` ${firstStyleId}` : ''} created`, 'success')
            onOpen(firstStyleId)
          }}
        />
      )}

      {/* ── Create Master Order Modal ── */}
      {showMO && (
        <Modal title="Create Master Order" subtitle="One customer buy, e.g. a season's range. Styles are created under it." onClose={() => { if (!moSaving) { setShowMO(false); setMoFromWizard(false); resetMoForm() } }} size="md">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {caps.isBuyer ? (
              <div>
                <label style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 6 }}>Brand</label>
                <div style={{ fontSize: 14, fontWeight: 600, color: T.text }}>{currentUser.company}</div>
              </div>
            ) : noConnectedBrands ? (
              <div style={{ fontSize: 13, color: T.textMuted, background: T.warningBg, border: `1px solid ${T.warningBorder}`, borderRadius: 8, padding: '10px 12px', lineHeight: 1.5 }}>
                You are not connected with any brand yet. Ask your Tradio contact to connect you with the brands you work for, then you can set up their orders here.
              </div>
            ) : (
              <Select label={caps.isMfr ? 'Customer (brand) *' : 'Customer *'} value={mo.buyerId} onChange={e => setMo({ ...mo, buyerId: e.target.value })}>
                <option value="">Select customer...</option>
                {customerChoices.map(b => <option key={b.id} value={b.id}>{b.company} ({b.code})</option>)}
              </Select>
            )}
            <div className="form-grid-2" style={{ gap: 12 }}>
              <Input label="Order Name *" value={mo.orderName} onChange={e => setMo({ ...mo, orderName: e.target.value })} placeholder="e.g. H1, H26, Core Series" hint="Shown with the customer's name, e.g. Cocoblu, H1." />
              <Select label="Season" value={mo.season} onChange={e => setMo({ ...mo, season: e.target.value })}>
                {SEASONS.map(s => <option key={s}>{s}</option>)}
              </Select>
            </div>
            <div className="form-grid-2" style={{ gap: 12 }}>
              <Input label="Customer PO number" value={mo.poNumber} onChange={e => setMo({ ...mo, poNumber: e.target.value })} maxLength={60} placeholder="As on the customer's PO" />
              <Input label="PO date" type="date" value={mo.poDate} onChange={e => setMo({ ...mo, poDate: e.target.value })} />
            </div>
            <Input label="Ship by" type="date" value={mo.shipBy} onChange={e => setMo({ ...mo, shipBy: e.target.value })} hint="When the customer needs the buy shipped. Each style's own delivery date is set when its manufacturer is added." />
            <Textarea label="Notes" value={mo.notes} onChange={e => setMo({ ...mo, notes: e.target.value })} rows={2} maxLength={2000} placeholder="Terms, ship-to, anything worth keeping with this buy" />
            <div>
              <label style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 8 }}>Customer PO or RFQ file (optional)</label>
              <FileUpload file={moFile} onFile={f => { setMoFile(f); setMoFileErr('') }} error={moFileErr} onError={setMoFileErr} />
              <div style={{ fontSize: 11, color: T.textLight, marginTop: 4 }}>It shows in the PO and Invoice folder of every style in this master order. The number is given when you create it.</div>
            </div>
            {moErr && <div style={{ fontSize: 12, color: T.danger, fontWeight: 600, background: T.dangerBg, border: `1px solid ${T.dangerBorder}`, borderRadius: 8, padding: '8px 12px' }}><AlertTriangle size={12} style={{ verticalAlign: -2, marginRight: 4 }} /> {moErr}</div>}
            <FlexRow justify="flex-end" gap={8}>
              <Btn variant="secondary" disabled={moSaving} onClick={() => { setShowMO(false); setMoFromWizard(false); resetMoForm() }}>Cancel</Btn>
              <Btn disabled={!moBuyerId || !mo.orderName.trim() || moSaving} onClick={async () => {
                setMoErr('')
                setMoSaving(true)
                try {
                  // The server numbers it (a new number can never clash with one a teammate just made).
                  const created = await createMasterOrder({ id: 'auto', buyerId: moBuyerId, orderName: mo.orderName.trim(), season: mo.season,
                    poNumber: mo.poNumber.trim(), poDate: mo.poDate || null, shipBy: mo.shipBy || null, notes: mo.notes.trim() })
                  const moId = created.id
                  let fileFailed = null
                  if (moFile) {
                    try {
                      await uploadDoc({
                        type: 'PO', name: `Customer PO, ${moId}`, issuer: '', issueDate: mo.poDate || getToday(),
                        expiryDate: null, orderId: null, mfrId: null, masterOrderId: moId,
                        ...fileUploadPayload(moFile),
                      })
                    } catch (e) { fileFailed = e?.message || 'upload failed' }
                  }
                  // Say so when the attached file did not make it, instead of reporting a clean success.
                  if (fileFailed) toast(`Master order ${moId} created, but the file did not upload (${fileFailed}). Add it to a style's PO and Invoice folder.`, 'warning')
                  else toast(`Master order ${moId} created`, 'success')
                  setShowMO(false)
                  resetMoForm()
                  // Made from inside Create Style: back to the wizard with it chosen. Otherwise straight to its page.
                  if (moFromWizard) { setWizardMo(moId); setMoFromWizard(false) }
                  else if (onOpenMo) onOpenMo(moId)
                } catch (err) {
                  setMoErr(err?.message || 'Failed to create master order')
                } finally { setMoSaving(false) }
              }}>{moSaving ? 'Creating...' : 'Create Master Order'}</Btn>
            </FlexRow>
          </div>
        </Modal>
      )}

      <PageHeader
        title="Order Management"
        subtitle={caps.createOrders
          ? (caps.standalone && caps.isMfr ? 'Set up styles for your brands and take each one through production'
            : caps.standalone && caps.isBuyer ? 'Place styles with your manufacturers and follow each one through production'
            : 'Create styles, assign manufacturers, and manage the full order lifecycle')
          : caps.isBuyer ? 'Every style you have placed, and where each one stands'
          : 'Every style assigned to your factory, and where each one stands'}
        action={caps.createOrders ? (
          <FlexRow gap={8}>
            <Btn variant="secondary" onClick={() => { setMoFromWizard(false); setShowMO(true) }} icon={<Folder size={13} />}>New Master Order</Btn>
            <Btn onClick={() => setShowWizard(true)} icon={<Plus size={13} />}>Create Style</Btn>
          </FlexRow>
        ) : (caps.submitRequirement && onSubmitReq ? <Btn onClick={onSubmitReq} icon={<Plus size={13} />}>Submit Requirement</Btn> : null)} />

      <FlexRow gap={6} style={{ marginBottom: 14 }}>
        {PHASES.map(([id, label]) => (
          <button key={id} onClick={() => setPhase(id)} aria-pressed={phase === id}
            style={{ fontSize: 13, fontWeight: 800, padding: '8px 16px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit',
              border: `1px solid ${phase === id ? T.primaryDeep : T.border}`,
              background: phase === id ? T.primaryDeep : T.surface,
              color: phase === id ? '#fff' : T.text }}>
            {label} <span style={{ opacity: 0.8, fontWeight: 700 }}>({phaseCount[id]})</span>
          </button>
        ))}
      </FlexRow>
      {phase === 'development' && currentUser.role !== 'manufacturer' && (() => {
        const ready = filtered.filter(o => orderCaps(currentUser, o).edit)
        if (ready.length === 0) return null
        const byMo = new Map()
        ready.forEach(o => { const k = o.masterOrderId || '__none__'; if (!byMo.has(k)) byMo.set(k, []); byMo.get(k).push(o) })
        const toggle = ids => setPicked(prev => {
          const next = new Set(prev)
          const all = ids.every(id => next.has(id))
          ids.forEach(id => (all ? next.delete(id) : next.add(id)))
          return next
        })
        const chosen = ready.filter(o => picked.has(o.id))
        const move = async date => {
          setMoving(true)
          let ok = 0
          try {
            // Only a style with a manufacturer takes the date now; one without gets it when the manufacturer is added.
            for (const o of chosen) { await editOrder(o.id, { phase: 'production', ...(o.delivery || !(o.assignments || []).length ? {} : { delivery: date }) }); ok++ }
            toast(`${ok} ${ok === 1 ? 'style' : 'styles'} moved to production`, 'success')
            setPicked(new Set()); setPromoteOpen(false); setAskDate(false)
          } catch (e) {
            toast(`${ok} moved, then stopped: ${typeof e === 'string' ? e : (e?.message || 'error')}`, 'error')
            setPicked(prev => { const next = new Set(prev); chosen.slice(0, ok).forEach(o => next.delete(o.id)); return next })
            setAskDate(false)
          } finally { setMoving(false) }
        }
        return (
          <div style={{ marginBottom: 14 }}>
            {askDate && <PromoteModal count={chosen.length} needsDate={chosen.some(o => !o.delivery && (o.assignments || []).length > 0)} busy={moving} onClose={() => setAskDate(false)} onConfirm={move} />}
            <Btn variant="secondary" size="sm" onClick={() => setPromoteOpen(v => !v)} icon={<ArrowRight size={13} />}>
              {promoteOpen ? 'Close' : 'Move styles to production'}
            </Btn>
            {promoteOpen && (
              <Card style={{ marginTop: 10 }}>
                <div style={{ fontSize: 13, fontWeight: 800, color: '#0f172a', marginBottom: 8 }}>Tick the styles that are ready for production</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {[...byMo.entries()].map(([k, list]) => {
                    const ids = list.map(o => o.id)
                    const label = groupDisplayLabel({ mo: masterOrders.find(m => m.id === k) || null, moId: k, orders: list })
                    return (
                      <div key={k}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 800, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', cursor: 'pointer' }}>
                          <input type="checkbox" checked={ids.every(id => picked.has(id))} onChange={() => toggle(ids)} style={{ accentColor: T.primaryDeep }} />
                          {label}
                        </label>
                        {list.map(o => (
                          <label key={o.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0 5px 24px', fontSize: 13, color: T.text, cursor: 'pointer' }}>
                            <input type="checkbox" checked={picked.has(o.id)} onChange={() => toggle([o.id])} style={{ accentColor: T.primaryDeep }} />
                            <span>{o.product}</span>
                          </label>
                        ))}
                      </div>
                    )
                  })}
                </div>
                <div style={{ marginTop: 12 }}>
                  <Btn size="sm" disabled={chosen.length === 0 || moving} onClick={() => setAskDate(true)}>
                    {moving ? 'Moving…' : chosen.length ? `Move ${chosen.length} to production` : 'Move to production'}
                  </Btn>
                </div>
              </Card>
            )}
          </div>
        )
      })()}

      <Card pad={false}>
        <div style={{ padding: '14px 18px', borderBottom: `1px solid ${T.border}`, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {/* Search with order-ID autocomplete */}
          {(() => {
            const sugg = q.trim().length > 0
              ? orders.filter(o =>
                  o.id.toLowerCase().includes(q.toLowerCase()) ||
                  o.product.toLowerCase().includes(q.toLowerCase()) ||
                  (o.styleNumber || '').toLowerCase().includes(q.toLowerCase())
                ).slice(0, 8)
              : []
            return (
              <div style={{ flex: 1, minWidth: 200, position: 'relative' }}>
                <Search size={13} color={T.textLight} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} />
                <input
                  value={q}
                  onChange={e => { setQ(e.target.value); setShowSugg(true) }}
                  onFocus={() => setShowSugg(true)}
                  onBlur={() => setTimeout(() => setShowSugg(false), 150)}
                  placeholder="Search by product or order ID…"
                  style={{ width: '100%', boxSizing: 'border-box', border: `1px solid ${T.border}`, borderRadius: 8, padding: '7px 12px 7px 32px', fontSize: 13, color: T.text, background: '#f8fafc', fontFamily: 'inherit' }}
                />
                {showSugg && sugg.length > 0 && (
                  <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.1)', zIndex: 200, overflow: 'hidden' }}>
                    {sugg.map((o, i) => (
                      <div key={o.id}
                        onMouseDown={() => { setQ(o.id); setShowSugg(false) }}
                        style={{ padding: '9px 14px', cursor: 'pointer', borderBottom: i < sugg.length - 1 ? `1px solid ${T.border}` : 'none', display: 'flex', gap: 10, alignItems: 'center', background: 'transparent' }}
                        onMouseEnter={e => e.currentTarget.style.background = '#f8fafc'}
                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                      >
                        <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 12, color: T.primary, fontWeight: 700, whiteSpace: 'nowrap' }}>{o.id}</span>
                        <span style={{ fontSize: 12, color: T.text, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.product}</span>
                        <span style={{ fontSize: 11, color: T.textLight, whiteSpace: 'nowrap' }}>{o.buyerCompany}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })()}
          <select value={sfilt} onChange={e => setSfilt(e.target.value)}
            style={{ border: `1px solid ${T.border}`, borderRadius: 8, padding: '7px 12px', fontSize: 13, color: T.text, background: T.surface, fontFamily: 'inherit' }}>
            <option value="All">All Statuses</option>
            {ORDER_STATUSES.filter(s => s !== 'On Hold').map(s => <option key={s}>{s}</option>)}
          </select>
        </div>
        {/* Styles across the top, TNA steps down the side. Each cell's state is named in its hover tooltip. */}
          <div style={{ padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>

            {groupedOrders.length === 0 && <EmptyState icon={<Package size={26} color={T.textLight} />} title={phase === 'development' ? 'Nothing in New Product Development' : 'No orders'} desc={phase === 'development' ? 'Styles still being sampled show up here.' : caps.createOrders ? "Create your first order above" : "Orders will appear here once they are placed"} />}

            {groupedOrders.map(g => {
              // Earliest delivery first — the style due soonest is the one that
              // most needs eyes, so it belongs leftmost, not wherever it happened
              // to land in creation order.
              // A style with no manufacturer yet still needs its own column —
              // asgn: null — so it isn't invisible in the matrix while TBD.
              const entries = g.orders.flatMap(o => (o.assignments || []).length > 0
                // A split on hold is not in the TNA; its master order's page still lists it.
                ? o.assignments.filter(a => a.status !== 'On Hold').map(a => ({ order: o, asgn: a }))
                : [{ order: o, asgn: null }])
                .sort((x, y) => {
                  const dx = x.order.delivery ? new Date(x.order.delivery).getTime() : Infinity
                  const dy = y.order.delivery ? new Date(y.order.delivery).getTime() : Infinity
                  return dx - dy
                })
              const spine = entries.length ? buildMatrixSpine(entries) : []
              const groupLabel = groupDisplayLabel(g)
              const held = g.orders.filter(styleOnHold).length
              const isOpen = expandedGroups.has(g.moId)
              return (
                <div key={g.moId} style={{ border: `1px solid ${T.border}`, borderRadius: 10, overflow: 'hidden' }}>
                  <FlexRow gap={10} onClick={() => toggleGroup(g.moId)}
                    style={{ padding: '9px 14px', background: '#f1f5f9', cursor: 'pointer' }}>
                    <span style={{ color: T.textMuted, transform: isOpen ? 'none' : 'rotate(-90deg)', display: 'inline-flex' }}><ChevronDown size={13} /></span>
                    <span style={{ fontSize: 13, fontWeight: 800, color: T.text, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Folder size={13} /> {groupLabel}</span>
                    {g.mo?.season && <span style={{ fontSize: 10, fontWeight: 700, color: '#0369a1', background: '#dbeafe', padding: '1px 7px', borderRadius: 4 }}>{g.mo.season}</span>}
                    <span style={{ fontSize: 11, color: T.textMuted, marginLeft: 'auto' }}>{entries.length} style{entries.length !== 1 ? 's' : ''} · {spine.length} steps</span>
                    {held > 0 && (
                      <span title="Styles on hold are not shown in the TNA. Open Details to see them." style={{ fontSize: 10, fontWeight: 800, color: '#475569', background: '#e2e8f0', padding: '1px 8px', borderRadius: 999, whiteSpace: 'nowrap' }}>{held} on hold</span>
                    )}
                    {g.mo && onOpenMo && (
                      <button onClick={e => { e.stopPropagation(); onOpenMo(g.moId) }} title="Open the master order page" aria-label={`Open master order ${groupLabel}`}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 9px', fontSize: 11, fontWeight: 700, borderRadius: 6, border: `1px solid ${T.primaryDeep}`, background: T.surface, color: T.primaryDeep, cursor: 'pointer', fontFamily: 'inherit' }}>
                        Details <ArrowRight size={11} />
                      </button>
                    )}
                  </FlexRow>

                  {isOpen && entries.length === 0 && (
                    <div style={{ padding: '14px 16px', fontSize: 12, color: T.textMuted }}>
                      {held > 0 ? 'Every style in this master order is on hold. Open Details to see them.' : `No styles in this master order yet.${caps.createOrders ? ' Use Create Style to add the first one.' : ''}`}
                    </div>
                  )}
                  {isOpen && entries.length > 0 && (
                    <div className="table-scroll">
                      <table style={{ borderCollapse: 'collapse', minWidth: 340 + entries.length * 150 }}>
                        <thead>
                          <tr style={{ background: '#f8fafc' }}>
                            <th style={{ padding: '9px 14px', textAlign: 'left', fontSize: 10, fontWeight: 800, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.07em', position: 'sticky', left: 0, zIndex: 2, background: '#f8fafc', minWidth: 220 }}>
                              Step
                            </th>
                            {entries.map(({ order, asgn }) => (
                              <th key={`${order.id}-${asgn?.mid ?? 'unassigned'}`} onClick={() => onOpen(order.id, asgn?.mid)} role="button" tabIndex={0} onKeyDown={activateOnKey(() => onOpen(order.id, asgn?.mid))}
                                title={`${order.product} - ${order.id}${asgn ? '' : ' (no manufacturer assigned yet)'}`}
                                style={{ padding: '9px 10px', textAlign: 'left', minWidth: 150, cursor: 'pointer', borderLeft: `1px solid ${T.border}` }}>
                                <FlexRow gap={6}>
                                  <ProductThumb order={order} size="sm" />
                                  <div style={{ minWidth: 0 }}>
                                    <div style={{ fontSize: 11, fontWeight: 700, color: T.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 110 }}>
                                      {order.product}
                                    </div>
                                    {asgn
                                      ? <Mono style={{ fontSize: 9 }}>{asgn.qty?.toLocaleString()} pcs</Mono>
                                      : <span style={{ fontSize: 9, fontWeight: 800, color: T.textLight, letterSpacing: '0.04em' }}>TBD</span>}
                                  </div>
                                </FlexRow>
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {spine.map((step, ri) => {
                            const key = step.toLowerCase()
                            return (
                              <tr key={step} style={{ borderTop: `1px solid ${T.border}` }}>
                                <td style={{ padding: '7px 14px', fontSize: 12, fontWeight: 600, color: T.text, position: 'sticky', left: 0, zIndex: 1, background: T.surface, whiteSpace: 'nowrap' }}>
                                  <span style={{ color: T.textLight, fontSize: 10, marginRight: 6 }}>{ri + 1}</span>{step}
                                </td>
                                {entries.map(({ order, asgn }) => {
                                  const stageIdx = (asgn?.stages || []).findIndex(s => s.name.trim().toLowerCase() === key)
                                  const stage = stageIdx >= 0 ? asgn.stages[stageIdx] : null
                                  const state = cellState(stage)
                                  const st = state ? CELL_STATE[state] : null
                                  const planVariance = stage ? stageVariance(stage) : null
                                  const actualVariance = stage ? stageActualVariance(stage) : null
                                  // Once a stage is done, the story shifts from "did the plan move"
                                  // to "did we hit it" — show actualEnd against eta instead of eta
                                  // against baseline. isStageDone (not just state==='done') so this
                                  // also covers blocked-but-done edge cases the same way.
                                  const done = stage && isStageDone(stage) && stage.actualEnd
                                  const variance = done ? actualVariance : planVariance
                                  // Everything trimmed from the visible cell (start date, planned
                                  // vs revised, exact progress) lives in the hover tooltip instead —
                                  // full detail on hover, nothing lost. A CUSTOM tooltip, not the
                                  // native `title` attribute: browsers delay `title` by ~1s and it's
                                  // easy to move off the cell before it ever appears.
                                  const tipLines = stage ? [
                                    `${step} - ${st.label}`,
                                    `Start: ${fmtStageDate(stage.startDate)}`,
                                    `Planned: ${fmtStageDate(stage.baselineEta)}  →  Revised: ${stage.eta && stage.eta === stage.baselineEta ? 'NA' : fmtStageDate(stage.eta)}${planVariance != null && planVariance !== 0 ? `  (${planVariance > 0 ? '+' : ''}${planVariance}d)` : ''}`,
                                    `Actual: ${fmtStageDate(stage.actualEnd)}${actualVariance != null && actualVariance !== 0 ? `  (${actualVariance > 0 ? '+' : ''}${actualVariance}d vs plan)` : ''}`,
                                    `Progress: ${stageProgressLabel(stage)}`,
                                    stage.blockedReason ? `Blocked: ${stage.blockedReason}` : null,
                                  ].filter(Boolean) : null
                                  return (
                                    <td key={`${order.id}-${asgn?.mid ?? 'unassigned'}`} onClick={() => stage && setQuickStage({ orderId: order.id, mfrId: asgn.mid, stageIndex: stageIdx })} role={stage ? 'button' : undefined} tabIndex={stage ? 0 : undefined} onKeyDown={stage ? activateOnKey(() => setQuickStage({ orderId: order.id, mfrId: asgn.mid, stageIndex: stageIdx })) : undefined}
                                      onMouseEnter={e => tipLines && showMatrixTip(e.clientX, e.clientY, tipLines)}
                                      onMouseMove={e => tipLines && setMatrixTip(tip => tip && { ...tip, x: e.clientX, y: e.clientY })}
                                      onMouseLeave={hideMatrixTip}
                                      style={{ padding: '5px 8px', borderLeft: `1px solid ${T.border}`, cursor: stage ? 'pointer' : 'default', verticalAlign: 'top' }}>
                                      {!stage ? (
                                        <span style={{ fontSize: 11, color: '#cbd5e1' }}>{asgn ? 'NA' : 'TBD'}</span>
                                      ) : (
                                        <div style={{ background: st.bg, borderRadius: 5, padding: '4px 7px' }}>
                                          {/* The date is what answers "where are things" — primary and
                                              legible. Units/percent are secondary, kept small below;
                                              raw counts aren't shown at all (only on hover). */}
                                          <FlexRow gap={5} style={{ justifyContent: 'space-between' }}>
                                            <span style={{ fontSize: 12, fontWeight: 800, color: st.fg, whiteSpace: 'nowrap', fontFamily: "'JetBrains Mono',monospace" }}>
                                              {state === 'done' ? <Check size={10} strokeWidth={3} style={{ verticalAlign: -1 }} /> : state === 'blocked' ? <Ban size={10} style={{ verticalAlign: -1 }} /> : state === 'overdue' ? <AlertTriangle size={10} style={{ verticalAlign: -1 }} /> : ''} {fmtStageDate(done ? stage.actualEnd : effectiveEta(stage))}
                                            </span>
                                            {variance != null && variance !== 0 && (
                                              <span style={{ fontSize: 9, fontWeight: 800, color: variance > 0 ? '#b91c1c' : '#047857', whiteSpace: 'nowrap' }}>
                                                {variance > 0 ? '+' : ''}{variance}d
                                              </span>
                                            )}
                                          </FlexRow>
                                          <div style={{ fontSize: 9, color: st.fg, opacity: 0.75, marginTop: 1 }}>
                                            {stagePct(stage)}%
                                          </div>
                                        </div>
                                      )}
                                    </td>
                                  )
                                })}
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
      </Card>

      {/* Custom matrix-cell tooltip — position: fixed so it's never clipped by
          the scrolling table, and pointer-events: none so it can't itself
          become the mouseleave target. */}
      {matrixTip && (
        <div style={{
          // Kept on screen: it opens to the left near the right edge and above the cursor near the bottom.
          position: 'fixed', zIndex: 1000,
          left: Math.max(8, Math.min(matrixTip.x + 14, window.innerWidth - 336)),
          top: matrixTip.y + 16 + matrixTip.lines.length * 18 + 18 > window.innerHeight ? Math.max(8, matrixTip.y - 8 - (matrixTip.lines.length * 18 + 18)) : matrixTip.y + 16,
          pointerEvents: 'none', background: '#1e293b', color: '#f1f5f9', borderRadius: 8,
          padding: '8px 12px', fontSize: 11, lineHeight: 1.6, whiteSpace: 'pre-wrap',
          boxShadow: '0 8px 24px rgba(0,0,0,0.25)', maxWidth: 320,
        }}>
          {matrixTip.lines.join('\n')}
        </div>
      )}

      {quickStage && (
        <QuickStageModal
          orderId={quickStage.orderId} mfrId={quickStage.mfrId} stageIndex={quickStage.stageIndex}
          onClose={() => setQuickStage(null)} onOpenOrder={onOpen}
        />
      )}
    </div>
  )
}
