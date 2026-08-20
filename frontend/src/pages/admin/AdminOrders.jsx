import { useState, useRef, useEffect } from 'react'
import {
  T, CATEGORIES, SEASONS, DEFAULT_STAGE_NAMES, ORDER_STATUSES, STAGE_DOC_MAP,
  isStageDone, stageIsOverdue, stageStatusOf, stageKindOf, stageProgressLabel, stageVariance, stageActualVariance, stagePct,
  STAGE_STATUS_LABELS, CELL_STATE, cellState, buildMatrixSpine,
} from '../../constants.js'
import { Badge, Btn, Card, EmptyState, Mono, FlexRow, PageHeader, Select, Input, FileUpload, LoadingScreen, useToast, fileUploadPayload, ProductThumb, Modal, SectionLabel, Textarea, DocCard } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'
import { ordersApi } from '../../api.js'
import { EditOrderModal } from './EditOrderModal.jsx'
import { DeleteOrderModal } from './DeleteOrderModal.jsx'
import { BulkUploadCsvPanel } from './BulkUploadCsvPanel.jsx'
import { MaterialsBulkUploadPanel } from './MaterialsBulkUploadPanel.jsx'
import { TnaImportPanel } from './TnaImportPanel.jsx'

function fmtDate(d) {
  if (!d) return '—'
  const dt = new Date(d)
  const dd = String(dt.getDate()).padStart(2, '0')
  const mm = String(dt.getMonth() + 1).padStart(2, '0')
  return `${dd}-${mm}-${dt.getFullYear()}`
}

// Stage dates are 'YYYY-MM-DD' strings or the literal 'NA' — never a bare
// Date, so this is deliberately separate from fmtDate() above (which formats
// order.delivery, a real Date). Feeding 'NA' through `new Date()` there
// produces 'NaN-NaN-NaN'.
function fmtStageDate(d) {
  if (!d || d === 'NA') return '—'
  const [y, m, day] = d.slice(0, 10).split('-')
  return y && m && day ? `${day}-${m}-${y}` : '—'
}

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

// A focused stage-update modal that lives ON the Order Management page — no
// navigation to Order Detail. Clicking a matrix date cell (or, later, any
// other quick-action entry point) opens this in place, so saving an edit
// leaves you exactly where you were. Mirrors the full Order Detail modal's
// sections (description, progress, updates, materials, evidence) so the two
// don't drift apart — "Open full order" is for order-wide context, not to
// reach functionality missing here.
function QuickStageModal({ orderId, mfrId, stageIndex, onClose, onOpenOrder }) {
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

  // ── Stage evidence — same shape as AdminOrderDetail's Update Stage modal ──
  const [showStageDocs, setShowStageDocs] = useState(false)
  const [sdItems, setSdItems] = useState([{ type: '', name: '', file: null, notes: '', fileErr: '' }])
  const [sdErr, setSdErr] = useState('')

  const uploadedStageDocs = (docs || []).filter(d =>
    d.orderId === orderId && d.stageIndex === stageIndex && d.materialLineIndex == null && String(d.mfrId || '') === String(mfrId))

  // Document Name defaults to the stage's own name (e.g. "Lab Dip Approval")
  // rather than starting blank — see matching comment in AdminOrderDetail.jsx.
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
            <Input label={`Units Done (max ${stage.totalUnits})`} type="number" value={units} onChange={e => setUnits(e.target.value)} />
          ) : (
            <Select label="Status" value={status} onChange={e => setStatus(e.target.value)}>
              {Object.entries(STAGE_STATUS_LABELS).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </Select>
          )}
          <FlexRow justify="flex-end" style={{ marginTop: 8 }}>
            <Btn size="sm" disabled={saving} onClick={saveProgress}>{saving ? 'Saving…' : 'Save Progress'}</Btn>
          </FlexRow>
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
          <Btn variant="ghost" onClick={() => { onClose(); onOpenOrder(orderId, mfrId) }}>Open full order →</Btn>
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

// ── Matrix view: styles across the top, TNA steps down the side ────────────
// The shape the team already keeps by hand in the Summary TNA sheet — one
// glance at a whole master order's plan, rather than one row per order.

// "Fitleasure — Core Series" rather than just "Core Series" — the master-order
// name alone doesn't say whose order it is. A real master-order group always
// belongs to one buyer; the "Other Orders" catch-all can span several, so it
// only gets a client prefix when every order in it happens to share one.
function groupDisplayLabel(g) {
  const base = g.mo?.orderName || (g.moId === '__none__' ? 'Other Orders' : g.moId)
  const buyers = new Set(g.orders.map(o => o.buyerCompany).filter(Boolean))
  return buyers.size === 1 ? `${[...buyers][0]} — ${base}` : base
}

export function AdminOrders({ onOpen, initialStatus }) {
  const { orders, users, loading, createOrder, uploadDoc, masterOrders, createMasterOrder, editOrder, deleteOrder } = useApp()
  const toast = useToast()
  const [q, setQ] = useState('')
  const [showSugg, setShowSugg] = useState(false)
  const [sfilt, setSfilt] = useState(initialStatus || 'All')
  const [sortCol, setSortCol] = useState(null)
  const [sortDir, setSortDir] = useState('asc')
  // Groups start collapsed — an admin managing many master orders shouldn't have to
  // scroll past every line item of every group just to find one. Tracks which groups
  // have been explicitly expanded, rather than which are collapsed.
  const [expandedGroups, setExpandedGroups] = useState(() => new Set())
  const toggleGroup = moId => setExpandedGroups(prev => {
    const next = new Set(prev)
    next.has(moId) ? next.delete(moId) : next.add(moId)
    return next
  })

  // List vs Matrix (styles across, TNA steps down). Both read the SAME
  // expandedGroups Set, keyed by master-order id — so a group left open in one
  // view stays open switching to the other; only the rendering changes.
  const [view, setView] = useState('list')
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
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [showMatBulk, setShowMatBulk] = useState(false)
  const [showTnaImport, setShowTnaImport] = useState(false)

  // ── Create Order state ──
  const [showC, setShowC] = useState(false)
  const [mode, setMode] = useState('single') // 'single' | 'bulk' — bulk only available once a master order is selected
  const [f, setF] = useState({ masterOrderId: '', buyerId: '', product: '', category: '', customCategory: '', season: 'SS26', totalQty: '', delivery: '' })
  const [mfrs, setMfrs] = useState([{ _key: 1, mid: '', qty: '' }])
  const [stages, setStages] = useState(DEFAULT_STAGE_NAMES.map((name, i) => ({ _key: i + 1, name, startDate: '', eta: '', kind: 'quantity' })))
  // Comma-separated on the form, split on submit. Kept at order level so
  // per-colour steps generate their checklist from one list.
  const [colourways, setColourways] = useState('')
  const [poFile, setPoFile] = useState(null)
  const [poErr, setPoErr] = useState('')
  const [tpFile, setTpFile] = useState(null)
  const [tpErr, setTpErr] = useState('')
  const [photoFile, setPhotoFile] = useState(null)
  const [photoErr, setPhotoErr] = useState('')
  const [createErr, setCreateErr] = useState('')
  const [saving, setSaving] = useState(false)

  // ── Create Master Order state ──
  const [showMO, setShowMO] = useState(false)
  const [mo, setMo] = useState({ buyerId: '', orderName: '', season: 'SS26' })
  const [moFile, setMoFile] = useState(null)
  const [moFileErr, setMoFileErr] = useState('')
  const [moErr, setMoErr] = useState('')
  const [moSaving, setMoSaving] = useState(false)

  if (loading) return <LoadingScreen />

  const buyerUsers = users.filter(u => u.role === 'buyer' && u.isActive)  // used in Master Order modal
  const mfrUsers = users.filter(u => u.role === 'manufacturer' && u.isActive)

  // Derive unique categories from existing orders + default list
  const allCategories = [...new Set([...CATEGORIES, ...orders.map(o => o.category).filter(Boolean)])]

  const toggleSort = col => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
  }

  const filtered = orders.filter(o => {
    const qm = !q || (o.id.toLowerCase().includes(q.toLowerCase()) || o.product.toLowerCase().includes(q.toLowerCase()))
    const sm = sfilt === 'All' || (o.assignments || []).some(a => a.status === sfilt)
    return qm && sm
  }).sort((a, b) => {
    if (!sortCol) return 0
    const dir = sortDir === 'asc' ? 1 : -1
    if (sortCol === 'buyer') return dir * (a.buyerCompany || '').localeCompare(b.buyerCompany || '')
    if (sortCol === 'manufacturer') {
      const am = (a.assignments || []).map(x => x.mfrCompany).filter(Boolean).join(', ')
      const bm = (b.assignments || []).map(x => x.mfrCompany).filter(Boolean).join(', ')
      return dir * am.localeCompare(bm)
    }
    if (sortCol === 'status') return dir * orderStatus(a).localeCompare(orderStatus(b))
    if (sortCol === 'delivery') return dir * (new Date(a.delivery) - new Date(b.delivery))
    return 0
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
    result.sort((a, b) => {
      if (a.moId === '__none__') return 1
      if (b.moId === '__none__') return -1
      return new Date(b.mo?.createdAt || 0) - new Date(a.mo?.createdAt || 0)
    })
    return result
  })()

  const genMoId = () => {
    const b = users.find(u => u.id === mo.buyerId)
    if (!b) return null
    const cnt = masterOrders.filter(m => m.buyerId === mo.buyerId).length + 1
    return `MO-${b.code}-${mo.season || 'XX'}-${String(cnt).padStart(3, '0')}`
  }

  const genId = () => {
    const b = users.find(u => u.id === f.buyerId)
    const m = users.find(u => u.id === mfrs[0]?.mid)
    if (!b || !m) return null
    const cat = f.category === '__custom__' ? (f.customCategory || 'CUST').toUpperCase().slice(0, 6) : (f.category || 'XX')
    const cnt = orders.filter(o => o.id.startsWith(b.code + '-')).length + 1
    return `${b.code}-${m.code}-${cat}-${f.season}-${String(cnt).padStart(3, '0')}`
  }

  const resetForm = () => {
    setF({ masterOrderId: '', buyerId: '', product: '', category: '', customCategory: '', season: 'SS26', totalQty: '', delivery: '' })
    setMfrs([{ mid: '', qty: '' }])
    setStages(DEFAULT_STAGE_NAMES.map((name, i) => ({ _key: i + 1, name, startDate: '', eta: '', kind: 'quantity' })))
    setColourways('')
    setPoFile(null)
    setPoErr('')
    setTpFile(null)
    setTpErr('')
    setPhotoFile(null)
    setPhotoErr('')
    setCreateErr('')
    setMode('single')
  }

  const resetMoForm = () => {
    setMo({ buyerId: '', orderName: '', season: 'SS26' })
    setMoFile(null); setMoFileErr(''); setMoErr('')
  }

  const create = async () => {
    const id = genId()
    if (!id) return
    setCreateErr('')

    // Validate assignment quantities sum to totalQty
    const totalQtyNum = Math.floor(Number(f.totalQty))
    if (!totalQtyNum || totalQtyNum < 1) {
      setCreateErr('Total quantity must be a positive number')
      return
    }
    const validMfrs = mfrs.filter(a => a.mid && a.qty !== '')
    if (validMfrs.length === 0) {
      setCreateErr('At least one manufacturer with a quantity is required')
      return
    }
    const assignedTotal = validMfrs.reduce((sum, a) => sum + Math.floor(Number(a.qty) || 0), 0)
    if (assignedTotal !== totalQtyNum) {
      setCreateErr(`Assigned quantities (${assignedTotal.toLocaleString()}) must equal total quantity (${totalQtyNum.toLocaleString()}). Difference: ${Math.abs(totalQtyNum - assignedTotal).toLocaleString()}`)
      return
    }

    const validStages = stages.filter(s => s.name.trim())
    if (validStages.length === 0) {
      setCreateErr('At least one production stage is required')
      return
    }
    const missingStartDate = validStages.find(s => !s.startDate || !s.startDate.trim())
    if (missingStartDate) {
      setCreateErr(`Stage "${missingStartDate.name}" is missing a start date — enter a date or type "NA"`)
      return
    }
    const missingEta = validStages.find(s => !s.eta || !s.eta.trim())
    if (missingEta) {
      setCreateErr(`Stage "${missingEta.name}" is missing an end date — enter a date or type "NA"`)
      return
    }
    const badOrder = validStages.find(s =>
      s.startDate !== 'NA' && s.eta !== 'NA' && new Date(s.startDate) > new Date(s.eta)
    )
    if (badOrder) {
      setCreateErr(`Stage "${badOrder.name}" — start date must be on or before its end date`)
      return
    }

    setSaving(true)
    try {
      const resolvedCategory = f.category === '__custom__' ? f.customCategory.trim() : f.category
      const photoPayload = fileUploadPayload(photoFile)
      const orderData = {
        id, buyerId: f.buyerId, product: f.product, category: resolvedCategory, season: f.season,
        masterOrderId: f.masterOrderId || null,
        totalQty: totalQtyNum, delivery: f.delivery,
        createdAt: new Date().toISOString().slice(0, 10),
        assignments: validMfrs.map((a, i) => ({ mid: a.mid, qty: Math.floor(Number(a.qty)), sub: `M${i + 1}` })),
        stageNames: validStages.map(s => s.name.trim()),
        stageStartDates: validStages.map(s => s.startDate === 'NA' ? 'NA' : s.startDate || null),
        stageEtas: validStages.map(s => s.eta === 'NA' ? 'NA' : s.eta || null),
        stageKinds: validStages.map(s => s.kind || 'quantity'),
        colourways: colourways.split(',').map(c => c.trim()).filter(Boolean),
        imageDataUrl: photoPayload.dataUrl || null,
        imageUrl: photoPayload.externalUrl || null,
      }
      await createOrder(orderData)

      // Upload PO attachment if provided
      if (poFile) {
        try {
          await uploadDoc({
            type: 'PO', name: `PO — ${id}`, issuer: '', issueDate: new Date().toISOString().slice(0, 10),
            expiryDate: null, orderId: id, mfrId: null,
            ...fileUploadPayload(poFile),
          })
        } catch (poErr) {
          console.error('[create order] PO upload failed:', poErr)
          toast('Order created but PO upload failed — re-upload from the Documents tab', 'warning')
          setShowC(false)
          resetForm()
          return
        }
      }

      // Upload Tech Pack if provided
      if (tpFile) {
        try {
          await uploadDoc({
            type: 'tech_pack', name: `Tech Pack — ${id}`, issuer: '', issueDate: new Date().toISOString().slice(0, 10),
            expiryDate: null, orderId: id, mfrId: null,
            ...fileUploadPayload(tpFile),
          })
        } catch (tpErr) {
          console.error('[create order] Tech pack upload failed:', tpErr)
          toast('Order created but Tech Pack upload failed — re-upload from the Documents tab', 'warning')
          setShowC(false)
          resetForm()
          return
        }
      }

      toast(`Order ${id} created`, 'success')
      setShowC(false)
      resetForm()
    } catch (err) {
      setCreateErr(typeof err === 'string' ? err : (err?.message || 'Failed to create order. Please try again.'))
    } finally { setSaving(false) }
  }

  const previewId = genId()

  const orderStatus = (o) => {
    if (o.assignments.some(a => a.status === 'Delayed')) return 'Delayed'
    if (o.assignments.some(a => a.status === 'On Hold')) return 'On Hold'
    if (o.assignments.every(a => a.status === 'Delivered')) return 'Delivered'
    return 'Processing'
  }

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
      {deleteTarget && (
        <DeleteOrderModal
          order={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onConfirm={async (id) => {
            await deleteOrder(id)
            toast(`Order ${id} deleted`, 'success')
            setDeleteTarget(null)
          }}
        />
      )}
      {showC && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, backdropFilter: 'blur(2px)' }} onClick={e => e.target === e.currentTarget && (setShowC(false), resetForm())}>
          <div style={{ background: '#fff', borderRadius: 14, border: `1px solid ${T.border}`, width: '100%', maxWidth: 720, maxHeight: '94vh', display: 'flex', flexDirection: 'column', boxShadow: '0 24px 64px rgba(0,0,0,0.18)' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '20px 24px 16px', borderBottom: `1px solid ${T.border}` }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 700, color: T.text }}>Create New Order</div>
                <div style={{ fontSize: 12, color: T.textMuted, marginTop: 3 }}>Order ID will be auto-generated · All stages start at 0%</div>
              </div>
              <button onClick={() => { setShowC(false); resetForm() }} style={{ background: '#f1f5f9', border: 'none', cursor: 'pointer', width: 28, height: 28, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, color: T.textMuted }}>×</button>
            </div>
            <div style={{ padding: '20px 24px', overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 16 }}>

              {/* Link to Master Order */}
              <Select label="Master Order *" value={f.masterOrderId} onChange={e => {
                const moId = e.target.value
                const sel = masterOrders.find(m => m.id === moId)
                setF(prev => ({
                  ...prev,
                  masterOrderId: moId,
                  buyerId: sel?.buyerId || prev.buyerId,
                  season: sel?.season || prev.season,
                }))
              }}>
                <option value="">— Select Master Order —</option>
                {masterOrders.map(m => <option key={m.id} value={m.id}>{m.id} — {m.orderName} ({m.buyerCompany})</option>)}
              </Select>

              {f.masterOrderId && (() => {
                const sel = masterOrders.find(m => m.id === f.masterOrderId)
                return sel ? (
                  <div style={{ background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 8, padding: '8px 14px', fontSize: 12, color: '#0369a1', display: 'flex', gap: 16 }}>
                    <span><b>Buyer:</b> {sel.buyerCompany}</span>
                    <span><b>Season:</b> {sel.season || '—'}</span>
                    <span><b>Order:</b> {sel.orderName}</span>
                  </div>
                ) : null
              })()}

              {/* Single Order / Bulk Upload CSV mode toggle — only once a master order is selected */}
              {f.masterOrderId && (
                <div role="tablist" style={{ display: 'flex', gap: 2, background: '#f1f5f9', padding: 3, borderRadius: 9, width: 'fit-content' }}>
                  <button type="button" role="tab" aria-selected={mode === 'single'} onClick={() => setMode('single')}
                    style={{ background: mode === 'single' ? '#fff' : 'transparent', border: 'none', cursor: 'pointer', padding: '6px 14px', borderRadius: 7, fontSize: 12, fontWeight: 700, color: mode === 'single' ? T.text : T.textMuted, fontFamily: 'inherit', boxShadow: mode === 'single' ? '0 1px 2px rgba(0,0,0,0.06)' : 'none' }}>
                    Single Order
                  </button>
                  <button type="button" role="tab" aria-selected={mode === 'bulk'} onClick={() => setMode('bulk')}
                    style={{ background: mode === 'bulk' ? '#fff' : 'transparent', border: 'none', cursor: 'pointer', padding: '6px 14px', borderRadius: 7, fontSize: 12, fontWeight: 700, color: mode === 'bulk' ? T.text : T.textMuted, fontFamily: 'inherit', boxShadow: mode === 'bulk' ? '0 1px 2px rgba(0,0,0,0.06)' : 'none' }}>
                    📄 Bulk Upload CSV
                  </button>
                </div>
              )}

              {mode === 'bulk' && f.masterOrderId ? (
                <BulkUploadCsvPanel
                  masterOrder={masterOrders.find(m => m.id === f.masterOrderId)}
                  onDone={() => { setShowC(false); resetForm() }}
                />
              ) : (
              <>

              {/* Product fields */}
              <div className="form-grid-2">
                <Input label="Product Name *" value={f.product} onChange={e => setF({ ...f, product: e.target.value })} placeholder="e.g. Classic T-Shirt" />
                <Input
                  label="Colourways"
                  value={colourways}
                  onChange={e => setColourways(e.target.value)}
                  placeholder="e.g. Peacot, Brown, Olivine"
                  hint="Comma-separated. Checklist steps can generate one line per colour from this."
                />
                <Input label="Total Quantity *" type="number" value={f.totalQty} onChange={e => setF({ ...f, totalQty: e.target.value })} placeholder="5000" />
              </div>
              <div className="form-grid-3">
                <div>
                  <Select label="Category" value={f.category} onChange={e => setF({ ...f, category: e.target.value })}>
                    <option value="">— Select —</option>
                    {allCategories.map(c => <option key={c} value={c}>{c}</option>)}
                    <option value="__custom__">✏️ Custom…</option>
                  </Select>
                  {f.category === '__custom__' && (
                    <input
                      value={f.customCategory}
                      onChange={e => setF({ ...f, customCategory: e.target.value.toUpperCase() })}
                      placeholder="Type category code…"
                      maxLength={20}
                      style={{ width: '100%', border: `1px solid ${T.border}`, borderRadius: 8, padding: '7px 12px', fontSize: 13, marginTop: 6, fontFamily: 'inherit', boxSizing: 'border-box' }}
                    />
                  )}
                </div>
                <Select label="Season" value={f.season} onChange={e => setF({ ...f, season: e.target.value })}>
                  {SEASONS.map(s => <option key={s}>{s}</option>)}
                </Select>
                <Input label="Expected Delivery *" type="date" value={f.delivery} onChange={e => setF({ ...f, delivery: e.target.value })} />
              </div>

              {/* Manufacturer assignments */}
              <div>
                <FlexRow justify="space-between" style={{ marginBottom: 8 }}>
                  <label style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Manufacturer Assignments *</label>
                  <button onClick={() => setMfrs([...mfrs, { _key: Date.now(), mid: '', qty: '' }])} style={{ fontSize: 12, color: T.primary, background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600, fontFamily: 'inherit' }}>+ Add Manufacturer</button>
                </FlexRow>
                {mfrs.map((a, i) => (
                  <div key={a._key} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                    <select value={a.mid} onChange={e => setMfrs(mfrs.map((x, j) => j === i ? { ...x, mid: e.target.value } : x))}
                      style={{ flex: 1, border: `1px solid ${T.border}`, borderRadius: 8, padding: '8px 12px', fontSize: 13, color: T.text, background: T.surface, fontFamily: 'inherit' }}>
                      <option value="">Select manufacturer…</option>
                      {mfrUsers.map(m => <option key={m.id} value={m.id}>{m.company} ({m.code})</option>)}
                    </select>
                    <input type="number" value={a.qty} onChange={e => setMfrs(mfrs.map((x, j) => j === i ? { ...x, qty: e.target.value } : x))}
                      placeholder="Qty" style={{ width: 100, border: `1px solid ${T.border}`, borderRadius: 8, padding: '8px 12px', fontSize: 13, fontFamily: 'inherit' }} />
                    {mfrs.length > 1 && (
                      <button onClick={() => setMfrs(mfrs.filter((_, j) => j !== i))}
                        style={{ background: T.dangerBg, border: `1px solid ${T.dangerBorder}`, borderRadius: 8, cursor: 'pointer', padding: '0 12px', color: T.danger, fontSize: 18, fontFamily: 'inherit' }}>×</button>
                    )}
                  </div>
                ))}
                {/* Live qty balance indicator */}
                {(() => {
                  const total = Math.floor(Number(f.totalQty)) || 0
                  const assigned = mfrs.reduce((sum, a) => sum + (Math.floor(Number(a.qty)) || 0), 0)
                  if (total === 0) return null
                  const ok = assigned === total
                  const remaining = total - assigned
                  return (
                    <div style={{ fontSize: 11, fontWeight: 600, color: ok ? T.success : T.danger, marginTop: 2 }}>
                      {ok
                        ? `✓ Quantities balance (${assigned.toLocaleString()} / ${total.toLocaleString()})`
                        : remaining > 0
                          ? `${remaining.toLocaleString()} units still unallocated (${assigned.toLocaleString()} / ${total.toLocaleString()})`
                          : `Over-allocated by ${(-remaining).toLocaleString()} units (${assigned.toLocaleString()} / ${total.toLocaleString()})`
                      }
                    </div>
                  )
                })()}
              </div>

              {/* Dynamic Production Stages */}
              <div>
                <FlexRow justify="space-between" style={{ marginBottom: 8 }}>
                  <label style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Production Stages *</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={() => setStages(DEFAULT_STAGE_NAMES.map((name, i) => ({ _key: i + 1, name, startDate: '', eta: '', kind: 'quantity' })))} style={{ fontSize: 11, color: T.textMuted, background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600, fontFamily: 'inherit', textDecoration: 'underline' }}>Load Defaults</button>
                    <button onClick={() => setStages([...stages, { _key: Date.now(), name: '', startDate: '', eta: '', kind: 'quantity' }])} style={{ fontSize: 12, color: T.primary, background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600, fontFamily: 'inherit' }}>+ Add Stage</button>
                  </div>
                </FlexRow>
                <div style={{ background: '#f8fafc', borderRadius: 10, border: `1px solid ${T.border}`, padding: '12px 14px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                    <span style={{ fontSize: 11, color: T.textLight }}>Define the production stages for this order. Every stage needs a start and end date — type "NA" only if it genuinely doesn't apply.</span>
                    <span style={{ fontSize: 11, fontWeight: 700, color: stages.filter(s => s.name.trim()).length > 0 ? T.success : T.danger }}>{stages.filter(s => s.name.trim()).length} stage{stages.filter(s => s.name.trim()).length !== 1 ? 's' : ''}</span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {stages.map((s, i) => (
                      <div key={s._key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, minWidth: 22, textAlign: 'right' }}>{i + 1}.</span>
                        <input
                          value={s.name}
                          onChange={e => setStages(stages.map((x, j) => j === i ? { ...x, name: e.target.value } : x))}
                          placeholder="Stage name"
                          style={{ flex: 1, border: `1px solid ${T.border}`, borderRadius: 6, padding: '6px 10px', fontSize: 12, fontFamily: 'inherit', color: T.text, fontWeight: 600 }}
                        />
                        <input
                          type={s.startDate === 'NA' ? 'text' : 'date'}
                          value={s.startDate}
                          onChange={e => setStages(stages.map((x, j) => j === i ? { ...x, startDate: e.target.value } : x))}
                          placeholder="Start date"
                          style={{ width: 130, border: `1px solid ${s.name.trim() && !s.startDate.trim() ? T.danger : T.border}`, borderRadius: 6, padding: '6px 8px', fontSize: 12, fontFamily: 'inherit', color: s.startDate === 'NA' ? T.textLight : T.text }}
                        />
                        <input
                          type={s.eta === 'NA' ? 'text' : 'date'}
                          value={s.eta}
                          onChange={e => setStages(stages.map((x, j) => j === i ? { ...x, eta: e.target.value } : x))}
                          placeholder="End date"
                          style={{ width: 130, border: `1px solid ${s.name.trim() && !s.eta.trim() ? T.danger : T.border}`, borderRadius: 6, padding: '6px 8px', fontSize: 12, fontFamily: 'inherit', color: s.eta === 'NA' ? T.textLight : T.text }}
                        />
                        {/* Most real TNA steps are milestones — "FPT Sent" is done or
                            not, it doesn't count garments. Checklist steps hold their
                            own short list (one lab dip per colourway). */}
                        <select
                          value={s.kind || 'quantity'}
                          onChange={e => setStages(stages.map((x, j) => j === i ? { ...x, kind: e.target.value } : x))}
                          title="How this step measures done"
                          style={{ width: 106, border: `1px solid ${T.border}`, borderRadius: 6, padding: '6px 6px', fontSize: 11, fontFamily: 'inherit', color: T.text, background: '#fff', cursor: 'pointer' }}
                        >
                          <option value="quantity">Quantity</option>
                          <option value="milestone">Milestone</option>
                          <option value="checklist">Checklist</option>
                        </select>
                        {i > 0 && (
                          <button onClick={() => { const n = [...stages]; [n[i-1], n[i]] = [n[i], n[i-1]]; setStages(n) }}
                            style={{ background: '#f1f5f9', border: `1px solid ${T.border}`, borderRadius: 6, cursor: 'pointer', width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: T.textMuted }}>↑</button>
                        )}
                        {i < stages.length - 1 && (
                          <button onClick={() => { const n = [...stages]; [n[i], n[i+1]] = [n[i+1], n[i]]; setStages(n) }}
                            style={{ background: '#f1f5f9', border: `1px solid ${T.border}`, borderRadius: 6, cursor: 'pointer', width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: T.textMuted }}>↓</button>
                        )}
                        {stages.length > 1 && (
                          <button onClick={() => setStages(stages.filter((_, j) => j !== i))}
                            style={{ background: T.dangerBg, border: `1px solid ${T.dangerBorder}`, borderRadius: 6, cursor: 'pointer', width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, color: T.danger }}>×</button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Product Photo */}
              <div>
                <label style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 8 }}>Product Photo (optional)</label>
                <FileUpload file={photoFile} onFile={f => { setPhotoFile(f); setPhotoErr('') }} error={photoErr} onError={setPhotoErr} />
              </div>

              {/* PO Attachment */}
              <div>
                <label style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 8 }}>PO Attachment (optional)</label>
                <FileUpload file={poFile} onFile={f => { setPoFile(f); setPoErr('') }} error={poErr} onError={setPoErr} />
              </div>

              {/* Tech Pack */}
              <div>
                <label style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 8 }}>Tech Pack (optional)</label>
                <FileUpload file={tpFile} onFile={f => { setTpFile(f); setTpErr('') }} error={tpErr} onError={setTpErr} />
              </div>

              {/* Preview ID */}
              {previewId && (
                <div style={{ background: T.primaryLight, border: '1px solid #c7d2fe', borderRadius: 10, padding: '12px 16px' }}>
                  <div style={{ fontSize: 11, color: T.primary, fontWeight: 700, marginBottom: 4 }}>GENERATED ORDER ID</div>
                  <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 14, color: T.primaryDark, fontWeight: 500 }}>{previewId}</span>
                </div>
              )}

              {createErr && <div style={{ fontSize: 12, color: T.danger, fontWeight: 600, background: T.dangerBg, border: `1px solid ${T.dangerBorder}`, borderRadius: 8, padding: '8px 12px' }}>⚠ {createErr}</div>}
              <FlexRow justify="flex-end" gap={8} style={{ marginTop: 4 }}>
                <Btn variant="secondary" onClick={() => setShowC(false)}>Cancel</Btn>
                <Btn disabled={!f.masterOrderId || !f.buyerId || !f.product || !f.totalQty || !f.delivery || !mfrs[0].mid || !mfrs[0].qty || stages.filter(s => s.name.trim()).some(s => !s.startDate.trim() || !s.eta.trim()) || saving} onClick={create}>{saving ? 'Creating…' : 'Create Order'}</Btn>
              </FlexRow>
              </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Create Master Order Modal ── */}
      {showMO && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, backdropFilter: 'blur(2px)' }} onClick={e => e.target === e.currentTarget && (setShowMO(false), resetMoForm())}>
          <div style={{ background: '#fff', borderRadius: 14, border: `1px solid ${T.border}`, width: '100%', maxWidth: 560, boxShadow: '0 24px 64px rgba(0,0,0,0.18)' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '20px 24px 16px', borderBottom: `1px solid ${T.border}` }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 700, color: T.text }}>Create Master Order</div>
                <div style={{ fontSize: 12, color: T.textMuted, marginTop: 3 }}>A master order groups all products for a buyer's order</div>
              </div>
              <button onClick={() => { setShowMO(false); resetMoForm() }} style={{ background: '#f1f5f9', border: 'none', cursor: 'pointer', width: 28, height: 28, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, color: T.textMuted }}>×</button>
            </div>
            <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
              <Select label="Buyer *" value={mo.buyerId} onChange={e => setMo({ ...mo, buyerId: e.target.value })}>
                <option value="">Select buyer…</option>
                {buyerUsers.map(b => <option key={b.id} value={b.id}>{b.company} ({b.code})</option>)}
              </Select>
              <Input label="Order Name *" value={mo.orderName} onChange={e => setMo({ ...mo, orderName: e.target.value })} placeholder="e.g. Spring Collection 2026" />
              <Select label="Season" value={mo.season} onChange={e => setMo({ ...mo, season: e.target.value })}>
                {SEASONS.map(s => <option key={s}>{s}</option>)}
              </Select>
              <div>
                <label style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 8 }}>PO / RFQ Attachment (optional)</label>
                <FileUpload file={moFile} onFile={f => { setMoFile(f); setMoFileErr('') }} error={moFileErr} onError={setMoFileErr} />
              </div>
              {genMoId() && (
                <div style={{ background: T.primaryLight, border: '1px solid #c7d2fe', borderRadius: 8, padding: '8px 14px' }}>
                  <div style={{ fontSize: 10, color: T.primary, fontWeight: 700, marginBottom: 2 }}>GENERATED ID</div>
                  <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 13, color: T.primaryDark }}>{genMoId()}</span>
                </div>
              )}
              {moErr && <div style={{ fontSize: 12, color: T.danger, fontWeight: 600, background: T.dangerBg, border: `1px solid ${T.dangerBorder}`, borderRadius: 8, padding: '8px 12px' }}>⚠ {moErr}</div>}
              <FlexRow justify="flex-end" gap={8}>
                <Btn variant="secondary" onClick={() => { setShowMO(false); resetMoForm() }}>Cancel</Btn>
                <Btn disabled={!mo.buyerId || !mo.orderName.trim() || moSaving} onClick={async () => {
                  const moId = genMoId()
                  if (!moId) return
                  setMoErr('')
                  setMoSaving(true)
                  try {
                    await createMasterOrder({ id: moId, buyerId: mo.buyerId, orderName: mo.orderName.trim(), season: mo.season })
                    // Upload attached file as PO/RFQ linked to this master order
                    if (moFile) {
                      try {
                        await uploadDoc({
                          type: 'PO', name: `PO — ${moId}`, issuer: '', issueDate: new Date().toISOString().slice(0, 10),
                          expiryDate: null, orderId: null, mfrId: null,
                          ...fileUploadPayload(moFile),
                        })
                      } catch { /* ignore upload errors */ }
                    }
                    toast(`Master Order ${moId} created`, 'success')
                    setShowMO(false)
                    resetMoForm()
                  } catch (err) {
                    setMoErr(typeof err === 'string' ? err : (err?.message || 'Failed to create master order'))
                  } finally { setMoSaving(false) }
                }}>{moSaving ? 'Creating…' : 'Create Master Order'}</Btn>
              </FlexRow>
            </div>
          </div>
        </div>
      )}

      <PageHeader title="Order Management" subtitle="Create orders, assign manufacturers, and manage the full order lifecycle" action={
        <FlexRow gap={8}>
          <Btn variant="secondary" onClick={() => setShowMO(true)} icon="📁">New Master Order</Btn>
          <Btn variant="secondary" onClick={() => setShowTnaImport(true)} icon="📊">Import TNA Dates</Btn>
          <Btn variant="secondary" onClick={() => setShowMatBulk(true)} icon="📦">Bulk Upload Materials</Btn>
          <Btn onClick={() => setShowC(true)} icon="➕">Create Order</Btn>
        </FlexRow>
      } />

      {/* List = one row per order, for day-to-day management. Matrix = styles
          across the top, TNA steps down the side, for "where does the whole
          book stand" at a glance — the shape of the Summary TNA sheet. */}
      <FlexRow gap={6} style={{ marginBottom: 14 }}>
        {[['list', '☰ List'], ['matrix', '▦ Matrix']].map(([id, label]) => (
          <button key={id} onClick={() => setView(id)}
            style={{ fontSize: 12, fontWeight: 700, padding: '6px 14px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit',
              border: `1px solid ${view === id ? T.primary : T.border}`,
              background: view === id ? T.primaryLight : T.surface,
              color: view === id ? T.primaryDark : T.textMuted }}>
            {label}
          </button>
        ))}
      </FlexRow>

      {/* ── Materials Bulk Upload Modal ── */}
      {showTnaImport && (
        <Modal title="Import TNA Dates" subtitle="Re-sync revised start/end dates from a Summary TNA sheet onto existing orders" size="xl" onClose={() => setShowTnaImport(false)}>
          <TnaImportPanel onClose={() => setShowTnaImport(false)} />
        </Modal>
      )}

      {showMatBulk && (
        <Modal title="Bulk Upload Materials" subtitle="Add materials/PO lines onto existing orders' stages, by order ID + manufacturer code + stage name" size="xl" onClose={() => setShowMatBulk(false)}>
          <MaterialsBulkUploadPanel onDone={() => setShowMatBulk(false)} />
        </Modal>
      )}

      <Card pad={false}>
        <div style={{ padding: '14px 18px', borderBottom: `1px solid ${T.border}`, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {/* Search with order-ID autocomplete */}
          {(() => {
            const sugg = q.trim().length > 0
              ? orders.filter(o =>
                  o.id.toLowerCase().includes(q.toLowerCase()) ||
                  o.product.toLowerCase().includes(q.toLowerCase())
                ).slice(0, 8)
              : []
            return (
              <div style={{ flex: 1, minWidth: 200, position: 'relative' }}>
                <input
                  value={q}
                  onChange={e => { setQ(e.target.value); setShowSugg(true) }}
                  onFocus={() => setShowSugg(true)}
                  onBlur={() => setTimeout(() => setShowSugg(false), 150)}
                  placeholder="🔍  Search by product or order ID…"
                  style={{ width: '100%', boxSizing: 'border-box', border: `1px solid ${T.border}`, borderRadius: 8, padding: '7px 12px', fontSize: 13, color: T.text, background: '#f8fafc', fontFamily: 'inherit' }}
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
            {ORDER_STATUSES.map(s => <option key={s}>{s}</option>)}
          </select>
        </div>
        {view === 'list' && (
        <div className="table-scroll">
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 700 }}>
            <thead>
              <tr style={{ background: '#f8fafc' }}>
                {[
                  { key: 'id', label: 'Order ID' },
                  { key: 'product', label: 'Product' },
                  { key: 'buyer', label: 'Buyer', sortable: true },
                  { key: 'manufacturer', label: 'Manufacturer(s)', sortable: true },
                  { key: 'qty', label: 'Qty' },
                  { key: 'status', label: 'Status' },
                  { key: 'delivery', label: 'Delivery', sortable: true },
                  { key: 'action', label: '' },
                ].map(h => (
                  <th key={h.key} onClick={h.sortable ? () => toggleSort(h.key) : undefined}
                    style={{ padding: '10px 16px', textAlign: 'left', fontSize: 10, fontWeight: 800, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.07em', whiteSpace: 'nowrap', cursor: h.sortable ? 'pointer' : 'default', userSelect: h.sortable ? 'none' : undefined }}>
                    {h.sortable ? (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 8px', borderRadius: 6, background: sortCol === h.key ? T.primaryLight : '#f1f5f9', color: sortCol === h.key ? T.primaryDark : T.textMuted, border: `1px solid ${sortCol === h.key ? '#fed7aa' : T.border}`, transition: 'all 0.15s' }}>
                        {h.label}
                        <span style={{ display: 'inline-flex', flexDirection: 'column', lineHeight: 1, fontSize: 8, gap: 0 }}>
                          <span style={{ color: sortCol === h.key && sortDir === 'asc' ? T.primaryDark : '#cbd5e1' }}>▲</span>
                          <span style={{ color: sortCol === h.key && sortDir === 'desc' ? T.primaryDark : '#cbd5e1' }}>▼</span>
                        </span>
                      </span>
                    ) : h.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groupedOrders.flatMap((g, gi) => {
                const collapsed = !expandedGroups.has(g.moId)
                const groupLabel = groupDisplayLabel(g)
                const spacerRow = gi > 0 ? (
                  <tr key={`sp-${g.moId}`} aria-hidden="true"><td colSpan={8} style={{ padding: 0, height: 12, border: 'none', background: T.bg }} /></tr>
                ) : null
                const headerRow = (
                  <tr key={`h-${g.moId}`} onClick={() => toggleGroup(g.moId)} style={{ cursor: 'pointer', background: '#f1f5f9' }}>
                    <td colSpan={8} style={{ padding: '10px 16px' }}>
                      <FlexRow gap={10}>
                        <span style={{ fontSize: 11, color: T.textMuted, transition: 'transform 0.15s', transform: collapsed ? 'rotate(-90deg)' : 'none', display: 'inline-block' }}>▾</span>
                        <span style={{ fontSize: 13, fontWeight: 800, color: T.text }}>📁 {groupLabel}</span>
                        {g.mo?.season && <span style={{ fontSize: 10, fontWeight: 700, color: '#0369a1', background: '#dbeafe', padding: '2px 7px', borderRadius: 4 }}>{g.mo.season}</span>}
                        <span style={{ fontSize: 11, color: T.textMuted, marginLeft: 'auto' }}>{g.orders.length} order{g.orders.length !== 1 ? 's' : ''}</span>
                      </FlexRow>
                    </td>
                  </tr>
                )
                if (collapsed) return [spacerRow, headerRow].filter(Boolean)
                const rows = g.orders.flatMap(o => {
                  const visibleAsgns = sfilt === 'All'
                    ? (o.assignments.length > 0 ? o.assignments : [null])
                    : o.assignments.filter(a => a.status === sfilt)
                  return visibleAsgns.map((a, ai) => (
                    <tr key={`${o.id}-${ai}`}
                      style={{ borderTop: `1px solid ${T.border}`, cursor: 'pointer' }}
                      onClick={() => onOpen(o.id, a?.mid)}
                      onMouseEnter={e => e.currentTarget.style.background = '#f8fafc'}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                    >
                      <td style={{ padding: '11px 16px' }}>
                        <Mono style={{ fontSize: 11 }}>{o.id}{a ? `-${a.sub}` : ''}</Mono>
                      </td>
                      <td style={{ padding: '11px 16px', fontWeight: 600, color: T.text, fontSize: 13 }}>
                        <FlexRow gap={10}><ProductThumb order={o} size="sm" onClick={e => { e.stopPropagation(); setEditTarget(o) }} />{o.product}</FlexRow>
                      </td>
                      <td style={{ padding: '11px 16px', color: T.textMuted, fontSize: 13 }}>{o.buyerCompany || '—'}</td>
                      <td style={{ padding: '11px 16px' }}>
                        {a ? (
                          <span style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{a.mfrCompany || '—'}</span>
                        ) : <span style={{ color: T.textMuted }}>—</span>}
                      </td>
                      <td style={{ padding: '11px 16px', color: T.textMuted, fontSize: 13 }}>{a ? a.qty?.toLocaleString() : o.totalQty?.toLocaleString()}</td>
                      <td style={{ padding: '11px 16px' }}>{a ? <Badge status={a.status} /> : '—'}</td>
                      <td style={{ padding: '11px 16px', color: T.textMuted, fontSize: 13 }}>
                        <FlexRow gap={5}>
                          {fmtDate(o.delivery)}
                          {typeof o.deliveryVarianceDays === 'number' && o.deliveryVarianceDays !== 0 && (
                            <span
                              title={`Originally promised ${fmtDate(o.baselineDelivery)}`}
                              style={{ fontSize: 10, fontWeight: 800, color: o.deliveryVarianceDays > 0 ? T.danger : T.success }}
                            >
                              {o.deliveryVarianceDays > 0 ? '+' : ''}{o.deliveryVarianceDays}d
                            </span>
                          )}
                        </FlexRow>
                      </td>
                      <td style={{ padding: '11px 16px' }}>
                        <FlexRow gap={6}>
                          <Btn size="sm" onClick={(e) => { e.stopPropagation(); onOpen(o.id, a?.mid) }}>Manage →</Btn>
                          <Btn size="sm" variant="secondary" onClick={(e) => { e.stopPropagation(); setEditTarget(o) }}>Edit</Btn>
                          <button
                            onClick={(e) => { e.stopPropagation(); setDeleteTarget(o) }}
                            style={{ padding: '4px 10px', fontSize: 11, fontWeight: 700, borderRadius: 6, border: `1px solid ${T.dangerBorder}`, background: T.dangerBg, color: T.danger, cursor: 'pointer', fontFamily: 'inherit' }}
                          >Delete</button>
                        </FlexRow>
                      </td>
                    </tr>
                  ))
                })
                return [spacerRow, headerRow, ...rows].filter(Boolean)
              })}
              {filtered.length === 0 && <tr><td colSpan={8}><EmptyState icon="📦" title="No orders" desc="Create your first order above" /></td></tr>}
            </tbody>
          </table>
        </div>
        )}

        {view === 'matrix' && (
          // No standalone legend here — it's the one thing List doesn't have,
          // so it made switching views feel like landing on a different page.
          // Each cell's state is still named in its hover tooltip; the color
          // is a glanceable summary of exactly that.
          <div style={{ padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>

            {groupedOrders.length === 0 && <EmptyState icon="📦" title="No orders" desc="Create your first order above" />}

            {groupedOrders.map(g => {
              // Earliest delivery first — the style due soonest is the one that
              // most needs eyes, so it belongs leftmost, not wherever it happened
              // to land in creation order.
              const entries = g.orders.flatMap(o => (o.assignments || []).map(a => ({ order: o, asgn: a })))
                .sort((x, y) => {
                  const dx = x.order.delivery ? new Date(x.order.delivery).getTime() : Infinity
                  const dy = y.order.delivery ? new Date(y.order.delivery).getTime() : Infinity
                  return dx - dy
                })
              if (entries.length === 0) return null
              const spine = buildMatrixSpine(entries)
              const groupLabel = groupDisplayLabel(g)
              const isOpen = expandedGroups.has(g.moId)
              return (
                <div key={g.moId} style={{ border: `1px solid ${T.border}`, borderRadius: 10, overflow: 'hidden' }}>
                  <FlexRow gap={10} onClick={() => toggleGroup(g.moId)}
                    style={{ padding: '9px 14px', background: '#f1f5f9', cursor: 'pointer' }}>
                    <span style={{ fontSize: 11, color: T.textMuted, transform: isOpen ? 'none' : 'rotate(-90deg)', display: 'inline-block' }}>▾</span>
                    <span style={{ fontSize: 13, fontWeight: 800, color: T.text }}>📁 {groupLabel}</span>
                    {g.mo?.season && <span style={{ fontSize: 10, fontWeight: 700, color: '#0369a1', background: '#dbeafe', padding: '1px 7px', borderRadius: 4 }}>{g.mo.season}</span>}
                    <span style={{ fontSize: 11, color: T.textMuted, marginLeft: 'auto' }}>{entries.length} style{entries.length !== 1 ? 's' : ''} · {spine.length} steps</span>
                  </FlexRow>

                  {isOpen && (
                    <div className="table-scroll">
                      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 340 + entries.length * 150 }}>
                        <thead>
                          <tr style={{ background: '#f8fafc' }}>
                            <th style={{ padding: '9px 14px', textAlign: 'left', fontSize: 10, fontWeight: 800, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.07em', position: 'sticky', left: 0, zIndex: 2, background: '#f8fafc', minWidth: 220 }}>
                              Step
                            </th>
                            {entries.map(({ order, asgn }) => (
                              <th key={`${order.id}-${asgn.mid}`} onClick={() => onOpen(order.id, asgn.mid)}
                                title={`${order.product} — ${order.id}`}
                                style={{ padding: '9px 10px', textAlign: 'left', minWidth: 150, cursor: 'pointer', borderLeft: `1px solid ${T.border}` }}>
                                <FlexRow gap={6}>
                                  <ProductThumb order={order} size="sm" />
                                  <div style={{ minWidth: 0 }}>
                                    <div style={{ fontSize: 11, fontWeight: 700, color: T.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 110 }}>
                                      {order.product}
                                    </div>
                                    <Mono style={{ fontSize: 9 }}>{asgn.qty?.toLocaleString()} pcs</Mono>
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
                                  const stageIdx = (asgn.stages || []).findIndex(s => s.name.trim().toLowerCase() === key)
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
                                    `${step} — ${st.label}`,
                                    `Start: ${fmtStageDate(stage.startDate)}`,
                                    `Planned: ${fmtStageDate(stage.baselineEta)}  →  Revised: ${stage.eta && stage.eta === stage.baselineEta ? 'NA' : fmtStageDate(stage.eta)}${planVariance != null && planVariance !== 0 ? `  (${planVariance > 0 ? '+' : ''}${planVariance}d)` : ''}`,
                                    `Actual: ${fmtStageDate(stage.actualEnd)}${actualVariance != null && actualVariance !== 0 ? `  (${actualVariance > 0 ? '+' : ''}${actualVariance}d vs plan)` : ''}`,
                                    `Progress: ${stageProgressLabel(stage)}`,
                                    stage.blockedReason ? `Blocked: ${stage.blockedReason}` : null,
                                  ].filter(Boolean) : null
                                  return (
                                    <td key={`${order.id}-${asgn.mid}`} onClick={() => stage && setQuickStage({ orderId: order.id, mfrId: asgn.mid, stageIndex: stageIdx })}
                                      onMouseEnter={e => tipLines && showMatrixTip(e.clientX, e.clientY, tipLines)}
                                      onMouseMove={e => tipLines && setMatrixTip(tip => tip && { ...tip, x: e.clientX, y: e.clientY })}
                                      onMouseLeave={hideMatrixTip}
                                      style={{ padding: '5px 8px', borderLeft: `1px solid ${T.border}`, cursor: stage ? 'pointer' : 'default', verticalAlign: 'top' }}>
                                      {!stage ? (
                                        <span style={{ fontSize: 11, color: '#cbd5e1' }}>NA</span>
                                      ) : (
                                        <div style={{ background: st.bg, borderRadius: 5, padding: '4px 7px' }}>
                                          {/* The date is what answers "where are things" — primary and
                                              legible. Units/percent are secondary, kept small below;
                                              raw counts aren't shown at all (only on hover). */}
                                          <FlexRow gap={5} style={{ justifyContent: 'space-between' }}>
                                            <span style={{ fontSize: 12, fontWeight: 800, color: st.fg, whiteSpace: 'nowrap', fontFamily: "'JetBrains Mono',monospace" }}>
                                              {state === 'done' ? '✓ ' : state === 'blocked' ? '⛔ ' : state === 'overdue' ? '! ' : ''}{fmtStageDate(done ? stage.actualEnd : stage.eta)}
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
        )}
      </Card>

      {/* Custom matrix-cell tooltip — position: fixed so it's never clipped by
          the scrolling table, and pointer-events: none so it can't itself
          become the mouseleave target. */}
      {matrixTip && (
        <div style={{
          position: 'fixed', left: matrixTip.x + 14, top: matrixTip.y + 16, zIndex: 1000,
          pointerEvents: 'none', background: '#1e293b', color: '#f1f5f9', borderRadius: 8,
          padding: '8px 12px', fontSize: 11, lineHeight: 1.6, whiteSpace: 'pre',
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
