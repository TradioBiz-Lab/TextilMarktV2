import { useState } from 'react'
import { X, AlertTriangle } from 'lucide-react'
import { T } from '../../constants.js'
import { Btn, Card, Badge, FlexRow, EmptyState, Input, useToast } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'

const STAGE_KIND_OPTIONS = [
  { v: 'milestone', l: 'Milestone' },
  { v: 'checklist', l: 'Checklist' },
  { v: 'quantity', l: 'Quantity' },
]

// TNA for a manufacturer's own non-Tradio project (Order Setup Wizard, Phase 4).
// Reuses AdminOrderDetail.jsx's stage-table/quick-update patterns, scaled down
// to this scope's simpler shape: one owner, no assignments/buyer split, so
// every write goes straight through mfrProjectsApi's stage routes with no
// mfrId segment. Mounted as a tab in MfrProjects.jsx's ProjectDetail.
export function MfrProjectStages({ project, onUpdated }) {
  const {
    seedMfrProjectStages, updateMfrProjectStage, updateMfrProjectStageDates, removeMfrProjectStage,
    addMfrProjectStageUpdate, addMfrProjectStageItem, updateMfrProjectStageItem, removeMfrProjectStageItem,
    addMfrProjectStageMaterial, updateMfrProjectStageMaterial, removeMfrProjectStageMaterial,
  } = useApp()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState(null) // stage index
  const [seedRows, setSeedRows] = useState([{ name: '', startDate: '', eta: '', kind: 'milestone' }])

  const stages = project.stages || []

  async function run(fn) {
    setBusy(true)
    try { onUpdated(await fn()) } catch (err) { toast(err.message || 'Update failed', 'error') } finally { setBusy(false) }
  }

  function addSeedRow() { setSeedRows(r => [...r, { name: '', startDate: '', eta: '', kind: 'milestone' }]) }
  function updateSeedRow(i, patch) { setSeedRows(r => r.map((row, idx) => idx === i ? { ...row, ...patch } : row)) }
  function removeSeedRow(i) { setSeedRows(r => r.filter((_, idx) => idx !== i)) }

  async function handleSeed() {
    const rows = seedRows.filter(r => r.name.trim())
    if (rows.length === 0) { toast('Add at least one stage', 'error'); return }
    for (const r of rows) {
      if (!r.startDate || !r.eta) { toast('Every stage needs a start and end date (or "NA")', 'error'); return }
    }
    await run(() => seedMfrProjectStages(project.id, {
      stageNames: rows.map(r => r.name.trim()),
      stageStartDates: rows.map(r => r.startDate),
      stageEtas: rows.map(r => r.eta),
      stageKinds: rows.map(r => r.kind),
    }))
  }

  if (stages.length === 0) {
    return (
      <Card>
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>Set up your TNA plan</div>
        <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 12 }}>Define the steps once - you can edit, reorder work, or delete a step afterward.</div>
        {seedRows.map((row, i) => (
          <FlexRow key={i} gap={6} style={{ marginBottom: 6 }}>
            <Input placeholder="Stage name" value={row.name} onChange={e => updateSeedRow(i, { name: e.target.value })} style={{ flex: 2 }} />
            <select value={row.kind} onChange={e => updateSeedRow(i, { kind: e.target.value })}
              style={{ padding: '8px 10px', borderRadius: 8, border: `1px solid ${T.border}`, fontSize: 13 }}>
              {STAGE_KIND_OPTIONS.map(k => <option key={k.v} value={k.v}>{k.l}</option>)}
            </select>
            <Input type="date" value={row.startDate} onChange={e => updateSeedRow(i, { startDate: e.target.value })} style={{ flex: 1 }} />
            <Input type="date" value={row.eta} onChange={e => updateSeedRow(i, { eta: e.target.value })} style={{ flex: 1 }} />
            <Btn size="sm" variant="secondary" onClick={() => removeSeedRow(i)}><X size={13} /></Btn>
          </FlexRow>
        ))}
        <FlexRow gap={8} style={{ marginTop: 8 }}>
          <Btn size="sm" variant="secondary" onClick={addSeedRow}>+ Add Row</Btn>
          <Btn size="sm" disabled={busy} onClick={handleSeed}>Create TNA Plan</Btn>
        </FlexRow>
      </Card>
    )
  }

  return (
    <div>
      {stages.map((s, i) => (
        <Card key={i} style={{ marginBottom: 10 }}>
          <FlexRow style={{ justifyContent: 'space-between', cursor: 'pointer' }} onClick={() => setExpanded(expanded === i ? null : i)}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 13 }}>{i + 1}. {s.name}</div>
              <div style={{ fontSize: 11, color: T.textMuted }}>
                {s.kind === 'quantity' ? `${s.unitsDone}/${s.totalUnits} units` : s.kind === 'checklist' ? `${s.itemsDone}/${s.itemsTotal} items` : 'Milestone'}
                {' · '}{s.startDate || 'NA'} → {s.eta || 'NA'}
                {s.etaVarianceDays > 0 && <span style={{ color: T.danger, marginLeft: 6 }}>+{s.etaVarianceDays}d</span>}
                {s.etaVarianceDays < 0 && <span style={{ color: T.success, marginLeft: 6 }}>{s.etaVarianceDays}d</span>}
                {s.blocked && <span style={{ color: T.danger, marginLeft: 6, display: 'inline-flex', alignItems: 'center', gap: 3 }}><AlertTriangle size={11} /> Blocked</span>}
              </div>
            </div>
            <FlexRow gap={8}>
              <Badge status={s.status} />
              <Btn size="sm" variant="secondary" onClick={(e) => { e.stopPropagation(); run(() => removeMfrProjectStage(project.id, i)) }}>Delete</Btn>
            </FlexRow>
          </FlexRow>

          {expanded === i && (
            <div style={{ marginTop: 12, borderTop: `1px solid ${T.border}`, paddingTop: 12 }}>
              <StageProgress stage={s} busy={busy}
                onUpdate={(data) => run(() => updateMfrProjectStage(project.id, i, data))} />
              <StageDates stage={s} busy={busy}
                onUpdate={(dates) => run(() => updateMfrProjectStageDates(project.id, i, dates))} />
              {s.kind === 'checklist' && (
                <StageItems stage={s} busy={busy}
                  onAdd={(data) => run(() => addMfrProjectStageItem(project.id, i, data))}
                  onUpdate={(li, data) => run(() => updateMfrProjectStageItem(project.id, i, li, data))}
                  onRemove={(li) => run(() => removeMfrProjectStageItem(project.id, i, li))} />
              )}
              <StageMaterials stage={s} busy={busy}
                onAdd={(data) => run(() => addMfrProjectStageMaterial(project.id, i, data))}
                onUpdate={(li, data) => run(() => updateMfrProjectStageMaterial(project.id, i, li, data))}
                onRemove={(li) => run(() => removeMfrProjectStageMaterial(project.id, i, li))} />
              <StageUpdates stage={s} busy={busy}
                onAdd={(text) => run(() => addMfrProjectStageUpdate(project.id, i, text))} />
            </div>
          )}
        </Card>
      ))}
    </div>
  )
}

function StageProgress({ stage, busy, onUpdate }) {
  const [units, setUnits] = useState(stage.unitsDone)
  const [note, setNote] = useState('')
  if (stage.kind === 'quantity') {
    return (
      <FlexRow gap={8} style={{ marginBottom: 10 }}>
        <Input type="number" min="0" max={stage.totalUnits} value={units} onChange={e => setUnits(e.target.value)} style={{ width: 100 }} />
        <span style={{ fontSize: 12, color: T.textMuted, alignSelf: 'center' }}>/ {stage.totalUnits} units</span>
        <Btn size="sm" disabled={busy} onClick={() => onUpdate({ unitsDone: Number(units), note })}>Update</Btn>
      </FlexRow>
    )
  }
  return (
    <FlexRow gap={8} style={{ marginBottom: 10 }}>
      <select value={stage.status} disabled={busy} onChange={e => onUpdate({ status: e.target.value })}
        style={{ padding: '6px 10px', borderRadius: 8, border: `1px solid ${T.border}`, fontSize: 13 }}>
        <option value="not_started">Not started</option>
        <option value="in_progress">In progress</option>
        <option value="done">Done</option>
      </select>
      <Btn size="sm" variant="secondary" disabled={busy} onClick={() => onUpdate({ blocked: !stage.blocked })}>
        {stage.blocked ? 'Unblock' : 'Flag Blocked'}
      </Btn>
    </FlexRow>
  )
}

function StageDates({ stage, busy, onUpdate }) {
  const [eta, setEta] = useState(stage.eta || '')
  const [startDate, setStartDate] = useState(stage.startDate || '')
  return (
    <FlexRow gap={8} style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 11, color: T.textMuted }}>Planned: {stage.baselineEta || 'NA'}</div>
      <Input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={{ width: 140 }} />
      <Input type="date" value={eta} onChange={e => setEta(e.target.value)} style={{ width: 140 }} />
      <Btn size="sm" variant="secondary" disabled={busy} onClick={() => onUpdate({ startDate, eta })}>Save Dates</Btn>
    </FlexRow>
  )
}

function StageItems({ stage, busy, onAdd, onUpdate, onRemove }) {
  const [name, setName] = useState('')
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 6 }}>Checklist Items</div>
      {(stage.items || []).map((it, li) => (
        <FlexRow key={li} style={{ justifyContent: 'space-between', padding: '4px 0' }}>
          <div style={{ fontSize: 12 }}>{it.name}{it.colourway ? ` (${it.colourway})` : ''}</div>
          <FlexRow gap={6}>
            <Badge status={it.status} />
            <Btn size="sm" variant="secondary" disabled={busy} onClick={() => onUpdate(li, { status: it.status === 'done' ? 'pending' : 'done' })}>
              {it.status === 'done' ? 'Reopen' : 'Mark Done'}
            </Btn>
            <Btn size="sm" variant="secondary" disabled={busy} onClick={() => onRemove(li)}><X size={13} /></Btn>
          </FlexRow>
        </FlexRow>
      ))}
      <FlexRow gap={6} style={{ marginTop: 6 }}>
        <Input placeholder="Item name" value={name} onChange={e => setName(e.target.value)} />
        <Btn size="sm" variant="secondary" disabled={busy || !name.trim()} onClick={() => { onAdd({ name }); setName('') }}>+ Add</Btn>
      </FlexRow>
    </div>
  )
}

function StageMaterials({ stage, busy, onAdd, onUpdate, onRemove }) {
  const [form, setForm] = useState({ name: '', requiredQty: '', unit: '' })
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 6 }}>Materials / PO Checklist</div>
      {(stage.materials || []).map((m, li) => (
        <FlexRow key={m.id || li} style={{ justifyContent: 'space-between', padding: '4px 0' }}>
          <div style={{ fontSize: 12 }}>{m.name} · {m.requiredQty} {m.unit}</div>
          <FlexRow gap={6}>
            <select value={m.status} disabled={busy} onChange={e => onUpdate(li, { status: e.target.value, receivedQty: e.target.value === 'received' ? m.requiredQty : m.receivedQty })}
              style={{ padding: '4px 6px', borderRadius: 6, border: `1px solid ${T.border}`, fontSize: 12 }}>
              <option value="pending">Pending</option>
              <option value="ordered">Ordered</option>
              <option value="received">Received</option>
            </select>
            <Btn size="sm" variant="secondary" disabled={busy} onClick={() => onRemove(li)}><X size={13} /></Btn>
          </FlexRow>
        </FlexRow>
      ))}
      <FlexRow gap={6} style={{ marginTop: 6 }}>
        <Input placeholder="Material" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
        <Input placeholder="Qty" type="number" value={form.requiredQty} onChange={e => setForm(f => ({ ...f, requiredQty: e.target.value }))} style={{ width: 80 }} />
        <Input placeholder="Unit" value={form.unit} onChange={e => setForm(f => ({ ...f, unit: e.target.value }))} style={{ width: 80 }} />
        <Btn size="sm" variant="secondary" disabled={busy || !form.name.trim() || !form.requiredQty} onClick={() => { onAdd({ ...form, requiredQty: Number(form.requiredQty) }); setForm({ name: '', requiredQty: '', unit: '' }) }}>+ Add</Btn>
      </FlexRow>
    </div>
  )
}

function StageUpdates({ stage, busy, onAdd }) {
  const [text, setText] = useState('')
  return (
    <div>
      <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 6 }}>Updates</div>
      {(stage.updates || []).map((u, ui) => (
        <div key={ui} style={{ fontSize: 12, padding: '4px 0', color: T.textMuted }}>{u.text} <span style={{ fontSize: 10 }}>· {new Date(u.at).toLocaleDateString()}</span></div>
      ))}
      <FlexRow gap={6} style={{ marginTop: 6 }}>
        <Input placeholder="Post an update…" value={text} onChange={e => setText(e.target.value)} />
        <Btn size="sm" variant="secondary" disabled={busy || !text.trim()} onClick={() => { onAdd(text); setText('') }}>Post</Btn>
      </FlexRow>
    </div>
  )
}
