import { useState } from 'react'
import { T } from '../../constants.js'
import { Modal, Input, Select, Btn, Card, Alert, EmptyState, FlexRow, PageHeader, RoleBadge, Mono, LoadingScreen, FileUpload, useToast, fileUploadPayload } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'

function fmtDate(d) {
  if (!d) return '—'
  const dt = new Date(d)
  const dd = String(dt.getDate()).padStart(2, '0')
  const mm = String(dt.getMonth() + 1).padStart(2, '0')
  return `${dd}-${mm}-${dt.getFullYear()}`
}

export function UserSetup() {
  const { users, loading, createUser, updateUser, toggleUser, resetUserPw, uploadDoc } = useApp()
  const toast = useToast()
  const [tab, setTab] = useState('all')
  const [q, setQ] = useState('')
  const [showC, setShowC] = useState(false)
  const [f, setF] = useState({ name: '', email: '', password: '', company: '', phone: '', role: 'buyer', adminType: 'user', code: '' })
  const [errors, setErrors] = useState({})
  const [profileFile, setProfileFile] = useState(null)
  const [profileFileErr, setProfileFileErr] = useState('')
  const [saving, setSaving] = useState(false)
  const [tempPwInfo, setTempPwInfo] = useState(null)
  const [editUser, setEditUser] = useState(null)
  const [ef, setEf] = useState({ name: '', email: '', phone: '' })
  const [editErrors, setEditErrors] = useState({})
  const [editSaving, setEditSaving] = useState(false)

  if (loading) return <LoadingScreen />

  const validatePw = pw => {
    if (pw.length < 8) return 'Minimum 8 characters'
    if (!/[A-Z]/.test(pw)) return 'Must include uppercase letter'
    if (!/[a-z]/.test(pw)) return 'Must include lowercase letter'
    if (!/[0-9]/.test(pw)) return 'Must include a number'
    if (!/[^A-Za-z0-9]/.test(pw)) return 'Must include a special character'
    return ''
  }

  const filtered = users.filter(u => {
    const rm = tab === 'all' || (tab === 'admins' ? u.role === 'admin' : u.role === tab)
    const qm = !q || (u.name.toLowerCase().includes(q.toLowerCase()) || u.email.toLowerCase().includes(q.toLowerCase()) || u.company.toLowerCase().includes(q.toLowerCase()))
    return rm && qm
  })

  const counts = {
    all: users.length,
    buyer: users.filter(u => u.role === 'buyer').length,
    manufacturer: users.filter(u => u.role === 'manufacturer').length,
    admins: users.filter(u => u.role === 'admin').length,
  }

  const create = async () => {
    const errs = {}
    const pwE = validatePw(f.password)
    if (pwE) errs.password = pwE
    if (!f.name.trim()) errs.name = 'Required'
    if (!f.email.trim() || !/\S+@\S+\.\S+/.test(f.email)) errs.email = 'Valid email required'
    if (users.find(u => u.email === f.email)) errs.email = 'Email already in use'
    if (!f.company.trim()) errs.company = 'Required'
    if (f.role !== 'admin' && !f.code.trim()) errs.code = 'Required'
    if (f.role !== 'admin' && f.code.trim().length > 0 && (f.code.trim().length < 3 || f.code.trim().length > 5)) errs.code = 'Must be 3–5 characters'
    if (f.role !== 'admin' && f.code.trim() && users.find(u => u.code === f.code.toUpperCase().trim())) errs.code = 'Code already in use'
    if (f.role === 'manufacturer' && !profileFile) { setProfileFileErr('Manufacturer profile document is required'); return }
    if (Object.keys(errs).length) { setErrors(errs); return }
    setSaving(true)
    try {
      const newUser = await createUser({ ...f, code: f.role === 'admin' ? 'TRD' : f.code.toUpperCase().slice(0, 5) })
      if (f.role === 'manufacturer' && profileFile) {
        await uploadDoc({
          type: 'mfr_profile', name: `${f.company} — Manufacturer Profile`,
          issuer: f.company, issueDate: new Date().toISOString().slice(0, 10),
          expiryDate: null, mfrId: newUser.id, orderId: null,
          ...fileUploadPayload(profileFile),
        })
      }
      toast(`User ${f.name} created`, 'success')
      setShowC(false)
      setF({ name: '', email: '', password: '', company: '', phone: '', role: 'buyer', adminType: 'user', code: '' })
      setProfileFile(null)
      setProfileFileErr('')
      setErrors({})
    } catch (e) {
      toast(typeof e === 'string' ? e : 'Failed to create user', 'error')
    } finally { setSaving(false) }
  }

  const openEdit = (u) => {
    setEditUser(u)
    setEf({ name: u.name, email: u.email, phone: u.phone || '' })
    setEditErrors({})
  }

  const saveEdit = async () => {
    const errs = {}
    if (!ef.name.trim()) errs.name = 'Required'
    if (!ef.email.trim() || !/\S+@\S+\.\S+/.test(ef.email)) errs.email = 'Valid email required'
    if (ef.email.trim().toLowerCase() !== editUser.email.toLowerCase() && users.find(u => u.email.toLowerCase() === ef.email.trim().toLowerCase())) errs.email = 'Email already in use'
    if (Object.keys(errs).length) { setEditErrors(errs); return }
    setEditSaving(true)
    try {
      await updateUser(editUser.id, { name: ef.name.trim(), email: ef.email.trim(), phone: ef.phone.trim() || null })
      toast('User details updated', 'success')
      setEditUser(null)
    } catch (e) {
      setEditErrors({ _: typeof e === 'string' ? e : 'Update failed. Please try again.' })
    } finally { setEditSaving(false) }
  }

  const tabs = [
    { id: 'all', l: `All (${counts.all})` },
    { id: 'buyer', l: `Buyers (${counts.buyer})` },
    { id: 'manufacturer', l: `Manufacturers (${counts.manufacturer})` },
    { id: 'admins', l: `Admins (${counts.admins})` },
  ]

  return (
    <div>
      {showC && (
        <Modal title="Create New User" subtitle="User must change password on first login" onClose={() => { setShowC(false); setErrors({}); setProfileFile(null); setProfileFileErr('') }} size="lg">
          <div style={{ marginBottom: 14 }}><Alert type="success">👑 Master Admin privilege — only you can create platform users.</Alert></div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div className="form-grid-2">
              <Input label="Full Name *" value={f.name} onChange={e => { setF({ ...f, name: e.target.value }); setErrors({ ...errors, name: '' }) }} error={errors.name} placeholder="Jane Smith" />
              <Input label="Email Address *" type="email" value={f.email} onChange={e => { setF({ ...f, email: e.target.value }); setErrors({ ...errors, email: '' }) }} error={errors.email} placeholder="jane@company.com" />
            </div>
            <div className="form-grid-2">
              <Input label="Temporary Password *" type="password" value={f.password} onChange={e => { setF({ ...f, password: e.target.value }); setErrors({ ...errors, password: '' }) }} error={errors.password} placeholder="Min 8 chars + uppercase + number + special" hint="User must change on first login" />
              <Input label="Company *" value={f.company} onChange={e => { setF({ ...f, company: e.target.value }); setErrors({ ...errors, company: '' }) }} error={errors.company} placeholder="Company Ltd." />
            </div>
            <div className="form-grid-3">
              <Input label="Phone" value={f.phone} onChange={e => setF({ ...f, phone: e.target.value })} placeholder="+91-9876540000" />
              <Select label="Role *" value={f.role} onChange={e => { setF({ ...f, role: e.target.value, adminType: e.target.value === 'admin' ? 'user' : '', code: e.target.value === 'admin' ? 'TRD' : '' }); setProfileFile(null); setProfileFileErr('') }}>
                <option value="buyer">Buyer</option>
                <option value="manufacturer">Manufacturer</option>
                <option value="admin">Tradio Admin</option>
              </Select>
              {f.role === 'admin' ? (
                <Select label="Admin Type *" value={f.adminType} onChange={e => setF({ ...f, adminType: e.target.value })}>
                  <option value="user">Admin User</option>
                  <option value="master">Master Admin</option>
                </Select>
              ) : (
                <Input label="Company Code (3–5 chars) *" value={f.code} onChange={e => { setF({ ...f, code: e.target.value.toUpperCase().slice(0, 5) }); setErrors({ ...errors, code: '' }) }} error={errors.code} placeholder="ZAR" maxLength={5} hint="Used in Order IDs — must be unique, permanent" />
              )}
            </div>
            {f.role === 'manufacturer' && (
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
                  Manufacturer Profile Document <span style={{ color: T.danger }}>*</span>
                </div>
                <FileUpload
                  file={profileFile}
                  onFile={pf => { setProfileFile(pf); setProfileFileErr('') }}
                  error={profileFileErr}
                  onError={setProfileFileErr}
                />
                <div style={{ fontSize: 11, color: T.textMuted, marginTop: 4 }}>Upload a PDF or image (factory profile, certifications overview, etc.) — visible to buyers.</div>
              </div>
            )}
            {f.role === 'admin' && f.adminType === 'master' && <Alert type="warning">You are creating another Master Admin. They will have full user management access.</Alert>}
            <FlexRow justify="flex-end" gap={8} style={{ marginTop: 4 }}>
              <Btn variant="secondary" onClick={() => { setShowC(false); setErrors({}) }}>Cancel</Btn>
              <Btn onClick={create} disabled={saving} icon="✓">Create User</Btn>
            </FlexRow>
          </div>
        </Modal>
      )}
      {tempPwInfo && (
        <Modal title="Password Reset Successful" onClose={() => setTempPwInfo(null)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Alert type="success">Temporary password sent to <strong>{tempPwInfo.name}</strong> at {tempPwInfo.email}</Alert>
            <Alert type="warning">The user has been emailed their temporary password and will be required to change it on first login.</Alert>
            <FlexRow justify="flex-end">
              <Btn onClick={() => setTempPwInfo(null)}>Done</Btn>
            </FlexRow>
          </div>
        </Modal>
      )}
      {editUser && (
        <Modal title="Edit User Details" subtitle={`${editUser.name} · ${editUser.company}`} onClose={() => setEditUser(null)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Input label="Contact Person Name *" value={ef.name} onChange={e => { setEf({ ...ef, name: e.target.value }); setEditErrors({ ...editErrors, name: '' }) }} error={editErrors.name} placeholder="Jane Smith" />
            <Input label="Email Address *" type="email" value={ef.email} onChange={e => { setEf({ ...ef, email: e.target.value }); setEditErrors({ ...editErrors, email: '' }) }} error={editErrors.email} placeholder="jane@company.com" />
            <Input label="Phone Number" value={ef.phone} onChange={e => setEf({ ...ef, phone: e.target.value })} placeholder="+91-9876540000" />
            {editErrors._ && <div style={{ fontSize: 12, color: T.danger, fontWeight: 500 }}>⚠ {editErrors._}</div>}
            <FlexRow justify="flex-end" gap={8} style={{ marginTop: 4 }}>
              <Btn variant="secondary" onClick={() => setEditUser(null)}>Cancel</Btn>
              <Btn onClick={saveEdit} disabled={editSaving} icon="✓">{editSaving ? 'Saving…' : 'Save Changes'}</Btn>
            </FlexRow>
          </div>
        </Modal>
      )}
      <PageHeader
        title="User Setup"
        subtitle={<span style={{ color: T.master, fontWeight: 600 }}>👑 Master Admin exclusive — manage all platform accounts</span>}
        action={<Btn onClick={() => setShowC(true)} icon="➕">Create User</Btn>}
      />
      <div style={{ display: 'flex', gap: 0, borderBottom: `1px solid ${T.border}`, marginBottom: 14 }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            style={{ padding: '10px 18px', background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600, color: tab === t.id ? T.primary : T.textMuted, borderBottom: `2px solid ${tab === t.id ? T.primary : 'transparent'}`, fontFamily: 'inherit' }}>
            {t.l}
          </button>
        ))}
      </div>
      <input value={q} onChange={e => setQ(e.target.value)} placeholder="🔍  Search users by name, email, or company…"
        style={{ width: '100%', maxWidth: 380, border: `1px solid ${T.border}`, borderRadius: 8, padding: '7px 12px', fontSize: 13, color: T.text, background: '#f8fafc', fontFamily: 'inherit', marginBottom: 14 }} />
      <Card pad={false}>
        <div className="table-scroll">
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 680 }}>
            <thead>
              <tr style={{ background: '#f8fafc' }}>
                {['User', 'Email', 'Company', 'Role', 'Code', 'Status', 'Actions'].map(h => (
                  <th key={h} style={{ padding: '10px 18px', textAlign: 'left', fontSize: 10, fontWeight: 800, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.07em', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map(u => (
                <tr key={u.id} style={{ borderTop: `1px solid ${T.border}`, opacity: u.isActive ? 1 : 0.55 }}>
                  <td style={{ padding: '12px 18px' }}>
                    <FlexRow gap={10}>
                      <div style={{ width: 34, height: 34, borderRadius: '50%', background: u.role === 'admin' ? T.masterBg : u.role === 'buyer' ? '#dbeafe' : '#fef9c3', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 800, color: u.role === 'admin' ? T.master : u.role === 'buyer' ? T.info : '#92400e', flexShrink: 0 }}>{u.name[0]}</div>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{u.name}{u.adminType === 'master' && ' 👑'}</div>
                        <div style={{ fontSize: 10, color: T.textLight }}>Created {fmtDate(u.createdAt)}</div>
                      </div>
                    </FlexRow>
                  </td>
                  <td style={{ padding: '12px 18px', color: T.textMuted, fontSize: 13 }}>{u.email}</td>
                  <td style={{ padding: '12px 18px', color: T.textMuted, fontSize: 13 }}>{u.company}</td>
                  <td style={{ padding: '12px 18px' }}><RoleBadge role={u.role} adminType={u.adminType} /></td>
                  <td style={{ padding: '12px 18px' }}><Mono style={{ fontSize: 11 }}>{u.code || '—'}</Mono></td>
                  <td style={{ padding: '12px 18px' }}>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                      <span style={{ padding: '2px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: u.isActive ? T.successBg : '#f1f5f9', color: u.isActive ? T.success : T.textMuted }}>{u.isActive ? '● Active' : '○ Inactive'}</span>
                      {u.mustChangePw && <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 10, fontWeight: 700, background: T.warningBg, color: T.warning }}>🔑 Pending</span>}
                    </div>
                  </td>
                  <td style={{ padding: '12px 18px' }}>
                    {u.adminType === 'master' ? (
                      <span style={{ fontSize: 11, color: T.textLight, fontStyle: 'italic' }}>Protected</span>
                    ) : (
                      <FlexRow gap={6} style={{ flexWrap: 'nowrap' }}>
                        <button onClick={() => openEdit(u)}
                          style={{ padding: '4px 10px', borderRadius: 7, fontSize: 11, fontWeight: 600, cursor: 'pointer', background: T.primaryLight, color: T.primary, border: 'none', fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
                          ✏️ Edit
                        </button>
                        <button onClick={async () => {
                            try { await toggleUser(u.id); toast(`${u.name} ${u.isActive ? 'deactivated' : 'activated'}`, 'success') }
                            catch { toast('Failed to update user status', 'error') }
                          }}
                          style={{ padding: '4px 10px', borderRadius: 7, fontSize: 11, fontWeight: 600, cursor: 'pointer', background: u.isActive ? T.dangerBg : T.successBg, color: u.isActive ? T.danger : T.success, border: 'none', fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
                          {u.isActive ? 'Deactivate' : 'Activate'}
                        </button>
                        <button onClick={async () => {
                            try {
                              await resetUserPw(u.id)
                              setTempPwInfo({ name: u.name, email: u.email })
                              toast(`Password reset for ${u.name}`, 'success')
                            } catch { toast('Failed to reset password', 'error') }
                          }}
                          style={{ padding: '4px 10px', borderRadius: 7, fontSize: 11, fontWeight: 600, cursor: 'pointer', background: T.warningBg, color: T.warning, border: 'none', fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
                          Reset PW
                        </button>
                      </FlexRow>
                    )}
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && <tr><td colSpan={7}><EmptyState icon="👥" title="No users found" desc="Create your first user above" /></td></tr>}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}
