import { useState, useMemo } from 'react' // useMemo kept for myReqDocs
import { AlertTriangle, ClipboardList, UploadCloud, Search, Package, Check, Clock } from '../../icons.jsx'
import { T, DOC_TYPES, getToday, fmtDate } from '../../constants.js'
import { Card, EmptyState, PageHeader, Btn, Modal, Select, Input, FileUpload, FlexRow, LoadingScreen, DocCard, useToast, fileUploadPayload } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'

const REQ_TYPES = ['RFQ', 'tech_pack', 'PO']
const REQ_DOC_TYPES = DOC_TYPES.filter(t => REQ_TYPES.includes(t.v))

export function BuyerSubmitReq() {
  const { docs, orders, masterOrders, currentUser: user, users, loading, getDocData, uploadDoc, loadError } = useApp()
  const toast = useToast()
  const [showUpload, setShowUpload] = useState(false)
  const [uf, setUf] = useState(() => ({ type: 'RFQ', name: '', issuer: '', issueDate: getToday() }))
  const [fileData, setFileData] = useState(null)
  const [fileErr, setFileErr] = useState('')
  const [uploadErr, setUploadErr] = useState('')
  const [saving, setSaving] = useState(false)

  // Show only buyer-submitted RFQ/TechPack/PO docs
  const myReqDocs = useMemo(() =>
    (docs || []).filter(d =>
      d.isActive !== false &&
      String(d.uploadedBy) === String(user.id) &&
      REQ_TYPES.includes(d.type)
    ).sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt)),
    [docs, user]
  )

  const resetUpload = () => {
    setUf({ type: 'RFQ', name: '', issuer: '', issueDate: getToday() })
    setFileData(null); setFileErr(''); setUploadErr('')
  }

  const submitDoc = async () => {
    if (!uf.name.trim()) { setUploadErr('Please enter a document name.'); return }
    if (!fileData) { setFileErr('Please select a file.'); return }
    setSaving(true); setUploadErr('')
    try {
      await uploadDoc({ ...uf, orderId: null, name: uf.name.trim(), mfrId: null, expiryDate: null, ...fileUploadPayload(fileData) })
      toast('Requirement submitted successfully!', 'success')
      setShowUpload(false); resetUpload()
    } catch (e) {
      setUploadErr(e?.message || 'Upload failed. Please try again.')
    } finally { setSaving(false) }
  }

  if (loadError) return (
    <Card><EmptyState icon={<AlertTriangle size={26} color={T.textLight} />} title="Could not load data" desc="Check your connection and refresh the page." /></Card>
  )

  // Hooks above must run on every render, so the loading gate sits after them.
  if (loading) return <LoadingScreen />

  return (
    <div>
      {showUpload && (
        <Modal title="Submit New Requirement" subtitle="Upload your RFQ, Tech Pack, or Purchase Order" onClose={() => { setShowUpload(false); resetUpload() }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Select label="Document Type" value={uf.type} onChange={e => setUf({ ...uf, type: e.target.value })}>
              {REQ_DOC_TYPES.map(t => <option key={t.v} value={t.v}>{t.l}</option>)}
            </Select>
            <Input label="Document Name *" value={uf.name} onChange={e => setUf({ ...uf, name: e.target.value })} placeholder="e.g. RFQ-Summer-2026-Tees" />
            <div className="form-grid-2">
              <Input label="Issuing Authority" value={uf.issuer} onChange={e => setUf({ ...uf, issuer: e.target.value })} placeholder="e.g. Zara HQ" />
              <Input label="Date" type="date" value={uf.issueDate} onChange={e => setUf({ ...uf, issueDate: e.target.value })} />
            </div>
            <FileUpload file={fileData} onFile={f => { setFileData(f); setFileErr(''); setUploadErr('') }} error={fileErr} onError={setFileErr} />
            {uploadErr && <div style={{ fontSize: 12, color: T.danger, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 5 }}><AlertTriangle size={13} /> {uploadErr}</div>}
            <FlexRow justify="flex-end" gap={8}>
              <Btn variant="secondary" onClick={() => { setShowUpload(false); resetUpload() }}>Cancel</Btn>
              <Btn disabled={!uf.name.trim() || !fileData || saving} onClick={submitDoc}>{saving ? 'Submitting…' : 'Submit Requirement'}</Btn>
            </FlexRow>
          </div>
        </Modal>
      )}

      <PageHeader
        title="Submit Requirement"
        subtitle="Upload your RFQ, Tech Pack, or Purchase Order for Tradio to process"
        action={<Btn icon={<ClipboardList size={16} />} onClick={() => setShowUpload(true)}>New Requirement</Btn>}
      />

      {/* Intro banner */}
      <div style={{ background: 'linear-gradient(135deg, #003B73 0%, #0f5baa 100%)', borderRadius: 12, padding: '24px 28px', marginBottom: 20, color: '#fff' }}>
        <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 8 }}>How it works</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16 }}>
          {[
            { step: '1', icon: UploadCloud, title: 'Upload Document', desc: 'Upload your RFQ, Tech Pack, or PO' },
            { step: '2', icon: Search, title: 'Tradio Reviews', desc: 'Our team reviews and matches manufacturers' },
            { step: '3', icon: Package, title: 'Filed to your style', desc: 'Each file moves onto its style, and shows here where it went' },
          ].map(s => (
            <div key={s.step} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'rgba(255,255,255,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 800, flexShrink: 0 }}>{s.step}</div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}><s.icon size={14} /> {s.title}</div>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)', marginTop: 2 }}>{s.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Past submissions */}
      {myReqDocs.length === 0 ? (
        <Card>
          <EmptyState
            icon={<ClipboardList size={26} color={T.textLight} />}
            title="No requirements submitted yet"
            desc="Click 'New Requirement' above to upload your first RFQ, Tech Pack, or Purchase Order"
          />
        </Card>
      ) : (
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: T.text, marginBottom: 10 }}>Your Submissions ({myReqDocs.length})</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            {myReqDocs.map(d => {
              // Where it stands: still with Tradio, or filed onto one of the customer's styles (or its master order).
              const style = d.orderId ? (orders || []).find(o => String(o.id) === String(d.orderId)) : null
              const mo = !d.orderId && d.masterOrderId ? (masterOrders || []).find(m => m.id === d.masterOrderId) : null
              const filed = !!(d.orderId || d.masterOrderId)
              const text = d.orderId ? `${d.filedAt ? 'Filed into' : 'On'} ${style?.product || 'the style'} (${d.orderId})${d.filedAt ? `, ${fmtDate(d.filedAt)}` : ''}`
                : mo ? `On the master order ${mo.orderName}` : 'With Tradio, not yet filed into a style'
              return (
                <div key={d.id}>
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 800, padding: '2px 9px', borderRadius: 10, marginBottom: 4, ...(filed ? { background: '#dcfce7', color: '#166534', border: '1px solid #86efac' } : { background: '#ffedd5', color: '#9a3412', border: '1px solid #fdba74' }) }}>
                    {filed ? <Check size={11} /> : <Clock size={11} />} {text}
                  </div>
                  <DocCard doc={d} users={users} onGetData={getDocData} />
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
