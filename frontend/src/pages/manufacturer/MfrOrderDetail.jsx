import { useState } from 'react'
import { T, STAGE_DOC_MAP, getToday, isExpiringSoon, isExpired } from '../../constants.js'
import { Modal, Select, Textarea, Btn, Card, Badge, FlexRow, Mono, Tabs, Alert, EmptyState, FileUpload, Input, DocCard, LoadingScreen, StageTimeline, StageDocGroup, useToast, fileUploadPayload } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'

function fmtDate(d) {
  if (!d) return '—'
  const dt = new Date(d)
  const dd = String(dt.getDate()).padStart(2, '0')
  const mm = String(dt.getMonth() + 1).padStart(2, '0')
  return `${dd}-${mm}-${dt.getFullYear()}`
}

export function MfrOrderDetail({ orderId, onBack }) {
  const { orders, docs, users, currentUser: user, loading, updateStage, uploadDoc, getDocData } = useApp()
  const toast = useToast()

  const [tab, setTab] = useState('stages')

  // Stage update modal
  const [showStage, setShowStage] = useState(false)
  const [stageIdx, setStageIdx] = useState(0)
  const [stageUnits, setStageUnits] = useState('')
  const [stageNote, setStageNote] = useState('')
  const [stageDate, setStageDate] = useState('')
  const [stageInitUnits, setStageInitUnits] = useState('')
  const [stageInitDate, setStageInitDate] = useState('')
  const [stageFiles, setStageFiles] = useState([null])
  const [stageFileErrs, setStageFileErrs] = useState([''])

  // Cert upload modal
  const [showUp, setShowUp] = useState(false)
  const [uf, setUf] = useState({ type: 'compliance_cert', name: '', issuer: '', issueDate: '', expiryDate: '' })
  const [fileData, setFileData] = useState(null)
  const [fileErr, setFileErr] = useState('')

  const [saving, setSaving] = useState(false)

  if (loading) return <LoadingScreen />

  const order = orders.find(o => o.id === orderId)
  const mine = order?.assignments?.find(a => String(a.mid) === String(user.id))

  if (!order || !mine) return (
    <div>
      <FlexRow style={{ marginBottom: 18 }} gap={12}>
        <Btn variant="secondary" size="sm" onClick={onBack}>← Back</Btn>
      </FlexRow>
      <Card><EmptyState icon="⚠️" title="Order not found" desc={`Order ${orderId} could not be loaded.`} /></Card>
    </div>
  )

  const stages = mine.stages || []
  const buyerCompany = order.buyerCompany
  const overdue = new Date(order.delivery) < new Date(getToday()) && mine.status !== 'Delivered'

  // Derived data
  const orderDocs = docs.filter(d => String(d.orderId) === String(order.id) && d.isActive !== false)
  const stageDocs = orderDocs.filter(d => d.stageIndex != null && String(d.mfrId || '') === String(user.id))
  const myDocs = docs.filter(d => String(d.mfrId) === String(user.id) && d.isActive !== false && d.stageIndex == null)
  const expiringCerts = myDocs.filter(d => d.expiryDate && (isExpiringSoon(d.expiryDate) || isExpired(d.expiryDate)))

  // Overall progress
  const totalDone = stages.reduce((s, st) => s + (st.unitsDone || 0), 0)
  const totalAll = stages.reduce((s, st) => s + (st.totalUnits || 0), 0)
  const overallPct = totalAll > 0 ? Math.round((totalDone / totalAll) * 100) : 0

  // Stage helpers
  const stageComplete = (idx) => {
    const s = stages[idx]
    return s && s.totalUnits > 0 && s.unitsDone >= s.totalUnits
  }

  const nextIncompleteStage = () => {
    for (let i = 0; i < stages.length; i++) {
      if (!stageComplete(i)) return i
    }
    return null
  }

  const openStageModal = (idx) => {
    const initUnits = stages[idx]?.unitsDone?.toString() || '0'
    const initDate = stages[idx]?.stageDate || ''
    setStageIdx(idx)
    setStageUnits(initUnits)
    setStageInitUnits(initUnits)
    setStageNote('')
    setStageDate(initDate)
    setStageInitDate(initDate)
    setStageFiles([null])
    setStageFileErrs([''])
    setShowStage(true)
  }

  const submitStage = async () => {
    const units = parseInt(stageUnits, 10)
    if (isNaN(units) || units < 0) return
    const maxUnits = stages[stageIdx]?.totalUnits || 0
    if (maxUnits > 0 && units > maxUnits) return
    setSaving(true)
    try {
      const stageDocTypes = STAGE_DOC_MAP[stageIdx] || []
      const docType = stageDocTypes[0]?.v || 'compliance_cert'
      const stageName = stages[stageIdx]?.name || `Stage ${stageIdx + 1}`
      const filesToUpload = stageFiles.filter(Boolean)
      const stageNoteTrim = stageNote.trim()
      for (const f of filesToUpload) {
        await uploadDoc({
          type: docType,
          name: `${stageName} — ${orderId}`,
          issuer: null, issueDate: new Date().toISOString().slice(0, 10), expiryDate: null,
          mfrId: user.id, orderId, stageIndex: stageIdx,
          notes: stageNoteTrim || null,
          ...fileUploadPayload(f),
        })
      }
      const unitsChanged = stageUnits !== stageInitUnits
      const dateChanged = stageDate !== stageInitDate
      const noteChanged = stageNote.trim() !== ''
      if (unitsChanged || dateChanged || noteChanged) {
        await updateStage(orderId, user.id, stageIdx, { unitsDone: units, note: stageNote, stageDate: stageDate || null })
      }
      toast('Stage updated', 'success')
      setShowStage(false)
    } catch {
      toast('Failed to update stage', 'error')
    } finally { setSaving(false) }
  }

  // Cert upload helpers
  const certDocTypes = [
    { v: 'compliance_cert', l: 'Compliance Certificate' }, { v: 'factory_audit', l: 'Factory Audit Report' },
    { v: 'chemical_cert', l: 'Chemical Test Certificate' }, { v: 'environmental_cert', l: 'Environmental Certification' },
    { v: 'insurance', l: 'Insurance Certificate' },
  ]
  const resetUpload = () => { setUf({ type: 'compliance_cert', name: '', issuer: '', issueDate: '', expiryDate: '' }); setFileData(null); setFileErr('') }
  const submitDoc = async () => {
    if (!fileData) { setFileErr('Please select a file.'); return }
    setSaving(true)
    try {
      await uploadDoc({ ...uf, expiryDate: uf.expiryDate || null, mfrId: user.id, orderId: null, ...fileUploadPayload(fileData) })
      toast('Certificate uploaded', 'success')
      setShowUp(false); resetUpload()
    } catch {
      toast('Failed to upload certificate', 'error')
    } finally { setSaving(false) }
  }

  // Modal pct helper
  const modalPct = () => {
    const total = stages[stageIdx]?.totalUnits || 0
    return total > 0 ? Math.min(100, Math.round((parseInt(stageUnits, 10) || 0) / total * 100)) : 0
  }

  return (
    <div>
      {/* ── Stage Update Modal ── */}
      {showStage && (
        <Modal title="Update Production Stage" subtitle={`${order.id}-${mine.sub} · ${stages[stageIdx]?.name}`} onClose={() => setShowStage(false)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Select label="Select Stage" value={stageIdx} onChange={e => {
              const idx = parseInt(e.target.value, 10)
              const initUnits = stages[idx]?.unitsDone?.toString() || '0'
              const initDate = stages[idx]?.stageDate || ''
              setStageIdx(idx)
              setStageUnits(initUnits)
              setStageInitUnits(initUnits)
              setStageNote('')
              setStageDate(initDate)
              setStageInitDate(initDate)
            }}>
              {stages.map((s, i) => {
                const pct = s?.totalUnits > 0 ? Math.round((s.unitsDone / s.totalUnits) * 100) : 0
                return <option key={i} value={i}>{i + 1}. {s.name} — {pct}% ({s?.unitsDone || 0}/{s?.totalUnits || 0})</option>
              })}
            </Select>

            <div>
              <Input
                label={`Units Completed (of ${stages[stageIdx]?.totalUnits || 0})`}
                type="number" min="0" max={stages[stageIdx]?.totalUnits || 0}
                value={stageUnits} onChange={e => setStageUnits(e.target.value)}
              />
              <div style={{ marginTop: 8, background: '#f1f5f9', borderRadius: 6, height: 8, overflow: 'hidden' }}>
                <div style={{ width: `${modalPct()}%`, height: '100%', background: modalPct() >= 100 ? T.success : T.primary, borderRadius: 6, transition: 'width 0.2s' }} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
                {stages[stageIdx]?.eta && <span style={{ fontSize: 11, color: T.info }}>ETA: {fmtDate(stages[stageIdx].eta)}</span>}
                <span style={{ fontSize: 11, color: T.textMuted, marginLeft: 'auto' }}>{modalPct()}%</span>
              </div>
            </div>

            <Input label="Stage Date" type="date" value={stageDate} onChange={e => setStageDate(e.target.value)} hint="Date when this stage was completed or updated" />
            <Textarea label="Optional Note" value={stageNote} onChange={e => setStageNote(e.target.value)} placeholder="Describe progress or any issues…" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Evidence Files <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(optional, multiple allowed)</span>
              </div>
              {stageFiles.map((f, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                    <FileUpload
                      file={f}
                      onFile={file => setStageFiles(prev => { const n = [...prev]; n[i] = file; return n })}
                      error={stageFileErrs[i]}
                      onError={err => setStageFileErrs(prev => { const n = [...prev]; n[i] = err; return n })}
                    />
                  </div>
                  {stageFiles.length > 1 && (
                    <button
                      onClick={() => { setStageFiles(p => p.filter((_, j) => j !== i)); setStageFileErrs(p => p.filter((_, j) => j !== i)) }}
                      style={{ flexShrink: 0, background: T.dangerBg, border: `1px solid ${T.dangerBorder}`, color: T.danger, borderRadius: 6, width: 28, height: 28, cursor: 'pointer', fontSize: 16, lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                    >×</button>
                  )}
                </div>
              ))}
              <button
                onClick={() => { setStageFiles(p => [...p, null]); setStageFileErrs(p => [...p, '']) }}
                style={{ alignSelf: 'flex-start', background: 'none', border: `1px dashed ${T.border}`, color: T.primary, borderRadius: 6, padding: '5px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
              >+ Add another file</button>
            </div>

            {/* Smart prompt: stage at 100% */}
            {modalPct() >= 100 && stageIdx < stages.length - 1 && (
              <Alert type="success">
                Stage complete! Ready to advance to <strong>{stages[stageIdx + 1]?.name || `Stage ${stageIdx + 2}`}</strong>?
              </Alert>
            )}

            <FlexRow justify="flex-end" gap={8}>
              <Btn variant="secondary" onClick={() => setShowStage(false)}>Cancel</Btn>
              <Btn onClick={submitStage} disabled={saving || isNaN(parseInt(stageUnits, 10))}>{saving ? 'Saving…' : 'Confirm Update'}</Btn>
            </FlexRow>
          </div>
        </Modal>
      )}

      {/* ── Upload Cert Modal ── */}
      {showUp && (
        <Modal title="Upload Compliance Certificate" onClose={() => { setShowUp(false); resetUpload() }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Select label="Document Type" value={uf.type} onChange={e => setUf({ ...uf, type: e.target.value })}>
              {certDocTypes.map(t => <option key={t.v} value={t.v}>{t.l}</option>)}
            </Select>
            <Input label="Document Name *" value={uf.name} onChange={e => setUf({ ...uf, name: e.target.value })} placeholder="e.g. BSCI Audit 2026" />
            <Input label="Issuing Authority / Lab" value={uf.issuer} onChange={e => setUf({ ...uf, issuer: e.target.value })} placeholder="e.g. Bureau Veritas" />
            <div className="form-grid-2">
              <Input label="Issue Date" type="date" value={uf.issueDate} onChange={e => setUf({ ...uf, issueDate: e.target.value })} />
              <Input label="Expiry Date" type="date" value={uf.expiryDate} onChange={e => setUf({ ...uf, expiryDate: e.target.value })} />
            </div>
            <FileUpload file={fileData} onFile={f => { setFileData(f); setFileErr('') }} error={fileErr} onError={setFileErr} />
            <FlexRow justify="flex-end" gap={8}>
              <Btn variant="secondary" onClick={() => { setShowUp(false); resetUpload() }}>Cancel</Btn>
              <Btn disabled={!uf.name || !fileData || saving} onClick={submitDoc}>{saving ? 'Uploading…' : 'Upload'}</Btn>
            </FlexRow>
          </div>
        </Modal>
      )}

      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <Btn variant="secondary" size="sm" onClick={onBack}>← Back</Btn>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <Mono style={{ fontSize: 15, fontWeight: 800 }}>{order.id}-{mine.sub}</Mono>
            <Badge status={mine.status} />
            {overdue && <span style={{ fontSize: 9, fontWeight: 800, color: T.danger, background: T.dangerBg, border: `1px solid ${T.dangerBorder}`, borderRadius: 4, padding: '2px 6px', letterSpacing: '0.05em' }}>OVERDUE</span>}
          </div>
          <div style={{ fontSize: 13, color: T.textMuted, marginTop: 4, lineHeight: 1.6 }}>
            {order.product}
            {order.category && <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, color: T.textLight, background: '#f1f5f9', padding: '1px 6px', borderRadius: 4 }}>{order.category}</span>}
            {order.season && <span style={{ marginLeft: 5, fontSize: 10, fontWeight: 700, color: '#0369a1', background: '#dbeafe', padding: '1px 6px', borderRadius: 4 }}>{order.season}</span>}
            <span style={{ marginLeft: 6 }}>· {mine.qty?.toLocaleString()} pcs · Buyer: {buyerCompany || '—'} · Due {fmtDate(order.delivery)}</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0, flexWrap: 'wrap' }}>
          <Btn variant="secondary" size="sm" onClick={() => setShowUp(true)} icon="🛡">Upload Cert</Btn>
          <Btn size="sm" onClick={() => openStageModal(nextIncompleteStage() ?? 0)} icon="⚙️">Update Stage</Btn>
        </div>
      </div>

      {/* ── Alerts ── */}
      {expiringCerts.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <Alert type="warning">
            <strong>{expiringCerts.length} certificate{expiringCerts.length > 1 ? 's' : ''}</strong> expiring or expired — please renew to maintain order visibility.
          </Alert>
        </div>
      )}

      {/* ── Overall progress bar ── */}
      <Card pad={false} style={{ marginBottom: 16 }}>
        <div style={{ padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: T.text }}>Overall Production Progress</span>
              <span style={{ fontSize: 13, fontWeight: 800, color: overallPct >= 100 ? T.success : T.primary }}>{overallPct}%</span>
            </div>
            <div style={{ background: '#f1f5f9', borderRadius: 6, height: 10, overflow: 'hidden' }}>
              <div style={{ width: `${overallPct}%`, height: '100%', background: overallPct >= 100 ? T.success : T.primary, borderRadius: 6, transition: 'width 0.3s' }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
              <span style={{ fontSize: 11, color: T.textMuted }}>{totalDone.toLocaleString()} / {totalAll.toLocaleString()} units across {stages.length} stages</span>
              {mine.updatedAt && <span style={{ fontSize: 11, color: T.textLight }}>Updated: {fmtDate(mine.updatedAt)}</span>}
            </div>
          </div>
        </div>
        {/* Smart advance prompt */}
        {(() => {
          const nxt = nextIncompleteStage()
          if (nxt !== null && nxt > 0 && stageComplete(nxt - 1)) {
            return (
              <div style={{ padding: '10px 20px', borderTop: `1px solid ${T.border}`, background: T.successBg, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 13, color: T.success }}><strong>{stages[nxt - 1]?.name}</strong> is complete! Ready to advance to <strong>{stages[nxt]?.name}</strong>?</span>
                <Btn variant="success" size="sm" onClick={() => openStageModal(nxt)}>Advance →</Btn>
              </div>
            )
          }
          return null
        })()}
      </Card>

      {/* ── Latest note ── */}
      {mine.note && (
        <div style={{ marginBottom: 14, display: 'flex', alignItems: 'flex-start', gap: 10, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, padding: '11px 14px' }}>
          <span style={{ fontSize: 15, flexShrink: 0 }}>💬</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, marginBottom: 3 }}>Latest Note</div>
            <div style={{ fontSize: 13, color: T.text }}>{mine.note}</div>
          </div>
        </div>
      )}

      {/* ── Tabbed content ── */}
      <Card pad={false}>
        <Tabs
          tabs={[
            { id: 'stages',         label: `⚙️ Production (${stages.length})` },
            { id: 'docs',           label: `📋 Documents (${orderDocs.filter(d => d.stageIndex == null).length})` },
            { id: 'stage_evidence', label: `🖼 Stage Evidence (${stageDocs.length})` },
            { id: 'certs',          label: `🛡 Certificates (${myDocs.length})` },
            { id: 'info',           label: '📦 Order Info' },
          ]}
          active={tab}
          onChange={setTab}
        />

        <div style={{ padding: 20 }}>

          {/* ── TAB: Production Stages ── */}
          {tab === 'stages' && (
            <div>
              {/* Bubble timeline */}
              <div style={{ marginBottom: 20 }}>
                <StageTimeline stages={stages} />
              </div>

              {/* Stage rows */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                {stages.map((s, i) => {
                  const pct = s.totalUnits > 0 ? Math.round((s.unitsDone / s.totalUnits) * 100) : 0
                  const done = pct >= 100
                  const active = pct > 0 && !done
                  const isLate = s.eta && new Date(s.eta) < new Date(getToday()) && !done
                  return (
                    <div
                      key={i}
                      onClick={() => openStageModal(i)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 14,
                        padding: '12px 14px',
                        borderBottom: i < 9 ? `1px solid ${T.border}` : 'none',
                        cursor: 'pointer', borderRadius: 8,
                        transition: 'background 0.12s',
                      }}
                      onMouseEnter={e => e.currentTarget.style.background = '#f8fafc'}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                    >
                      {/* Step number bubble */}
                      <div style={{
                        width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
                        background: done ? T.success : active ? T.primary : '#e2e8f0',
                        color: done || active ? '#fff' : T.textLight,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 12, fontWeight: 800,
                        border: isLate ? `2px solid ${T.danger}` : 'none',
                      }}>
                        {done ? '✓' : i + 1}
                      </div>

                      {/* Name + progress bar */}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                          <span style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{s.name}</span>
                          {isLate && <span style={{ fontSize: 9, fontWeight: 700, color: T.danger, background: T.dangerBg, padding: '1px 5px', borderRadius: 3 }}>LATE</span>}
                        </div>
                        <div style={{ background: '#f1f5f9', borderRadius: 4, height: 6, overflow: 'hidden' }}>
                          <div style={{ width: `${pct}%`, height: '100%', background: done ? T.success : T.primary, borderRadius: 4, transition: 'width 0.3s' }} />
                        </div>
                        {s.eta && <div style={{ fontSize: 10, color: isLate ? T.danger : T.textLight, marginTop: 3 }}>ETA: {fmtDate(s.eta)}</div>}
                      </div>

                      {/* Stage date */}
                      <div style={{ flexShrink: 0 }}>
                        {s.stageDate ? (
                          <span style={{ fontSize: 11, fontWeight: 600, color: done ? T.success : T.info, background: done ? T.successBg : T.infoBg, padding: '2px 8px', borderRadius: 4 }}>
                            {fmtDate(s.stageDate)}
                          </span>
                        ) : (
                          <span style={{ fontSize: 10, color: T.textLight, fontStyle: 'italic' }}>No date</span>
                        )}
                      </div>

                      {/* Units + percentage */}
                      <div style={{ textAlign: 'right', flexShrink: 0, minWidth: 60 }}>
                        <div style={{ fontSize: 14, fontWeight: 800, color: done ? T.success : active ? T.primary : T.textLight }}>{pct}%</div>
                        <div style={{ fontSize: 11, color: T.textMuted, marginTop: 1 }}>{s.unitsDone?.toLocaleString()}/{s.totalUnits?.toLocaleString()}</div>
                      </div>

                      {/* Edit indicator */}
                      <div style={{ fontSize: 14, color: T.textLight, flexShrink: 0 }}>›</div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* ── TAB: Order Documents ── */}
          {tab === 'docs' && (
            orderDocs.filter(d => d.stageIndex == null).length === 0
              ? <EmptyState icon="📋" title="No order documents" desc="PO, Tech Pack, and other documents uploaded to this order will appear here" />
              : <StageDocGroup
                  docs={orderDocs.filter(d => d.stageIndex == null)}
                  stages={mine.stages || []}
                  users={users}
                  onGetData={getDocData}
                />
          )}

          {tab === 'stage_evidence' && (
            <div>
              {stageDocs.length === 0 ? (
                <EmptyState icon="🖼" title="No stage evidence yet" desc="Upload images or documents when updating each production stage — they will appear here" />
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {stages.map((s, i) => {
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
                          <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 700, color: '#1d4ed8', background: '#dbeafe', padding: '2px 8px', borderRadius: 10 }}>{sDocs.length} file{sDocs.length !== 1 ? 's' : ''}</span>
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

          {/* ── TAB: My Certificates ── */}
          {tab === 'certs' && (
            <div>
              <FlexRow justify="flex-end" style={{ marginBottom: 12 }}>
                <Btn size="sm" icon="🛡" onClick={() => setShowUp(true)}>Upload Certificate</Btn>
              </FlexRow>
              {myDocs.length === 0
                ? <EmptyState icon="🛡" title="No certificates" desc="Upload your compliance documents so buyers and admin can verify your factory" />
                : <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {myDocs.map(d => {
                      const exp = isExpiringSoon(d.expiryDate)
                      const expd = isExpired(d.expiryDate)
                      return <DocCard
                        key={d.id}
                        doc={{ ...d, name: (expd || exp) ? `${d.name}${expd ? ' — EXPIRED' : ' — EXPIRING SOON'}` : d.name }}
                        users={users}
                        onGetData={getDocData}
                      />
                    })}
                  </div>
              }
            </div>
          )}

          {/* ── TAB: Order Info ── */}
          {tab === 'info' && (
            <div>
              {/* Two-column grid */}
              <div className="grid-responsive-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 32px' }}>
                {[
                  ['Order ID',     <Mono key="oid" style={{ fontSize: 12 }}>{order.id}</Mono>],
                  ['Split',        mine.sub],
                  ['Product',      order.product],
                  ['Category',     order.category || '—'],
                  ['Season',       order.season || '—'],
                  ['Buyer',        buyerCompany || '—'],
                  ['Total Qty',    `${order.totalQty?.toLocaleString()} pcs`],
                  ['My Qty',       `${mine.qty?.toLocaleString()} pcs`],
                  ['Status',       <Badge key="st" status={mine.status} />],
                  ['Delivery',     fmtDate(order.delivery)],
                  ['Last Updated', fmtDate(mine.updatedAt)],
                  ['Progress',     `${overallPct}%`],
                ].map(([k, v]) => (
                  <div key={k} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '11px 0', borderBottom: `1px solid ${T.border}`, fontSize: 13 }}>
                    <span style={{ color: T.textMuted, fontWeight: 500 }}>{k}</span>
                    <span style={{ fontWeight: 600, color: T.text }}>{v}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </Card>
    </div>
  )
}
