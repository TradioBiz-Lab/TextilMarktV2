import { useState } from 'react'
import { Factory, Paperclip, Folder, Inbox, ChevronDown } from '../../icons.jsx'
import { T, DOC_TYPES, getToday } from '../../constants.js'
import { Modal, Select, Input, Btn, Card, EmptyState, FlexRow, PageHeader, DocCard, FileUpload, LoadingScreen, useToast, fileUploadPayload, activateOnKey } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'
import { capsFor } from '../../caps.js'
import { FileIntoStyle } from '../../components/FileIntoStyle.jsx'

// This page holds the factory-level files only: who a manufacturer is, and the proof it is compliant. Everything
// about a style (tech packs, POs, test reports, evidence) lives on the style itself. Certificates keep their own types.
const FACTORY_TYPES = ['mfr_profile', 'compliance_cert', 'chemical_cert', 'environmental_cert', 'insurance', 'factory_audit']
const CERT_LABEL = { compliance_cert: 'Upload Compliance Certificate', chemical_cert: 'Upload Chemical Test Certificate', environmental_cert: 'Upload Environmental Certification', insurance: 'Upload Insurance Certificate' }

export function AdminDocuments() {
  const { docs, users, loading, uploadDoc, getDocData, currentUser } = useApp()
  const toast = useToast()
  // Same repository for every role; what each may upload follows the server's rules (caps.js).
  const caps = capsFor(currentUser)
  const defaultIssuer = caps.isAdmin ? 'Tradio' : (currentUser?.company || '')
  // Admins upload any of these for any manufacturer; a factory uploads its own. A customer only reads.
  const uploadTypes = DOC_TYPES.filter(t => FACTORY_TYPES.includes(t.v))
  const [show, setShow] = useState(false)
  const [filt, setFilt] = useState('all')
  // Every folder starts closed, like the Orders page; a click opens it.
  const [openGroups, setOpenGroups] = useState(() => new Set())
  const toggleGroup = id => setOpenGroups(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  const blankForm = () => ({ type: 'mfr_profile', name: '', issuer: defaultIssuer, issueDate: getToday(), expiryDate: '', mfrId: null })
  const [uf, setUf] = useState(blankForm)
  const [fileData, setFileData] = useState(null)
  const [fileErr, setFileErr] = useState('')
  const [saving, setSaving] = useState(false)

  const mfrUsers = users.filter(u => u.role === 'manufacturer')
  const active = docs.filter(d => d.isActive !== false)
  const nonStageDocs = active.filter(d => FACTORY_TYPES.includes(d.type))
  const show2 = filt === 'all' ? nonStageDocs : nonStageDocs.filter(d => d.type === filt)

  const reset = () => { setUf(blankForm()); setFileData(null); setFileErr('') }

  const submit = async () => {
    if (!fileData) { setFileErr('Please select a file.'); return }
    setSaving(true)
    try {
      // A factory always uploads as itself; a customer may never attach a factory (the server refuses it).
      const mfrId = caps.isMfr ? currentUser.id : caps.isBuyer ? null : (uf.mfrId || null)
      await uploadDoc({ ...uf, expiryDate: uf.expiryDate || null, orderId: null, mfrId, ...fileUploadPayload(fileData) })
      toast('Document uploaded', 'success')
      setShow(false); reset()
    } catch {
      toast('Failed to upload document', 'error')
    } finally { setSaving(false) }
  }

  const filterBtns = [
    { v: 'all', l: `All (${nonStageDocs.length})` },
    { v: 'mfr_profile', l: 'Manufacturer Profiles', Icon: Factory },
    { v: 'compliance_cert', l: 'Compliance' },
    { v: 'chemical_cert', l: 'Chemical' },
    { v: 'environmental_cert', l: 'Environmental' },
    { v: 'insurance', l: 'Insurance' },
    { v: 'factory_audit', l: 'Audit Reports' },
  ].filter(fb => fb.v === 'all' || fb.v === 'mfr_profile' || nonStageDocs.some(d => d.type === fb.v) || ['compliance_cert', 'factory_audit'].includes(fb.v))

  // Hooks above must run on every render, so the loading gate sits after them.
  if (loading) return <LoadingScreen />

  return (
    <div>
      {show && (() => {
        const isMfrProfile = uf.type === 'mfr_profile'
        const modalTitle = isMfrProfile ? 'Upload Manufacturer Profile' : uf.type === 'factory_audit' ? 'Upload Audit Report' : (CERT_LABEL[uf.type] || 'Upload Certificate')
        const modalSub = isMfrProfile ? 'PDF profile visible to all users working with this manufacturer' : 'Document will be automatically distributed to relevant parties'
        const canSubmit = uf.name && fileData && !saving && (caps.isAdmin ? !!uf.mfrId : true)
        return (
        <Modal title={modalTitle} subtitle={modalSub} onClose={() => { setShow(false); reset() }} size="lg">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div className="form-grid-2">
              <Select label="Document Type" value={uf.type} onChange={e => setUf({ ...uf, type: e.target.value })}>
                {uploadTypes.map(t => <option key={t.v} value={t.v}>{t.l}</option>)}
              </Select>
              <Input label="Document Name" value={uf.name} onChange={e => setUf({ ...uf, name: e.target.value })} placeholder="Document title" />
            </div>
            {!isMfrProfile && (
              <Input label="Issuing Authority" value={uf.issuer} onChange={e => setUf({ ...uf, issuer: e.target.value })} />
            )}
            {caps.isAdmin && (
              <div className="form-grid-2">
                <Select label="Manufacturer *" value={uf.mfrId || ''} onChange={e => setUf({ ...uf, mfrId: e.target.value || null })}>
                  <option value="">Select manufacturer</option>
                  {mfrUsers.map(m => <option key={m.id} value={m.id}>{m.company}</option>)}
                </Select>
              </div>
            )}
            {!isMfrProfile && (
              <div className="form-grid-2">
                <Input label="Issue Date" type="date" value={uf.issueDate} onChange={e => setUf({ ...uf, issueDate: e.target.value })} />
                <Input label="Expiry Date (optional)" type="date" value={uf.expiryDate} onChange={e => setUf({ ...uf, expiryDate: e.target.value })} />
              </div>
            )}
            <FileUpload file={fileData} onFile={f => { setFileData(f); setFileErr('') }} error={fileErr} onError={setFileErr} />
            <FlexRow justify="flex-end" gap={8}>
              <Btn variant="secondary" onClick={() => { setShow(false); reset() }}>Cancel</Btn>
              <Btn disabled={!canSubmit} onClick={submit}>Upload</Btn>
            </FlexRow>
          </div>
        </Modal>
        )
      })()}

      <PageHeader title="Documents" subtitle={caps.isBuyer ? 'Your factories\' profiles, compliance certificates and audit reports' : 'Manufacturer profiles, compliance certificates and audit reports, and customer requests'} action={!caps.isBuyer && <Btn onClick={() => setShow(true)} icon={<Paperclip size={13} />}>Upload Document</Btn>} />

      {(
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
            {filterBtns.map(fb => (
              <button key={fb.v} onClick={() => setFilt(fb.v)}
                style={{ padding: '5px 14px', borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: 'pointer', background: filt === fb.v ? T.primary : T.surface, color: filt === fb.v ? '#fff' : T.textMuted, border: filt === fb.v ? 'none' : `1px solid ${T.border}`, fontFamily: 'inherit', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                {fb.Icon && <fb.Icon size={12} />}{fb.l}
              </button>
            ))}
          </div>
          {(() => {
            // One folder per manufacturer, closed until opened, in the same look as the Orders page.
            const byMfr = new Map()
            show2.forEach(d => { const k = d.mfrId ? String(d.mfrId) : '__none__'; if (!byMfr.has(k)) byMfr.set(k, []); byMfr.get(k).push(d) })
            const groups = [...byMfr.entries()].map(([k, list]) => ({
              id: k, list,
              label: k === '__none__' ? 'Not linked to a manufacturer' : (users.find(u => String(u.id) === k)?.company || list[0]?.uploadedByCompany || 'Manufacturer'),
            })).sort((a, b) => a.id === '__none__' ? 1 : b.id === '__none__' ? -1 : a.label.localeCompare(b.label))
            const typeCount = list => FACTORY_TYPES
              .map(t => [DOC_TYPES.find(x => x.v === t)?.l || t, list.filter(d => d.type === t).length]).filter(([, n]) => n > 0)
            // Customer Requests: requirement documents (RFQ, tech pack, PO) customers sent in with no style, for Tradio to
            // file into the right one. Whatever type they are, they stay here until someone files them.
            const customerDocs = caps.isAdmin && filt === 'all' ? active.filter(d => d.uploadedByRole === 'buyer' && !FACTORY_TYPES.includes(d.type) && !d.orderId && !d.masterOrderId && d.stageIndex == null) : []
            const requestsOpen = openGroups.has('__customer_requests__')
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {customerDocs.length > 0 && (
                  <div style={{ border: `1px solid ${T.border}`, borderRadius: 10, overflow: 'hidden' }}>
                    <FlexRow gap={10} onClick={() => toggleGroup('__customer_requests__')} role="button" tabIndex={0} onKeyDown={activateOnKey(() => toggleGroup('__customer_requests__'))} style={{ padding: '9px 14px', background: '#f1f5f9', cursor: 'pointer' }}>
                      <span style={{ color: T.textMuted, transform: requestsOpen ? 'none' : 'rotate(-90deg)', display: 'inline-flex' }}><ChevronDown size={13} /></span>
                      <span style={{ fontSize: 13, fontWeight: 800, color: T.text, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Inbox size={13} /> Customer Requests</span>
                      <span style={{ fontSize: 11, color: T.textMuted, marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                        Requirement documents uploaded by customers
                        <span style={{ fontWeight: 700, color: T.textMuted, background: '#e2e8f0', padding: '1px 8px', borderRadius: 10 }}>{customerDocs.length}</span>
                      </span>
                    </FlexRow>
                    {requestsOpen && (
                      <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 6, borderTop: `1px solid ${T.border}` }}>
                        {customerDocs.map(d => <div key={d.id}><DocCard doc={d} users={users} onGetData={getDocData} /><FileIntoStyle doc={d} /></div>)}
                      </div>
                    )}
                  </div>
                )}
                {groups.map(g => {
                  const isOpen = openGroups.has(g.id)
                  return (
                    <div key={g.id} style={{ border: `1px solid ${T.border}`, borderRadius: 10, overflow: 'hidden' }}>
                      <FlexRow gap={10} onClick={() => toggleGroup(g.id)} role="button" tabIndex={0} onKeyDown={activateOnKey(() => toggleGroup(g.id))} style={{ padding: '9px 14px', background: '#f1f5f9', cursor: 'pointer' }}>
                        <span style={{ color: T.textMuted, transform: isOpen ? 'none' : 'rotate(-90deg)', display: 'inline-flex' }}><ChevronDown size={13} /></span>
                        <span style={{ fontSize: 13, fontWeight: 800, color: T.text, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Factory size={13} /> {g.label}</span>
                        <span style={{ fontSize: 11, color: T.textMuted, marginLeft: 'auto' }}>{typeCount(g.list).map(([l, n]) => `${n} ${l.toLowerCase()}`).join(' · ')}</span>
                      </FlexRow>
                      {isOpen && (
                        <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 6, borderTop: `1px solid ${T.border}` }}>
                          {g.list.map(d => <DocCard key={d.id} doc={d} users={users} onGetData={getDocData} />)}
                        </div>
                      )}
                    </div>
                  )
                })}
                {groups.length === 0 && customerDocs.length === 0 && <Card><EmptyState icon={<Folder size={26} color={T.textLight} />} title="No documents" desc={caps.isBuyer ? 'Your factories\' profiles and certificates will show up here' : 'Upload a manufacturer profile, compliance certificate or audit report'} /></Card>}
              </div>
            )
          })()}
        </>
      )}
    </div>
  )
}
