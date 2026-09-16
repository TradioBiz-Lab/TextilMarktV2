import { useState, useEffect } from 'react'
import { ArrowRight } from 'lucide-react'
import { T, STAGE_DOC_MAP, stageKindOf, stageStatusOf, stageVariance, stageActualVariance, STAGE_STATUS_LABELS, fmtStageDate } from '../../constants.js'
import { Modal, Select, Textarea, Btn, FlexRow, Input, FileUpload, DocCard, useToast, fileUploadPayload, SectionLabel } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'
import { ordersApi } from '../../api.js'

// 'YYYY-MM-DD' or 'NA' → the value a native <input type="date"> (or the 'NA'
// text fallback) expects — same helper as AdminOrderDetail's date-adjust modal.
function dateToInput(d) {
  return d === 'NA' ? 'NA' : (d ? new Date(d).toISOString().slice(0, 10) : '')
}

function fmtDateTime(d) {
  if (!d) return ''
  const dt = new Date(d)
  if (isNaN(dt.getTime())) return ''
  const dd = String(dt.getDate()).padStart(2, '0')
  const mm = String(dt.getMonth() + 1).padStart(2, '0')
  const hh = String(dt.getHours()).padStart(2, '0')
  const mi = String(dt.getMinutes()).padStart(2, '0')
  return `${dd}-${mm}-${dt.getFullYear()} ${hh}:${mi}`
}

// The one stage-update modal, used from both the Order Management page
// (clicking a matrix date cell — no navigation, saving leaves you exactly
// where you were) and Order Detail (clicking a stage row) — a single
// component so the two entry points can never drift out of sync with each
// other again. showOpenOrderLink hides the "Open full order" shortcut when
// already on the full order page.
export function QuickStageModal({ orderId, mfrId, stageIndex, onClose, onOpenOrder, showOpenOrderLink = true }) {
  const { currentUser, orders, docs, users, updateStage, addStageUpdate, addStageMaterial, updateStageMaterial, removeStageMaterial, refreshOrders, uploadDoc, getDocData } = useApp()
  const toast = useToast()
  const order = (orders || []).find(o => o.id === orderId)
  const asgn = order?.assignments.find(a => String(a.mid) === String(mfrId))
  const stage = asgn?.stages?.[stageIndex]
  const isMaster = currentUser?.adminType === 'master'

  const [description, setDescription] = useState(stage?.description || '')
  const [units, setUnits] = useState(String(stage?.unitsDone ?? 0))
  const [status, setStatus] = useState(stage ? stageStatusOf(stage) : 'not_started')
  const [etaDraft, setEtaDraft] = useState(dateToInput(stage?.eta))
  // Planned/Actual are normally system-managed (frozen baseline, auto-stamped
  // completion) — these two drafts exist only so the master admin can
  // directly correct them, a short-term escape hatch for getting real
  // historical dates into the system. See saveEta().
  const [baselineEtaDraft, setBaselineEtaDraft] = useState(dateToInput(stage?.baselineEta))
  const [actualEndDraft, setActualEndDraft] = useState(dateToInput(stage?.actualEnd))
  const [updateText, setUpdateText] = useState('')
  const [matDraft, setMatDraft] = useState({ name: '', requiredQty: '' })
  const [saving, setSaving] = useState(false)
  const [savingEta, setSavingEta] = useState(false)
  // Partial-completion entry is collapsed by default — Mark Stage Done is
  // the action almost everyone wants; the units form is there for the
  // minority of stages where partial progress matters, one click away.
  const [showPartial, setShowPartial] = useState(false)
  // Set right before markStageDone() writes — see its comment.
  const [preCloseUnits, setPreCloseUnits] = useState(null)

  // ── Stage evidence ──
  const [showStageDocs, setShowStageDocs] = useState(false)
  const [sdItems, setSdItems] = useState([{ type: '', name: '', file: null, notes: '', fileErr: '' }])
  const [sdErr, setSdErr] = useState('')

  const uploadedStageDocs = (docs || []).filter(d =>
    d.orderId === orderId && d.stageIndex === stageIndex && d.materialLineIndex == null && String(d.mfrId || '') === String(mfrId))

  // Document Name defaults to the stage's own name (e.g. "Lab Dip Approval")
  // rather than starting blank.
  const openStageDocUpload = () => {
    const types = STAGE_DOC_MAP[stageIndex] || []
    setSdItems([{ type: types[0]?.v || '', name: stage?.name || `Stage ${stageIndex + 1}`, file: null, notes: '', fileErr: '' }])
    setSdErr('')
    setShowStageDocs(true)
  }

  const updateSdItem = (idx, patch) => setSdItems(prev => prev.map((item, i) => i === idx ? { ...item, ...patch } : item))

  const addSdItem = () => {
    const types = STAGE_DOC_MAP[stageIndex] || []
    setSdItems(prev => [...prev, { type: types[0]?.v || '', name: stage?.name || `Stage ${stageIndex + 1}`, file: null, notes: '', fileErr: '' }])
  }

  const removeSdItem = (idx) => setSdItems(prev => prev.filter((_, i) => i !== idx))

  const submitStageDoc = async () => {
    // Stage evidence: file OR notes is sufficient (managed via SOP)
    let hasErr = false
    setSdItems(prev => prev.map(item => {
      if (!item.name.trim()) { hasErr = true; return { ...item, fileErr: 'Enter a document name.' } }
      if (!item.file && !item.notes?.trim()) { hasErr = true; return { ...item, fileErr: 'Attach a file or add notes.' } }
      return { ...item, fileErr: '' }
    }))
    if (hasErr) return
    setSaving(true)
    try {
      for (const item of sdItems) {
        await uploadDoc({
          type: item.type, name: item.name.trim(), issuer: null,
          issueDate: new Date().toISOString().slice(0, 10), expiryDate: null,
          orderId, mfrId, stageIndex,
          notes: item.notes?.trim() || null,
          ...fileUploadPayload(item.file),
        })
      }
      toast(`${sdItems.length} stage evidence entr${sdItems.length > 1 ? 'ies' : 'y'} saved`, 'success')
      setShowStageDocs(false)
    } catch {
      toast('Failed to save stage evidence', 'error')
    } finally { setSaving(false) }
  }

  // Keep the form in step once a save round-trips fresh data back.
  useEffect(() => {
    if (!stage) return
    setDescription(stage.description || '')
    setUnits(String(stage.unitsDone ?? 0))
    setStatus(stageStatusOf(stage))
    setEtaDraft(dateToInput(stage.eta))
    setBaselineEtaDraft(dateToInput(stage.baselineEta))
    setActualEndDraft(dateToInput(stage.actualEnd))
  }, [stage?.description, stage?.unitsDone, stage?.status, stage?.eta, stage?.baselineEta, stage?.actualEnd])

  if (!order || !asgn || !stage) return null
  const kind = stageKindOf(stage)
  const isDone = stageStatusOf(stage) === 'done'

  const saveDescription = async () => {
    setSaving(true)
    try {
      await ordersApi.updateStageDates(orderId, mfrId, stageIndex, { description })
      await refreshOrders()
      toast('Description updated', 'success')
    } catch (err) {
      toast(err?.message || 'Failed to update description', 'error')
    } finally { setSaving(false) }
  }

  const saveProgress = async () => {
    setSaving(true)
    try {
      const body = kind === 'quantity' ? { unitsDone: parseInt(units, 10) || 0 } : { status }
      const res = await updateStage(orderId, mfrId, stageIndex, body)
      if (res?.warnings?.length) toast(res.warnings[0], 'warning')
      else toast('Stage updated', 'success')
    } catch (err) {
      toast(err?.message || 'Failed to update stage', 'error')
    } finally { setSaving(false) }
  }

  // Quantity-kind close path — skips the units math entirely (see backend's
  // status:'done' handling in the stage-update route's quantity branch).
  // Remembers what unitsDone was right before closing, so Undo can restore
  // real partial progress instead of always dropping back to 0 — but only
  // for this modal session; a stage that was already done when this modal
  // opened has no such memory, so its Undo falls back to reopening at 0.
  const markStageDone = async () => {
    setSaving(true)
    try {
      setPreCloseUnits(stage.unitsDone || 0)
      const res = await updateStage(orderId, mfrId, stageIndex, { status: 'done' })
      if (res?.warnings?.length) toast(res.warnings[0], 'warning')
      else toast('Stage marked done', 'success')
    } catch (err) {
      toast(err?.message || 'Failed to close stage', 'error')
    } finally { setSaving(false) }
  }

  const undoMarkDone = async () => {
    setSaving(true)
    try {
      const res = await updateStage(orderId, mfrId, stageIndex, { unitsDone: preCloseUnits ?? 0 })
      if (res?.warnings?.length) toast(res.warnings[0], 'warning')
      else toast('Stage reopened', 'success')
    } catch (err) {
      toast(err?.message || 'Failed to reopen stage', 'error')
    } finally { setSaving(false) }
  }

  // The New/revised date goes through the same /eta route (and same
  // refreshOrders() refetch) that Order Detail's own date-adjustment modal
  // uses — one write path, so a date changed here is the same stage object
  // Order Detail renders, never a second copy that can drift out of sync.
  const saveEta = async () => {
    const dates = {}
    if (etaDraft !== dateToInput(stage.eta)) dates.eta = etaDraft === 'NA' ? 'NA' : (etaDraft || null)
    // Master-only overrides — the backend rejects these from anyone else, but
    // don't even offer to send them from a non-master session.
    if (isMaster && baselineEtaDraft !== dateToInput(stage.baselineEta)) {
      dates.baselineEta = baselineEtaDraft === 'NA' ? 'NA' : (baselineEtaDraft || null)
    }
    if (isMaster && actualEndDraft && actualEndDraft !== dateToInput(stage.actualEnd)) {
      dates.actualEnd = actualEndDraft
    }
    if (Object.keys(dates).length === 0) return
    setSavingEta(true)
    try {
      await ordersApi.updateStageDates(orderId, mfrId, stageIndex, dates)
      await refreshOrders()
      toast('Date updated', 'success')
    } catch (err) {
      toast(err?.message || 'Failed to update date', 'error')
    } finally { setSavingEta(false) }
  }

  const postUpdate = async () => {
    if (!updateText.trim()) return
    setSaving(true)
    try {
      await addStageUpdate(orderId, mfrId, stageIndex, updateText.trim())
      setUpdateText('')
    } catch (err) {
      toast(err?.message || 'Failed to post update', 'error')
    } finally { setSaving(false) }
  }

  const addMaterial = async () => {
    if (!matDraft.name.trim() || !matDraft.requiredQty) return
    setSaving(true)
    try {
      await addStageMaterial(orderId, mfrId, stageIndex, { name: matDraft.name.trim(), requiredQty: parseFloat(matDraft.requiredQty) })
      setMatDraft({ name: '', requiredQty: '' })
    } catch (err) {
      toast(err?.message || 'Failed to add material', 'error')
    } finally { setSaving(false) }
  }

  const advanceMaterial = async (mi, current) => {
    const next = current === 'pending' ? 'ordered' : current === 'ordered' ? 'received' : 'pending'
    try { await updateStageMaterial(orderId, mfrId, stageIndex, mi, { status: next }) }
    catch (err) { toast(err?.message || 'Failed to update material', 'error') }
  }

  const deleteMaterial = async mi => {
    try { await removeStageMaterial(orderId, mfrId, stageIndex, mi) }
    catch (err) { toast(err?.message || 'Failed to remove material', 'error') }
  }

  return (
    <>
    <Modal title={stage.name} subtitle={`${order.product} · ${asgn.mfrCompany || 'Manufacturer'}`} size="lg" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <SectionLabel>Description</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="What does this stage involve? (optional)" />
            <FlexRow justify="flex-end">
              <Btn size="sm" variant="secondary" disabled={saving} onClick={saveDescription}>{saving ? 'Saving…' : 'Save Description'}</Btn>
            </FlexRow>
          </div>
        </div>

        <div>
          <SectionLabel>Progress</SectionLabel>
          {kind === 'quantity' ? (
            <>
              <div style={{ background: '#f8fafc', borderRadius: 10, border: `1px solid ${T.border}`, padding: '12px 14px' }}>
                <FlexRow justify="space-between" style={{ alignItems: 'center', gap: 12 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 6 }}>
                      {stage.unitsDone} / {stage.totalUnits} units
                      {stage.totalUnits > 0 && <span style={{ color: T.textLight }}> ({Math.round(stage.unitsDone / stage.totalUnits * 100)}%)</span>}
                    </div>
                    <div style={{ height: 6, background: '#e2e8f0', borderRadius: 3, overflow: 'hidden' }}>
                      <div style={{ height: 6, background: T.primary, borderRadius: 3, width: `${stage.totalUnits > 0 ? (stage.unitsDone / stage.totalUnits) * 100 : 0}%`, transition: 'width 0.3s' }} />
                    </div>
                  </div>
                  {isDone ? (
                    <Btn size="sm" variant="secondary" disabled={saving} onClick={undoMarkDone}>{saving ? 'Saving…' : 'Undo — Reopen Stage'}</Btn>
                  ) : (
                    <Btn size="sm" disabled={saving} onClick={markStageDone}>{saving ? 'Saving…' : 'Mark Stage Done'}</Btn>
                  )}
                </FlexRow>
              </div>
              <button
                onClick={() => setShowPartial(p => !p)}
                style={{ marginTop: 8, background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11.5, fontWeight: 600, color: T.primary, padding: 0 }}
              >
                {showPartial ? 'Hide partial update' : 'Update partial completion instead'}
              </button>
              {showPartial && (
                <div style={{ marginTop: 10 }}>
                  <Input label={`Units Done (max ${stage.totalUnits})`} type="number" value={units} onChange={e => setUnits(e.target.value)} />
                  <FlexRow justify="flex-end" style={{ marginTop: 8 }}>
                    <Btn size="sm" variant="secondary" disabled={saving} onClick={saveProgress}>{saving ? 'Saving…' : 'Save partial progress'}</Btn>
                  </FlexRow>
                </div>
              )}
            </>
          ) : (
            <>
              <Select label="Status" value={status} onChange={e => setStatus(e.target.value)}>
                {Object.entries(STAGE_STATUS_LABELS).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
              </Select>
              <FlexRow justify="flex-end" style={{ marginTop: 8 }}>
                <Btn size="sm" disabled={saving} onClick={saveProgress}>{saving ? 'Saving…' : 'Save Progress'}</Btn>
              </FlexRow>
            </>
          )}
        </div>

        <div style={{ borderTop: `1px dashed ${T.border}`, paddingTop: 14 }}>
          <SectionLabel>Dates</SectionLabel>
          <FlexRow gap={10} style={{ alignItems: 'flex-end' }}>
            <div>
              <div style={{ fontSize: 10, color: T.textLight, marginBottom: 4 }}>Planned</div>
              {isMaster ? (
                <input
                  type={baselineEtaDraft === 'NA' ? 'text' : 'date'}
                  value={baselineEtaDraft}
                  onChange={e => setBaselineEtaDraft(e.target.value)}
                  style={{ width: 120, border: `1px solid ${T.border}`, borderRadius: 6, padding: '5px 8px', fontSize: 12, fontFamily: 'inherit', color: baselineEtaDraft === 'NA' ? T.textLight : T.text, boxSizing: 'border-box' }}
                />
              ) : (
                <div style={{ fontSize: 12, fontWeight: 700, color: T.text }}>{fmtStageDate(stage.baselineEta)}</div>
              )}
            </div>
            <div style={{ flex: 1, minWidth: 110 }}>
              <div style={{ fontSize: 10, color: T.textLight, marginBottom: 4 }}>New</div>
              <input
                type={etaDraft === 'NA' ? 'text' : 'date'}
                value={etaDraft}
                onChange={e => setEtaDraft(e.target.value)}
                style={{ width: '100%', border: `1px solid ${T.border}`, borderRadius: 6, padding: '5px 8px', fontSize: 12, fontFamily: 'inherit', color: etaDraft === 'NA' ? T.textLight : T.text, boxSizing: 'border-box' }}
              />
            </div>
            <div>
              <div style={{ fontSize: 10, color: T.textLight, marginBottom: 4 }}>Actual</div>
              <FlexRow gap={4}>
                {isMaster ? (
                  <input
                    type="date"
                    value={actualEndDraft}
                    onChange={e => setActualEndDraft(e.target.value)}
                    style={{ width: 120, border: `1px solid ${T.border}`, borderRadius: 6, padding: '5px 8px', fontSize: 12, fontFamily: 'inherit', color: T.text, boxSizing: 'border-box' }}
                  />
                ) : (
                  <div style={{ fontSize: 12, fontWeight: 700, color: T.text }}>{fmtStageDate(stage.actualEnd)}</div>
                )}
                {(() => {
                  const av = stageActualVariance(stage)
                  return av != null && av !== 0 ? (
                    <span style={{ fontSize: 10, fontWeight: 800, color: av > 0 ? T.danger : T.success }}>
                      {av > 0 ? '+' : ''}{av}d
                    </span>
                  ) : null
                })()}
              </FlexRow>
            </div>
            <Btn
              size="sm"
              disabled={savingEta || (
                etaDraft === dateToInput(stage.eta)
                && (!isMaster || baselineEtaDraft === dateToInput(stage.baselineEta))
                && (!isMaster || !actualEndDraft || actualEndDraft === dateToInput(stage.actualEnd))
              )}
              onClick={saveEta}
            >{savingEta ? 'Saving…' : 'Save Date'}</Btn>
          </FlexRow>
          {isMaster && (
            <div style={{ fontSize: 10, color: T.textLight, marginTop: 4 }}>
              Planned/Actual are directly editable for the master admin — a short-term fix for entering real historical dates.
            </div>
          )}
          {(() => {
            const v = stageVariance(stage)
            return v != null && v !== 0 ? (
              <div style={{ fontSize: 10, color: v > 0 ? T.danger : T.success, marginTop: 6, fontWeight: 700 }}>
                {v > 0 ? '+' : ''}{v}d vs plan
              </div>
            ) : null
          })()}
        </div>

        <div style={{ borderTop: `1px dashed ${T.border}`, paddingTop: 14 }}>
          <SectionLabel>Updates</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8, maxHeight: 180, overflowY: 'auto' }}>
            {(stage.updates || []).length === 0 && <div style={{ fontSize: 11, color: T.textLight }}>No updates yet.</div>}
            {(stage.updates || []).slice().reverse().map((u, ui) => (
              <div key={ui} style={{ background: '#f8fafc', borderRadius: 6, padding: '6px 10px', border: `1px solid ${T.border}` }}>
                <div style={{ fontSize: 11, color: T.text }}>{u.text}</div>
                <div style={{ fontSize: 9, color: T.textLight, marginTop: 2 }}>{u.byUserName || 'Someone'} · {fmtDateTime(u.at)}</div>
              </div>
            ))}
          </div>
          <FlexRow gap={6}>
            <input
              value={updateText} onChange={e => setUpdateText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') postUpdate() }}
              placeholder="Add a progress update…"
              style={{ flex: 1, border: `1px solid ${T.border}`, borderRadius: 6, padding: '6px 8px', fontSize: 12, fontFamily: 'inherit' }}
            />
            <Btn size="sm" disabled={saving || !updateText.trim()} onClick={postUpdate}>Post</Btn>
          </FlexRow>
        </div>

        <div style={{ borderTop: `1px dashed ${T.border}`, paddingTop: 14 }}>
          <SectionLabel>Materials / PO</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
            {(stage.materials || []).length === 0 && <div style={{ fontSize: 11, color: T.textLight }}>No materials tracked for this stage.</div>}
            {(stage.materials || []).map((m, mi) => {
              const sStyle = m.status === 'received' ? { bg: T.successBg, c: T.success }
                : m.status === 'ordered' ? { bg: T.warningBg, c: T.warning }
                : { bg: '#f1f5f9', c: T.textMuted }
              return (
                <FlexRow key={mi} gap={8} style={{ background: '#fff', borderRadius: 6, padding: '6px 10px', border: `1px solid ${T.border}` }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: T.text }}>{m.name} — {m.requiredQty}{m.unit ? ` ${m.unit}` : ''}</div>
                  </div>
                  <button onClick={() => advanceMaterial(mi, m.status)}
                    style={{ fontSize: 9, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: sStyle.bg, color: sStyle.c, border: 'none', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
                    {m.status}
                  </button>
                  <button onClick={() => deleteMaterial(mi)}
                    style={{ background: T.dangerBg, border: 'none', borderRadius: 6, cursor: 'pointer', width: 20, height: 20, color: T.danger, flexShrink: 0 }}>×</button>
                </FlexRow>
              )
            })}
          </div>
          <FlexRow gap={6}>
            <input value={matDraft.name} placeholder="Material name" onChange={e => setMatDraft(d => ({ ...d, name: e.target.value }))}
              style={{ flex: 1, border: `1px solid ${T.border}`, borderRadius: 6, padding: '5px 8px', fontSize: 11, fontFamily: 'inherit' }} />
            <input type="number" value={matDraft.requiredQty} placeholder="Qty" onChange={e => setMatDraft(d => ({ ...d, requiredQty: e.target.value }))}
              style={{ width: 70, border: `1px solid ${T.border}`, borderRadius: 6, padding: '5px 8px', fontSize: 11, fontFamily: 'inherit' }} />
            <Btn size="sm" disabled={saving || !matDraft.name.trim() || !matDraft.requiredQty} onClick={addMaterial}>+ Add</Btn>
          </FlexRow>
        </div>

        <div style={{ borderTop: `1px dashed ${T.border}`, paddingTop: 14 }}>
          <SectionLabel>Evidence</SectionLabel>
          {uploadedStageDocs.length === 0 && <div style={{ fontSize: 11, color: T.textLight, marginBottom: 8 }}>No evidence uploaded yet.</div>}
          {uploadedStageDocs.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              {uploadedStageDocs.map(d => (
                <DocCard key={d.id} doc={d} users={users} onGetData={getDocData} stageName={stage?.name} />
              ))}
            </div>
          )}
          <Btn size="sm" variant="outline" onClick={openStageDocUpload}>
            📎 Upload Evidence
          </Btn>
        </div>

        <FlexRow justify="flex-end" gap={8}>
          {showOpenOrderLink && (
            <Btn variant="ghost" onClick={() => { onClose(); onOpenOrder(orderId, mfrId) }}>Open full order <ArrowRight size={13} style={{ marginLeft: -2 }} /></Btn>
          )}
          <Btn variant="secondary" onClick={onClose}>Close</Btn>
        </FlexRow>
      </div>
    </Modal>

    {showStageDocs && (
      <Modal title="Upload Stage Evidence" subtitle={`${stage?.name || `Stage ${stageIndex + 1}`} — Evidence Documents`} onClose={() => setShowStageDocs(false)} size="lg">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ fontSize: 12, color: T.textMuted, background: '#f0f7ff', border: `1px solid #dbeafe`, borderRadius: 8, padding: '8px 12px' }}>
            Linked to the {stage?.name || `Stage ${stageIndex + 1}`} stage. Attach a file/link, or add SOP notes only — either is sufficient.
          </div>
          {sdItems.map((item, idx) => (
            <div key={idx} style={{ border: `1px solid ${T.border}`, borderRadius: 10, padding: '14px 16px', background: '#f8fafc', position: 'relative' }}>
              {sdItems.length > 1 && (
                <button onClick={() => removeSdItem(idx)} style={{ position: 'absolute', top: 10, right: 10, background: '#fee2e2', border: 'none', borderRadius: 6, cursor: 'pointer', width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, color: T.danger }}>×</button>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <Input label="Document Name *" value={item.name} onChange={e => updateSdItem(idx, { name: e.target.value, fileErr: '' })} placeholder={`e.g. ${stage?.name || `Stage ${stageIndex + 1}`} GRN - Batch ${idx + 1}`} />
                <FileUpload file={item.file} onFile={f => updateSdItem(idx, { file: f, fileErr: '' })} error={item.fileErr} onError={err => updateSdItem(idx, { fileErr: err })} />
                <Textarea
                  label="Notes (optional — text evidence)"
                  value={item.notes}
                  onChange={e => updateSdItem(idx, { notes: e.target.value, fileErr: '' })}
                  placeholder="Add SOP context, observations, or text-only stage evidence…"
                  rows={3}
                />
              </div>
            </div>
          ))}
          {sdErr && <div style={{ fontSize: 12, color: T.danger, fontWeight: 500 }}>⚠ {sdErr}</div>}
          <FlexRow justify="space-between" gap={8}>
            <Btn variant="secondary" size="sm" onClick={addSdItem}>+ Add Another Document</Btn>
            <FlexRow gap={8}>
              <Btn variant="secondary" onClick={() => setShowStageDocs(false)}>Cancel</Btn>
              <Btn disabled={saving} onClick={submitStageDoc}>{saving ? 'Uploading…' : `Upload ${sdItems.length > 1 ? `${sdItems.length} Documents` : 'Evidence'}`}</Btn>
            </FlexRow>
          </FlexRow>
        </div>
      </Modal>
    )}
    </>
  )
}
