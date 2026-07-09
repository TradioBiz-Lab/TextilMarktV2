import { useState, useMemo } from 'react'
import { T, ORDER_STATUSES, STAGE_DOC_MAP, DOC_ICONS } from '../../constants.js'
import { Modal, Select, Textarea, Btn, Card, Badge, Alert, FlexRow, Mono, Input, Tabs, StageTimeline, FileUpload, DocCard, SectionLabel, LoadingScreen, MfrProfileLink, StageDocGroup, EmptyState, useToast, dataUrlToBlobUrl, fileUploadPayload } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'
import { ordersApi } from '../../api.js'
import { EditOrderModal } from './EditOrderModal.jsx'
import { DeleteOrderModal } from './DeleteOrderModal.jsx'

function fmtDate(d) {
  if (!d) return '—'
  const dt = new Date(d)
  const dd = String(dt.getDate()).padStart(2, '0')
  const mm = String(dt.getMonth() + 1).padStart(2, '0')
  return `${dd}-${mm}-${dt.getFullYear()}`
}

export function AdminOrderDetail({ orderId, initialMid, onBack }) {
  const { orders, docs, users, loading, updateAssignment, updateStage, uploadDoc, getDocData, refreshOrders, editOrder, deleteOrder } = useApp()
  const toast = useToast()

  const [showEdit, setShowEdit] = useState(false)
  const [showDelete, setShowDelete] = useState(false)

  const [tab, setTab] = useState('production')
  const [viewerBlob, setViewerBlob] = useState(null)
  const [viewerName, setViewerName] = useState('')
  const [viewerLoading, setViewerLoading] = useState(false)
  const closeViewer = () => { if (viewerBlob) { viewerBlob.revoke(); setViewerBlob(null) }; setViewerLoading(false) }

  // Status override modal
  const [showSt, setShowSt] = useState(false)
  const [stTarget, setStTarget] = useState(null) // mfrId
  const [stStatus, setStStatus] = useState('')
  const [stNote, setStNote] = useState('')

  // Stage override modal
  const [showStage, setShowStage] = useState(false)
  const [sgTarget, setSgTarget] = useState(null) // mfrId
  const [sgIndex, setSgIndex] = useState(0)
  const [sgUnits, setSgUnits] = useState('')
  const [sgNote, setSgNote] = useState('')

  // Stage dates (start/end) adjustment modal
  const [showEta, setShowEta] = useState(false)
  const [etaTarget, setEtaTarget] = useState(null) // mfrId
  const [etaValues, setEtaValues] = useState([]) // array of end-date strings
  const [startValues, setStartValues] = useState([]) // array of start-date strings

  // Doc upload modal
  const [showUp, setShowUp] = useState(false)
  const [uf, setUf] = useState({ type: 'PO', name: '', issuer: 'Tradio', issueDate: new Date().toISOString().slice(0, 10), expiryDate: '' })
  const [fileData, setFileData] = useState(null)
  const [fileErr, setFileErr] = useState('')

  // Stage doc upload modal
  const [showStageDocs, setShowStageDocs] = useState(false)
  const [sdMfrId, setSdMfrId] = useState(null)
  const [sdStageIdx, setSdStageIdx] = useState(0)
  const [sdItems, setSdItems] = useState([{ type: '', name: '', file: null, notes: '', fileErr: '' }])
  const [sdErr, setSdErr] = useState('')

  const [saving, setSaving] = useState(false)
  const [selectedMid, setSelectedMid] = useState(initialMid || null)

  const order = (orders || []).find(o => o.id === orderId)

  const currentStageData = useMemo(() => {
    if (!sgTarget || !order) return null
    const asgn = order.assignments.find(a => String(a.mid) === String(sgTarget))
    return asgn?.stages?.[sgIndex] || null
  }, [order, sgTarget, sgIndex])

  if (loading) return <LoadingScreen />
  if (!order) return null

  const effectiveMid = selectedMid || (order.assignments?.length === 1 ? String(order.assignments[0]?.mid) : null)
  const selectedAsgn = order.assignments?.find(a => String(a.mid) === effectiveMid) || null

  const orderDocs = docs.filter(d => String(d.orderId) === String(order.id) && d.isActive !== false)
  const mfrDocs = docs.filter(d => d.mfrId && d.stageIndex == null && (order.assignments || []).some(a => String(a.mid) === String(d.mfrId)) && d.isActive !== false)
  const txnDocs = effectiveMid
    ? orderDocs.filter(d => d.stageIndex == null || String(d.mfrId || '') === effectiveMid)
    : orderDocs
  const stageDocs = effectiveMid
    ? orderDocs.filter(d => d.stageIndex != null && String(d.mfrId || '') === effectiveMid)
    : []

  const resetUpload = () => { setUf({ type: 'PO', name: '', issuer: 'Tradio', issueDate: new Date().toISOString().slice(0, 10), expiryDate: '' }); setFileData(null); setFileErr('') }

  // ── Stage Dates Adjustment ──
  const dateToInput = d => d === 'NA' ? 'NA' : (d ? new Date(d).toISOString().slice(0, 10) : '')

  const openEtaAdjust = (mfrId) => {
    const asgn = order.assignments.find(a => String(a.mid) === String(mfrId))
    setEtaTarget(mfrId)
    setStartValues((asgn?.stages || []).map(s => dateToInput(s.startDate)))
    setEtaValues((asgn?.stages || []).map(s => dateToInput(s.eta)))
    setShowEta(true)
  }

  const submitEtaAdjust = async () => {
    setSaving(true)
    try {
      const asgn = order.assignments.find(a => String(a.mid) === String(etaTarget))
      const stageCount = asgn?.stages?.length || 0
      let changed = false
      for (let i = 0; i < stageCount; i++) {
        const stage = asgn?.stages?.[i]
        const oldStart = dateToInput(stage?.startDate)
        const oldEta = dateToInput(stage?.eta)
        const startChanged = startValues[i] !== oldStart
        const etaChanged = etaValues[i] !== oldEta
        if (startChanged || etaChanged) {
          const dates = {}
          if (startChanged) dates.startDate = startValues[i] === 'NA' ? 'NA' : startValues[i] || null
          if (etaChanged) dates.eta = etaValues[i] === 'NA' ? 'NA' : etaValues[i] || null
          await ordersApi.updateStageDates(order.id, etaTarget, i, dates)
          changed = true
        }
      }
      if (changed) {
        await refreshOrders()
        toast('Stage dates updated successfully', 'success')
      } else {
        toast('No date changes to save', 'info')
      }
      setShowEta(false)
    } catch (err) {
      toast(err?.message || 'Failed to update stage dates', 'error')
    } finally { setSaving(false) }
  }

  // ── Status Override ──
  const openStatusOverride = (mfrId, currentStatus) => {
    setStTarget(mfrId)
    setStStatus(currentStatus)
    setStNote('')
    setShowSt(true)
  }

  const submitStatusOverride = async () => {
    if (!stNote.trim()) return
    setSaving(true)
    try {
      await updateAssignment(order.id, stTarget, stStatus, `[Admin Override] ${stNote}`)
      toast(`Status updated to "${stStatus}"`, 'success')
      setShowSt(false)
    } catch {
      toast('Failed to update status', 'error')
    } finally { setSaving(false) }
  }

  // ── Stage Override ──
  const openStageOverride = (mfrId) => {
    const asgn = order.assignments.find(a => String(a.mid) === String(mfrId))
    setSgTarget(mfrId)
    setSgIndex(0)
    setSgUnits(asgn?.stages?.[0]?.unitsDone?.toString() || '0')
    setSgNote('')
    setShowStage(true)
  }

  const submitStageOverride = async () => {
    if (!sgNote.trim()) return
    setSaving(true)
    try {
      const units = parseInt(sgUnits) || 0
      await updateStage(order.id, sgTarget, sgIndex, {
        unitsDone: units,
        note: `[Admin Override] ${sgNote}`,
      })
      toast('Stage progress updated', 'success')
      setShowStage(false)
    } catch {
      toast('Failed to update stage', 'error')
    } finally { setSaving(false) }
  }

  // ── Doc Upload ──
  const submitDoc = async () => {
    if (!fileData) { setFileErr('Please select a file.'); return }
    setSaving(true)
    try {
      await uploadDoc({ ...uf, expiryDate: uf.expiryDate || null, orderId: order.id, mfrId: null, ...fileUploadPayload(fileData) })
      toast('Document uploaded', 'success')
      setShowUp(false); resetUpload()
    } catch {
      toast('Failed to upload document', 'error')
    } finally { setSaving(false) }
  }

  // ── Stage Doc Upload ──
  const openStageDocUpload = (mfrId, stageIdx) => {
    const types = STAGE_DOC_MAP[stageIdx] || []
    setSdMfrId(mfrId)
    setSdStageIdx(stageIdx)
    setSdItems([{ type: types[0]?.v || '', name: '', file: null, notes: '', fileErr: '' }])
    setSdErr('')
    setShowStageDocs(true)
  }

  const updateSdItem = (idx, patch) => setSdItems(prev => prev.map((item, i) => i === idx ? { ...item, ...patch } : item))

  const addSdItem = () => {
    const types = STAGE_DOC_MAP[sdStageIdx] || []
    setSdItems(prev => [...prev, { type: types[0]?.v || '', name: '', file: null, notes: '', fileErr: '' }])
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
          orderId: order.id, mfrId: sdMfrId, stageIndex: sdStageIdx,
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

  const orderDocTypes = [
    { v: 'PO', l: 'Purchase Order' }, { v: 'buyer_order', l: 'Buyer Order' },
    { v: 'tech_pack', l: 'Tech Pack' },
    { v: 'cost_sheet', l: 'Cost Sheet' }, { v: 'RFQ', l: 'RFQ' },
    { v: 'terms', l: 'Terms & Conditions' },
  ]

  const overallStatus = () => {
    if (order.assignments.some(a => a.status === 'Delayed')) return 'Delayed'
    if (order.assignments.some(a => a.status === 'On Hold')) return 'On Hold'
    if (order.assignments.every(a => a.status === 'Delivered')) return 'Delivered'
    return 'Processing'
  }

  // ── Assignment picker ──
  if (!effectiveMid && order.assignments?.length > 1) {
    return (
      <div>
        <FlexRow style={{ marginBottom: 20 }} gap={12}>
          <Btn variant="secondary" size="sm" onClick={onBack} icon="←">Back</Btn>
          <div style={{ flex: 1 }}>
            <FlexRow gap={10}>
              <Mono style={{ fontSize: 15 }}>{order.id}</Mono>
              <Badge status={overallStatus()} />
            </FlexRow>
            <div style={{ fontSize: 13, color: T.textMuted, marginTop: 3 }}>
              {order.product} · {order.buyerCompany || '—'} · {order.totalQty?.toLocaleString()} pcs · Due {fmtDate(order.delivery)}
            </div>
          </div>
          <Btn variant="secondary" onClick={() => setShowUp(true)} icon="📎">Upload Document</Btn>
        </FlexRow>
        <div style={{ marginBottom: 12, fontSize: 13, fontWeight: 600, color: T.textMuted }}>Select a manufacturer to manage that transaction:</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {order.assignments.map(a => {
            const stages = a.stages || []
            const totalDone = stages.reduce((s, st) => s + (st.unitsDone || 0), 0)
            const totalAll = stages.reduce((s, st) => s + (st.totalUnits || 0), 0)
            const pct = totalAll > 0 ? Math.round((totalDone / totalAll) * 100) : 0
            const completedStages = stages.filter(s => s.unitsDone >= s.totalUnits && s.totalUnits > 0).length
            const stageCnt = orderDocs.filter(d => d.stageIndex != null && String(d.mfrId || '') === String(a.mid)).length
            return (
              <div key={a.mid}
                onClick={() => setSelectedMid(String(a.mid))}
                style={{ border: `1px solid ${a.status === 'Delayed' ? T.dangerBorder : a.status === 'On Hold' ? T.warningBorder : T.border}`, borderRadius: 12, padding: '16px 18px', cursor: 'pointer', background: a.status === 'Delayed' ? '#fff8f8' : a.status === 'On Hold' ? '#fefdf5' : T.surface, transition: 'all 0.15s' }}
                onMouseEnter={e => e.currentTarget.style.opacity = '0.85'}
                onMouseLeave={e => e.currentTarget.style.opacity = '1'}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                  <MfrProfileLink mfrId={a.mid} mfrName={a.mfrCompany || '—'} docs={docs} onGetData={getDocData} />
                  <span style={{ fontSize: 10, color: T.textLight, background: '#f1f5f9', padding: '1px 6px', borderRadius: 4 }}>{a.sub}</span>
                  <Badge status={a.status} />
                  <span style={{ marginLeft: 'auto', fontSize: 12, color: T.textMuted }}>{a.qty?.toLocaleString()} pcs</span>
                </div>
                <div style={{ height: 6, background: '#f1f5f9', borderRadius: 4, overflow: 'hidden', marginBottom: 6 }}>
                  <div style={{ height: 6, background: pct >= 100 ? T.success : T.primary, borderRadius: 4, width: `${pct}%`, transition: 'width 0.3s' }} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: T.textMuted }}>
                  <span>{pct}% · {completedStages}/{stages.length} stages</span>
                  {stageCnt > 0 && <span style={{ color: '#1d4ed8' }}>{stageCnt} stage evidence file{stageCnt !== 1 ? 's' : ''}</span>}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  const tabs = [
    { id: 'production', label: `Production` },
    { id: 'documents', label: `Documents (${txnDocs.filter(d => d.stageIndex == null).length})` },
    { id: 'stage_evidence', label: `🖼 Stage Evidence (${stageDocs.length})` },
    { id: 'compliance', label: `Compliance (${mfrDocs.length})` },
    { id: 'info', label: 'Order Info' },
  ]

  return (
    <div>
      {/* ── Edit Order Modal ── */}
      {showEdit && (
        <EditOrderModal
          order={order}
          onClose={() => setShowEdit(false)}
          onSave={async (id, data) => {
            await editOrder(id, data)
            toast(`Order ${id} updated`, 'success')
            setShowEdit(false)
          }}
        />
      )}

      {/* ── Delete Order Modal ── */}
      {showDelete && (
        <DeleteOrderModal
          order={order}
          onClose={() => setShowDelete(false)}
          onConfirm={async (id) => {
            await deleteOrder(id)
            toast(`Order ${id} deleted`, 'success')
            setShowDelete(false)
            onBack()
          }}
        />
      )}

      {/* ── Status Override Modal ── */}
      {showSt && stTarget && (
        <Modal title="Override Assignment Status" subtitle="Admin override — permanently logged in audit trail" onClose={() => setShowSt(false)}>
          <Alert type="warning" style={{ marginBottom: 14 }}>All admin overrides are permanently logged with your name and timestamp.</Alert>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Select label="New Status" value={stStatus} onChange={e => setStStatus(e.target.value)}>
              {ORDER_STATUSES.map(s => <option key={s}>{s}</option>)}
            </Select>
            <Textarea label="Reason for Override *" value={stNote} onChange={e => setStNote(e.target.value)} placeholder="Explain why this override is needed…" />
            <FlexRow justify="flex-end" gap={8}>
              <Btn variant="secondary" onClick={() => setShowSt(false)}>Cancel</Btn>
              <Btn disabled={!stNote.trim() || saving} onClick={submitStatusOverride}>{saving ? 'Saving…' : 'Override Status'}</Btn>
            </FlexRow>
          </div>
        </Modal>
      )}

      {/* ── Stage Override Modal ── */}
      {showStage && sgTarget && (
        <Modal title="Override Production Stage" subtitle="Admin can progress or regress any stage — logged as admin override" size="lg" onClose={() => setShowStage(false)}>
          <Alert type="warning" style={{ marginBottom: 14 }}>Stage overrides are logged in the audit trail. A mandatory comment is required.</Alert>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Select label="Stage" value={sgIndex} onChange={e => {
              const idx = parseInt(e.target.value)
              setSgIndex(idx)
              const asgn = order.assignments.find(a => String(a.mid) === String(sgTarget))
              setSgUnits(asgn?.stages?.[idx]?.unitsDone?.toString() || '0')
            }}>
              {(order.assignments.find(a => String(a.mid) === String(sgTarget))?.stages || []).map((s, i) => <option key={i} value={i}>{i + 1}. {s.name}</option>)}
            </Select>

            {currentStageData && (
              <div style={{ background: '#f8fafc', borderRadius: 10, border: `1px solid ${T.border}`, padding: '14px 16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{currentStageData.name}</span>
                  <span style={{ fontSize: 12, color: T.textMuted }}>
                    Current: {currentStageData.unitsDone} / {currentStageData.totalUnits} units
                  </span>
                </div>
                <div style={{ height: 6, background: '#e2e8f0', borderRadius: 3, overflow: 'hidden', marginBottom: 6 }}>
                  <div style={{ height: 6, background: T.primary, borderRadius: 3, width: `${currentStageData.totalUnits > 0 ? (currentStageData.unitsDone / currentStageData.totalUnits) * 100 : 0}%`, transition: 'width 0.3s' }} />
                </div>
                {currentStageData.startDate && currentStageData.startDate !== 'NA' && (
                  <div style={{ fontSize: 11, color: T.textMuted }}>Start: {fmtDate(currentStageData.startDate)}</div>
                )}
                {currentStageData.eta && currentStageData.eta !== 'NA' && (
                  <div style={{ fontSize: 11, color: T.textMuted }}>ETA: {fmtDate(currentStageData.eta)}</div>
                )}
                {currentStageData.note && (
                  <div style={{ fontSize: 11, color: T.textMuted, marginTop: 4 }}>Last note: {currentStageData.note}</div>
                )}
              </div>
            )}

            <Input
              label={`Set Units Done (max ${currentStageData?.totalUnits || 0})`}
              type="number"
              value={sgUnits}
              onChange={e => setSgUnits(e.target.value)}
              placeholder="0"
            />

            {/* Preview progress bar */}
            {currentStageData && (
              <div>
                <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 4 }}>Preview: {sgUnits || 0} / {currentStageData.totalUnits} units ({currentStageData.totalUnits > 0 ? Math.round(((parseInt(sgUnits) || 0) / currentStageData.totalUnits) * 100) : 0}%)</div>
                <div style={{ height: 6, background: '#e2e8f0', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ height: 6, background: T.success, borderRadius: 3, width: `${currentStageData.totalUnits > 0 ? Math.min(100, ((parseInt(sgUnits) || 0) / currentStageData.totalUnits) * 100) : 0}%`, transition: 'width 0.3s' }} />
                </div>
              </div>
            )}

            <Textarea label="Reason for Override *" value={sgNote} onChange={e => setSgNote(e.target.value)} placeholder="Explain why this stage override is needed…" />

            <Alert type="info">
              Updating a stage will automatically reset all subsequent stages to 0 (sequential production model).
            </Alert>

            <FlexRow justify="flex-end" gap={8}>
              <Btn variant="secondary" onClick={() => setShowStage(false)}>Cancel</Btn>
              <Btn disabled={!sgNote.trim() || saving} onClick={submitStageOverride}>{saving ? 'Saving…' : 'Override Stage'}</Btn>
            </FlexRow>
          </div>
        </Modal>
      )}

      {/* ── Stage Dates Adjustment Modal ── */}
      {showEta && etaTarget && (
        <Modal title="Adjust Stage Dates" subtitle="Update planned start and end dates for each production stage" size="lg" onClose={() => setShowEta(false)}>
          <Alert type="info" style={{ marginBottom: 14 }}>Adjust dates for delayed stages. Changes are logged in the audit trail.</Alert>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ background: '#f8fafc', borderRadius: 10, border: `1px solid ${T.border}`, padding: '12px 14px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {(order.assignments.find(a => String(a.mid) === String(etaTarget))?.stages || []).map((s, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: T.text, minWidth: 110 }}>{i + 1}. {s.name}</span>
                    <input
                      type={startValues[i] === 'NA' ? 'text' : 'date'}
                      value={startValues[i]}
                      onChange={e => setStartValues(prev => prev.map((v, j) => j === i ? e.target.value : v))}
                      placeholder="NA or start date"
                      style={{ flex: 1, border: `1px solid ${T.border}`, borderRadius: 6, padding: '5px 8px', fontSize: 12, fontFamily: 'inherit', color: startValues[i] === 'NA' ? T.textLight : T.text }}
                    />
                    <input
                      type={etaValues[i] === 'NA' ? 'text' : 'date'}
                      value={etaValues[i]}
                      onChange={e => setEtaValues(prev => prev.map((v, j) => j === i ? e.target.value : v))}
                      placeholder="NA or end date"
                      style={{ flex: 1, border: `1px solid ${T.border}`, borderRadius: 6, padding: '5px 8px', fontSize: 12, fontFamily: 'inherit', color: etaValues[i] === 'NA' ? T.textLight : T.text }}
                    />
                  </div>
                ))}
              </div>
            </div>
            <FlexRow justify="flex-end" gap={8}>
              <Btn variant="secondary" onClick={() => setShowEta(false)}>Cancel</Btn>
              <Btn disabled={saving} onClick={submitEtaAdjust}>{saving ? 'Saving…' : 'Update Dates'}</Btn>
            </FlexRow>
          </div>
        </Modal>
      )}

      {/* ── Doc Upload Modal ── */}
      {showUp && (
        <Modal title="Upload Order Document" onClose={() => { setShowUp(false); resetUpload() }} size="lg">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div className="form-grid-2">
              <Select label="Document Type" value={uf.type} onChange={e => setUf({ ...uf, type: e.target.value })}>
                {orderDocTypes.map(t => <option key={t.v} value={t.v}>{t.l}</option>)}
              </Select>
              <Input label="Document Name" value={uf.name} onChange={e => setUf({ ...uf, name: e.target.value })} placeholder="Document title" />
            </div>
            <Input label="Issuing Authority" value={uf.issuer} onChange={e => setUf({ ...uf, issuer: e.target.value })} />
            <div className="form-grid-2">
              <Input label="Issue Date" type="date" value={uf.issueDate} onChange={e => setUf({ ...uf, issueDate: e.target.value })} />
              <Input label="Expiry Date (optional)" type="date" value={uf.expiryDate} onChange={e => setUf({ ...uf, expiryDate: e.target.value })} />
            </div>
            <Alert type="info">Document will be visible to the buyer and all assigned manufacturers.</Alert>
            <FileUpload file={fileData} onFile={f => { setFileData(f); setFileErr('') }} error={fileErr} onError={setFileErr} />
            <FlexRow justify="flex-end" gap={8}>
              <Btn variant="secondary" onClick={() => { setShowUp(false); resetUpload() }}>Cancel</Btn>
              <Btn disabled={!uf.name || !fileData || saving} onClick={submitDoc}>{saving ? 'Uploading…' : 'Upload Document'}</Btn>
            </FlexRow>
          </div>
        </Modal>
      )}

      {/* ── Stage Doc Upload Modal ── */}
      {showStageDocs && sdMfrId && (
        <Modal title="Upload Stage Evidence" subtitle={`${(order.assignments.find(a => String(a.mid) === String(sdMfrId))?.stages?.[sdStageIdx]?.name) || `Stage ${sdStageIdx + 1}`} — Evidence Documents`} onClose={() => setShowStageDocs(false)} size="lg">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <Alert type="info">
              Linked to the {(order.assignments.find(a => String(a.mid) === String(sdMfrId))?.stages?.[sdStageIdx]?.name) || `Stage ${sdStageIdx + 1}`} stage. Attach a file/link, or add SOP notes only — either is sufficient.
            </Alert>
            {sdItems.map((item, idx) => (
              <div key={idx} style={{ border: `1px solid ${T.border}`, borderRadius: 10, padding: '14px 16px', background: '#f8fafc', position: 'relative' }}>
                {sdItems.length > 1 && (
                  <button onClick={() => removeSdItem(idx)} style={{ position: 'absolute', top: 10, right: 10, background: '#fee2e2', border: 'none', borderRadius: 6, cursor: 'pointer', width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, color: T.danger }}>×</button>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div className="form-grid-2">
                    <Select label="Document Type" value={item.type} onChange={e => updateSdItem(idx, { type: e.target.value })}>
                      {(STAGE_DOC_MAP[sdStageIdx] || []).map(t => <option key={t.v} value={t.v}>{t.l}</option>)}
                    </Select>
                    <Input label="Document Name *" value={item.name} onChange={e => updateSdItem(idx, { name: e.target.value, fileErr: '' })} placeholder={`e.g. ${(order.assignments.find(a => String(a.mid) === String(sdMfrId))?.stages?.[sdStageIdx]?.name) || `Stage ${sdStageIdx + 1}`} GRN - Batch ${idx + 1}`} />
                  </div>
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

      {/* ── Inline document viewer ── */}
      {(viewerBlob || viewerLoading) && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.75)', zIndex: 2000, display: 'flex', flexDirection: 'column' }}
          onClick={e => e.target === e.currentTarget && closeViewer()}>
          <div style={{ height: 48, background: '#0f172a', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 16px', flexShrink: 0, gap: 12 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{viewerName}</span>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {viewerBlob && (
                <button onClick={() => { const a = document.createElement('a'); a.href = viewerBlob.url; a.download = viewerName; a.click() }}
                  style={{ background: '#1e293b', border: '1px solid #334155', color: '#e2e8f0', borderRadius: 7, padding: '0 12px', height: 32, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>⬇ Download</button>
              )}
              <button onClick={closeViewer}
                style={{ background: '#ef4444', border: 'none', color: '#fff', borderRadius: 7, width: 32, height: 32, fontSize: 18, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'inherit' }}>×</button>
            </div>
          </div>
          {viewerLoading && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, background: '#0f172a' }}>
              <div style={{ width: 40, height: 40, border: '3px solid #334155', borderTopColor: '#f97316', borderRadius: '50%', animation: 'tradio-spin 0.7s linear infinite' }} />
              <div style={{ fontSize: 13, fontWeight: 600, color: '#94a3b8' }}>Loading document…</div>
            </div>
          )}
          {viewerBlob && (
            viewerBlob.mimeType?.startsWith('image/') ? (
              <div style={{ flex: 1, overflow: 'auto', display: viewerLoading ? 'none' : 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
                <img src={viewerBlob.url} alt={viewerName} onLoad={() => setViewerLoading(false)} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
              </div>
            ) : (
              <iframe src={viewerBlob.url} title={viewerName}
                sandbox="allow-scripts allow-popups"
                referrerPolicy="no-referrer"
                onLoad={() => setViewerLoading(false)}
                style={{ flex: 1, border: 'none', width: '100%', minHeight: 0, display: viewerLoading ? 'none' : 'block' }} />
            )
          )}
        </div>
      )}

      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <Btn variant="secondary" size="sm" onClick={onBack} icon="←">Back</Btn>
        <div style={{ flex: 1, minWidth: 0 }}>
          <FlexRow gap={10} style={{ flexWrap: 'wrap' }}>
            <Mono style={{ fontSize: 15 }}>{order.id}</Mono>
            <Badge status={overallStatus()} />
          </FlexRow>
          <div style={{ fontSize: 13, color: T.textMuted, marginTop: 3 }}>
            {order.product} · {order.buyerCompany || '—'} · {order.totalQty?.toLocaleString()} pcs · Due {fmtDate(order.delivery)}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', flexShrink: 0 }}>
          {order.assignments?.length > 1 && (
            <Btn variant="secondary" size="sm" onClick={() => setSelectedMid(null)}>⇄ Change Mfr</Btn>
          )}
          <Btn variant="secondary" onClick={() => setShowUp(true)} icon="📎">Upload Document</Btn>
          <Btn variant="secondary" onClick={() => setShowEdit(true)} icon="✏️">Edit Order</Btn>
          <button
            onClick={() => setShowDelete(true)}
            style={{ padding: '8px 14px', fontSize: 12, fontWeight: 700, borderRadius: 8, border: `1px solid ${T.dangerBorder}`, background: T.dangerBg, color: T.danger, cursor: 'pointer', fontFamily: 'inherit' }}
          >Delete Order</button>
        </div>
      </div>

      {/* ── Tabs ── */}
      <Card pad={false}>
        <Tabs tabs={tabs} active={tab} onChange={setTab} />
        <div style={{ padding: '20px 22px' }}>

          {/* ── Production Tab ── */}
          {tab === 'production' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {order.assignments.filter(a => !effectiveMid || String(a.mid) === effectiveMid).map(a => {
                const stages = a.stages || []
                const completedStages = stages.filter(s => s.totalUnits > 0 && s.unitsDone >= s.totalUnits).length
                const overallPct = stages.length > 0
                  ? Math.round(stages.reduce((sum, s) => sum + (s.totalUnits > 0 ? (s.unitsDone / s.totalUnits) * 100 : 0), 0) / stages.length)
                  : 0

                return (
                  <div key={a.sub} style={{ border: `1px solid ${a.status === 'Delayed' ? T.dangerBorder : a.status === 'On Hold' ? T.warningBorder : T.border}`, borderRadius: 12, overflow: 'hidden', background: a.status === 'Delayed' ? '#fff8f8' : a.status === 'On Hold' ? '#fefdf5' : T.surface }}>
                    {/* Assignment header */}
                    <div style={{ padding: '12px 16px', borderBottom: `1px solid ${T.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 10 }}>
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>
                          <MfrProfileLink mfrId={a.mid} mfrName={a.mfrCompany || '—'} docs={docs} onGetData={getDocData} />
                          <span style={{ color: T.textLight, fontSize: 12 }}> ({a.sub})</span>
                        </div>
                        <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>
                          {a.qty?.toLocaleString()} pcs · Updated {fmtDate(a.updatedAt)}
                        </div>
                      </div>
                      <FlexRow gap={8}>
                        <Badge status={a.status} />
                        <Btn size="sm" variant="warning" onClick={() => openStatusOverride(a.mid, a.status)}>✏️ Status</Btn>
                        <Btn size="sm" variant="outline" onClick={() => openStageOverride(a.mid)}>⚙️ Stage</Btn>
                        <Btn size="sm" variant="secondary" onClick={() => openEtaAdjust(a.mid)}>📅 ETAs</Btn>
                      </FlexRow>
                    </div>

                    {/* Overall progress */}
                    <div style={{ padding: '12px 18px', borderBottom: `1px solid ${T.border}`, background: '#f8fafc' }}>
                      <FlexRow justify="space-between" style={{ marginBottom: 6 }}>
                        <span style={{ fontSize: 12, fontWeight: 600, color: T.text }}>Overall Progress</span>
                        <span style={{ fontSize: 12, color: T.textMuted }}>{completedStages}/{stages.length} stages · {overallPct}%</span>
                      </FlexRow>
                      <div style={{ height: 6, background: '#e2e8f0', borderRadius: 3, overflow: 'hidden' }}>
                        <div style={{ height: 6, background: overallPct === 100 ? T.success : T.primary, borderRadius: 3, width: `${overallPct}%`, transition: 'width 0.3s' }} />
                      </div>
                    </div>

                    {/* Stage timeline */}
                    <div style={{ padding: '14px 18px' }}>
                      {stages.length > 0 && <StageTimeline stages={stages} />}

                      {/* Stage detail grid with ETAs and evidence docs */}
                      <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {stages.map((s, i) => {
                          const pct = s.totalUnits > 0 ? Math.round((s.unitsDone / s.totalUnits) * 100) : 0
                          const done = pct >= 100
                          const isLate = s.eta && s.eta !== 'NA' && new Date(s.eta) < new Date() && !done
                          const etaStr = s.eta === 'NA' ? 'N/A' : s.eta ? fmtDate(s.eta) : '—'
                          const startStr = s.startDate === 'NA' ? 'N/A' : s.startDate ? fmtDate(s.startDate) : '—'
                          const stageDocs = STAGE_DOC_MAP[i] || [{ v: 'compliance_cert', l: 'Evidence Document' }]
                          const uploadedStageDocs = orderDocs.filter(d => d.stageIndex === i && String(d.mfrId || '') === String(a.mid))
                          return (
                            <div key={i} style={{ background: done ? T.successBg : isLate ? T.dangerBg : '#f8fafc', borderRadius: 8, border: `1px solid ${done ? T.successBorder : isLate ? T.dangerBorder : T.border}`, padding: '8px 12px' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <span style={{ fontSize: 11, fontWeight: 700, color: done ? T.success : isLate ? T.danger : T.text, minWidth: 110 }}>
                                  {i + 1}. {s.name}
                                </span>
                                <div style={{ flex: 1, height: 4, background: '#e2e8f0', borderRadius: 2, overflow: 'hidden' }}>
                                  <div style={{ height: 4, background: done ? T.success : isLate ? T.danger : T.primary, borderRadius: 2, width: `${pct}%` }} />
                                </div>
                                <span style={{ fontSize: 10, color: T.textMuted, minWidth: 32, textAlign: 'right' }}>{pct}%</span>
                                {isLate && <span style={{ fontSize: 8, fontWeight: 800, color: T.danger, background: T.dangerBg, padding: '1px 4px', borderRadius: 3 }}>LATE</span>}
                              </div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4, flexWrap: 'wrap' }}>
                                <span style={{ fontSize: 10, color: isLate ? T.danger : T.textMuted, fontWeight: isLate ? 700 : 400 }}>
                                  ETA: {etaStr}
                                </span>
                                <span style={{ fontSize: 10, color: T.textMuted }}>
                                  Start: {startStr}
                                </span>
                                <span style={{ fontSize: 10, color: T.textMuted }}>
                                  {s.unitsDone}/{s.totalUnits} units
                                </span>
                                {stageDocs.length > 0 && (
                                  <Btn size="sm" variant="outline" style={{ fontSize: 10, padding: '1px 6px', marginLeft: 'auto' }}
                                    onClick={() => openStageDocUpload(a.mid, i)}>
                                    📎 Upload Evidence
                                  </Btn>
                                )}
                              </div>
                              {uploadedStageDocs.length > 0 && (
                                <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                                  {uploadedStageDocs.map(d => (
                                    <span key={d.id} onClick={async () => {
                                      try {
                                        setViewerName(d.name)
                                        setViewerLoading(true)
                                        setViewerBlob(null)
                                        const data = await getDocData(d.id)
                                        if (!data?.dataUrl) { setViewerLoading(false); return }
                                        const blob = dataUrlToBlobUrl(data.dataUrl)
                                        if (!blob) { setViewerLoading(false); return }
                                        setViewerBlob(blob)
                                      } catch { setViewerLoading(false) }
                                    }} style={{ fontSize: 10, background: T.primaryLight, color: T.primaryDark, padding: '2px 8px', borderRadius: 4, cursor: 'pointer', border: `1px solid ${T.warningBorder}` }}>
                                      {DOC_ICONS[d.type] || '📄'} {d.name}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>

                      {a.note && (
                        <div style={{ marginTop: 12, background: '#f8fafc', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: T.textMuted, border: `1px solid ${T.border}` }}>
                          💬 {a.note}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* ── Documents Tab ── */}
          {tab === 'documents' && (
            <div>
              <FlexRow justify="space-between" style={{ marginBottom: 14 }}>
                <SectionLabel>Order Documents</SectionLabel>
                <Btn size="sm" onClick={() => setShowUp(true)} icon="📎">Upload</Btn>
              </FlexRow>
              {txnDocs.filter(d => d.stageIndex == null).length === 0 ? (
                <Alert type="info">No documents uploaded for this order yet.</Alert>
              ) : (
                <StageDocGroup
                  docs={txnDocs.filter(d => d.stageIndex == null)}
                  stages={selectedAsgn?.stages || order.assignments[0]?.stages || []}
                  users={users}
                  onGetData={getDocData}
                />
              )}
            </div>
          )}

          {tab === 'stage_evidence' && (
            <div>
              {stageDocs.length === 0 ? (
                <EmptyState icon="🖼" title="No stage evidence" desc="Images and docs uploaded for each production stage will appear here" />
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {(selectedAsgn?.stages || []).map((s, i) => {
                    const sDocs = stageDocs.filter(d => d.stageIndex === i)
                    if (sDocs.length === 0) return null
                    const pct = s.totalUnits > 0 ? Math.round((s.unitsDone / s.totalUnits) * 100) : 0
                    const done = pct >= 100
                    return (
                      <div key={i} style={{ border: `1px solid ${done ? T.successBorder : T.border}`, borderRadius: 12, overflow: 'hidden' }}>
                        <div style={{ padding: '10px 16px', background: done ? T.successBg : '#f8fafc', borderBottom: `1px solid ${done ? T.successBorder : T.border}`, display: 'flex', alignItems: 'center', gap: 10 }}>
                          <div style={{ width: 26, height: 26, borderRadius: '50%', background: done ? T.success : T.primary, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 800, flexShrink: 0 }}>
                            {done ? '✓' : i + 1}
                          </div>
                          <span style={{ fontSize: 13, fontWeight: 700, color: done ? T.success : T.text }}>{s.name}</span>
                          <span style={{ fontSize: 11, color: T.textMuted }}>{pct}%</span>
                          <FlexRow gap={8} style={{ marginLeft: 'auto' }}>
                            <span style={{ fontSize: 11, fontWeight: 700, color: '#1d4ed8', background: '#dbeafe', padding: '2px 8px', borderRadius: 10 }}>{sDocs.length} file{sDocs.length !== 1 ? 's' : ''}</span>
                            <Btn size="sm" variant="outline" style={{ fontSize: 10 }} onClick={() => openStageDocUpload(effectiveMid, i)}>📎 Add</Btn>
                          </FlexRow>
                        </div>
                        <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                          {sDocs.map(d => <DocCard key={d.id} doc={d} users={users} onGetData={getDocData} stageName={s.name} />)}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {/* ── Compliance Tab ── */}
          {tab === 'compliance' && (
            <div>
              <SectionLabel>Manufacturer Compliance Certificates</SectionLabel>
              {mfrDocs.length === 0 ? (
                <Alert type="info">No compliance certificates uploaded by manufacturers for this order.</Alert>
              ) : (
                mfrDocs.map(d => {
                  const asgn = order.assignments.find(a => String(a.mid) === String(d.mfrId))
                  return <DocCard key={d.id} doc={{ ...d, name: `${d.name} — ${asgn?.mfrCompany || '—'}` }} users={users} onGetData={getDocData} />
                })
              )}
            </div>
          )}

          {/* ── Order Info Tab ── */}
          {tab === 'info' && (
            <div className="grid-responsive-2" style={{ gap: '14px 32px' }}>
              <InfoRow label="Order ID" value={order.id} mono />
              <InfoRow label="Product" value={order.product} />
              <InfoRow label="Category" value={order.category} />
              <InfoRow label="Season" value={order.season} />
              <InfoRow label="Buyer" value={order.buyerCompany || '—'} />
              <InfoRow label="Buyer Code" value={order.buyerCode || '—'} />
              <InfoRow label="Total Quantity" value={order.totalQty?.toLocaleString()} />
              <InfoRow label="Delivery Date" value={fmtDate(order.delivery)} />
              <InfoRow label="Created" value={fmtDate(order.createdAt)} />
              <InfoRow label="Overall Status" value={overallStatus()} badge />
              <div style={{ gridColumn: '1 / -1' }}>
                <SectionLabel>Manufacturer Assignments</SectionLabel>
                <div className="grid-responsive-2" style={{ gap: 10 }}>
                  {order.assignments.map(a => (
                    <div key={a.sub} style={{ background: '#f8fafc', borderRadius: 8, border: `1px solid ${T.border}`, padding: '10px 14px' }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}><MfrProfileLink mfrId={a.mid} mfrName={a.mfrCompany || '—'} docs={docs} onGetData={getDocData} /> <span style={{ color: T.textLight }}>({a.sub})</span></div>
                      <div style={{ fontSize: 12, color: T.textMuted, marginTop: 3 }}>
                        {a.qty?.toLocaleString()} pcs · <Badge status={a.status} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </Card>
    </div>
  )
}

function InfoRow({ label, value, mono, badge }) {
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 800, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>{label}</div>
      {badge ? (
        <Badge status={value} />
      ) : mono ? (
        <Mono style={{ fontSize: 13 }}>{value}</Mono>
      ) : (
        <div style={{ fontSize: 14, fontWeight: 600, color: T.text }}>{value}</div>
      )}
    </div>
  )
}
