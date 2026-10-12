import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, Search } from '../../icons.jsx'
import { T } from '../../constants.js'
import { Modal, Input, Select, Btn, Alert, FlexRow, LoadingScreen, SectionLabel, Mono, useToast } from '../../components/ui.jsx'
import { DataTable } from '../../components/DataTable.jsx'
import { Switch } from '../../components/Switch.jsx'
import { orgsApi } from '../../api.js'
import { announceCompaniesChanged } from '../../lib/companiesEvents.js'

// The master admin's company management, for the standalone product: create a company with its
// owner, switch Tradio management on for a manufacturer, add teammates, and connect brands with the
// manufacturers they work with. Nothing here can turn a company's privacy back off: whether Tradio
// staff may look at a company is the company owner's own choice and is shown read-only.

const TONES = {
  neutral: { bg: '#f1f5f9', c: '#475569' },
  good: { bg: T.successBg, c: T.successDeep || T.success },
  warn: { bg: T.warningBg, c: T.warning },
  info: { bg: T.infoBg, c: T.info },
}
const pill = (text, tone = 'neutral') => (
  <span style={{ padding: '2px 9px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: TONES[tone].bg, color: TONES[tone].c, whiteSpace: 'nowrap' }}>{text}</span>
)

const typeLabel = type => (type === 'manufacturer' ? 'Manufacturer' : 'Brand')
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function SwitchRow({ title, desc, on, onChange, disabled, label }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, padding: '12px 0', borderBottom: `1px solid ${T.border}` }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{title}</div>
        <div style={{ fontSize: 12, color: T.textMuted, marginTop: 3, lineHeight: 1.5 }}>{desc}</div>
      </div>
      <Switch on={on} onChange={onChange} disabled={disabled} label={label} />
    </div>
  )
}

function NewCompanyModal({ onClose, onCreated }) {
  const toast = useToast()
  const [f, setF] = useState({ type: 'manufacturer', company: '', code: '', ownerName: '', ownerEmail: '', ownerPhone: '', tradioEnabled: false })
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)
  const set = patch => { setF(p => ({ ...p, ...patch })); setErrors({}) }

  const submit = async () => {
    const errs = {}
    const code = f.code.trim().toUpperCase()
    if (!f.company.trim()) errs.company = 'Required'
    if (code.length < 3 || code.length > 5) errs.code = 'Must be 3 to 5 characters'
    if (!f.ownerName.trim()) errs.ownerName = 'Required'
    if (!EMAIL_RE.test(f.ownerEmail.trim())) errs.ownerEmail = 'A valid email is required'
    if (Object.keys(errs).length) { setErrors(errs); return }
    setSaving(true)
    try {
      const org = await orgsApi.create({
        type: f.type, company: f.company.trim(), code,
        tradioEnabled: f.type === 'manufacturer' && f.tradioEnabled,
        owner: { name: f.ownerName.trim(), email: f.ownerEmail.trim(), phone: f.ownerPhone.trim() || undefined },
      })
      toast(`${org.name} created. ${org.ownerEmail} is emailed a temporary password.`, 'success')
      onCreated(org)
    } catch (e) {
      setErrors({ _: e?.message || 'Could not create the company' })
    } finally { setSaving(false) }
  }

  return (
    <Modal title="New company" subtitle="Creates the company and its owner's login" onClose={() => !saving && onClose()} size="lg">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="form-grid-2">
          <Select label="Type *" value={f.type} onChange={e => set({ type: e.target.value, tradioEnabled: false })}>
            <option value="manufacturer">Manufacturer</option>
            <option value="brand">Brand</option>
          </Select>
          <Input label="Company code (3 to 5 characters) *" value={f.code} onChange={e => set({ code: e.target.value.toUpperCase().slice(0, 5) })} error={errors.code} placeholder="TPR" maxLength={5} hint="Used in order numbers. Permanent." />
        </div>
        <Input label="Company name *" value={f.company} onChange={e => set({ company: e.target.value })} error={errors.company} placeholder="Tiruppur Textiles Pvt Ltd" />
        <div className="form-grid-2">
          <Input label="Owner name *" value={f.ownerName} onChange={e => set({ ownerName: e.target.value })} error={errors.ownerName} placeholder="Ravi Kumar" />
          <Input label="Owner email *" type="email" value={f.ownerEmail} onChange={e => set({ ownerEmail: e.target.value })} error={errors.ownerEmail} placeholder="ravi@company.com" />
        </div>
        <Input label="Owner phone" value={f.ownerPhone} onChange={e => set({ ownerPhone: e.target.value })} placeholder="+91 98765 40000" />
        {f.type === 'manufacturer' && (
          <SwitchRow title="Tradio managed" on={f.tradioEnabled} onChange={v => set({ tradioEnabled: v })} label="Tradio managed"
            desc="Tradio staff can take actions on this manufacturer's behalf, such as updating orders. Leave off for a factory that runs everything itself." />
        )}
        {errors._ && <Alert type="danger">{errors._}</Alert>}
        <FlexRow justify="flex-end" gap={8}>
          <Btn variant="secondary" disabled={saving} onClick={onClose}>Cancel</Btn>
          <Btn disabled={saving} onClick={submit}>{saving ? 'Creating...' : 'Create company'}</Btn>
        </FlexRow>
      </div>
    </Modal>
  )
}

function ManageCompany({ org, orgs, onClose, onChange, reload }) {
  const toast = useToast()
  const [name, setName] = useState(org.name)
  const [busy, setBusy] = useState('')
  const [confirmOff, setConfirmOff] = useState(false)
  const [member, setMember] = useState({ name: '', email: '', phone: '' })
  const [memberErr, setMemberErr] = useState('')
  const [connectId, setConnectId] = useState('')

  const byId = useMemo(() => new Map(orgs.map(o => [o.id, o])), [orgs])
  const partners = org.partnerIds.map(id => byId.get(id)).filter(Boolean)
  const connectable = orgs.filter(o => o.type !== org.type && o.isActive && !org.partnerIds.includes(o.id))

  // Companies answer with themselves as they now stand; a connection answers ok, so the list is re-read.
  const run = async (key, call, okMessage) => {
    setBusy(key)
    try {
      const result = await call()
      if (result?.id) onChange(result); else await reload()
      announceCompaniesChanged()
      if (okMessage) toast(okMessage, 'success')
      return true
    } catch (e) {
      toast(e?.message || 'That did not work', 'error')
      return false
    } finally { setBusy('') }
  }

  const addMember = async () => {
    if (!member.name.trim()) { setMemberErr('Enter their name'); return }
    if (!EMAIL_RE.test(member.email.trim())) { setMemberErr('Enter a valid email'); return }
    setMemberErr('')
    const ok = await run('member', () => orgsApi.addMember(org.id, { name: member.name.trim(), email: member.email.trim(), phone: member.phone.trim() || undefined }), `${member.name.trim()} added. They are emailed a temporary password.`)
    if (ok) setMember({ name: '', email: '', phone: '' })
  }

  return (
    <Modal title={org.name} subtitle={`${typeLabel(org.type)} - code ${org.code}`} onClose={() => !busy && onClose()} size="lg">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <div style={{ flex: 1 }}><Input label="Company name" value={name} onChange={e => setName(e.target.value)} /></div>
          <Btn disabled={busy === 'name' || !name.trim() || name.trim() === org.name} onClick={() => run('name', () => orgsApi.update(org.id, { name: name.trim() }), 'Name updated')}>Save</Btn>
        </div>

        <div style={{ marginTop: 8 }}>
          {org.type === 'manufacturer' && (
            <SwitchRow title="Tradio managed" on={org.tradioEnabled} disabled={busy === 'managed'} label="Tradio managed"
              onChange={v => run('managed', () => orgsApi.update(org.id, { tradioEnabled: v }), v ? 'Tradio can now take actions for this manufacturer' : 'Tradio can no longer take actions for this manufacturer')}
              desc="Tradio staff can take actions on this manufacturer's behalf. When off, staff can only look, and only if the company allows it." />
          )}
          <SwitchRow title="Active" on={org.isActive} disabled={busy === 'active'} label="Company is active"
            onChange={v => (v ? run('active', () => orgsApi.update(org.id, { isActive: true }), 'Company activated') : setConfirmOff(true))}
            desc="An inactive company is signed out everywhere and its team cannot log in. Orders and history are kept." />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, padding: '12px 0', borderBottom: `1px solid ${T.border}` }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>Tradio staff can look at this company</div>
              <div style={{ fontSize: 12, color: T.textMuted, marginTop: 3, lineHeight: 1.5 }}>Only the company's owner can change this, from their own Company page.</div>
            </div>
            {org.tradioCanView ? pill('Yes', 'good') : pill('Private', 'warn')}
          </div>
        </div>

        {confirmOff && (
          <Alert type="warning">
            <div style={{ fontWeight: 700, marginBottom: 4 }}>Deactivate {org.name}?</div>
            Everyone on the team is signed out at once and cannot log in until you activate the company again.
            <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              <Btn variant="danger" disabled={busy === 'active'} onClick={async () => { await run('active', () => orgsApi.update(org.id, { isActive: false }), 'Company deactivated'); setConfirmOff(false) }}>Deactivate</Btn>
              <Btn variant="secondary" onClick={() => setConfirmOff(false)}>Keep active</Btn>
            </div>
          </Alert>
        )}

        <div style={{ marginTop: 14 }}>
          <SectionLabel>Team ({org.members.length})</SectionLabel>
          {org.members.map(m => (
            <div key={m.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '8px 0', borderBottom: `1px solid ${T.border}` }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{m.name}</div>
                <div style={{ fontSize: 12, color: T.textMuted, overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.email}</div>
              </div>
              <span style={{ display: 'flex', gap: 6 }}>{m.orgRole === 'owner' && pill('Owner', 'info')}{!m.isActive && pill('Inactive')}</span>
            </div>
          ))}
          <div style={{ marginTop: 12, fontSize: 12, fontWeight: 700, color: T.textMuted }}>Add a teammate</div>
          <div className="form-grid-3" style={{ marginTop: 6, alignItems: 'flex-start' }}>
            <Input label="Name" value={member.name} onChange={e => { setMember({ ...member, name: e.target.value }); setMemberErr('') }} placeholder="Anita Rao" />
            <Input label="Email" type="email" value={member.email} onChange={e => { setMember({ ...member, email: e.target.value }); setMemberErr('') }} placeholder="anita@company.com" />
            <Input label="Phone (optional)" value={member.phone} onChange={e => setMember({ ...member, phone: e.target.value })} placeholder="+91 98765 40000" />
          </div>
          {memberErr && <div style={{ fontSize: 12, color: T.danger, fontWeight: 600, marginTop: 6 }}>{memberErr}</div>}
          <FlexRow justify="flex-end" style={{ marginTop: 8 }}>
            <Btn variant="secondary" disabled={busy === 'member'} onClick={addMember}>{busy === 'member' ? 'Adding...' : 'Add teammate'}</Btn>
          </FlexRow>
          <div style={{ fontSize: 12, color: T.textLight, marginTop: 4 }}>Everyone on the team acts as the company, so they all see the same orders. Each person signs in with their own login.</div>
        </div>

        <div style={{ marginTop: 14 }}>
          <SectionLabel>{org.type === 'manufacturer' ? 'Brands it works with' : 'Manufacturers it works with'} ({partners.length})</SectionLabel>
          {partners.length === 0 && <div style={{ fontSize: 12, color: T.textMuted, padding: '6px 0' }}>Not connected with anyone yet. A company can only create orders with the companies it is connected with.</div>}
          {partners.map(p => (
            <div key={p.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '8px 0', borderBottom: `1px solid ${T.border}` }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{p.name}</div>
                <div style={{ fontSize: 12, color: T.textMuted }}><Mono style={{ fontSize: 11 }}>{p.code}</Mono></div>
              </div>
              <Btn size="sm" variant="secondary" disabled={busy === `off-${p.id}`} onClick={() => run(`off-${p.id}`, () => orgsApi.disconnect(org.id, p.id), `Disconnected from ${p.name}`)}>Disconnect</Btn>
            </div>
          ))}
          {connectable.length > 0 && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginTop: 12 }}>
              <div style={{ flex: 1 }}>
                <Select label={`Connect with a ${org.type === 'manufacturer' ? 'brand' : 'manufacturer'}`} value={connectId} onChange={e => setConnectId(e.target.value)}>
                  <option value="">Select company...</option>
                  {connectable.map(o => <option key={o.id} value={o.id}>{o.name} ({o.code})</option>)}
                </Select>
              </div>
              <Btn disabled={!connectId || busy === 'connect'} onClick={async () => { const ok = await run('connect', () => orgsApi.connect(org.id, connectId), 'Connected'); if (ok) setConnectId('') }}>Connect</Btn>
            </div>
          )}
          <div style={{ fontSize: 12, color: T.textLight, marginTop: 8 }}>Disconnecting keeps existing orders as they are. It only stops new orders being created between the two.</div>
        </div>

        <FlexRow justify="flex-end" style={{ marginTop: 14 }}>
          <Btn variant="secondary" onClick={onClose}>Done</Btn>
        </FlexRow>
      </div>
    </Modal>
  )
}

export function CompaniesAdmin() {
  const [orgs, setOrgs] = useState(null)
  const [error, setError] = useState('')
  const [q, setQ] = useState('')
  const [kind, setKind] = useState('all')
  const [openId, setOpenId] = useState(null)
  const [showNew, setShowNew] = useState(false)

  const load = useCallback(async () => {
    try { setOrgs(await orgsApi.list()); setError('') } catch (e) { setError(e?.message || 'Could not load the companies') }
  }, [])
  useEffect(() => { load() }, [load])

  const put = org => setOrgs(list => (list || []).map(o => (o.id === org.id ? org : o)))

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase()
    return (orgs || []).filter(o => (kind === 'all' || o.type === kind)
      && (!s || o.name.toLowerCase().includes(s) || o.code.toLowerCase().includes(s) || (o.ownerEmail || '').toLowerCase().includes(s)))
  }, [orgs, q, kind])

  if (!orgs && !error) return <LoadingScreen message="Loading companies..." />

  const counts = { all: orgs?.length || 0, manufacturer: (orgs || []).filter(o => o.type === 'manufacturer').length, brand: (orgs || []).filter(o => o.type === 'brand').length }
  const open = orgs?.find(o => o.id === openId) || null

  const columns = [
    { key: 'name', header: 'Company', primary: true, render: o => (
      <div>
        <div style={{ fontWeight: 700, color: T.text }}>{o.name}</div>
        <div style={{ fontSize: 11, color: T.textLight, marginTop: 2 }}><Mono style={{ fontSize: 11 }}>{o.code}</Mono>{o.ownerName ? ` - ${o.ownerName}` : ''}</div>
      </div>
    ) },
    { key: 'type', header: 'Type', render: o => pill(typeLabel(o.type), o.type === 'manufacturer' ? 'warn' : 'info') },
    { key: 'tradio', header: 'Tradio managed', render: o => (o.type === 'manufacturer' ? (o.tradioEnabled ? pill('Managed', 'good') : pill('Not managed')) : '-') },
    { key: 'view', header: 'Tradio can look', hideOnMobile: true, render: o => (o.tradioCanView ? 'Yes' : pill('Private', 'warn')) },
    { key: 'team', header: 'Team', numeric: true, hideOnMobile: true, render: o => o.members.length },
    { key: 'partners', header: 'Connected', numeric: true, hideOnMobile: true, render: o => o.partnerIds.length },
    { key: 'status', header: 'Status', render: o => (o.isActive ? pill('Active', 'good') : pill('Inactive')) },
  ]

  return (
    <div>
      {showNew && <NewCompanyModal onClose={() => setShowNew(false)} onCreated={org => { setShowNew(false); setOrgs(l => [...(l || []), org].sort((a, b) => a.name.localeCompare(b.name))); setOpenId(org.id); announceCompaniesChanged() }} />}
      {open && <ManageCompany key={open.id} org={open} orgs={orgs} onClose={() => setOpenId(null)} onChange={put} reload={load} />}

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
        <div style={{ position: 'relative', flex: '1 1 260px', maxWidth: 380 }}>
          <Search size={13} color={T.textLight} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search by name, code or owner email" aria-label="Search companies"
            style={{ width: '100%', border: `1px solid ${T.border}`, borderRadius: 8, padding: '9px 12px 9px 32px', fontSize: 13, color: T.text, background: '#f8fafc', fontFamily: 'inherit', boxSizing: 'border-box' }} />
        </div>
        <div role="group" aria-label="Filter by type" style={{ display: 'flex', gap: 6 }}>
          {[['all', 'All'], ['manufacturer', 'Manufacturers'], ['brand', 'Brands']].map(([id, label]) => (
            <button key={id} type="button" aria-pressed={kind === id} onClick={() => setKind(id)}
              style={{ fontSize: 12, fontWeight: 700, padding: '7px 13px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit', border: `1px solid ${kind === id ? T.primary : T.border}`, background: kind === id ? T.primaryLight : T.surface, color: kind === id ? T.primaryDark : T.textMuted }}>
              {label} ({counts[id]})
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <Btn onClick={() => setShowNew(true)} icon={<Plus size={13} />}>New company</Btn>
      </div>

      {error && <Alert type="danger">{error}</Alert>}
      <DataTable columns={columns} rows={shown} rowKey="id" onRowClick={o => setOpenId(o.id)}
        empty={q || kind !== 'all' ? 'No company matches that.' : 'No companies yet. Create the first one with New company.'} />
    </div>
  )
}
