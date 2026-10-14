import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Check, ArrowRight, ArrowLeft, Trash2 } from '../icons.jsx'
import { T, ST, deliveryStatus } from '../constants.js'
import { Btn, FlexRow, Modal, Textarea, useToast } from './ui.jsx'
import { useApp } from '../context.jsx'

// Everything about where a style stands, in one place: its status (applied to every manufacturer split at once), its
// stage (Sampling & Development or Production) and dropping it. Delivered is never picked here: it follows the
// Delivery step, which is closed on the plan.
const SETTABLE = ['Processing', 'On Hold', 'Delayed']

export function styleStatus(order) {
  const splits = order.assignments || []
  if (!splits.length) return 'Not assigned'
  if (splits.every(a => deliveryStatus(order, a).delivered)) return 'Delivered'
  const open = splits.filter(a => !deliveryStatus(order, a).delivered)
  if (open.some(a => a.status === 'Delayed')) return 'Delayed'
  if (open.every(a => a.status === 'On Hold')) return 'On Hold'
  return 'Processing'
}

export function StyleStatusMenu({ order, canStatus, canStage, canDrop, onPromote, onDrop }) {
  const { updateAssignment, editOrder } = useApp()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [pick, setPick] = useState(null)      // the status being applied (asks for an optional note)
  const [note, setNote] = useState('')
  const [demoting, setDemoting] = useState(false)
  const [busy, setBusy] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    const close = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const splits = order.assignments || []
  const live = splits.filter(a => !deliveryStatus(order, a).delivered)
  const current = styleStatus(order)
  const anyDelivered = splits.some(a => deliveryStatus(order, a).delivered)
  const dev = order.phase === 'development'
  const showStatus = canStatus && splits.length > 0
  if (!showStatus && !canStage && !canDrop) return null

  const apply = async () => {
    setBusy(true)
    try {
      const targets = live.filter(a => a.status !== pick)
      for (const a of targets) await updateAssignment(order.id, a.mid, pick, note.trim() || `Style set to ${pick}`)
      toast(`${order.product}: ${pick}`, 'success')
      setPick(null); setNote('')
    } catch (e) { toast(typeof e === 'string' ? e : (e?.message || 'Could not change the status'), 'error') }
    finally { setBusy(false) }
  }
  const demote = async () => {
    setBusy(true)
    try { await editOrder(order.id, { phase: 'development' }); toast('Moved back to Sampling & Development', 'success'); setDemoting(false) }
    catch (e) { toast(typeof e === 'string' ? e : (e?.message || 'Could not move the style'), 'error') }
    finally { setBusy(false) }
  }

  const st = ST[current] || { bg: '#f1f5f9', c: '#475569' }
  const item = (label, { onClick, disabled, active, danger, icon, hint } = {}) => (
    <button key={label} role="menuitem" disabled={disabled} title={hint}
      onClick={() => { setOpen(false); onClick?.() }}
      style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 12px', border: 'none', background: 'none', textAlign: 'left', fontSize: 13, fontWeight: 600, fontFamily: 'inherit', cursor: disabled ? 'default' : 'pointer', color: disabled ? T.textLight : danger ? T.danger : T.text }}
      onMouseEnter={e => { if (!disabled) e.currentTarget.style.background = '#f8fafc' }} onMouseLeave={e => { e.currentTarget.style.background = 'none' }}>
      <span style={{ width: 14, display: 'inline-flex' }}>{active ? <Check size={13} color={T.primaryDeep} /> : icon}</span>{label}
    </button>
  )
  const heading = text => <div style={{ padding: '8px 12px 4px', fontSize: 10, fontWeight: 800, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{text}</div>

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button onClick={() => setOpen(v => !v)} aria-haspopup="menu" aria-expanded={open}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '6px 10px 6px 12px', fontSize: 12, fontWeight: 700, borderRadius: 8, border: `1px solid ${T.border}`, background: T.surface, color: T.text, cursor: 'pointer', fontFamily: 'inherit' }}>
        Status
        <span style={{ fontSize: 11, fontWeight: 800, padding: '2px 8px', borderRadius: 999, background: st.bg, color: st.c }}>{current}</span>
        <ChevronDown size={13} color={T.textMuted} />
      </button>
      {open && (
        <div role="menu" style={{ position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 400, minWidth: 250, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, boxShadow: '0 12px 32px rgba(15,23,42,0.14)', padding: '4px 0' }}>
          {showStatus && (<>
            {heading(splits.length > 1 ? `Status (all ${splits.length} splits)` : 'Status')}
            {current === 'Delivered'
              ? <div style={{ padding: '6px 12px 8px', fontSize: 12, color: T.textMuted }}>Delivered. Reopen the Delivery step on the plan to change it.</div>
              : SETTABLE.map(s => item(s, { active: current === s, disabled: current === s, onClick: () => { setPick(s); setNote('') } }))}
            {current !== 'Delivered' && <div style={{ padding: '2px 12px 8px', fontSize: 11, color: T.textLight }}>Delivered follows the Delivery step.</div>}
          </>)}
          {canStage && (<>
            <div style={{ height: 1, background: T.border, margin: '4px 0' }} />
            {heading('Stage')}
            {dev
              ? item('Move to production', { icon: <ArrowRight size={13} />, onClick: onPromote })
              : item('Move back to Sampling & Development', { icon: <ArrowLeft size={13} />, disabled: anyDelivered, hint: anyDelivered ? 'A style with a delivered split stays in production' : undefined, onClick: () => setDemoting(true) })}
          </>)}
          {canDrop && (<>
            <div style={{ height: 1, background: T.border, margin: '4px 0' }} />
            {item('Drop style...', { danger: true, icon: <Trash2 size={13} color={T.danger} />, onClick: onDrop })}
          </>)}
        </div>
      )}

      {pick && (
        <Modal title={`Set ${order.product} to ${pick}`} subtitle={live.length > 1 ? `Applies to all ${live.length} open manufacturer splits` : undefined} onClose={() => { if (!busy) setPick(null) }} size="sm">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {pick === 'On Hold' && <div style={{ fontSize: 12, color: T.textMuted }}>A style on hold leaves the TNA and Reports. Its master order page still lists it.</div>}
            <Textarea label="Note (optional)" value={note} onChange={e => setNote(e.target.value)} placeholder="Why? It goes into the audit log." rows={3} />
            <FlexRow justify="flex-end" gap={8}>
              <Btn variant="secondary" disabled={busy} onClick={() => setPick(null)}>Cancel</Btn>
              <Btn disabled={busy} onClick={apply}>{busy ? 'Saving...' : `Set to ${pick}`}</Btn>
            </FlexRow>
          </div>
        </Modal>
      )}
      {demoting && (
        <Modal title="Move back to Sampling & Development" onClose={() => { if (!busy) setDemoting(false) }} size="sm">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ fontSize: 13, color: T.textMuted }}>The style leaves the production numbers. Its plans lose the Delivery step and the style its delivery date; both come back when it moves to production again.</div>
            <FlexRow justify="flex-end" gap={8}>
              <Btn variant="secondary" disabled={busy} onClick={() => setDemoting(false)}>Cancel</Btn>
              <Btn disabled={busy} onClick={demote}>{busy ? 'Moving...' : 'Move back'}</Btn>
            </FlexRow>
          </div>
        </Modal>
      )}
    </div>
  )
}
