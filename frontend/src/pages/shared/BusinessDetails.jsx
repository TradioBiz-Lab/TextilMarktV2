import { useState } from 'react'
import { T } from '../../constants.js'
import { Btn, Card, Input, Select, Textarea, Alert, FlexRow, SectionLabel, useToast } from '../../components/ui.jsx'
import { orgsApi } from '../../api.js'
import { GST_STATE_OPTIONS, isValidGstin, isValidPan, normalizeGstin, stateName } from '../../lib/gst.js'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * The company's business details: what a purchase order's header says (who is buying, GSTIN, where to
 * deliver) and what decides CGST and SGST versus IGST. The owner edits them; everyone else sees them.
 */
export function BusinessDetails({ org, canEdit, onSaved }) {
  const toast = useToast()
  const p = org.profile || {}
  const [f, setF] = useState({ legalName: p.legalName || '', gstin: p.gstin || '', pan: p.pan || '', address: p.address || '', city: p.city || '', pincode: p.pincode || '', stateCode: p.stateCode || '', phone: p.phone || '', email: p.email || '' })
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)
  const set = patch => { setF(prev => ({ ...prev, ...patch })); setErrors({}) }
  const gstin = normalizeGstin(f.gstin)
  const gstinValid = isValidGstin(gstin)
  const dirty = Object.keys(f).some(k => (f[k] || '') !== (p[k] || ''))
  const complete = !!(p.gstin && p.address && p.stateCode)

  const save = async () => {
    const errs = {}
    if (gstin && !gstinValid) errs.gstin = 'That GSTIN does not look right: check each character'
    if (f.pan.trim() && !isValidPan(f.pan.trim())) errs.pan = 'PAN looks like ABCDE1234F'
    if (f.pincode.trim() && !/^\d{6}$/.test(f.pincode.trim())) errs.pincode = 'PIN code is 6 digits'
    if (f.email.trim() && !EMAIL_RE.test(f.email.trim())) errs.email = 'Enter a valid email address'
    if (Object.keys(errs).length) { setErrors(errs); return }
    setSaving(true)
    try {
      const saved = await orgsApi.updateProfile({
        legalName: f.legalName.trim(), gstin, pan: f.pan.trim().toUpperCase(), address: f.address.trim(), city: f.city.trim(), pincode: f.pincode.trim(),
        stateCode: gstinValid ? gstin.slice(0, 2) : f.stateCode, phone: f.phone.trim(), email: f.email.trim(),
      })
      toast('Business details saved', 'success')
      onSaved(saved)
    } catch (e) { setErrors({ _: e?.message || 'Could not save' }) } finally { setSaving(false) }
  }

  const readOnly = !canEdit
  return (
    <Card>
      <SectionLabel>Business details</SectionLabel>
      <div style={{ fontSize: 13, color: T.textMuted, marginTop: 6, lineHeight: 1.55 }}>
        These appear at the top of the purchase orders you send, and your state decides whether suppliers' GST is split into CGST and SGST or charged as IGST.
      </div>
      {!complete && <div style={{ marginTop: 12 }}><Alert type="warning">Fill in your GSTIN, address and state so your purchase orders look complete.</Alert></div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 14 }}>
        <Input label="Legal name" value={f.legalName} onChange={e => set({ legalName: e.target.value })} placeholder={org.name} readOnly={readOnly} hint="As it should appear on documents. Leave blank to use your company name." />
        <div className="form-grid-2">
          <Input label="GSTIN" value={f.gstin} onChange={e => set({ gstin: normalizeGstin(e.target.value).slice(0, 15) })} error={errors.gstin} readOnly={readOnly} placeholder="33AAPFU0939F1ZV"
            hint={gstinValid ? `Valid. State: ${stateName(gstin.slice(0, 2))}` : undefined} inputStyle={{ fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.04em' }} />
          <Input label="PAN" value={f.pan} onChange={e => set({ pan: e.target.value.toUpperCase().replace(/\s/g, '').slice(0, 10) })} error={errors.pan} readOnly={readOnly} placeholder="AAPFU0939F" inputStyle={{ fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.04em' }} />
        </div>
        <Textarea label="Address" value={f.address} onChange={e => set({ address: e.target.value })} rows={2} readOnly={readOnly} placeholder="Plot, street, area" />
        <div className="form-grid-3">
          <Input label="City" value={f.city} onChange={e => set({ city: e.target.value })} readOnly={readOnly} placeholder="Tiruppur" />
          <Input label="PIN code" inputMode="numeric" value={f.pincode} onChange={e => set({ pincode: e.target.value.replace(/\D/g, '').slice(0, 6) })} error={errors.pincode} readOnly={readOnly} placeholder="641604" />
          {gstinValid
            ? <Input label="State" value={`${stateName(gstin.slice(0, 2))} (${gstin.slice(0, 2)})`} readOnly hint="From the GSTIN" inputStyle={{ background: T.bg }} />
            : <Select label="State" value={f.stateCode} onChange={e => set({ stateCode: e.target.value })} disabled={readOnly}>
                <option value="">Not set</option>
                {GST_STATE_OPTIONS.map(s => <option key={s.code} value={s.code}>{s.name}</option>)}
              </Select>}
        </div>
        <div className="form-grid-2">
          <Input label="Phone" type="tel" inputMode="tel" value={f.phone} onChange={e => set({ phone: e.target.value })} readOnly={readOnly} placeholder="+91 98765 43003" />
          <Input label="Email on documents" type="email" inputMode="email" value={f.email} onChange={e => set({ email: e.target.value })} error={errors.email} readOnly={readOnly} placeholder="accounts@company.com" />
        </div>
        {errors._ && <Alert type="danger">{errors._}</Alert>}
        {canEdit
          ? <FlexRow justify="flex-end"><Btn onClick={save} disabled={saving || !dirty}>{saving ? 'Saving...' : 'Save details'}</Btn></FlexRow>
          : <div style={{ fontSize: 12, color: T.textLight }}>Only the owner of your company can change these.</div>}
      </div>
    </Card>
  )
}
