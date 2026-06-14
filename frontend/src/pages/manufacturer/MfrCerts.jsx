import { useState } from 'react'
import { T, isExpiringSoon, isExpired } from '../../constants.js'
import { Modal, Select, Input, Btn, Card, Alert, EmptyState, FlexRow, PageHeader, DocCard, FileUpload, LoadingScreen, useToast, fileUploadPayload } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'

export function MfrCerts() {
  const { docs, users, currentUser: user, loading, uploadDoc, getDocData } = useApp()
  const toast = useToast()
  const [show, setShow] = useState(false)
  const [uf, setUf] = useState({ type: 'compliance_cert', name: '', issuer: '', issueDate: '', expiryDate: '' })
  const [fileData, setFileData] = useState(null)
  const [fileErr, setFileErr] = useState('')
  const [saving, setSaving] = useState(false)

  if (loading) return <LoadingScreen />

  const myDocs = docs.filter(d => String(d.mfrId) === String(user.id) && d.isActive !== false && d.stageIndex == null)
  const expiring = myDocs.filter(d => d.expiryDate && (isExpiringSoon(d.expiryDate) || isExpired(d.expiryDate)))

  const reset = () => { setUf({ type: 'compliance_cert', name: '', issuer: '', issueDate: '', expiryDate: '' }); setFileData(null); setFileErr('') }

  const submit = async () => {
    if (!fileData) { setFileErr('Please select a file.'); return }
    setSaving(true)
    try {
      await uploadDoc({ ...uf, expiryDate: uf.expiryDate || null, mfrId: user.id, orderId: null, ...fileUploadPayload(fileData) })
      toast('Certificate uploaded', 'success')
      setShow(false); reset()
    } catch {
      toast('Failed to upload certificate', 'error')
    } finally { setSaving(false) }
  }

  const certTypes = [
    { v: 'compliance_cert', l: 'Compliance Certificate' }, { v: 'factory_audit', l: 'Factory Audit Report' },
    { v: 'chemical_cert', l: 'Chemical Test Certificate' }, { v: 'environmental_cert', l: 'Environmental Certification' },
    { v: 'insurance', l: 'Insurance Certificate' },
  ]

  return (
    <div>
      {show && (
        <Modal title="Upload Certificate" onClose={() => { setShow(false); reset() }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Select label="Document Type" value={uf.type} onChange={e => setUf({ ...uf, type: e.target.value })}>
              {certTypes.map(t => <option key={t.v} value={t.v}>{t.l}</option>)}
            </Select>
            <Input label="Document Name" value={uf.name} onChange={e => setUf({ ...uf, name: e.target.value })} placeholder="e.g. BSCI Audit 2026" />
            <Input label="Issuing Authority / Lab" value={uf.issuer} onChange={e => setUf({ ...uf, issuer: e.target.value })} placeholder="e.g. Bureau Veritas" />
            <div className="form-grid-2">
              <Input label="Issue Date" type="date" value={uf.issueDate} onChange={e => setUf({ ...uf, issueDate: e.target.value })} />
              <Input label="Expiry Date" type="date" value={uf.expiryDate} onChange={e => setUf({ ...uf, expiryDate: e.target.value })} />
            </div>
            <FileUpload file={fileData} onFile={f => { setFileData(f); setFileErr('') }} error={fileErr} onError={setFileErr} />
            <FlexRow justify="flex-end" gap={8}>
              <Btn variant="secondary" onClick={() => { setShow(false); reset() }}>Cancel</Btn>
              <Btn disabled={!uf.name || !fileData || saving} onClick={submit}>Upload</Btn>
            </FlexRow>
          </div>
        </Modal>
      )}
      <PageHeader title="My Certificates" subtitle="Manage compliance and certification documents" action={<Btn onClick={() => setShow(true)} icon="📎">Upload Certificate</Btn>} />
      {expiring.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <Alert type="warning"><strong>{expiring.length} certificate(s)</strong> expiring or expired — please renew before they affect order visibility.</Alert>
        </div>
      )}
      {myDocs.map(d => <DocCard key={d.id} doc={d} users={users} onGetData={getDocData} />)}
      {myDocs.length === 0 && <Card><EmptyState icon="🛡" title="No certificates yet" desc="Upload your compliance documents to share with buyers" /></Card>}
    </div>
  )
}
