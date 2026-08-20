import { useState, useEffect, useCallback } from 'react'
import { Bot, Copy, Package, CheckCircle2 } from 'lucide-react'
import { T, REQUIREMENT_CATEGORIES, REQUIREMENT_CATEGORY_LABEL } from '../../constants.js'
import { Card, Btn, Input, FlexRow, useToast, LoadingScreen, EmptyState, SupplierCombobox, Modal } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'
import { AiDraftModal } from '../shared/AiDraftModal.jsx'

const CATEGORIES = REQUIREMENT_CATEGORIES
const CATEGORY_LABEL = REQUIREMENT_CATEGORY_LABEL

function pushKey(lineId, p) { return `${lineId}:${p.mfrId}:${p.stageIndex}` }

// Admin-only planning layer for one Order — sits next to (not inside) the
// per-stage materials checklist it feeds. Authoring here is order-wide;
// "push to stage" is what turns one line into a real, execution-tracked
// stageMaterialSchema line on a specific manufacturer's specific stage.
// "Raise PO" (§2 of the plan) operates on already-pushed lines: it stamps a
// shared PO number + 'ordered' status onto each selected stage material
// line and files a matching material_po Document per line, mfrId-stamped
// so it never leaks to a competing manufacturer on a split order.
export function MaterialRequirementsPanel({ order }) {
  const { getMaterialRequirement, addRequirementLine, removeRequirementLine, pushRequirementToStage,
    updateStageMaterial, uploadDoc, listSuppliers, duplicateRequirement, draftBomFromDocuments, orders, docs } = useApp()
  const toast = useToast()

  const [doc, setDoc] = useState(null)
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState({ category: 'fabric_primary', name: '', requiredQty: '', unit: '', supplier: '', colourway: '', wastagePct: '', rate: '' })
  const [pushTarget, setPushTarget] = useState({}) // lineId -> { mfrId, stageIndex }
  const [selectedPushes, setSelectedPushes] = useState(new Set()) // pushKey set, for Raise PO
  const [poNumberDraft, setPoNumberDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [suppliers, setSuppliers] = useState([])
  const [showClone, setShowClone] = useState(false)
  const [cloneTargetOrderId, setCloneTargetOrderId] = useState('')
  const [showAiDraft, setShowAiDraft] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await getMaterialRequirement({ orderId: order.id })
      setDoc(res)
    } catch (err) {
      toast(err.message || 'Failed to load material requirements', 'error')
    } finally {
      setLoading(false)
    }
  }, [order.id])

  useEffect(() => { load() }, [load])
  useEffect(() => { listSuppliers().then(setSuppliers).catch(() => {}) }, [listSuppliers])

  async function handleAdd() {
    if (!form.name.trim() || !form.requiredQty) { toast('Name and required quantity are required', 'error'); return }
    setBusy(true)
    try {
      const res = await addRequirementLine({
        scopeType: 'tradio_order', orderId: order.id, ...form, requiredQty: Number(form.requiredQty),
        wastagePct: form.wastagePct ? Number(form.wastagePct) : undefined,
        rate: form.rate ? Number(form.rate) : undefined,
      })
      setDoc(res)
      setForm({ category: 'fabric_primary', name: '', requiredQty: '', unit: '', supplier: '', colourway: '', wastagePct: '', rate: '' })
      toast('Requirement line added', 'success')
    } catch (err) { toast(err.message || 'Failed to add line', 'error') } finally { setBusy(false) }
  }

  async function handleClone() {
    if (!doc?.id || !cloneTargetOrderId) return
    setBusy(true)
    try {
      await duplicateRequirement(doc.id, { targetOrderId: cloneTargetOrderId })
      toast('BOM cloned to the selected order', 'success')
      setShowClone(false)
      setCloneTargetOrderId('')
    } catch (err) { toast(err.message || 'Failed to clone', 'error') } finally { setBusy(false) }
  }

  async function handleRemove(lineId) {
    setBusy(true)
    try {
      const res = await removeRequirementLine(doc.id, lineId)
      setDoc(res)
    } catch (err) { toast(err.message || 'Failed to remove line', 'error') } finally { setBusy(false) }
  }

  async function handlePush(lineId) {
    const target = pushTarget[lineId]
    if (!target?.mfrId || target.stageIndex === undefined || target.stageIndex === '') {
      toast('Pick a manufacturer and a stage first', 'error'); return
    }
    setBusy(true)
    try {
      const res = await pushRequirementToStage(doc.id, lineId, { mfrId: target.mfrId, stageIndex: Number(target.stageIndex) })
      setDoc(res)
      toast('Pushed to stage', 'success')
    } catch (err) { toast(err.message || 'Push failed', 'error') } finally { setBusy(false) }
  }

  function togglePushSelection(lineId, p) {
    const key = pushKey(lineId, p)
    setSelectedPushes(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  // Resolves a pushed line back to its real stage material line — pushedTo
  // stores a stable materialLineId (a real subdocument _id), never a
  // positional index, since stage-insert/-delete/material-delete all shift
  // array positions. Look up the CURRENT index by id, right before writing.
  function resolveStageLine(mfrId, stageIndex, materialLineId) {
    const asgn = order.assignments.find(a => String(a.mid) === String(mfrId))
    const stage = asgn?.stages?.[stageIndex]
    const lineIndex = (stage?.materials || []).findIndex(m => String(m.id) === String(materialLineId))
    return lineIndex === -1 ? null : { asgn, stage, lineIndex, material: stage.materials[lineIndex] }
  }

  async function handleRaisePO() {
    if (selectedPushes.size === 0) return
    setBusy(true)
    const poNumber = poNumberDraft.trim() || `PO-${order.id}-${Date.now().toString(36).toUpperCase()}`
    let created = 0
    try {
      for (const line of doc.lines) {
        for (const p of (line.pushedTo || [])) {
          const key = pushKey(line.id, p)
          if (!selectedPushes.has(key)) continue
          const resolved = resolveStageLine(p.mfrId, p.stageIndex, p.materialLineId)
          if (!resolved) continue // stage line no longer exists — skip defensively
          const { stage, lineIndex, material } = resolved
          const notes = `PURCHASE ORDER ${poNumber}\nSupplier: ${material.supplier || line.supplier || '—'}\nMaterial: ${material.name}\nQty: ${material.requiredQty} ${material.unit}\nStage: ${stage.name}`
          await updateStageMaterial(order.id, p.mfrId, p.stageIndex, lineIndex, { poNumber, status: 'ordered' })
          await uploadDoc({ type: 'material_po', name: `PO ${poNumber} — ${material.name}`, orderId: order.id, mfrId: p.mfrId, stageIndex: p.stageIndex, materialLineIndex: lineIndex, notes })
          created++
        }
      }
      if (created === 0) { toast('Nothing to raise — those stage lines no longer exist', 'error'); return }
      toast(`PO ${poNumber} raised on ${created} line${created > 1 ? 's' : ''}`, 'success')
      setSelectedPushes(new Set())
      setPoNumberDraft('')
      load()
    } catch (err) { toast(err.message || 'Failed to raise PO', 'error') } finally { setBusy(false) }
  }

  if (loading) return <LoadingScreen />

  const lines = doc?.lines || []

  const candidateDocs = (docs || []).filter(d => d.orderId === order.id && ['tech_pack', 'measurement_sheet', 'PO', 'buyer_order', 'RFQ'].includes(d.type))
  const otherOrders = (orders || []).filter(o => o.id !== order.id)

  return (
    <Card>
      {showAiDraft && (
        <AiDraftModal scopeType="tradio_order" orderId={order.id} candidateDocs={candidateDocs}
          onClose={() => setShowAiDraft(false)}
          onAccept={async (line) => {
            const res = await addRequirementLine({ scopeType: 'tradio_order', orderId: order.id, ...line, requiredQty: line.requiredQty ?? 0 })
            setDoc(res)
          }} />
      )}
      {showClone && (
        <Modal title="Clone BOM to Another Order" onClose={() => setShowClone(false)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <select value={cloneTargetOrderId} onChange={e => setCloneTargetOrderId(e.target.value)}
              style={{ padding: '8px 12px', borderRadius: 8, border: `1px solid ${T.border}`, fontSize: 13 }}>
              <option value="">Select target order…</option>
              {otherOrders.map(o => <option key={o.id} value={o.id}>{o.id} — {o.product}</option>)}
            </select>
            <FlexRow justify="flex-end" gap={8}>
              <Btn variant="secondary" onClick={() => setShowClone(false)}>Cancel</Btn>
              <Btn disabled={!cloneTargetOrderId || busy} onClick={handleClone}>Clone</Btn>
            </FlexRow>
          </div>
        </Modal>
      )}

      <FlexRow justify="space-between" style={{ marginBottom: 12 }}>
        <div style={{ fontWeight: 700, fontSize: 14 }}>Materials Requirement</div>
        <FlexRow gap={8}>
          <Btn size="sm" variant="secondary" icon={<Bot size={14} />} onClick={() => setShowAiDraft(true)}>AI Draft from Documents</Btn>
          <Btn size="sm" variant="secondary" icon={<Copy size={14} />} disabled={!doc?.id || lines.length === 0} onClick={() => setShowClone(true)}>Clone to…</Btn>
        </FlexRow>
      </FlexRow>

      {lines.length === 0
        ? <EmptyState icon={<Package size={26} color={T.textLight} />} title="No requirement lines yet" subtitle="Add fabric, trims, or accessories needed for this order below." />
        : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
            {lines.map(line => (
              <div key={line.id} style={{ border: `1px solid ${T.border}`, borderRadius: 8, padding: 12 }}>
                <FlexRow style={{ justifyContent: 'space-between' }}>
                  <div>
                    <span style={{ fontSize: 10, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', marginRight: 8 }}>{CATEGORY_LABEL[line.category] || line.category}</span>
                    <span style={{ fontWeight: 600 }}>{line.name}</span>
                    <span style={{ color: T.textMuted, fontSize: 12, marginLeft: 8 }}>{line.requiredQty} {line.unit}{line.colourway ? ` · ${line.colourway}` : ''}{line.supplier ? ` · ${line.supplier}` : ''}</span>
                    {line.wastagePct > 0 && <span style={{ color: T.warning, fontSize: 11, marginLeft: 8 }}>+{line.wastagePct}% wastage → order {line.qtyToOrder} {line.unit}</span>}
                    {line.rate != null && <span style={{ color: T.textMuted, fontSize: 11, marginLeft: 8 }}>@ ₹{line.rate}/{line.unit || 'unit'}</span>}
                  </div>
                  <Btn size="sm" variant="secondary" disabled={busy} onClick={() => handleRemove(line.id)}>Remove</Btn>
                </FlexRow>

                {line.pushedTo?.length > 0 && (
                  <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {line.pushedTo.map((p, i) => {
                      const asgn = order.assignments.find(a => String(a.mid) === String(p.mfrId))
                      const stageName = asgn?.stages?.[p.stageIndex]?.name || `Stage ${p.stageIndex + 1}`
                      const key = pushKey(line.id, p)
                      return (
                        <label key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: T.success, cursor: 'pointer' }}>
                          <input type="checkbox" checked={selectedPushes.has(key)} onChange={() => togglePushSelection(line.id, p)} />
                          <CheckCircle2 size={12} /> Pushed to {asgn?.mfrCompany || p.mfrId} — {stageName}
                        </label>
                      )
                    })}
                  </div>
                )}

                <FlexRow style={{ marginTop: 8, gap: 6 }}>
                  <select value={pushTarget[line.id]?.mfrId || ''} onChange={e => setPushTarget(p => ({ ...p, [line.id]: { ...p[line.id], mfrId: e.target.value, stageIndex: '' } }))}
                    style={{ flex: 1, padding: '6px 8px', borderRadius: 6, border: `1px solid ${T.border}`, fontSize: 12 }}>
                    <option value="">Manufacturer…</option>
                    {(order.assignments || []).map(a => <option key={a.mid} value={a.mid}>{a.mfrCompany || a.mid}</option>)}
                  </select>
                  <select value={pushTarget[line.id]?.stageIndex ?? ''} onChange={e => setPushTarget(p => ({ ...p, [line.id]: { ...p[line.id], stageIndex: e.target.value } }))}
                    disabled={!pushTarget[line.id]?.mfrId}
                    style={{ flex: 1, padding: '6px 8px', borderRadius: 6, border: `1px solid ${T.border}`, fontSize: 12 }}>
                    <option value="">Stage…</option>
                    {((order.assignments || []).find(a => String(a.mid) === String(pushTarget[line.id]?.mfrId))?.stages || []).map((s, i) => (
                      <option key={i} value={i}>{s.name}</option>
                    ))}
                  </select>
                  <Btn size="sm" disabled={busy} onClick={() => handlePush(line.id)}>Push</Btn>
                </FlexRow>
              </div>
            ))}
          </div>
        )}

      {selectedPushes.size > 0 && (
        <div style={{ border: `1px solid ${T.primary}`, background: T.primaryLight, borderRadius: 8, padding: 12, marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>Raise PO — {selectedPushes.size} line{selectedPushes.size > 1 ? 's' : ''} selected</div>
          <FlexRow style={{ gap: 8 }}>
            <input placeholder="PO number (auto-generated if blank)" value={poNumberDraft} onChange={e => setPoNumberDraft(e.target.value)}
              style={{ flex: 1, padding: '6px 8px', borderRadius: 6, border: `1px solid ${T.border}`, fontSize: 13 }} />
            <Btn size="sm" disabled={busy} onClick={handleRaisePO}>Raise PO</Btn>
            <Btn size="sm" variant="secondary" disabled={busy} onClick={() => setSelectedPushes(new Set())}>Clear</Btn>
          </FlexRow>
        </div>
      )}

      <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 12 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, marginBottom: 8 }}>ADD LINE</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr 1fr 1fr', gap: 8, marginBottom: 8 }}>
          <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
            style={{ padding: '8px 12px', borderRadius: 8, border: `1px solid ${T.border}`, fontSize: 13 }}>
            {CATEGORIES.map(c => <option key={c.v} value={c.v}>{c.l}</option>)}
          </select>
          <Input placeholder="Material name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
          <Input placeholder="Qty" type="number" value={form.requiredQty} onChange={e => setForm(f => ({ ...f, requiredQty: e.target.value }))} />
          <Input placeholder="Unit" value={form.unit} onChange={e => setForm(f => ({ ...f, unit: e.target.value }))} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
          <SupplierCombobox label="" suppliers={suppliers} value={form.supplier} onChange={v => setForm(f => ({ ...f, supplier: v }))} placeholder="Supplier (optional)" />
          <Input placeholder="Colourway (optional)" value={form.colourway} onChange={e => setForm(f => ({ ...f, colourway: e.target.value }))} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
          <Input placeholder="Wastage % (optional)" type="number" min="0" value={form.wastagePct} onChange={e => setForm(f => ({ ...f, wastagePct: e.target.value }))} />
          <Input placeholder="Rate per unit (optional)" type="number" min="0" value={form.rate} onChange={e => setForm(f => ({ ...f, rate: e.target.value }))} />
        </div>
        <Btn onClick={handleAdd} disabled={busy}>+ Add Line</Btn>
      </div>
    </Card>
  )
}
