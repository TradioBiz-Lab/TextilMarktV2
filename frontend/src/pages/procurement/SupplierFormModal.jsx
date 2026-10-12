import { useState } from 'react'
import { Plus, X } from '../../icons.jsx'
import { T } from '../../constants.js'
import { Modal, Input, Select, Textarea, Btn, Alert, FlexRow, SectionLabel } from '../../components/ui.jsx'
import { suppliersApi } from '../../api.js'
import { SUPPLIER_TYPES } from '../../lib/procurement.js'
import { GST_STATE_OPTIONS, isValidGstin, normalizeGstin, stateName } from '../../lib/gst.js'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const blankContact = () => ({ name: '', role: '', phone: '', email: '' })

/** Add a supplier, or change one. `onSaved(supplier)` gets the server's version. */
export function SupplierFormModal({ supplier, onClose, onSaved }) {
  const editing = !!supplier
  const [f, setF] = useState(() => ({
    name: supplier?.name || '', type: supplier?.type || 'fabric_supplier', email: supplier?.email || '', phone: supplier?.phone || '',
    gstin: supplier?.gstin || '', stateCode: supplier?.stateCode || '', address: supplier?.address || '', city: supplier?.city || '', pincode: supplier?.pincode || '',
    paymentTerms: supplier?.paymentTerms || '', deliveryTerms: supplier?.deliveryTerms || '', notes: supplier?.notes || '',
    contacts: supplier?.contacts?.length ? supplier.contacts.map(c => ({ ...c })) : [],
  }))
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)
  const set = patch => { setF(p => ({ ...p, ...patch })); setErrors({}) }

  const gstin = normalizeGstin(f.gstin)
  const gstinValid = isValidGstin(gstin)
  const gstinState = gstinValid ? gstin.slice(0, 2) : ''
  const setContact = (i, patch) => set({ contacts: f.contacts.map((c, j) => (j === i ? { ...c, ...patch } : c)) })

  const submit = async () => {
    const errs = {}
    if (!f.name.trim()) errs.name = 'Required'
    if (f.email.trim() && !EMAIL_RE.test(f.email.trim())) errs.email = 'Enter a valid email address'
    if (gstin && !gstinValid) errs.gstin = 'That GSTIN does not look right: check each character'
    if (f.pincode.trim() && !/^\d{6}$/.test(f.pincode.trim())) errs.pincode = 'PIN code is 6 digits'
    for (const [i, c] of f.contacts.entries()) if (c.email.trim() && !EMAIL_RE.test(c.email.trim())) errs[`contact${i}`] = 'Enter a valid email address'
    if (Object.keys(errs).length) { setErrors(errs); return }
    setSaving(true)
    const body = {
      name: f.name.trim(), type: f.type, email: f.email.trim(), phone: f.phone.trim(), gstin,
      stateCode: gstinValid ? gstinState : f.stateCode, address: f.address.trim(), city: f.city.trim(), pincode: f.pincode.trim(),
      paymentTerms: f.paymentTerms.trim(), deliveryTerms: f.deliveryTerms.trim(), notes: f.notes.trim(),
      contacts: f.contacts.map(c => ({ name: c.name.trim(), role: c.role.trim(), phone: c.phone.trim(), email: c.email.trim() })).filter(c => c.name || c.phone || c.email),
    }
    try {
      const saved = editing ? await suppliersApi.update(supplier.id, body) : await suppliersApi.create(body)
      onSaved(saved)
    } catch (e) { setErrors({ _: e?.message || 'Could not save the supplier' }) } finally { setSaving(false) }
  }

  return (
    <Modal title={editing ? 'Edit supplier' : 'Add supplier'} subtitle="Only your company sees your suppliers" onClose={() => !saving && onClose()} size="lg">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="form-grid-2">
          <Input label="Supplier name *" value={f.name} onChange={e => set({ name: e.target.value })} error={errors.name} placeholder="Coimbatore Knit Fabrics" autoFocus />
          <Select label="Type" value={f.type} onChange={e => set({ type: e.target.value })}>
            {SUPPLIER_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
          </Select>
        </div>
        <div className="form-grid-2">
          <Input label="Email" type="email" inputMode="email" value={f.email} onChange={e => set({ email: e.target.value })} error={errors.email} placeholder="sales@mill.com" hint="Purchase orders are emailed here" />
          <Input label="Phone" type="tel" inputMode="tel" value={f.phone} onChange={e => set({ phone: e.target.value })} placeholder="+91 98430 11223" />
        </div>
        <div className="form-grid-2">
          <Input label="GSTIN" value={f.gstin} onChange={e => set({ gstin: normalizeGstin(e.target.value).slice(0, 15) })} error={errors.gstin}
            placeholder="33AABCC1234D1ZP" hint={gstinValid ? `Valid. State: ${stateName(gstinState)}` : 'Optional. It also sets the state.'} inputStyle={{ fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.04em' }} />
          {gstinValid ? (
            <Input label="State" value={`${stateName(gstinState)} (${gstinState})`} readOnly hint="From the GSTIN" inputStyle={{ background: T.bg }} />
          ) : (
            <Select label="State" value={f.stateCode} onChange={e => set({ stateCode: e.target.value })}>
              <option value="">Not set</option>
              {GST_STATE_OPTIONS.map(s => <option key={s.code} value={s.code}>{s.name}</option>)}
            </Select>
          )}
        </div>
        <Textarea label="Address" value={f.address} onChange={e => set({ address: e.target.value })} placeholder="Street, area" rows={2} />
        <div className="form-grid-2">
          <Input label="City" value={f.city} onChange={e => set({ city: e.target.value })} placeholder="Coimbatore" />
          <Input label="PIN code" inputMode="numeric" value={f.pincode} onChange={e => set({ pincode: e.target.value.replace(/\D/g, '').slice(0, 6) })} error={errors.pincode} placeholder="641018" />
        </div>
        <div className="form-grid-2">
          <Input label="Payment terms" value={f.paymentTerms} onChange={e => set({ paymentTerms: e.target.value })} placeholder="45 days from invoice" hint="Copied onto new purchase orders" />
          <Input label="Delivery terms" value={f.deliveryTerms} onChange={e => set({ deliveryTerms: e.target.value })} placeholder="Ex-mill, freight to pay" />
        </div>

        <div>
          <SectionLabel>People to call</SectionLabel>
          {f.contacts.map((c, i) => (
            <div key={i} style={{ marginTop: 8 }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, alignItems: 'start' }}>
                <Input value={c.name} onChange={e => setContact(i, { name: e.target.value })} placeholder="Name" aria-label={`Contact ${i + 1} name`} />
                <Input value={c.phone} type="tel" inputMode="tel" onChange={e => setContact(i, { phone: e.target.value })} placeholder="Phone" aria-label={`Contact ${i + 1} phone`} />
                <Input value={c.email} type="email" inputMode="email" onChange={e => setContact(i, { email: e.target.value })} placeholder="Email" error={errors[`contact${i}`]} aria-label={`Contact ${i + 1} email`} />
                <button type="button" onClick={() => set({ contacts: f.contacts.filter((_, j) => j !== i) })} aria-label={`Remove contact ${i + 1}`}
                  style={{ justifySelf: 'start', border: `1px solid ${T.border}`, background: T.surface, borderRadius: 8, width: 38, height: 38, cursor: 'pointer', color: T.textMuted, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><X size={14} /></button>
              </div>
            </div>
          ))}
          {f.contacts.length < 10 && (
            <button type="button" onClick={() => set({ contacts: [...f.contacts, blankContact()] })}
              style={{ marginTop: 8, background: 'none', border: 'none', color: T.primaryDeep, fontWeight: 700, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 0' }}>
              <Plus size={13} /> Add a person
            </button>
          )}
        </div>

        <Textarea label="Notes" value={f.notes} onChange={e => set({ notes: e.target.value })} placeholder="Anything worth remembering about this supplier" rows={2} />
        {errors._ && <Alert type="danger">{errors._}</Alert>}
        <FlexRow justify="flex-end" gap={8}>
          <Btn variant="secondary" onClick={onClose} disabled={saving}>Cancel</Btn>
          <Btn onClick={submit} disabled={saving}>{saving ? 'Saving...' : editing ? 'Save changes' : 'Add supplier'}</Btn>
        </FlexRow>
      </div>
    </Modal>
  )
}
