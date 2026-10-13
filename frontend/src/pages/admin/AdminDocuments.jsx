import { useState, useMemo } from 'react'
import { Factory, ClipboardList, CheckCircle2, AlertTriangle, XCircle, Paperclip, Shield, Folder, Inbox, FileText, ChevronRight, ChevronDown } from '../../icons.jsx'
import { T, DOC_TYPES, DOC_ICONS, isExpiringSoon, isExpired , getToday, PHASES, phaseOf, withBuyerPrefix } from '../../constants.js'
import { Modal, Select, Input, Btn, Card, Alert, EmptyState, FlexRow, PageHeader, DocCard, FileUpload, StatCard, LoadingScreen, useToast, fileUploadPayload, Grid, ProductThumb, activateOnKey } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'
import { capsFor } from '../../caps.js'

// This page holds the factory-level files only: who a manufacturer is, and the proof it is compliant. Everything
// about a style (tech packs, POs, test reports, evidence) lives on the style itself.
const FACTORY_TYPES = ['mfr_profile', 'compliance_cert', 'factory_audit']
const CERT_TYPES = ['compliance_cert', 'factory_audit']

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
  const [certTab, setCertTab] = useState('all')
  const [mode, setMode] = useState('docs') // 'docs' | 'certs'
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

  // Certificate tracking data (US-DOC-04)
  const certData = useMemo(() => {
    const certs = active.filter(d => CERT_TYPES.includes(d.type) && d.expiryDate)
    const expired = certs.filter(d => isExpired(d.expiryDate))
    const expiring = certs.filter(d => isExpiringSoon(d.expiryDate) && !isExpired(d.expiryDate))
    const valid = certs.filter(d => !isExpired(d.expiryDate) && !isExpiringSoon(d.expiryDate))

    // Sort by urgency: expired first (most recently expired last), then expiring (soonest first), then active (soonest first)
    const sortByExpiry = (a, b) => new Date(a.expiryDate) - new Date(b.expiryDate)

    return {
      all: [...expired.sort(sortByExpiry), ...expiring.sort(sortByExpiry), ...valid.sort(sortByExpiry)],
      expired: expired.sort(sortByExpiry),
      expiring: expiring.sort(sortByExpiry),
      active: valid.sort(sortByExpiry),
    }
  }, [active])

  const certFiltered = certData[certTab] || certData.all

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

  const certTabs = [
    { id: 'all', l: `All (${certData.all.length})`, Icon: ClipboardList },
    { id: 'active', l: `Active (${certData.active.length})`, Icon: CheckCircle2 },
    { id: 'expiring', l: `Expiring (${certData.expiring.length})`, Icon: AlertTriangle },
    { id: 'expired', l: `Expired (${certData.expired.length})`, Icon: XCircle },
  ]

  const getMfrName = (mfrId, doc) => {
    if (!mfrId) return '—'
    const u = users.find(usr => String(usr.id) === String(mfrId))
    return u ? u.company : (doc?.uploadedByCompany || '—')
  }

  const daysUntilExpiry = d => {
    if (!d) return null
    const today = new Date(); today.setHours(0, 0, 0, 0)
    const exp = new Date(d); exp.setHours(0, 0, 0, 0)
    return Math.ceil((exp - today) / 86400000)
  }

  const certTypeName = type => DOC_TYPES.find(d => d.v === type)?.l || type

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

      {/* Mode toggle: Documents vs Certificate Tracker */}
      <div style={{ display: 'flex', gap: 0, borderBottom: `2px solid ${T.border}`, marginBottom: 16 }}>
        {[{ id: 'docs', l: 'Documents', Icon: Folder }, { id: 'certs', l: 'Certificate Tracker', Icon: Shield }].map(m => (
          <button key={m.id} onClick={() => setMode(m.id)}
            style={{ padding: '10px 22px', background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 700, color: mode === m.id ? T.primary : T.textMuted, borderBottom: `2px solid ${mode === m.id ? T.primary : 'transparent'}`, marginBottom: -2, fontFamily: 'inherit', display: 'inline-flex', alignItems: 'center', gap: 7 }}>
            <m.Icon size={15} />{m.l}
          </button>
        ))}
      </div>

      {mode === 'docs' && (
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

      {mode === 'certs' && (
        <>
          {/* Summary stats */}
          <Grid cols={4} gap={12} style={{ marginBottom: 18 }}>
            <StatCard label="Total Certificates" value={certData.all.length} icon={<ClipboardList size={20} color={T.info} />} bg={T.infoBg} />
            <StatCard label="Active" value={certData.active.length} icon={<CheckCircle2 size={20} color={T.success} />} bg={T.successBg} />
            <StatCard label="Expiring (30d)" value={certData.expiring.length} icon={<AlertTriangle size={20} color={T.warning} />} bg={T.warningBg} />
            <StatCard label="Expired" value={certData.expired.length} icon={<XCircle size={20} color={T.danger} />} bg={T.dangerBg} />
          </Grid>

          {(certData.expiring.length > 0 || certData.expired.length > 0) && (
            <div style={{ marginBottom: 14 }}>
              {certData.expired.length > 0 && <Alert type="danger">{certData.expired.length} certificate{certData.expired.length > 1 ? 's have' : ' has'} expired. Immediate renewal required.</Alert>}
              {certData.expiring.length > 0 && <Alert type="warning">{certData.expiring.length} certificate{certData.expiring.length > 1 ? 's are' : ' is'} expiring within 30 days. Chase renewals now.</Alert>}
            </div>
          )}

          {/* Certificate filter tabs */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
            {certTabs.map(ct => (
              <button key={ct.id} onClick={() => setCertTab(ct.id)}
                style={{ padding: '6px 16px', borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: 'pointer', background: certTab === ct.id ? (ct.id === 'expired' ? T.dangerBg : ct.id === 'expiring' ? T.warningBg : ct.id === 'active' ? T.successBg : T.primary) : T.surface, color: certTab === ct.id ? (ct.id === 'expired' ? T.danger : ct.id === 'expiring' ? T.warning : ct.id === 'active' ? T.success : '#fff') : T.textMuted, border: certTab === ct.id ? 'none' : `1px solid ${T.border}`, fontFamily: 'inherit' }}>
                <ct.Icon size={12} /> {ct.l}
              </button>
            ))}
          </div>

          {/* Certificate table */}
          <Card pad={false}>
            <div className="table-scroll">
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 680 }}>
                <thead>
                  <tr style={{ background: '#f8fafc' }}>
                    {['Status', 'Certificate', 'Type', 'Manufacturer', 'Issuer', 'Expiry Date', 'Days Left'].map(h => (
                      <th key={h} style={{ padding: '10px 16px', textAlign: 'left', fontSize: 10, fontWeight: 800, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.07em', whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {certFiltered.map(cert => {
                    const days = daysUntilExpiry(cert.expiryDate)
                    const expired = isExpired(cert.expiryDate)
                    const expiring = isExpiringSoon(cert.expiryDate) && !expired
                    const statusBg = expired ? T.dangerBg : expiring ? T.warningBg : T.successBg
                    const statusColor = expired ? T.danger : expiring ? T.warning : T.success
                    const StatusIcon = expired ? XCircle : expiring ? AlertTriangle : CheckCircle2
                    const statusLabel = expired ? 'Expired' : expiring ? 'Expiring' : 'Active'
                    const CertIcon = DOC_ICONS[cert.type] || FileText

                    return (
                      <tr key={cert.id} style={{ borderTop: `1px solid ${T.border}` }}>
                        <td style={{ padding: '10px 16px' }}>
                          <span style={{ padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: statusBg, color: statusColor, whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            <StatusIcon size={11} /> {statusLabel}
                          </span>
                        </td>
                        <td style={{ padding: '10px 16px' }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: T.text, display: 'flex', alignItems: 'center', gap: 6 }}><CertIcon size={13} /> {cert.name}</div>
                          <div style={{ fontSize: 10, color: T.textLight }}>Uploaded {fmtDate(cert.uploadedAt)}</div>
                        </td>
                        <td style={{ padding: '10px 16px', fontSize: 12, color: T.textMuted }}>{certTypeName(cert.type)}</td>
                        <td style={{ padding: '10px 16px', fontSize: 12, color: T.textMuted, fontWeight: 600 }}>{getMfrName(cert.mfrId, cert)}</td>
                        <td style={{ padding: '10px 16px', fontSize: 12, color: T.textMuted }}>{cert.issuer || '—'}</td>
                        <td style={{ padding: '10px 16px', fontSize: 12, color: expired ? T.danger : expiring ? T.warning : T.text, fontWeight: 600 }}>{fmtDate(cert.expiryDate)}</td>
                        <td style={{ padding: '10px 16px' }}>
                          <span style={{ fontSize: 13, fontWeight: 800, color: statusColor }}>
                            {expired ? `${Math.abs(days)}d overdue` : `${days}d`}
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                  {certFiltered.length === 0 && (
                    <tr><td colSpan={7}><EmptyState icon={<Shield size={26} color={T.textLight} />} title="No certificates found" desc={certTab === 'all' ? 'Upload compliance certificates to track them here' : `No ${certTab} certificates`} /></td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  )
}
