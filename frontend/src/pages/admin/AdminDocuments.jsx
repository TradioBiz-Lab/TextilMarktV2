import { useState, useMemo } from 'react'
import { T, DOC_TYPES, DOC_ICONS, isExpiringSoon, isExpired } from '../../constants.js'
import { Modal, Select, Input, Btn, Card, Alert, EmptyState, FlexRow, PageHeader, DocCard, FileUpload, StatCard, LoadingScreen, useToast, fileUploadPayload } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'

const CERT_TYPES = ['compliance_cert', 'factory_audit', 'chemical_cert', 'environmental_cert', 'insurance']

const fmtDate = d => {
  if (!d) return '—'
  const dt = new Date(d)
  return `${String(dt.getDate()).padStart(2, '0')}-${String(dt.getMonth() + 1).padStart(2, '0')}-${dt.getFullYear()}`
}

export function AdminDocuments() {
  const { docs, orders, users, loading, uploadDoc, getDocData } = useApp()
  const toast = useToast()
  const [show, setShow] = useState(false)
  const [filt, setFilt] = useState('all')
  const [certTab, setCertTab] = useState('all')
  const [mode, setMode] = useState('docs') // 'docs' | 'certs'
  const [openGroups, setOpenGroups] = useState(new Set())
  const toggleGroup = id => setOpenGroups(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  const [uf, setUf] = useState({ type: 'PO', name: '', issuer: 'Tradio', issueDate: new Date().toISOString().slice(0, 10), expiryDate: '', orderId: '', mfrId: null, buyerId: '' })
  const [fileData, setFileData] = useState(null)
  const [fileErr, setFileErr] = useState('')
  const [saving, setSaving] = useState(false)

  if (loading) return <LoadingScreen />

  const mfrUsers = users.filter(u => u.role === 'manufacturer')
  const buyerUsers = users.filter(u => u.role === 'buyer')
  const active = docs.filter(d => d.isActive !== false)
  const nonStageDocs = active.filter(d => d.stageIndex == null)
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

  const reset = () => { setUf({ type: 'PO', name: '', issuer: 'Tradio', issueDate: new Date().toISOString().slice(0, 10), expiryDate: '', orderId: '', mfrId: null, buyerId: '' }); setFileData(null); setFileErr('') }

  const submit = async () => {
    if (!fileData) { setFileErr('Please select a file.'); return }
    setSaving(true)
    try {
      await uploadDoc({ ...uf, expiryDate: uf.expiryDate || null, orderId: uf.orderId || null, mfrId: uf.mfrId || null, ...fileUploadPayload(fileData) })
      toast('Document uploaded', 'success')
      setShow(false); reset()
    } catch {
      toast('Failed to upload document', 'error')
    } finally { setSaving(false) }
  }

  const filterBtns = [
    { v: 'all', l: `All (${nonStageDocs.length})` }, { v: 'PO', l: 'Purchase Orders' }, { v: 'buyer_order', l: 'Buyer Orders' },
    { v: 'tech_pack', l: 'Tech Packs' }, { v: 'cost_sheet', l: 'Cost Sheets' },
    { v: 'compliance_cert', l: 'Compliance' }, { v: 'factory_audit', l: 'Audit Reports' },
    { v: 'mfr_profile', l: '🏭 Mfr Profiles' },
  ]

  const certTabs = [
    { id: 'all', l: `All (${certData.all.length})`, icon: '📋' },
    { id: 'active', l: `Active (${certData.active.length})`, icon: '🟢' },
    { id: 'expiring', l: `Expiring (${certData.expiring.length})`, icon: '⚠️' },
    { id: 'expired', l: `Expired (${certData.expired.length})`, icon: '❌' },
  ]

  const getMfrName = mfrId => {
    if (!mfrId) return '—'
    const u = users.find(usr => String(usr.id) === String(mfrId))
    return u ? u.company : '—'
  }

  const daysUntilExpiry = d => {
    if (!d) return null
    const today = new Date(); today.setHours(0, 0, 0, 0)
    const exp = new Date(d); exp.setHours(0, 0, 0, 0)
    return Math.ceil((exp - today) / 86400000)
  }

  const certTypeName = type => DOC_TYPES.find(d => d.v === type)?.l || type

  return (
    <div>
      {show && (() => {
        const isPO = uf.type === 'PO'
        const isBuyerOrder = uf.type === 'buyer_order'
        const isMfrProfile = uf.type === 'mfr_profile'
        const filteredOrders = isBuyerOrder && uf.buyerId
          ? orders.filter(o => String(o.buyerId) === String(uf.buyerId))
          : orders
        const modalTitle = isMfrProfile ? 'Upload Manufacturer Profile' : isPO ? 'Upload Purchase Order' : isBuyerOrder ? 'Upload Buyer Order' : 'Upload Document'
        const modalSub = isMfrProfile ? 'PDF profile visible to all users working with this manufacturer' : isPO ? 'Link this PO to the manufacturer it belongs to' : isBuyerOrder ? 'Link this order to the buyer and their order' : 'Document will be automatically distributed to relevant parties'
        const canSubmit = uf.name && fileData && !saving
          && (isPO ? !!uf.mfrId : true)
          && (isBuyerOrder ? (!!uf.buyerId && !!uf.orderId) : true)
          && (isMfrProfile ? !!uf.mfrId : true)
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
                {DOC_TYPES.map(t => <option key={t.v} value={t.v}>{t.l}</option>)}
              </Select>
              <Input label="Document Name" value={uf.name} onChange={e => setUf({ ...uf, name: e.target.value })} placeholder="Document title" />
            </div>
            {!isMfrProfile && (
              <Input label="Issuing Authority" value={uf.issuer} onChange={e => setUf({ ...uf, issuer: e.target.value })} />
            )}
            <div className="form-grid-2">
              {/* Buyer Order: show Buyer selector (compulsory) */}
              {isBuyerOrder && (
                <Select label="Link to Buyer *" value={uf.buyerId} onChange={e => setUf({ ...uf, buyerId: e.target.value, orderId: '' })}>
                  <option value="">— Select Buyer —</option>
                  {buyerUsers.map(b => <option key={b.id} value={b.id}>{b.company} ({b.name})</option>)}
                </Select>
              )}
              {/* Buyer Order: show Order selector (compulsory, filtered by buyer) */}
              {isBuyerOrder && (
                <Select label="Link to Order *" value={uf.orderId} onChange={e => setUf({ ...uf, orderId: e.target.value })} disabled={!uf.buyerId} style={{ opacity: !uf.buyerId ? 0.45 : 1 }}>
                  <option value="">— Select Order —</option>
                  {filteredOrders.map(o => <option key={o.id} value={o.id}>{o.id}</option>)}
                </Select>
              )}
              {/* PO: show Manufacturer selector (compulsory) */}
              {isPO && (
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
              {/* Generic docs: show both Order + Manufacturer as optional */}
              {!isPO && !isBuyerOrder && !isMfrProfile && (
                <Select label="Link to Order (optional)" value={uf.orderId} onChange={e => setUf({ ...uf, orderId: e.target.value })}>
                  <option value="">— None —</option>
                  {orders.map(o => <option key={o.id} value={o.id}>{o.id}</option>)}
                </Select>
              )}
              {!isPO && !isBuyerOrder && (
                <Select
                  label={isMfrProfile ? 'Manufacturer *' : 'Link to Manufacturer (optional)'}
                  value={uf.mfrId || ''}
                  onChange={e => setUf({ ...uf, mfrId: e.target.value || null })}
                >
                  <option value="">— None —</option>
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

      <PageHeader title="Document Repository" subtitle="All documents across orders and manufacturers" action={<Btn onClick={() => setShow(true)} icon="📎">Upload Document</Btn>} />

      {/* Mode toggle: Documents vs Certificate Tracker */}
      <div style={{ display: 'flex', gap: 0, borderBottom: `2px solid ${T.border}`, marginBottom: 16 }}>
        {[{ id: 'docs', l: 'All Documents' }, { id: 'certs', l: 'Certificate Tracker' }].map(m => (
          <button key={m.id} onClick={() => setMode(m.id)}
            style={{ padding: '10px 22px', background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 700, color: mode === m.id ? T.primary : T.textMuted, borderBottom: `2px solid ${mode === m.id ? T.primary : 'transparent'}`, marginBottom: -2, fontFamily: 'inherit' }}>
            {m.id === 'certs' ? '🛡 ' : '📁 '}{m.l}
          </button>
        ))}
      </div>

      {mode === 'docs' && (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
            {filterBtns.map(fb => (
              <button key={fb.v} onClick={() => setFilt(fb.v)}
                style={{ padding: '5px 14px', borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: 'pointer', background: filt === fb.v ? T.primary : T.surface, color: filt === fb.v ? '#fff' : T.textMuted, border: filt === fb.v ? 'none' : `1px solid ${T.border}`, fontFamily: 'inherit' }}>
                {fb.l}
              </button>
            ))}
          </div>
          {filt === 'all' ? (() => {
            // Buyer Docs = docs uploaded by a buyer user (Submit Requirement etc.).
            // Ops/admin reviews these here and extracts relevant ones to specific order folders.
            const buyerDocs = show2.filter(d => d.uploadedByRole === 'buyer')
            const buyerDocIds = new Set(buyerDocs.map(d => d.id))
            const remaining = show2.filter(d => !buyerDocIds.has(d.id))
            const withOrder = remaining.filter(d => d.orderId)
            const noOrder = remaining.filter(d => !d.orderId)
            const grouped = orders.map(o => ({ order: o, docs: withOrder.filter(d => String(d.orderId) === String(o.id)) })).filter(g => g.docs.length > 0)
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {/* Buyer Docs — all buyer-submitted requirement docs (RFQ/Tech Pack/PO) */}
                {buyerDocs.length > 0 && (() => {
                  const isOpen = openGroups.has('__buyer_docs__')
                  return (
                    <div style={{ border: `1px solid ${isOpen ? T.primary + '44' : T.border}`, borderRadius: 12, overflow: 'hidden', transition: 'border-color 0.15s' }}>
                      <button onClick={() => toggleGroup('__buyer_docs__')} style={{ width: '100%', padding: '11px 16px', background: isOpen ? T.primaryLight : '#fff7ed', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, fontFamily: 'inherit', transition: 'background 0.15s' }}>
                        <span style={{ fontSize: 13, color: isOpen ? T.primary : T.textMuted, transition: 'transform 0.15s', display: 'inline-block', transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}>›</span>
                        <span style={{ fontSize: 12, fontWeight: 700, color: T.text }}>📥 Buyer Docs</span>
                        <span style={{ fontSize: 10, color: T.textMuted, fontWeight: 600 }}>Requirement documents uploaded by buyers</span>
                        <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 700, color: '#9a3412', background: '#fed7aa', padding: '1px 8px', borderRadius: 10 }}>{buyerDocs.length}</span>
                      </button>
                      {isOpen && (
                        <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 6, borderTop: `1px solid ${T.border}` }}>
                          {buyerDocs.map(d => <DocCard key={d.id} doc={d} users={users} onGetData={getDocData} />)}
                        </div>
                      )}
                    </div>
                  )
                })()}

                {/* General Documents (admin/mfr uploads with no order) */}
                {noOrder.length > 0 && (() => {
                  const isOpen = openGroups.has('__general__')
                  return (
                    <div style={{ border: `1px solid ${T.border}`, borderRadius: 12, overflow: 'hidden' }}>
                      <button onClick={() => toggleGroup('__general__')} style={{ width: '100%', padding: '11px 16px', background: '#f8fafc', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, fontFamily: 'inherit' }}>
                        <span style={{ fontSize: 13, color: isOpen ? T.primary : T.textMuted, transition: 'transform 0.15s', display: 'inline-block', transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}>›</span>
                        <span style={{ fontSize: 12, fontWeight: 700, color: T.text }}>📁 General Documents</span>
                        <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 700, color: T.textMuted, background: '#e2e8f0', padding: '1px 8px', borderRadius: 10 }}>{noOrder.length}</span>
                      </button>
                      {isOpen && (
                        <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 6, borderTop: `1px solid ${T.border}` }}>
                          {noOrder.map(d => <DocCard key={d.id} doc={d} users={users} onGetData={getDocData} />)}
                        </div>
                      )}
                    </div>
                  )
                })()}

                {/* Order groups — collapsed by default */}
                {grouped.map(({ order: o, docs: oDocs }) => {
                  const isOpen = openGroups.has(o.id)
                  return (
                    <div key={o.id} style={{ border: `1px solid ${isOpen ? T.primary + '44' : T.border}`, borderRadius: 12, overflow: 'hidden', transition: 'border-color 0.15s' }}>
                      <button onClick={() => toggleGroup(o.id)} style={{ width: '100%', padding: '11px 16px', background: isOpen ? T.primaryLight : '#f8fafc', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, fontFamily: 'inherit', transition: 'background 0.15s' }}>
                        <span style={{ fontSize: 13, color: isOpen ? T.primary : T.textMuted, transition: 'transform 0.15s', display: 'inline-block', transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}>›</span>
                        <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 12, fontWeight: 800, color: T.primary }}>{o.id}</span>
                        <span style={{ fontSize: 12, color: T.text, fontWeight: 600 }}>{o.product}</span>
                        {o.season && <span style={{ fontSize: 10, fontWeight: 700, color: '#0369a1', background: '#dbeafe', padding: '1px 6px', borderRadius: 4 }}>{o.season}</span>}
                        <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 700, color: T.textMuted, background: '#e2e8f0', padding: '1px 8px', borderRadius: 10 }}>{oDocs.length}</span>
                      </button>
                      {isOpen && (
                        <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 6, borderTop: `1px solid ${T.border}` }}>
                          {oDocs.map(d => <DocCard key={d.id} doc={d} users={users} onGetData={getDocData} />)}
                        </div>
                      )}
                    </div>
                  )
                })}
                {show2.length === 0 && <Card><EmptyState icon="📁" title="No documents" desc="Upload your first document above" /></Card>}
              </div>
            )
          })() : (
            <>
              {show2.map(d => <DocCard key={d.id} doc={d} users={users} onGetData={getDocData} />)}
              {show2.length === 0 && <Card><EmptyState icon="📁" title="No documents" desc="Upload your first document above" /></Card>}
            </>
          )}
        </>
      )}

      {mode === 'certs' && (
        <>
          {/* Summary stats */}
          <Grid cols={4} gap={12} style={{ marginBottom: 18 }}>
            <StatCard label="Total Certificates" value={certData.all.length} icon="📋" bg={T.infoBg} />
            <StatCard label="Active" value={certData.active.length} icon="🟢" bg={T.successBg} />
            <StatCard label="Expiring (30d)" value={certData.expiring.length} icon="⚠️" bg={T.warningBg} />
            <StatCard label="Expired" value={certData.expired.length} icon="❌" bg={T.dangerBg} />
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
                {ct.icon} {ct.l}
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
                    const statusLabel = expired ? '❌ Expired' : expiring ? '⚠️ Expiring' : '🟢 Active'
                    const icon = DOC_ICONS[cert.type] || '📄'

                    return (
                      <tr key={cert.id} style={{ borderTop: `1px solid ${T.border}` }}>
                        <td style={{ padding: '10px 16px' }}>
                          <span style={{ padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: statusBg, color: statusColor, whiteSpace: 'nowrap' }}>
                            {statusLabel}
                          </span>
                        </td>
                        <td style={{ padding: '10px 16px' }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{icon} {cert.name}</div>
                          <div style={{ fontSize: 10, color: T.textLight }}>Uploaded {fmtDate(cert.uploadedAt)}</div>
                        </td>
                        <td style={{ padding: '10px 16px', fontSize: 12, color: T.textMuted }}>{certTypeName(cert.type)}</td>
                        <td style={{ padding: '10px 16px', fontSize: 12, color: T.textMuted, fontWeight: 600 }}>{getMfrName(cert.mfrId)}</td>
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
                    <tr><td colSpan={7}><EmptyState icon="🛡" title="No certificates found" desc={certTab === 'all' ? 'Upload compliance certificates to track them here' : `No ${certTab} certificates`} /></td></tr>
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
