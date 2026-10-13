import { useState } from 'react'
import { Factory, ClipboardList, CheckCircle2, AlertTriangle, XCircle, Paperclip, Shield, Folder, Inbox, FileText, ChevronRight, ChevronDown } from '../../icons.jsx'
import { T, DOC_TYPES, DOC_ICONS, isExpiringSoon, isExpired , getToday, PHASES, phaseOf, withBuyerPrefix } from '../../constants.js'
import { Modal, Select, Input, Btn, Card, Alert, EmptyState, FlexRow, PageHeader, DocCard, FileUpload, StatCard, LoadingScreen, useToast, fileUploadPayload, Grid, ProductThumb, activateOnKey } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'
import { capsFor } from '../../caps.js'

// This page holds the factory-level files only: who a manufacturer is, and the proof it is compliant. Everything
// about a style (tech packs, POs, test reports, evidence) lives on the style itself.
const FACTORY_TYPES = ['mfr_profile', 'compliance_cert', 'factory_audit']

const fmtDate = d => {
  if (!d) return '—'
  const dt = new Date(d)
  return `${String(dt.getDate()).padStart(2, '0')}-${String(dt.getMonth() + 1).padStart(2, '0')}-${dt.getFullYear()}`
}

export function AdminDocuments() {
  const { docs, orders, users, loading, uploadDoc, getDocData, currentUser, masterOrders } = useApp()
  const toast = useToast()
  // Same repository for every role; what each may upload follows the server's rules (caps.js).
  const caps = capsFor(currentUser)
  const defaultIssuer = caps.isAdmin ? 'Tradio' : (currentUser?.company || '')
  // Admins upload any of the three for any manufacturer; a factory uploads its own. A customer only reads.
  const uploadTypes = DOC_TYPES.filter(t => FACTORY_TYPES.includes(t.v))
  const [show, setShow] = useState(false)
  const [filt, setFilt] = useState('all')
  // Every folder starts closed, like the Orders page; a click opens it.
  const [openGroups, setOpenGroups] = useState(() => new Set())
  const toggleGroup = id => setOpenGroups(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  const [uf, setUf] = useState({ type: 'mfr_profile', name: '', issuer: defaultIssuer, issueDate: getToday(), expiryDate: '', orderId: '', mfrId: null, buyerId: '' })
  const [fileData, setFileData] = useState(null)
  const [fileErr, setFileErr] = useState('')
  const [saving, setSaving] = useState(false)

  const mfrUsers = users.filter(u => u.role === 'manufacturer')
  const buyerUsers = users.filter(u => u.role === 'buyer')
  const active = docs.filter(d => d.isActive !== false)
  const nonStageDocs = active.filter(d => FACTORY_TYPES.includes(d.type))
  const show2 = filt === 'all' ? nonStageDocs : nonStageDocs.filter(d => d.type === filt)

  const reset = () => { setUf({ type: 'mfr_profile', name: '', issuer: defaultIssuer, issueDate: getToday(), expiryDate: '', orderId: '', mfrId: null, buyerId: '' }); setFileData(null); setFileErr('') }

  const submit = async () => {
    if (!fileData) { setFileErr('Please select a file.'); return }
    setSaving(true)
    try {
      // A factory always uploads as itself; a customer may never attach a factory (the server refuses it).
      const mfrId = caps.isMfr ? currentUser.id : caps.isBuyer ? null : (uf.mfrId || null)
      await uploadDoc({ ...uf, expiryDate: uf.expiryDate || null, orderId: uf.orderId || null, mfrId, ...fileUploadPayload(fileData) })
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
    { v: 'factory_audit', l: 'Audit Reports' },
  ]

  // Hooks above must run on every render, so the loading gate sits after them.
  if (loading) return <LoadingScreen />

  return (
    <div>
      {show && (() => {
        const isPO = uf.type === 'PO'
        const isBuyerOrder = uf.type === 'buyer_order'
        const isMfrProfile = uf.type === 'mfr_profile'
        const filteredOrders = isBuyerOrder && uf.buyerId && caps.isAdmin
          ? orders.filter(o => String(o.buyerId) === String(uf.buyerId))
          : orders
        const modalTitle = isMfrProfile ? 'Upload Manufacturer Profile' : uf.type === 'factory_audit' ? 'Upload Audit Report' : 'Upload Compliance Certificate'
        const modalSub = isMfrProfile ? 'PDF profile visible to all users working with this manufacturer' : isPO ? 'Link this PO to the manufacturer it belongs to' : isBuyerOrder ? 'Link this order to the buyer and their order' : 'Document will be automatically distributed to relevant parties'
        const canSubmit = uf.name && fileData && !saving && (caps.isAdmin ? !!uf.mfrId : true)
        return (
        <Modal title={modalTitle} subtitle={modalSub} onClose={() => { setShow(false); reset() }} size="lg">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div className="form-grid-2">
              <Select label="Document Type" value={uf.type} onChange={e => {
                const t = e.target.value
                setUf(prev => ({
                  ...prev, type: t,
                  mfrId: (t === 'buyer_order') ? null : prev.mfrId,
                  orderId: (t === 'mfr_profile' || t === 'PO') ? '' : prev.orderId,
                  buyerId: (t === 'buyer_order') ? prev.buyerId : '',
                }))
              }}>
                {uploadTypes.map(t => <option key={t.v} value={t.v}>{t.l}</option>)}
              </Select>
              <Input label="Document Name" value={uf.name} onChange={e => setUf({ ...uf, name: e.target.value })} placeholder="Document title" />
            </div>
            {!isMfrProfile && (
              <Input label="Issuing Authority" value={uf.issuer} onChange={e => setUf({ ...uf, issuer: e.target.value })} />
            )}
            <div className="form-grid-2">
              {/* Buyer Order: show Buyer selector (compulsory) */}
              {caps.isAdmin && isBuyerOrder && (
                <Select label="Link to Buyer *" value={uf.buyerId} onChange={e => setUf({ ...uf, buyerId: e.target.value, orderId: '' })}>
                  <option value="">— Select Buyer —</option>
                  {buyerUsers.map(b => <option key={b.id} value={b.id}>{b.company} ({b.name})</option>)}
                </Select>
              )}
              {/* Buyer Order: show Order selector (compulsory, filtered by buyer) */}
              {isBuyerOrder && (
                <Select label="Link to Order *" value={uf.orderId} onChange={e => setUf({ ...uf, orderId: e.target.value })} disabled={caps.isAdmin && !uf.buyerId} style={{ opacity: caps.isAdmin && !uf.buyerId ? 0.45 : 1 }}>
                  <option value="">— Select Order —</option>
                  {filteredOrders.map(o => <option key={o.id} value={o.id}>{o.id}</option>)}
                </Select>
              )}
              {/* PO: show Manufacturer selector (compulsory) */}
              {caps.isAdmin && isPO && (
                <Select label="Link to Manufacturer *" value={uf.mfrId || ''} onChange={e => setUf({ ...uf, mfrId: e.target.value || null })}>
                  <option value="">— Select Manufacturer —</option>
                  {mfrUsers.map(m => <option key={m.id} value={m.id}>{m.company}</option>)}
                </Select>
              )}
              {/* PO: Order disabled */}
              {isPO && (
                <Select label="Link to Order (N/A for POs)" value="" disabled style={{ opacity: 0.45 }}>
                  <option value="">— Disabled —</option>
                </Select>
              )}
              {caps.isAdmin && !isPO && !isBuyerOrder && (
                <Select
                  label="Manufacturer *"
                  value={uf.mfrId || ''}
                  onChange={e => setUf({ ...uf, mfrId: e.target.value || null })}
                >
                  <option value="">— Select Manufacturer —</option>
                  {mfrUsers.map(m => <option key={m.id} value={m.id}>{m.company}</option>)}
                </Select>
              )}
            </div>
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
            const typeCount = list => ['mfr_profile', 'compliance_cert', 'factory_audit']
              .map(t => [DOC_TYPES.find(x => x.v === t)?.l || t, list.filter(d => d.type === t).length]).filter(([, n]) => n > 0)
            // Customer Requests: requirement documents (RFQ, tech pack, PO) uploaded by customers, for Tradio to sort
            // into the right style. Whatever type they are, they stay here until someone files them.
            const customerDocs = caps.isAdmin && filt === 'all' ? active.filter(d => d.uploadedByRole === 'buyer' && !FACTORY_TYPES.includes(d.type)) : []
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
                        {customerDocs.map(d => <DocCard key={d.id} doc={d} users={users} onGetData={getDocData} />)}
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
