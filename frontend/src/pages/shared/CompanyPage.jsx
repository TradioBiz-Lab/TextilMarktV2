import { useEffect, useState } from 'react'
import { Building2, Factory, LockKey, ShieldCheck, Handshake } from '../../icons.jsx'
import { T } from '../../constants.js'
import { Btn, Card, PageHeader, Alert, LoadingScreen, EmptyState, SectionLabel, useToast } from '../../components/ui.jsx'
import { Switch } from '../../components/Switch.jsx'
import { useApp } from '../../context.jsx'
import { capsFor } from '../../caps.js'
import { orgsApi, partnersApi } from '../../api.js'

// A company's own page: who is on its team, which companies it is connected with, and who at Tradio
// may see its account. The last one is the company's own call, made only by its owner; Tradio cannot
// change it.

function Row({ left, right, sub }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 0', borderBottom: `1px solid ${T.border}` }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis' }}>{left}</div>
        {sub && <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub}</div>}
      </div>
      {right}
    </div>
  )
}

const tag = (text, tone = 'neutral') => {
  const t = { neutral: { bg: '#f1f5f9', c: '#475569' }, good: { bg: T.successBg, c: T.successDeep }, owner: { bg: T.primaryLight, c: T.primaryDark } }[tone]
  return <span style={{ padding: '2px 9px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: t.bg, color: t.c, whiteSpace: 'nowrap' }}>{text}</span>
}

export function CompanyPage() {
  const { currentUser: user } = useApp()
  const toast = useToast()
  const caps = capsFor(user)
  const [org, setOrg] = useState(null)
  const [partners, setPartners] = useState([])
  const [error, setError] = useState('')
  const [confirmOff, setConfirmOff] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let live = true
    Promise.all([orgsApi.mine(), partnersApi.list()])
      .then(([o, p]) => { if (live) { setOrg(o); setPartners(p) } })
      .catch(e => { if (live) setError(e?.message || 'Could not load your company') })
    return () => { live = false }
  }, [])

  const setAccess = async allow => {
    setSaving(true)
    try {
      setOrg(await orgsApi.setTradioAccess(allow))
      setConfirmOff(false)
      toast(allow ? 'Tradio staff can view your account again' : 'Tradio staff can no longer view your account', 'success')
    } catch (e) { toast(e?.message || 'Could not change this', 'error') } finally { setSaving(false) }
  }

  if (!org && !error) return <LoadingScreen message="Loading your company…" />
  if (error) return <div><PageHeader title="Company" /><Alert type="danger">{error}</Alert></div>

  const isMfr = org.type === 'manufacturer'
  const Icon = isMfr ? Factory : Building2
  const canView = org.tradioCanView !== false

  return (
    <div style={{ maxWidth: 820 }}>
      <PageHeader title="Company" subtitle="Your team, the companies you work with, and who at Tradio can see your account." />

      <Card>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div aria-hidden="true" style={{ width: 48, height: 48, borderRadius: 13, background: isMfr ? T.warningBg : T.infoBg, color: isMfr ? T.warning : T.info, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Icon size={24} /></div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 18, fontWeight: 800, color: T.text }}>{org.name}</div>
            <div style={{ fontSize: 13, color: T.textMuted, marginTop: 2 }}>{isMfr ? 'Manufacturer' : 'Brand'} · company code <span className="num" style={{ fontWeight: 700 }}>{org.code}</span></div>
          </div>
        </div>
      </Card>

      <div style={{ height: 14 }} />
      <Card>
        <SectionLabel>Who at Tradio can see your account</SectionLabel>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, justifyContent: 'space-between', marginTop: 8 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 700, color: T.text }}>
              {canView ? <ShieldCheck size={16} color={T.success} /> : <LockKey size={16} color={T.textMuted} />}
              {canView ? 'Tradio staff can view your account' : 'Your account is private from Tradio'}
            </div>
            <div style={{ fontSize: 13, color: T.textMuted, marginTop: 6, lineHeight: 1.55 }}>
              {canView
                ? 'Tradio staff can open your account read-only to help you. They cannot change anything unless you are a manufacturer Tradio manages.'
                : 'Tradio staff cannot see your orders, documents or messages, and cannot open your account. The companies you work with still see what they could before.'}
            </div>
          </div>
          <Switch on={canView} label="Allow Tradio staff to view my account" disabled={!caps.changeTradioAccess || saving}
            onChange={next => (next ? setAccess(true) : setConfirmOff(true))} />
        </div>
        {!caps.changeTradioAccess && <div style={{ fontSize: 12, color: T.textLight, marginTop: 10 }}>Only the owner of your company can change this.</div>}
        {confirmOff && (
          <div style={{ marginTop: 14 }}>
            <Alert type="warning">
              <div style={{ fontWeight: 700, marginBottom: 4 }}>Turn off Tradio access?</div>
              Tradio will not be able to see your orders, documents or messages, or help you if you report a problem, until you turn this back on.
              <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                <Btn variant="danger" disabled={saving} onClick={() => setAccess(false)}>{saving ? 'Saving...' : 'Turn off Tradio access'}</Btn>
                <Btn variant="secondary" disabled={saving} onClick={() => setConfirmOff(false)}>Keep it on</Btn>
              </div>
            </Alert>
          </div>
        )}
        {isMfr && (
          <div style={{ fontSize: 12, color: T.textMuted, marginTop: 14, paddingTop: 12, borderTop: `1px solid ${T.border}` }}>
            Tradio can take actions for you: <strong>{org.tradioEnabled ? 'yes, you are a Tradio managed manufacturer' : 'no'}</strong>
          </div>
        )}
      </Card>

      <div style={{ height: 14 }} />
      <Card>
        <SectionLabel>Team ({org.members.length})</SectionLabel>
        {org.members.map(m => (
          <Row key={m.id} left={m.name} sub={m.email} right={<span style={{ display: 'flex', gap: 6 }}>{m.orgRole === 'owner' && tag('Owner', 'owner')}{!m.isActive && tag('Inactive')}</span>} />
        ))}
        <div style={{ fontSize: 12, color: T.textLight, marginTop: 10 }}>Everyone on the team acts as the company: they see the same orders and their changes carry the company's name, with their own name in the history. To add a teammate, ask your Tradio contact.</div>
      </Card>

      <div style={{ height: 14 }} />
      <Card>
        <SectionLabel>{isMfr ? 'Brands you work with' : 'Manufacturers you work with'} ({partners.length})</SectionLabel>
        {partners.length === 0
          ? <EmptyState compact icon={<Handshake size={22} color={T.textLight} />} title="No connections yet" desc="You can create orders with companies once they are connected to you. Ask your Tradio contact." />
          : partners.map(p => <Row key={p.id} left={p.company} sub={`${p.code}${p.name ? ` · ${p.name}` : ''}`} right={tag(p.role === 'manufacturer' ? 'Manufacturer' : 'Brand')} />)}
      </Card>
      <div style={{ height: 24 }} />
    </div>
  )
}
