import { useState, useMemo } from 'react'
import { Plus, Trash2 } from '../../icons.jsx'
import { T } from '../../constants.js'
import { Modal, Input, Select, Textarea, Btn, Alert, SectionLabel, Grid } from '../../components/ui.jsx'
import { TagInput } from '../../components/TagInput.jsx'
import { useApp } from '../../context.jsx'
import { PARTNER_TYPES, CATEGORIES, CLUSTERS, STATUSES, SPECIALISED_SUGGESTIONS, COMMON_FABRICS, fieldsFor } from '../../partners.js'

// Add or edit a partner. Only a name and a type are required, so a partner can be added in seconds and filled in
// later. Fields that do not apply to the chosen type are hidden: machines, MOQ, products and fabric experience for
// garment manufacturers, fabric types for fabric suppliers, trim categories for trims suppliers.

const blankContact = () => ({ name: '', role: '', phone: '', email: '', whatsapp: '' })
const num = v => (v === '' || v === null || v === undefined ? '' : String(v))

function initialForm(p, initialType) {
  return {
    name: p?.name || '', legalName: p?.legalName || '', type: p?.type || initialType || 'garment_manufacturer',
    status: p?.status || 'new', isActive: p ? p.isActive : true,
    categories: p?.categories || [],
    cluster: p?.cluster || '', city: p?.city || '', address: p?.address || '', pincode: p?.pincode || '',
    fabrics: p?.fabrics || [], fabricTypes: p?.fabricTypes || [], trimCategories: p?.trimCategories || [],
    flatlock: num(p?.machines?.flatlock || ''), coverstitch: num(p?.machines?.coverstitch || ''), overlock: num(p?.machines?.overlock || ''), singleNeedle: num(p?.machines?.singleNeedle || ''),
    moqPerStyleColour: num(p?.moqPerStyleColour), moqNote: p?.moqNote || '',
    priceIndication: p?.priceIndication || '', leadTimeDays: num(p?.leadTimeDays),
    contacts: p?.contacts?.length ? p.contacts.map(c => ({ ...blankContact(), ...c })) : [],
    website: p?.website || '', logoUrl: p?.logoUrl || '', gstin: p?.gstin || '', udyam: p?.udyam || '', mcaCin: p?.mcaCin || '',
    source: p?.source || '', keywords: p?.keywords || [], notes: p?.notes || '',
  }
}

export function PartnerFormModal({ partner, initialType, onClose, onSaved }) {
  const { createPartner, updatePartner, partnerFacets } = useApp()
  const editing = !!partner
  const [f, setF] = useState(() => initialForm(partner, initialType))
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (k, v) => { setF(cur => ({ ...cur, [k]: v })); setErr('') }
  const show = fieldsFor(f.type)

  const sugg = useMemo(() => ({
    fabrics: [...new Set([...(partnerFacets?.fabrics.map(x => x.value) || []), ...COMMON_FABRICS])],
    trims: partnerFacets?.trimCategories.map(x => x.value) || [],
    keywords: [...new Set([...(partnerFacets?.keywords.map(x => x.value) || []), ...SPECIALISED_SUGGESTIONS])],
  }), [partnerFacets])

  const setContact = (i, k, v) => set('contacts', f.contacts.map((c, j) => (j === i ? { ...c, [k]: v } : c)))

  const submit = async e => {
    e.preventDefault()
    if (!f.name.trim()) { setErr('Give the partner a name.'); return }
    const body = {
      name: f.name, legalName: f.legalName, type: f.type, categories: f.categories, status: f.status, isActive: f.isActive,
      cluster: f.cluster || null, city: f.city, address: f.address, pincode: f.pincode,
      priceIndication: f.priceIndication, leadTimeDays: f.leadTimeDays === '' ? null : Number(f.leadTimeDays),
      contacts: f.contacts, website: f.website, logoUrl: f.logoUrl, gstin: f.gstin, udyam: f.udyam, mcaCin: f.mcaCin,
      source: f.source, keywords: f.keywords, notes: f.notes,
    }
    // A hidden section is left as it was (editing) or empty (adding); it is never sent blank over saved data.
    if (show.garment) {
      Object.assign(body, {
        fabrics: f.fabrics,
        machines: Object.fromEntries(['flatlock', 'coverstitch', 'overlock', 'singleNeedle'].map(k => [k, f[k] === '' ? 0 : Number(f[k])])),
        moqPerStyleColour: f.moqPerStyleColour === '' ? null : Number(f.moqPerStyleColour), moqNote: f.moqNote,
      })
    }
    if (show.fabricTypes) body.fabricTypes = f.fabricTypes
    if (show.trimCategories) body.trimCategories = f.trimCategories
    setBusy(true); setErr('')
    try {
      const saved = editing ? await updatePartner(partner.id, body) : await createPartner(body)
      onSaved(saved)
    } catch (e2) {
      setErr(e2?.message || 'Could not save the partner')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={editing ? `Edit ${partner.name}` : 'Add partner'} subtitle={editing ? undefined : 'Only the name and type are needed. The rest can be filled in later.'} size="xl" onClose={onClose}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {err && <Alert type="danger">{err}</Alert>}

        <div>
          <SectionLabel>Basics</SectionLabel>
          <Grid cols={2} gap={12}>
            <Input label="Name *" value={f.name} onChange={e => set('name', e.target.value)} maxLength={200} autoFocus />
            <Select label="Type *" value={f.type} onChange={e => set('type', e.target.value)}>
              {PARTNER_TYPES.map(t => <option key={t.v} value={t.v}>{t.label}</option>)}
            </Select>
            <Input label="Legal name" value={f.legalName} onChange={e => set('legalName', e.target.value)} maxLength={200} />
            <Input label="Website" value={f.website} onChange={e => set('website', e.target.value)} placeholder="example.com" maxLength={300} />
            <Select label="Status" value={f.status} onChange={e => set('status', e.target.value)}>
              {STATUSES.map(s => <option key={s.v} value={s.v}>{s.label}</option>)}
            </Select>
          </Grid>
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 5 }}>Categories (pick every one that applies)</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {CATEGORIES.map(c => {
                const on = f.categories.includes(c.v)
                return (
                  <button key={c.v} type="button" aria-pressed={on} onClick={() => { setF(cur => ({ ...cur, categories: cur.categories.includes(c.v) ? cur.categories.filter(x => x !== c.v) : [...cur.categories, c.v] })); setErr('') }}
                    style={{ padding: '6px 14px', borderRadius: T.radius.pill, cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit', border: `1px solid ${on ? T.primaryDeep : T.border}`, background: on ? T.primaryLight : '#fff', color: on ? T.primaryDeep : T.textMuted }}>{c.label}</button>
                )
              })}
            </div>
          </div>
        </div>

        <div>
          <SectionLabel>Location</SectionLabel>
          <Grid cols={2} gap={12}>
            <Select label="Cluster" value={f.cluster} onChange={e => set('cluster', e.target.value)}>
              <option value="">Not set</option>
              {CLUSTERS.map(c => <option key={c.v} value={c.v}>{c.label}</option>)}
            </Select>
            <Input label="City" value={f.city} onChange={e => set('city', e.target.value)} maxLength={120} />
            <Input label="Address" value={f.address} onChange={e => set('address', e.target.value)} maxLength={500} />
            <Input label="Pincode" value={f.pincode} onChange={e => set('pincode', e.target.value)} maxLength={12} />
          </Grid>
        </div>

        {(show.garment || show.fabricTypes || show.trimCategories) && (
          <div>
            <SectionLabel>{show.garment ? 'Capabilities' : show.fabricTypes ? 'Fabrics supplied' : 'Trims supplied'}</SectionLabel>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {show.garment && (
                <>
                  <TagInput label="Fabric experience" value={f.fabrics} onChange={v => set('fabrics', v)} suggestions={sugg.fabrics} snake placeholder="poly spandex, cotton lycra" />
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 5 }}>Machines (leave empty if unknown)</div>
                    <Grid cols={4} gap={10}>
                      {[['flatlock', 'Flatlock'], ['coverstitch', 'Coverstitch'], ['overlock', 'Overlock'], ['singleNeedle', 'Single needle']].map(([k, l]) => (
                        <Input key={k} type="number" min={0} max={9999} aria-label={l} placeholder={l} value={f[k]} onChange={e => set(k, e.target.value)} />
                      ))}
                    </Grid>
                  </div>
                </>
              )}
              {show.fabricTypes && <TagInput label="Fabric types" value={f.fabricTypes} onChange={v => set('fabricTypes', v)} suggestions={sugg.fabrics} snake placeholder="single jersey, rib, fleece" />}
              {show.trimCategories && <TagInput label="Trim categories" value={f.trimCategories} onChange={v => set('trimCategories', v)} suggestions={sugg.trims} snake placeholder="buttons, zips, labels, drawcords" />}
            </div>
          </div>
        )}

        <div>
          <SectionLabel>Commercial</SectionLabel>
          <Grid cols={2} gap={12}>
            {show.garment && <Input label="MOQ per style per colour (pieces)" type="number" min={0} value={f.moqPerStyleColour} onChange={e => set('moqPerStyleColour', e.target.value)} hint="Recorded as the partner's own claim until verified." />}
            {show.garment && <Input label="MOQ note" value={f.moqNote} onChange={e => set('moqNote', e.target.value)} placeholder="e.g. 100 pcs/style, 3 colours" maxLength={500} />}
            <Input label="Price indication" value={f.priceIndication} onChange={e => set('priceIndication', e.target.value)} placeholder="e.g. Rs 300 to 350 per legging" maxLength={300} />
            <Input label="Lead time (days)" type="number" min={0} value={f.leadTimeDays} onChange={e => set('leadTimeDays', e.target.value)} />
          </Grid>
        </div>

        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <SectionLabel>Contacts</SectionLabel>
            <Btn size="sm" variant="secondary" icon={<Plus size={12} />} onClick={() => set('contacts', [...f.contacts, blankContact()])}>Add contact</Btn>
          </div>
          {f.contacts.length === 0 && <div style={{ fontSize: 12, color: T.textLight }}>No contacts yet.</div>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {f.contacts.map((c, i) => (
              <div key={i} style={{ border: `1px solid ${T.border}`, borderRadius: 10, padding: 10, background: '#fafbff' }}>
                <Grid cols={3} gap={8}>
                  <Input aria-label="Contact name" placeholder="Name" value={c.name} onChange={e => setContact(i, 'name', e.target.value)} />
                  <Input aria-label="Contact role" placeholder="Role" value={c.role} onChange={e => setContact(i, 'role', e.target.value)} />
                  <Input aria-label="Contact phone" placeholder="Phone" value={c.phone} onChange={e => setContact(i, 'phone', e.target.value)} />
                  <Input aria-label="Contact email" placeholder="Email" value={c.email} onChange={e => setContact(i, 'email', e.target.value)} />
                  <Input aria-label="Contact WhatsApp" placeholder="WhatsApp" value={c.whatsapp} onChange={e => setContact(i, 'whatsapp', e.target.value)} />
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>
                    <Btn size="sm" variant="danger" icon={<Trash2 size={12} />} onClick={() => set('contacts', f.contacts.filter((_, j) => j !== i))}>Remove</Btn>
                  </div>
                </Grid>
              </div>
            ))}
          </div>
        </div>

        <div>
          <SectionLabel>Registrations</SectionLabel>
          <Grid cols={3} gap={12}>
            <Input label="GSTIN" value={f.gstin} onChange={e => set('gstin', e.target.value.toUpperCase())} maxLength={15} />
            <Input label="Udyam" value={f.udyam} onChange={e => set('udyam', e.target.value.toUpperCase())} maxLength={30} />
            <Input label="CIN" value={f.mcaCin} onChange={e => set('mcaCin', e.target.value.toUpperCase())} maxLength={25} />
          </Grid>
          <div style={{ fontSize: 11, color: T.textLight, marginTop: 4 }}>Verification checks (GST verified, sample approved and so on) are ticked on the partner's page, where each change is logged.</div>
        </div>

        <div>
          <SectionLabel>Source and notes</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Input label="Source" value={f.source} onChange={e => set('source', e.target.value)} placeholder="Where the lead came from, with the date" maxLength={500} />
            <TagInput label="Keywords (specialised products)" value={f.keywords} onChange={v => set('keywords', v)} suggestions={sugg.keywords} placeholder="sports bras, thermals, low moq" hint="Name a product here only if it is specialised (sports bras, leggings, thermals, socks). Tees, joggers and dresses are covered by the category. Searchable." />
            <Textarea label="Notes" value={f.notes} onChange={e => set('notes', e.target.value)} maxLength={5000} />
            <Input label="Logo link" value={f.logoUrl} onChange={e => set('logoUrl', e.target.value)} placeholder="https://" maxLength={2000} />
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: T.text, cursor: 'pointer' }}>
              <input type="checkbox" checked={f.isActive} onChange={e => set('isActive', e.target.checked)} style={{ accentColor: T.primaryDeep }} />
              Active (untick to archive: it stays on file, out of the default list)
            </label>
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
          <Btn type="submit" disabled={busy}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Add partner'}</Btn>
        </div>
      </form>
    </Modal>
  )
}
