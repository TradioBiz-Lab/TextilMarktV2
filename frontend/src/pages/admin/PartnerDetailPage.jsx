import { useState, useEffect, useMemo } from 'react'
import { ArrowLeft, Pencil, Trash2, MapPin, Mail, Phone, Globe, MessageCircle, Camera, Check, Eye, EyeOff, AlertTriangle, History } from '../../icons.jsx'
import { T } from '../../constants.js'
import { Card, Btn, Modal, Select, Alert, SectionLabel, LoadingScreen, Grid, useToast } from '../../components/ui.jsx'
import { PartnerImage, Chip, CategoryChips, TagChips, ScoreBadge, ClaimTag, LiveBadge, CopyChip } from '../../components/PartnerBits.jsx'
import { PartnerFormModal } from './PartnerFormModal.jsx'
import { useApp } from '../../context.jsx'
import { photoFromFile } from '../../colours.js'
import { TYPE_LABEL, CLUSTER_LABEL, STATUSES, VERIFICATION_CHECKS, fieldsFor, moqVerified, canBeLive, machineTotal } from '../../partners.js'

// One partner: who they are, what they can make, what they claim and what has been checked. Admin only.

const day = d => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : 'never')
const dayTime = d => (d ? new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '')

function Section({ title, action, children }) {
  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 10 }}>
        <SectionLabel>{title}</SectionLabel>
        {action}
      </div>
      {children}
    </Card>
  )
}

const Fact = ({ label, children }) => (
  <div style={{ marginBottom: 10 }}>
    <div style={{ fontSize: 11, fontWeight: 700, color: T.textLight, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>{label}</div>
    <div style={{ fontSize: T.fontSize.body, color: T.text }}>{children}</div>
  </div>
)
const Empty = ({ children }) => <span style={{ color: T.textLight }}>{children}</span>

export function PartnerDetailPage({ partnerId, onBack }) {
  const { partnersById, loadPartner, updatePartner, deletePartner, setPartnerImage, users, audit, refreshAudit } = useApp()
  const toast = useToast()
  const p = partnersById[partnerId]
  const [missing, setMissing] = useState(false)
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false)
  const [score, setScore] = useState(null) // the score being typed, not yet saved
  const [imgErr, setImgErr] = useState('')

  useEffect(() => {
    setMissing(false)
    loadPartner(partnerId).catch(() => setMissing(true))
    refreshAudit().catch(() => {}) // so Activity shows what happened since sign-in
  }, [partnerId, loadPartner, refreshAudit])

  const save = async (patch, done) => {
    setBusy(true)
    try { await updatePartner(partnerId, patch); refreshAudit().catch(() => {}); if (done) toast(done, 'success') }
    catch (e) { toast(e?.message || 'Could not save', 'error') }
    finally { setBusy(false) }
  }

  const upload = async file => {
    if (!file) return
    setBusy(true); setImgErr('')
    try { await setPartnerImage(partnerId, await photoFromFile(file, 640), await photoFromFile(file, 360)); refreshAudit().catch(() => {}); toast('Image saved', 'success') }
    catch (e) { setImgErr(e?.message || 'Could not save the image') }
    finally { setBusy(false) }
  }

  const userName = id => users.find(u => u.id === id)?.name || null
  const recent = useMemo(() => (p ? audit.filter(a => a.action.startsWith('Partner') && a.detail.startsWith(p.name)).slice(0, 8) : []), [audit, p])

  if (!p) {
    return missing
      ? <div style={{ padding: 40, textAlign: 'center', color: T.textMuted }}>This partner no longer exists. <Btn variant="secondary" onClick={onBack}>Back to Partners</Btn></div>
      : <LoadingScreen message="Loading partner…" />
  }

  const show = fieldsFor(p.type)
  const v = p.verification
  const scoreValue = score === null ? (v.score ?? '') : score
  const scoreDirty = score !== null && String(score) !== String(v.score ?? '')
  const hasCapabilities = p.products.length + p.fabrics.length + p.fabricTypes.length + p.trimCategories.length > 0
  const machines = [['Flatlock', p.machines.flatlock], ['Coverstitch', p.machines.coverstitch], ['Overlock', p.machines.overlock], ['Single needle', p.machines.singleNeedle]]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 1100 }}>
      <button type="button" onClick={onBack} style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', color: T.textMuted, fontWeight: 700, fontSize: 13, fontFamily: 'inherit', padding: 0 }}>
        <ArrowLeft size={14} /> Partners
      </button>

      {/* Header */}
      <Card pad={false}>
        <div style={{ display: 'flex', flexWrap: 'wrap' }}>
          <div style={{ width: 240, maxWidth: '100%', flexShrink: 0 }}><PartnerImage partner={p} height={190} /></div>
          <div style={{ flex: 1, minWidth: 260, padding: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0 }}>
                <h1 style={{ fontSize: 22, fontWeight: 800, color: T.text, margin: 0, letterSpacing: '-0.02em', overflowWrap: 'anywhere' }}>{p.name}</h1>
                {p.legalName && p.legalName !== p.name && <div style={{ fontSize: 12, color: T.textLight, marginTop: 2 }}>{p.legalName}</div>}
              </div>
              <ScoreBadge score={v.score} size="lg" />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <Chip>{TYPE_LABEL[p.type]}</Chip>
              {(p.city || p.cluster) && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: T.fontSize.body, color: T.textMuted }}><MapPin size={13} />{p.city}</span>}
              {p.cluster && <Chip tone="place">{CLUSTER_LABEL[p.cluster]}</Chip>}
              {p.isLive && <LiveBadge />}
              {!p.isActive && <Chip>Archived</Chip>}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              {p.categories.length ? <CategoryChips categories={p.categories} /> : <span style={{ fontSize: T.fontSize.sm, color: T.textLight }}>No category yet. Use Edit to set athleisure, Indian, western, fusion or home textiles.</span>}
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div style={{ width: 160 }}>
                <Select label="Status" value={p.status} disabled={busy} onChange={e => save({ status: e.target.value }, 'Status updated')}>
                  {STATUSES.map(s => <option key={s.v} value={s.v} disabled={s.v === 'live' && !canBeLive(p)}>{s.label}{s.v === 'live' && !canBeLive(p) ? ' (needs a platform account)' : ''}</option>)}
                </Select>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 'auto' }}>
              <Btn variant="secondary" icon={<Pencil size={13} />} onClick={() => setEditing(true)}>Edit</Btn>
              <Btn variant="secondary" icon={p.isActive ? <EyeOff size={13} /> : <Eye size={13} />} disabled={busy} onClick={() => save({ isActive: !p.isActive }, p.isActive ? 'Archived: kept on file, out of the default list' : 'Restored to the list')}>{p.isActive ? 'Archive' : 'Restore'}</Btn>
              <Btn variant="danger" icon={<Trash2 size={13} />} onClick={() => setConfirmDelete(true)}>Delete</Btn>
            </div>
          </div>
        </div>
      </Card>

      {/* What the Live status means for this partner */}
      <div style={{ fontSize: T.fontSize.sm, lineHeight: 1.5, padding: '10px 14px', borderRadius: T.radius.md, border: `1px solid ${p.status === 'live' ? T.successBorder : T.border}`, background: p.status === 'live' ? T.successBg : T.surface, color: T.textMuted }}>
        {p.status === 'live'
          ? <><strong style={{ color: T.successDeep }}>Live.</strong> This manufacturer has orders with Tradio now and can be given styles. Change the status to stop new styles going to it; the work it already has stays.</>
          : canBeLive(p)
            ? <>It has a manufacturer account. Set the status to <strong>Live</strong> once it has orders with Tradio; until then it cannot be given a style.</>
            : <>No manufacturer account yet. <strong>Live</strong> needs one: create it in User Setup, and it will show up here.</>}
      </div>

      <Grid cols={2} gap={16}>
        <Section title={show.garment ? 'Capabilities and machines' : show.fabricTypes ? 'Fabrics supplied' : show.trimCategories ? 'Trims supplied' : 'Capabilities'}>
          <Fact label="Brands they work with">{p.brands.length ? <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>{p.brands.map(b => <Chip key={b}>{b}</Chip>)}</div> : <Empty>Not recorded</Empty>}</Fact>
          {!hasCapabilities && !show.garment && <Empty>Nothing else recorded yet.</Empty>}
          {show.garment && (
            <>
              <Fact label="Specialised products and keywords">{p.keywords.length ? <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>{p.keywords.map(k => <Chip key={k}>{k}</Chip>)}</div> : <Empty>None named. Add a keyword only for a specialised product.</Empty>}</Fact>
              <Fact label="Fabric experience">{p.fabrics.length ? <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}><TagChips tags={p.fabrics} tone="fabric" max={30} /></div> : <Empty>Not recorded</Empty>}</Fact>
              <Fact label="Machines">
                <div style={{ fontSize: T.fontSize.md, marginBottom: 8 }}>{machineTotal(p) !== null ? <><strong>{machineTotal(p)}</strong> in all{p.machineCount === null && <span style={{ color: T.textLight }}> (sum of the types below)</span>}</> : <Empty>Total not recorded</Empty>}</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 6 }}>
                  {machines.map(([l, n]) => (
                    <div key={l} style={{ border: `1px solid ${T.border}`, borderRadius: 8, padding: '6px 10px', display: 'flex', justifyContent: 'space-between', fontSize: T.fontSize.sm }}>
                      <span style={{ color: T.textMuted }}>{l}</span><strong style={{ color: n ? T.text : T.textLight }}>{n || 'unknown'}</strong>
                    </div>
                  ))}
                </div>
              </Fact>
            </>
          )}
          {show.fabricTypes && (p.fabricTypes.length ? <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}><TagChips tags={p.fabricTypes} tone="fabric" max={30} /></div> : <Empty>No fabric types recorded yet.</Empty>)}
          {show.trimCategories && (p.trimCategories.length ? <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}><TagChips tags={p.trimCategories} tone="trim" max={30} /></div> : <Empty>No trim categories recorded yet.</Empty>)}
          {!show.garment && !show.fabricTypes && !show.trimCategories && hasCapabilities && (
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}><TagChips tags={[...p.products, ...p.fabrics, ...p.fabricTypes, ...p.trimCategories]} max={30} /></div>
          )}
        </Section>

        <Section title="MOQ and commercial terms">
          {show.garment && (
            <Fact label="MOQ per style per colour">
              {p.moqPerStyleColour !== null
                ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}><strong>{p.moqPerStyleColour} pieces</strong>{moqVerified(p) ? <Chip tone="plain">verified</Chip> : <ClaimTag />}</span>
                : <Empty>Not recorded</Empty>}
              {p.moqNote && <div style={{ fontSize: T.fontSize.sm, color: T.textMuted, marginTop: 3 }}>{p.moqNote}</div>}
              {p.moqPerStyleColour !== null && !moqVerified(p) && <div style={{ fontSize: T.fontSize.xs, color: T.textLight, marginTop: 3 }}>The partner's own claim. It counts as verified once GST is verified or a sample is approved.</div>}
            </Fact>
          )}
          <Fact label="Price indication">{p.priceIndication || <Empty>Not recorded</Empty>}</Fact>
          <Fact label="Lead time">{p.leadTimeDays !== null ? `${p.leadTimeDays} days` : <Empty>Not recorded</Empty>}</Fact>
          <Fact label="Registrations">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {[['GSTIN', p.gstin], ['Udyam', p.udyam], ['CIN', p.mcaCin]].map(([l, val]) => (
                <div key={l} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: T.fontSize.sm }}><span style={{ width: 52, color: T.textLight }}>{l}</span>{val ? <CopyChip value={val} mono /> : <Empty>not recorded</Empty>}</div>
              ))}
            </div>
          </Fact>
        </Section>

        <Section title="Contacts">
          {p.contacts.length === 0 && <Empty>No contacts recorded. Use Edit to add one.</Empty>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {p.contacts.map((c, i) => (
              <div key={i} style={{ border: `1px solid ${T.border}`, borderRadius: 10, padding: '10px 12px' }}>
                <div style={{ fontWeight: 700, color: T.text, fontSize: T.fontSize.body }}>{c.name || 'Unnamed contact'}{c.role && <span style={{ fontWeight: 500, color: T.textLight }}> · {c.role}</span>}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 1, marginTop: 4 }}>
                  {c.phone && <CopyChip value={c.phone} icon={<Phone size={13} color={T.textLight} />} />}
                  {c.whatsapp && c.whatsapp !== c.phone && <CopyChip value={c.whatsapp} icon={<MessageCircle size={13} color={T.success} />} />}
                  {c.email && <CopyChip value={c.email} icon={<Mail size={13} color={T.textLight} />} />}
                </div>
              </div>
            ))}
          </div>
          {p.website && (
            <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 6, fontSize: T.fontSize.body }}>
              <Globe size={13} color={T.textLight} />
              <a href={p.website} target="_blank" rel="noopener noreferrer" style={{ color: T.primaryDeep, fontWeight: 600, overflowWrap: 'anywhere' }}>{p.website.replace(/^https?:\/\//, '')}</a>
            </div>
          )}
        </Section>

        <Section title="Verification">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {VERIFICATION_CHECKS.map(ck => {
              const on = v[ck.key]
              return (
                <button key={ck.key} type="button" disabled={busy} aria-pressed={on} onClick={() => save({ verification: { [ck.key]: !on } }, `${ck.label}: ${on ? 'cleared' : 'ticked'}`)}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left', padding: '7px 10px', borderRadius: 9, cursor: busy ? 'wait' : 'pointer', fontFamily: 'inherit', border: `1px solid ${on ? T.successBorder : T.border}`, background: on ? T.successBg : '#fff' }}>
                  <span style={{ width: 20, height: 20, borderRadius: 6, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: on ? T.successDeep : '#fff', border: `1.5px solid ${on ? T.successDeep : T.borderHover}` }}>{on && <Check size={13} color="#fff" strokeWidth={3} />}</span>
                  <span style={{ flex: 1 }}>
                    <span style={{ display: 'block', fontSize: T.fontSize.body, fontWeight: 700, color: T.text }}>{ck.label}</span>
                    <span style={{ display: 'block', fontSize: T.fontSize.xs, color: T.textLight }}>{ck.hint}</span>
                  </span>
                </button>
              )
            })}
          </div>
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 5 }}>Verification score (0 to 100)</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <input type="range" min={0} max={100} step={5} value={scoreValue === '' ? 0 : scoreValue} onChange={e => setScore(Number(e.target.value))} aria-label="Verification score" style={{ flex: 1, minWidth: 140, accentColor: T.primaryDeep }} />
              <input type="number" min={0} max={100} value={scoreValue} onChange={e => setScore(e.target.value === '' ? '' : Math.min(100, Math.max(0, Number(e.target.value))))} aria-label="Score number" style={{ width: 70, border: `1px solid ${T.border}`, borderRadius: 8, padding: '6px 8px', fontSize: 13, fontFamily: 'inherit' }} />
              <Btn size="sm" disabled={!scoreDirty || busy} onClick={async () => { await save({ verification: { score: score === '' ? null : score } }, 'Score saved'); setScore(null) }}>Save score</Btn>
            </div>
            <div style={{ fontSize: T.fontSize.xs, color: T.textLight, marginTop: 6 }}>Last checked {day(v.lastCheckedAt)}. Every change here is recorded in the Audit Log.</div>
          </div>
        </Section>

        <Section title="Source and notes">
          <Fact label="Source">{p.source || <Empty>Not recorded</Empty>}</Fact>
          {!show.garment && <Fact label="Keywords">{p.keywords.length ? <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>{p.keywords.map(k => <Chip key={k}>{k}</Chip>)}</div> : <Empty>None</Empty>}</Fact>}
          <Fact label="Notes">{p.notes ? <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.5 }}>{p.notes}</div> : <Empty>None</Empty>}</Fact>
          {p.address && <Fact label="Address">{p.address}{p.pincode ? `, ${p.pincode}` : ''}</Fact>}
        </Section>

        <Section title="Image">
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <div style={{ width: 200, borderRadius: 10, overflow: 'hidden', border: `1px solid ${T.border}` }}><PartnerImage partner={p} height={130} /></div>
            <div style={{ flex: 1, minWidth: 200 }}>
              <div style={{ fontSize: T.fontSize.sm, color: T.textMuted, lineHeight: 1.5, marginBottom: 10 }}>The tile that stands in for the partner on the cards. It is a generated picture, not a photo of the factory.</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', fontSize: 13, fontWeight: 600, borderRadius: 8, background: busy ? '#e2e8f0' : T.primaryDeep, color: '#fff', cursor: busy ? 'wait' : 'pointer' }}>
                  <Camera size={14} color="#fff" /> {p.hasUpload || p.imageUrl ? 'Replace image' : 'Upload image'}
                  <input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} style={{ display: 'none' }} onChange={e => { const f = e.target.files[0]; e.target.value = ''; upload(f) }} />
                </label>
                {(p.hasUpload || p.imageUrl) && <Btn variant="secondary" disabled={busy} onClick={async () => { setBusy(true); try { await setPartnerImage(partnerId, null); toast('Image removed', 'success') } catch (e) { toast(e?.message || 'Could not remove', 'error') } finally { setBusy(false) } }}>Remove</Btn>}
              </div>
              <div style={{ fontSize: T.fontSize.xs, color: T.textLight, marginTop: 6 }}>JPEG, PNG or WebP. It is shrunk to about 640 pixels wide here before it is saved. Do not use photos or logos taken from the partner's website.</div>
              {imgErr && <div style={{ marginTop: 8 }}><Alert type="danger">{imgErr}</Alert></div>}
            </div>
          </div>
        </Section>
      </Grid>

      <Section title="Activity" action={<History size={14} color={T.textLight} />}>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', fontSize: T.fontSize.body, color: T.textMuted, marginBottom: recent.length ? 12 : 0 }}>
          <span>Added {day(p.createdAt)}{userName(p.createdBy) ? ` by ${userName(p.createdBy)}` : ''}</span>
          <span>Last updated {day(p.updatedAt)}{userName(p.updatedBy) ? ` by ${userName(p.updatedBy)}` : ''}</span>
        </div>
        {recent.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {recent.map(a => (
              <div key={a.id} style={{ fontSize: T.fontSize.sm, color: T.textMuted, display: 'flex', gap: 10 }}>
                <span style={{ color: T.textLight, whiteSpace: 'nowrap' }}>{dayTime(a.at)}</span><span>{a.detail}</span>
              </div>
            ))}
          </div>
        )}
      </Section>

      {editing && <PartnerFormModal partner={p} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); toast('Saved', 'success') }} />}

      {confirmDelete && (
        <Modal title={`Delete ${p.name}?`} size="sm" onClose={() => setConfirmDelete(false)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Alert type="warning"><span style={{ display: 'inline-flex', gap: 6 }}><AlertTriangle size={14} />This removes the partner and its notes for good. To keep it on file instead, use Archive.</span></Alert>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <Btn variant="secondary" onClick={() => setConfirmDelete(false)}>Cancel</Btn>
              <Btn variant="danger" disabled={busy} onClick={async () => {
                setBusy(true)
                try { await deletePartner(partnerId); toast('Partner deleted', 'success'); onBack() }
                catch (e) { toast(e?.message || 'Could not delete', 'error'); setBusy(false) }
              }}>Delete partner</Btn>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}

