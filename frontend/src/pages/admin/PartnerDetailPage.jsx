import { useState, useEffect, useMemo } from 'react'
import { ArrowLeft, Pencil, Trash2, MapPin, Mail, Phone, Globe, MessageCircle, Camera, Check, Eye, EyeOff, AlertTriangle, History, ShieldCheck, Factory, Users, Package, Clock, FileText, Info, Layers } from '../../icons.jsx'
import { T } from '../../constants.js'
import { Card, Btn, Modal, Select, Alert, LoadingScreen, useToast } from '../../components/ui.jsx'
import { PartnerImage, Chip, CategoryChips, TagChips, ScoreBadge, ClaimTag, LiveBadge, CopyChip } from '../../components/PartnerBits.jsx'
import { PartnerFormModal } from './PartnerFormModal.jsx'
import { useApp } from '../../context.jsx'
import { photoFromFile } from '../../colours.js'
import { TYPE_LABEL, CLUSTER_LABEL, STATUSES, VERIFICATION_CHECKS, fieldsFor, moqVerified, canBeLive, machineTotal, readNotes, plainKeywords, certificationsOf } from '../../partners.js'

// One partner, read top to bottom the way a sourcing manager asks about a factory: who and where (the header), how big
// (the figures strip), what it is and what it makes (the left column), then who to call, its papers and how far Tradio
// has checked it (the right column). Admin only.

const day = d => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : 'never')
const dayTime = d => (d ? new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '')

function Section({ title, icon, action, children }) {
  return (
    <Card style={{ padding: '16px 18px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        {icon}
        <h2 style={{ margin: 0, fontSize: 14, fontWeight: 800, color: T.text, letterSpacing: '-0.01em', flex: 1 }}>{title}</h2>
        {action}
      </div>
      {children}
    </Card>
  )
}

const Label = ({ children }) => <div style={{ fontSize: 11, fontWeight: 700, color: T.textLight, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 5 }}>{children}</div>
const Row = ({ label, children }) => (
  <div style={{ marginBottom: 12 }}>
    <Label>{label}</Label>
    <div style={{ fontSize: T.fontSize.body, color: T.text }}>{children}</div>
  </div>
)
const Chips = ({ children }) => <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>{children}</div>
const Empty = ({ children }) => <span style={{ color: T.textLight, fontSize: T.fontSize.sm }}>{children}</span>

/** One figure in the strip under the header. Long values (a capacity sentence) wrap rather than cut off. */
function Figure({ icon, label, value, sub }) {
  const long = String(value).length > 16
  return (
    <div style={{ flex: '1 1 150px', minWidth: 0, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: '12px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, color: T.textLight, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{icon}{label}</div>
      <div style={{ marginTop: 5, fontSize: long ? 13 : 20, fontWeight: long ? 600 : 800, color: T.text, lineHeight: 1.3, letterSpacing: long ? 0 : '-0.02em', overflowWrap: 'anywhere' }}>{value}</div>
      {sub && <div style={{ marginTop: 3, fontSize: T.fontSize.xs, color: T.textLight }}>{sub}</div>}
    </div>
  )
}

const BLOCK_LABEL = { profile: 'From their profile', web: 'From the web', po: "From Tradio's purchase orders" }

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
  const [showSources, setShowSources] = useState(false)

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
  const read = useMemo(() => readNotes(p?.notes), [p?.notes])

  if (!p) {
    return missing
      ? <div style={{ padding: 40, textAlign: 'center', color: T.textMuted }}>This partner no longer exists. <Btn variant="secondary" onClick={onBack}>Back to Partners</Btn></div>
      : <LoadingScreen message="Loading partner…" />
  }

  const show = fieldsFor(p.type)
  const v = p.verification
  const scoreValue = score === null ? (v.score ?? '') : score
  const scoreDirty = score !== null && String(score) !== String(v.score ?? '')
  const machines = [['Flatlock', p.machines.flatlock], ['Coverstitch', p.machines.coverstitch], ['Overlock', p.machines.overlock], ['Single needle', p.machines.singleNeedle]].filter(([, n]) => n > 0)
  const total = machineTotal(p)
  const keywords = plainKeywords(p.keywords)
  const certs = certificationsOf(p, read)
  const checksDone = VERIFICATION_CHECKS.filter(ck => v[ck.key]).length
  const toConfirm = read.blocks.filter(b => b.toConfirm)
  const hasSources = read.blocks.some(b => b.files || b.sources.length)
  const figures = [
    total !== null && { icon: <Factory size={12} />, label: 'Machines', value: total, sub: machines.length ? machines.map(([l, n]) => `${n} ${l.toLowerCase()}`).join(', ') : null },
    read.facts.capacity && { icon: <Package size={12} />, label: 'Capacity', value: read.facts.capacity },
    read.facts.workforce && { icon: <Users size={12} />, label: 'Workforce', value: read.facts.workforce },
    p.moqPerStyleColour !== null && { icon: <Layers size={12} />, label: 'MOQ', value: `${p.moqPerStyleColour} pcs`, sub: moqVerified(p) ? 'per style per colour, verified' : 'per style per colour, their claim' },
    p.leadTimeDays !== null && { icon: <Clock size={12} />, label: 'Lead time', value: `${p.leadTimeDays} days` },
    read.facts.established && { icon: <History size={12} />, label: 'Established', value: read.facts.established },
  ].filter(Boolean)
  const firstContact = p.contacts.find(c => c.phone || c.email)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 1180 }}>
      <button type="button" onClick={onBack} style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', color: T.textMuted, fontWeight: 700, fontSize: 13, fontFamily: 'inherit', padding: 0 }}>
        <ArrowLeft size={14} /> Partners
      </button>

      {/* Who and where */}
      <Card style={{ padding: 18 }}>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div style={{ width: 104, flexShrink: 0, borderRadius: 12, overflow: 'hidden', border: `1px solid ${T.border}` }}><PartnerImage partner={p} height={104} /></div>
          <div style={{ flex: '1 1 320px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <h1 style={{ fontSize: 24, fontWeight: 800, color: T.text, margin: 0, letterSpacing: '-0.02em', overflowWrap: 'anywhere' }}>{p.name}</h1>
                {p.isLive && <LiveBadge />}
                {!p.isActive && <Chip>Archived</Chip>}
              </div>
              {p.legalName && p.legalName !== p.name && <div style={{ fontSize: 12, color: T.textLight, marginTop: 2 }}>{p.legalName}</div>}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: T.fontSize.body, color: T.textMuted }}>
              <Chip>{TYPE_LABEL[p.type]}</Chip>
              {p.city && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><MapPin size={13} />{p.city}</span>}
              {p.cluster && p.cluster !== 'other' && <Chip tone="place">{CLUSTER_LABEL[p.cluster]}</Chip>}
              {read.facts.country && <Chip tone="place">{read.facts.country}</Chip>}
              <CategoryChips categories={p.categories} />
            </div>
            {(firstContact || p.website) && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '2px 16px', flexWrap: 'wrap' }}>
                {firstContact?.name && <span style={{ fontSize: T.fontSize.body, fontWeight: 700, color: T.text }}>{firstContact.name}{firstContact.role && <span style={{ fontWeight: 500, color: T.textLight }}> · {firstContact.role}</span>}</span>}
                {firstContact?.phone && <CopyChip value={firstContact.phone} icon={<Phone size={13} color={T.textLight} />} />}
                {firstContact?.email && <CopyChip value={firstContact.email} icon={<Mail size={13} color={T.textLight} />} />}
                {p.website && <a href={p.website} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: T.primaryDeep, fontWeight: 600, fontSize: T.fontSize.body, overflowWrap: 'anywhere' }}><Globe size={13} />{p.website.replace(/^https?:\/\//, '').replace(/\/$/, '')}</a>}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-end', marginLeft: 'auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: T.fontSize.xs, color: T.textLight }}>{checksDone} of {VERIFICATION_CHECKS.length} checks</span>
              <ScoreBadge score={v.score} size="lg" />
            </div>
            <div style={{ width: 190 }}>
              <Select label="Status" value={p.status} disabled={busy} onChange={e => save({ status: e.target.value }, 'Status updated')}>
                {STATUSES.map(s => <option key={s.v} value={s.v} disabled={s.v === 'live' && !canBeLive(p)}>{s.label}{s.v === 'live' && !canBeLive(p) ? ' (needs a platform account)' : ''}</option>)}
              </Select>
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <Btn size="sm" icon={<Pencil size={13} />} onClick={() => setEditing(true)}>Edit</Btn>
              <Btn size="sm" variant="secondary" icon={p.isActive ? <EyeOff size={13} /> : <Eye size={13} />} disabled={busy} onClick={() => save({ isActive: !p.isActive }, p.isActive ? 'Archived: kept on file, out of the default list' : 'Restored to the list')}>{p.isActive ? 'Archive' : 'Restore'}</Btn>
              <Btn size="sm" variant="secondary" icon={<Trash2 size={13} />} onClick={() => setConfirmDelete(true)}>Delete</Btn>
            </div>
          </div>
        </div>
      </Card>

      {/* How big */}
      {figures.length > 0 && <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>{figures.map(f => <Figure key={f.label} {...f} />)}</div>}

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {/* Left: what it is and what it makes */}
        <div style={{ flex: '2 1 520px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Section title="About" icon={<Info size={15} color={T.textLight} />}>
            {read.blocks.length === 0 && !read.own && <Empty>Nothing written about this partner yet. Use Edit to add notes.</Empty>}
            {read.blocks.filter(b => b.summary).map((b, i) => (
              <div key={i} style={{ marginBottom: 12 }}>
                {read.blocks.filter(x => x.summary).length > 1 && <Label>{BLOCK_LABEL[b.kind]}</Label>}
                <div style={{ fontSize: T.fontSize.body, color: T.text, lineHeight: 1.6, overflowWrap: 'anywhere' }}>{b.summary}</div>
              </div>
            ))}
            {read.facts.cameThrough && <Row label="Came through">{read.facts.cameThrough}</Row>}
            {read.own && (
              <div style={{ marginBottom: 12 }}>
                {read.blocks.length > 0 && <Label>Tradio's notes</Label>}
                <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.6, fontSize: T.fontSize.body, color: T.text }}>{read.own}</div>
              </div>
            )}
            {toConfirm.length > 0 && (
              <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, padding: '10px 12px', marginBottom: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 800, color: '#92400e', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}><AlertTriangle size={13} />Still to confirm</div>
                {toConfirm.map((b, i) => <div key={i} style={{ fontSize: T.fontSize.sm, color: '#78350f', lineHeight: 1.55, overflowWrap: 'anywhere', marginTop: i ? 6 : 0 }}>{b.toConfirm}</div>)}
              </div>
            )}
            {(p.source || hasSources) && (
              <div style={{ fontSize: T.fontSize.xs, color: T.textLight, lineHeight: 1.6 }}>
                {p.source && <div>Source: {p.source}</div>}
                {hasSources && <button type="button" onClick={() => setShowSources(s => !s)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: T.primaryDeep, fontWeight: 600, fontSize: T.fontSize.xs, fontFamily: 'inherit' }}>{showSources ? 'Hide' : 'Show'} the files and pages this came from</button>}
                {showSources && read.blocks.map((b, i) => (b.files || b.sources.length > 0) && (
                  <div key={i} style={{ marginTop: 6 }}>
                    <div style={{ fontWeight: 700, color: T.textMuted }}>{b.heading}</div>
                    {b.files && <div style={{ display: 'flex', gap: 5 }}><FileText size={12} style={{ flexShrink: 0, marginTop: 3 }} /><span style={{ overflowWrap: 'anywhere' }}>{b.files}</span></div>}
                    {b.sources.map(u => <div key={u}><a href={u} target="_blank" rel="noopener noreferrer" style={{ color: T.primaryDeep, overflowWrap: 'anywhere' }}>{u.replace(/^https?:\/\//, '')}</a></div>)}
                  </div>
                ))}
              </div>
            )}
          </Section>

          <Section title={show.fabricTypes ? 'What they supply' : show.trimCategories ? 'What they supply' : 'What they make'} icon={<Package size={15} color={T.textLight} />}>
            {p.products.length > 0 && <Row label="Products"><Chips><TagChips tags={p.products} max={40} /></Chips></Row>}
            {show.fabricTypes && <Row label="Fabrics supplied">{p.fabricTypes.length ? <Chips><TagChips tags={p.fabricTypes} tone="fabric" max={40} /></Chips> : <Empty>Not recorded</Empty>}</Row>}
            {show.trimCategories && <Row label="Trims and packaging">{p.trimCategories.length ? <Chips><TagChips tags={p.trimCategories} tone="trim" max={40} /></Chips> : <Empty>Not recorded</Empty>}</Row>}
            {!show.fabricTypes && !show.trimCategories && p.fabricTypes.length + p.trimCategories.length > 0 && <Row label="Also supplies"><Chips><TagChips tags={[...p.fabricTypes, ...p.trimCategories]} tone="trim" max={40} /></Chips></Row>}
            {(p.fabrics.length > 0 || show.garment) && <Row label="Fabric experience">{p.fabrics.length ? <Chips><TagChips tags={p.fabrics} tone="fabric" max={40} /></Chips> : <Empty>Not recorded</Empty>}</Row>}
            {keywords.length > 0 && <Row label="Specialities and keywords"><Chips>{keywords.map(k => <Chip key={k}>{k.replace(/_/g, ' ')}</Chip>)}</Chips></Row>}
            <Row label="Brands they work with">{p.brands.length ? <Chips>{p.brands.map(b => <Chip key={b} tone="category">{b}</Chip>)}</Chips> : <Empty>Not recorded</Empty>}</Row>
            {show.garment && total === null && <Row label="Machines"><Empty>Not recorded</Empty></Row>}
          </Section>

          <Section title="Certifications" icon={<ShieldCheck size={15} color={T.textLight} />}>
            {certs.length === 0
              ? <Empty>None on record.</Empty>
              : (
                <>
                  <Chips>{certs.map(c => <span key={c} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: T.radius.pill, fontSize: T.fontSize.sm, fontWeight: 700, background: T.successBg, color: T.successDeep, border: `1px solid ${T.successBorder}` }}><ShieldCheck size={13} />{c}</span>)}</Chips>
                  {read.certDetails.map((d, i) => <div key={i} style={{ marginTop: 10, fontSize: T.fontSize.sm, color: T.textMuted, lineHeight: 1.6, overflowWrap: 'anywhere' }}>{d}</div>)}
                  <div style={{ marginTop: 8, fontSize: T.fontSize.xs, color: T.textLight }}>As stated in their profile or certificate. Tradio has not checked these with the certifying body.</div>
                </>
              )}
          </Section>

          <Section title="Commercial terms" icon={<Layers size={15} color={T.textLight} />}>
            <div style={{ display: 'flex', gap: '0 28px', flexWrap: 'wrap' }}>
              {show.garment && (
                <div style={{ flex: '1 1 220px', minWidth: 0 }}>
                  <Row label="MOQ per style per colour">
                    {p.moqPerStyleColour !== null
                      ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}><strong>{p.moqPerStyleColour} pieces</strong>{moqVerified(p) ? <Chip tone="plain">verified</Chip> : <ClaimTag />}</span>
                      : <Empty>Not recorded</Empty>}
                    {p.moqNote && <div style={{ fontSize: T.fontSize.sm, color: T.textMuted, marginTop: 3 }}>{p.moqNote}</div>}
                    {p.moqPerStyleColour !== null && !moqVerified(p) && <div style={{ fontSize: T.fontSize.xs, color: T.textLight, marginTop: 3 }}>The partner's own claim. It counts as verified once GST is verified or a sample is approved.</div>}
                  </Row>
                </div>
              )}
              <div style={{ flex: '1 1 160px', minWidth: 0 }}><Row label="Price indication">{p.priceIndication || <Empty>Not recorded</Empty>}</Row></div>
              <div style={{ flex: '1 1 120px', minWidth: 0 }}><Row label="Lead time">{p.leadTimeDays !== null ? `${p.leadTimeDays} days` : <Empty>Not recorded</Empty>}</Row></div>
            </div>
          </Section>
        </div>

        {/* Right: who to call, its papers, how far it has been checked */}
        <div style={{ flex: '1 1 320px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Section title="Contacts and address" icon={<Phone size={15} color={T.textLight} />}>
            {p.contacts.length === 0 && <div style={{ marginBottom: 10 }}><Empty>No contacts recorded. Use Edit to add one.</Empty></div>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {p.contacts.map((c, i) => (
                <div key={i} style={{ border: `1px solid ${T.border}`, borderRadius: 10, padding: '8px 12px' }}>
                  <div style={{ fontWeight: 700, color: T.text, fontSize: T.fontSize.body }}>{c.name || c.role || 'Contact'}{c.name && c.role && <span style={{ fontWeight: 500, color: T.textLight }}> · {c.role}</span>}</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 1, marginTop: 2 }}>
                    {c.phone && <CopyChip value={c.phone} icon={<Phone size={13} color={T.textLight} />} />}
                    {c.whatsapp && c.whatsapp !== c.phone && <CopyChip value={c.whatsapp} icon={<MessageCircle size={13} color={T.success} />} />}
                    {c.email && <CopyChip value={c.email} icon={<Mail size={13} color={T.textLight} />} />}
                  </div>
                </div>
              ))}
            </div>
            {(p.address || p.pincode || p.geo) && (
              <div style={{ marginTop: 12, display: 'flex', gap: 8, fontSize: T.fontSize.body, color: T.text, lineHeight: 1.5 }}>
                <MapPin size={14} color={T.textLight} style={{ flexShrink: 0, marginTop: 3 }} />
                <div style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                  {p.address || p.city}{p.pincode && !String(p.address).includes(p.pincode) ? `, ${p.pincode}` : ''}
                  {p.geo?.mapsUrl && <div><a href={p.geo.mapsUrl} target="_blank" rel="noopener noreferrer" style={{ color: T.primaryDeep, fontWeight: 600, fontSize: T.fontSize.sm }}>Open in Google Maps</a></div>}
                </div>
              </div>
            )}
            {p.website && (
              <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, fontSize: T.fontSize.body }}>
                <Globe size={14} color={T.textLight} />
                <a href={p.website} target="_blank" rel="noopener noreferrer" style={{ color: T.primaryDeep, fontWeight: 600, overflowWrap: 'anywhere' }}>{p.website.replace(/^https?:\/\//, '')}</a>
              </div>
            )}
          </Section>

          <Section title="Registrations" icon={<FileText size={15} color={T.textLight} />}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {[['GSTIN', p.gstin, v.gstVerified], ['Udyam', p.udyam, v.udyamVerified], ['CIN', p.mcaCin, null]].map(([l, val, ok]) => (
                <div key={l} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: T.fontSize.sm, minHeight: 26 }}>
                  <span style={{ width: 52, color: T.textLight, fontWeight: 700 }}>{l}</span>
                  {val ? <CopyChip value={val} mono /> : <Empty>not recorded</Empty>}
                  {val && ok === true && <Chip tone="plain"><Check size={11} strokeWidth={3} />checked</Chip>}
                  {val && ok === false && <span style={{ fontSize: T.fontSize.xs, color: T.textLight }}>not checked</span>}
                </div>
              ))}
            </div>
          </Section>

          <Section title="Verification" icon={<ShieldCheck size={15} color={T.textLight} />} action={<span style={{ fontSize: T.fontSize.xs, color: T.textLight }}>{checksDone} of {VERIFICATION_CHECKS.length} done</span>}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {VERIFICATION_CHECKS.map(ck => {
                const on = v[ck.key]
                return (
                  <button key={ck.key} type="button" disabled={busy} aria-pressed={on} title={ck.hint} onClick={() => save({ verification: { [ck.key]: !on } }, `${ck.label}: ${on ? 'cleared' : 'ticked'}`)}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left', padding: '6px 10px', borderRadius: 9, cursor: busy ? 'wait' : 'pointer', fontFamily: 'inherit', border: `1px solid ${on ? T.successBorder : T.border}`, background: on ? T.successBg : '#fff' }}>
                    <span style={{ width: 18, height: 18, borderRadius: 5, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: on ? T.successDeep : '#fff', border: `1.5px solid ${on ? T.successDeep : T.borderHover}` }}>{on && <Check size={12} color="#fff" strokeWidth={3} />}</span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ fontSize: T.fontSize.body, fontWeight: 700, color: T.text }}>{ck.label}</span>
                      <span style={{ fontSize: T.fontSize.xs, color: T.textLight }}> · {ck.hint}</span>
                    </span>
                  </button>
                )
              })}
            </div>
            <div style={{ marginTop: 12 }}>
              <Label>Verification score (0 to 100)</Label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <input type="range" min={0} max={100} step={5} value={scoreValue === '' ? 0 : scoreValue} onChange={e => setScore(Number(e.target.value))} aria-label="Verification score" style={{ flex: 1, minWidth: 100, accentColor: T.primaryDeep }} />
                <input type="number" min={0} max={100} value={scoreValue} onChange={e => setScore(e.target.value === '' ? '' : Math.min(100, Math.max(0, Number(e.target.value))))} aria-label="Score number" style={{ width: 62, border: `1px solid ${T.border}`, borderRadius: 8, padding: '6px 8px', fontSize: 13, fontFamily: 'inherit' }} />
                <Btn size="sm" disabled={!scoreDirty || busy} onClick={async () => { await save({ verification: { score: score === '' ? null : score } }, 'Score saved'); setScore(null) }}>Save</Btn>
              </div>
              <div style={{ fontSize: T.fontSize.xs, color: T.textLight, marginTop: 6 }}>Last checked {day(v.lastCheckedAt)}. Every change here is recorded in the Audit Log.</div>
            </div>
          </Section>

          {/* What the Live status means for this partner */}
          <div style={{ fontSize: T.fontSize.sm, lineHeight: 1.5, padding: '10px 14px', borderRadius: T.radius.md, border: `1px solid ${p.status === 'live' ? T.successBorder : T.border}`, background: p.status === 'live' ? T.successBg : T.surface, color: T.textMuted }}>
            {p.status === 'live'
              ? <><strong style={{ color: T.successDeep }}>Live.</strong> This manufacturer has orders with Tradio now and can be given styles. Change the status to stop new styles going to it; the work it already has stays.</>
              : canBeLive(p)
                ? <>It has a manufacturer account. Set the status to <strong>Live</strong> once it has orders with Tradio; until then it cannot be given a style.</>
                : <>No manufacturer account yet. <strong>Live</strong> needs one: create it in User Setup, and it will show up here.</>}
          </div>
        </div>
      </div>

      {/* The record itself: its tile and what has happened to it */}
      <Section title="Record" icon={<History size={15} color={T.textLight} />}>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div style={{ flex: '2 1 380px', minWidth: 0 }}>
            <div style={{ display: 'flex', gap: '2px 24px', flexWrap: 'wrap', fontSize: T.fontSize.body, color: T.textMuted, marginBottom: recent.length ? 10 : 0 }}>
              <span>Added {day(p.createdAt)}{userName(p.createdBy) ? ` by ${userName(p.createdBy)}` : ''}</span>
              <span>Last updated {day(p.updatedAt)}{userName(p.updatedBy) ? ` by ${userName(p.updatedBy)}` : ''}</span>
            </div>
            {recent.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {recent.map(a => (
                  <div key={a.id} style={{ fontSize: T.fontSize.sm, color: T.textMuted, display: 'flex', gap: 10 }}>
                    <span style={{ color: T.textLight, whiteSpace: 'nowrap' }}>{dayTime(a.at)}</span><span style={{ overflowWrap: 'anywhere' }}>{a.detail}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div style={{ flex: '1 1 280px', minWidth: 0 }}>
            <Label>Tile image</Label>
            <div style={{ fontSize: T.fontSize.xs, color: T.textLight, lineHeight: 1.5, marginBottom: 8 }}>A generated picture that stands in for the partner on the cards, not a photo of the factory. JPEG, PNG or WebP; do not use photos or logos taken from the partner's website.</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', fontSize: 12, fontWeight: 600, borderRadius: 8, background: '#fff', border: `1px solid ${T.border}`, color: T.text, cursor: busy ? 'wait' : 'pointer' }}>
                <Camera size={13} /> {p.hasUpload || p.imageUrl ? 'Replace image' : 'Upload image'}
                <input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} style={{ display: 'none' }} onChange={e => { const f = e.target.files[0]; e.target.value = ''; upload(f) }} />
              </label>
              {(p.hasUpload || p.imageUrl) && <Btn size="sm" variant="secondary" disabled={busy} onClick={async () => { setBusy(true); try { await setPartnerImage(partnerId, null); toast('Image removed', 'success') } catch (e) { toast(e?.message || 'Could not remove', 'error') } finally { setBusy(false) } }}>Remove</Btn>}
            </div>
            {imgErr && <div style={{ marginTop: 8 }}><Alert type="danger">{imgErr}</Alert></div>}
          </div>
        </div>
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
