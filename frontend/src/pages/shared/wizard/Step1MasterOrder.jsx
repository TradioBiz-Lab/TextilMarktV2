import { useState, useEffect } from 'react'
import { T, SEASONS } from '../../../constants.js'
import { Card, Btn, Input, Select, FlexRow, useToast, SectionLabel } from '../../../components/ui.jsx'
import { useApp } from '../../../context.jsx'

function randomPassword() {
  // 12 chars, guaranteed upper/lower/digit/special — satisfies the same
  // strength rule UserSetup.jsx enforces, generated so a master admin
  // creating a customer inline doesn't have to invent one on the spot.
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ', lower = 'abcdefghjkmnpqrstuvwxyz', digit = '23456789', special = '!@#$%&*'
  const pick = s => s[Math.floor(Math.random() * s.length)]
  let pw = pick(upper) + pick(lower) + pick(digit) + pick(special)
  const all = upper + lower + digit + special
  for (let i = 0; i < 8; i++) pw += pick(all)
  return pw.split('').sort(() => Math.random() - 0.5).join('')
}

export function Step1MasterOrder({ wizardState, patchState, onNext }) {
  const { currentUser, users, masterOrders, createMasterOrder, createUser, createMfrMasterProject, listMfrMasterProjects } = useApp()
  const toast = useToast()
  const isAdmin = wizardState.role === 'admin'
  const isMasterAdmin = isAdmin && currentUser?.adminType === 'master'

  const [buyerId, setBuyerId] = useState(wizardState.buyerId || '')
  const [buyerName, setBuyerName] = useState(wizardState.buyerName || '')
  const [orderName, setOrderName] = useState('')
  const [season, setSeason] = useState('SS26')
  const [notes, setNotes] = useState('')
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)

  const [showNewCustomer, setShowNewCustomer] = useState(false)
  const [nc, setNc] = useState({ name: '', email: '', company: '', phone: '', code: '' })
  const [ncErr, setNcErr] = useState('')

  const [existingBuyerNames, setExistingBuyerNames] = useState([])
  useEffect(() => {
    if (!isAdmin) listMfrMasterProjects().then(list => setExistingBuyerNames([...new Set(list.map(p => p.buyerName).filter(Boolean))])).catch(() => {})
  }, [isAdmin, listMfrMasterProjects])

  const buyerUsers = users.filter(u => u.role === 'buyer' && u.isActive)

  const createCustomer = async () => {
    setNcErr('')
    if (!nc.name.trim() || !nc.email.trim() || !nc.company.trim()) { setNcErr('Name, email, and company are required'); return }
    if (!nc.code.trim() || nc.code.trim().length < 3) { setNcErr('Company code must be 3–5 characters'); return }
    try {
      const user = await createUser({
        name: nc.name.trim(), email: nc.email.trim(), company: nc.company.trim(), phone: nc.phone.trim(),
        role: 'buyer', adminType: '', code: nc.code.trim().toUpperCase().slice(0, 5),
        password: randomPassword(),
      })
      setBuyerId(user.id)
      setShowNewCustomer(false)
      toast(`Customer "${user.company}" created — login emailed to ${user.email}`, 'success')
    } catch (e) {
      setNcErr(typeof e === 'string' ? e : (e?.message || 'Failed to create customer'))
    }
  }

  const genMoId = (bId) => {
    const b = users.find(u => u.id === bId)
    if (!b) return null
    const cnt = masterOrders.filter(m => m.buyerId === bId).length + 1
    return `MO-${b.code}-${season || 'XX'}-${String(cnt).padStart(3, '0')}`
  }

  const submit = async () => {
    setErr('')
    if (isAdmin) {
      if (!buyerId) { setErr('Select or create a customer first'); return }
      if (!orderName.trim()) { setErr('Order name is required'); return }
      const id = genMoId(buyerId)
      if (!id) { setErr('Could not resolve the customer — try again'); return }
      setSaving(true)
      try {
        const mo = await createMasterOrder({ id, buyerId, orderName: orderName.trim(), season })
        patchState({ masterOrderId: mo.id, buyerId })
        toast(`Master order ${mo.id} created`, 'success')
        onNext()
      } catch (e) {
        setErr(typeof e === 'string' ? e : (e?.message || 'Failed to create master order'))
      } finally {
        setSaving(false)
      }
    } else {
      setSaving(true)
      try {
        const mp = await createMfrMasterProject({ buyerName: buyerName.trim(), season, notes: notes.trim() })
        patchState({ mfrMasterProjectId: mp.id, buyerName: buyerName.trim() })
        toast('Master project created', 'success')
        onNext()
      } catch (e) {
        setErr(typeof e === 'string' ? e : (e?.message || 'Failed to create master project'))
      } finally {
        setSaving(false)
      }
    }
  }

  return (
    <Card>
      <SectionLabel>Step 1 — Master Order & Customer</SectionLabel>

      {isAdmin ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 480, marginTop: 10 }}>
          {!showNewCustomer ? (
            <>
              <Select label="Customer *" value={buyerId} onChange={e => setBuyerId(e.target.value)}>
                <option value="">Select an existing customer…</option>
                {buyerUsers.map(u => <option key={u.id} value={u.id}>{u.company} ({u.code})</option>)}
              </Select>
              {isMasterAdmin && (
                <button type="button" onClick={() => setShowNewCustomer(true)}
                  style={{ background: 'none', border: 'none', color: T.primary, fontSize: 12, fontWeight: 700, cursor: 'pointer', textAlign: 'left', padding: 0, fontFamily: 'inherit' }}>
                  + Create New Customer
                </button>
              )}
            </>
          ) : (
            <div style={{ border: `1px solid ${T.border}`, borderRadius: 10, padding: 14, background: '#fafbff', display: 'flex', flexDirection: 'column', gap: 10 }}>
              <FlexRow justify="space-between"><strong style={{ fontSize: 13 }}>New Customer</strong>
                <button type="button" onClick={() => setShowNewCustomer(false)} style={{ background: 'none', border: 'none', color: T.textMuted, cursor: 'pointer', fontSize: 12 }}>Cancel</button>
              </FlexRow>
              <Input label="Contact Name *" value={nc.name} onChange={e => setNc({ ...nc, name: e.target.value })} />
              <Input label="Email *" type="email" value={nc.email} onChange={e => setNc({ ...nc, email: e.target.value })} />
              <Input label="Company *" value={nc.company} onChange={e => setNc({ ...nc, company: e.target.value })} />
              <Input label="Phone" value={nc.phone} onChange={e => setNc({ ...nc, phone: e.target.value })} />
              <Input label="Company Code (3–5 chars) *" value={nc.code} onChange={e => setNc({ ...nc, code: e.target.value.toUpperCase().slice(0, 5) })} placeholder="ZAR" hint="Used in order IDs — must be unique" />
              {ncErr && <div style={{ fontSize: 12, color: T.danger, fontWeight: 600 }}>⚠ {ncErr}</div>}
              <Btn onClick={createCustomer}>Create Customer</Btn>
            </div>
          )}

          <Input label="Order Name *" value={orderName} onChange={e => setOrderName(e.target.value)} placeholder="e.g. FW26 Core Collection" />
          <Select label="Season" value={season} onChange={e => setSeason(e.target.value)}>
            {SEASONS.map(s => <option key={s} value={s}>{s}</option>)}
          </Select>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 480, marginTop: 10 }}>
          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 5 }}>Customer</label>
            <input list="wizard-buyer-names" value={buyerName} onChange={e => setBuyerName(e.target.value)}
              placeholder="Select an existing customer, or type a new one"
              style={{ width: '100%', border: `1px solid ${T.border}`, borderRadius: 8, padding: '10px 12px', fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box' }} />
            <datalist id="wizard-buyer-names">
              {existingBuyerNames.map(n => <option key={n} value={n} />)}
            </datalist>
            <div style={{ fontSize: 11, color: T.textLight, marginTop: 4 }}>This is your own client — Tradio has no record of them.</div>
          </div>
          <Select label="Season" value={season} onChange={e => setSeason(e.target.value)}>
            {SEASONS.map(s => <option key={s} value={s}>{s}</option>)}
          </Select>
          <Input label="Notes (optional)" value={notes} onChange={e => setNotes(e.target.value)} />
        </div>
      )}

      {err && <div style={{ fontSize: 12, color: T.danger, fontWeight: 600, marginTop: 12 }}>⚠ {err}</div>}

      <FlexRow justify="flex-end" style={{ marginTop: 20 }}>
        <Btn onClick={submit} disabled={saving}>{saving ? 'Creating…' : 'Next: Documents →'}</Btn>
      </FlexRow>
    </Card>
  )
}
