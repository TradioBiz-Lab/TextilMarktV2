import { useState } from 'react'
import { Plus, X } from '../icons.jsx'
import { T, STANDARD_STEP_NAMES, defaultStepOwner, stepOwnerOptions, siblingStepNames, stepNameWarning, STAGE_KIND_LABELS } from '../constants.js'
import { Btn, FlexRow, DateOrNA, useToast } from './ui.jsx'
import { useApp } from '../context.jsx'

// Add one step to a split's plan, at any time and at any place before the Delivery step (which always stays last).
// The owner starts from the standard rule (approvals to the customer, the rest to this split's factory, Tradio's own
// steps unassigned) and can be changed. With an empty plan it opens on its own; otherwise it waits behind a button.
// Once open it stays open for the next step until closed, and a chosen position moves on past the step just added,
// so several steps typed in a row land in that order. `onInserted(index)` is told where each step went.
export function AddStepBar({ order, asgn, users, onInserted }) {
  const { insertStage, orders } = useApp()
  // The names this master order's other styles already use come first, so the plans line up in the matrix.
  const sibling = siblingStepNames(orders, order)
  const toast = useToast()
  const stages = asgn.stages || []
  const steps = stages.filter(s => !s.isDelivery)
  const [open, setOpen] = useState(steps.length === 0)
  // Start is NA unless given: screens work from end dates.
  const blank = { name: '', startDate: 'NA', eta: '', kind: 'quantity', owner: undefined, at: 'end' }
  const [d, setD] = useState(blank)
  const [busy, setBusy] = useState(false)
  const set = patch => setD(p => ({ ...p, ...patch }))

  const owners = stepOwnerOptions(users, order, asgn.mid)
  const owner = d.owner !== undefined ? d.owner : (defaultStepOwner(d.name, order, asgn.mid, owners) || '')
  // "After step N" must still name a step that is not the last one (the plan can change under the form).
  const at = /^\d+$/.test(d.at) && Number(d.at) >= steps.length - 1 ? 'end' : d.at
  const ownerRole = owners.find(o => o.value === owner)?.role
  const label = { display: 'block', fontSize: 10, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }
  const field = { width: '100%', border: `1px solid ${T.border}`, borderRadius: 6, padding: '6px 8px', fontSize: 12, fontFamily: 'inherit', background: '#fff', boxSizing: 'border-box' }

  const add = async () => {
    setBusy(true)
    try {
      // Position: 'start', 'end' (just before Delivery, which always stays last) or after step N.
      const deliveryAt = stages.findIndex(s => s.isDelivery)
      const end = deliveryAt === -1 ? stages.length : deliveryAt
      const index = at === 'start' ? 0 : at === 'end' ? end : Number(at) + 1
      // A customer closes a step with one decision, so a quantity step given to the customer becomes a milestone.
      const kind = ownerRole === 'buyer' && d.kind === 'quantity' ? 'milestone' : d.kind
      await insertStage(order.id, asgn.mid, { name: d.name.trim(), startDate: d.startDate, eta: d.eta, kind, index, ...(owner ? { responsibleId: owner } : {}) })
      onInserted?.(index)
      toast(`${d.name.trim()} added`, 'success')
      setD({ ...blank, at: at === 'end' ? 'end' : String(index) })
    } catch (e) {
      toast(typeof e === 'string' ? e : (e?.message || 'Could not add the step'), 'error')
    } finally { setBusy(false) }
  }

  if (!open) {
    return (
      <div style={{ marginTop: 10 }}>
        <Btn size="sm" variant="secondary" icon={<Plus size={12} />} onClick={() => setOpen(true)}>Add step</Btn>
      </div>
    )
  }
  return (
    <div style={{ background: '#f8fafc', border: `1px dashed ${T.border}`, borderRadius: 10, padding: '14px 16px', margin: '12px 0' }}>
      <FlexRow justify="space-between" style={{ marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: T.text }}>{steps.length === 0 ? 'No production steps yet' : 'Add a step'}</div>
          <div style={{ fontSize: 11, color: T.textMuted }}>{steps.length === 0 ? 'Add the steps one at a time here, or use Upload CSV for a whole plan. Delivery stays last.' : 'Use the arrows on each step to move it up or down later.'}</div>
        </div>
        {steps.length > 0 && <button onClick={() => setOpen(false)} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: T.textLight }}><X size={14} /></button>}
      </FlexRow>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ flex: '2 1 180px' }}>
          <label style={label}>Step</label>
          <input list={`std-steps-${asgn.mid}`} value={d.name} onChange={e => set({ name: e.target.value })} placeholder="e.g. Lab Dip Approval" style={field} />
          <datalist id={`std-steps-${asgn.mid}`}>{[...new Set([...sibling, ...STANDARD_STEP_NAMES])].filter(n => !stages.some(s => s.name === n)).map(n => <option key={n} value={n} />)}</datalist>
          {stepNameWarning(d.name, sibling) && <div style={{ fontSize: 10, color: '#b45309', marginTop: 3 }}>{stepNameWarning(d.name, sibling)}</div>}
        </div>
        <div style={{ flex: '1 1 130px' }}>
          <label style={label}>Start</label>
          <DateOrNA label="Start date" value={d.startDate} onChange={v => set({ startDate: v })} />
        </div>
        <div style={{ flex: '1 1 130px' }}>
          <label style={label}>Planned end</label>
          <DateOrNA label="Planned end date" value={d.eta} onChange={v => set({ eta: v })} />
        </div>
        <div style={{ flex: '1 1 120px' }}>
          <label style={label}>Tracked as</label>
          <select value={d.kind} onChange={e => set({ kind: e.target.value })} style={field}>
            <option value="quantity">{STAGE_KIND_LABELS.quantity}</option>
            <option value="milestone">{STAGE_KIND_LABELS.milestone}</option>
            <option value="checklist">{STAGE_KIND_LABELS.checklist}</option>
          </select>
        </div>
        <div style={{ flex: '1 1 170px' }}>
          <label style={label}>Owner</label>
          <select value={owner} onChange={e => set({ owner: e.target.value })} style={field}>
            <option value="">Unassigned</option>
            {owners.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div style={{ flex: '1 1 170px' }}>
          <label style={label}>Position</label>
          <select value={at} onChange={e => set({ at: e.target.value })} style={field}>
            <option value="end">Last, before Delivery</option>
            {steps.length > 0 && <option value="start">First</option>}
            {stages.map((s, i) => (s.isDelivery || i === steps.length - 1 ? null : <option key={i} value={String(i)}>After {i + 1}. {s.name}</option>))}
          </select>
        </div>
        <Btn icon={<Plus size={12} />} size="sm" disabled={!d.name.trim() || !d.eta || busy} onClick={add}>{busy ? 'Adding...' : 'Add step'}</Btn>
      </div>
    </div>
  )
}
