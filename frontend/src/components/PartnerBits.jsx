import { useState, useEffect, useRef } from 'react'
import { Factory, Copy, Check, ShieldCheck, Link2, Zap } from '../icons.jsx'
import { T } from '../constants.js'
import { useToast } from './ui.jsx'
import { useApp } from '../context.jsx'
import { STATUS_BY, PRIORITY_BY, CATEGORY_LABEL, scoreTone, initialsOf, labelOf } from '../partners.js'

// Small pieces shared by the Partner Directory's list, card and detail page.

export function Chip({ children, tone = 'plain', title }) {
  const tones = {
    plain: { bg: '#f1f5f9', fg: T.textMuted, border: T.border },
    place: { bg: T.infoBg, fg: T.info, border: T.infoBorder },
    fabric: { bg: '#f5f3ff', fg: '#6d28d9', border: '#ddd6fe' },
    trim: { bg: '#ecfeff', fg: '#0e7490', border: '#a5f3fc' },
    category: { bg: T.primaryLight, fg: T.primaryDeep, border: T.warningBorder },
  }[tone]
  return (
    <span title={title} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: T.radius.pill, fontSize: T.fontSize.xs, fontWeight: 600, background: tones.bg, color: tones.fg, border: `1px solid ${tones.border}`, whiteSpace: 'nowrap', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }}>
      {children}
    </span>
  )
}

export function StatusPill({ status }) {
  const s = STATUS_BY[status] || STATUS_BY.new
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', padding: '2px 10px', borderRadius: T.radius.pill, fontSize: T.fontSize.xs, fontWeight: 700, background: s.bg, color: s.fg, whiteSpace: 'nowrap' }}>{s.label}</span>
  )
}

export function PriorityTag({ priority }) {
  const p = PRIORITY_BY[priority] || PRIORITY_BY.C
  return (
    <span title={`Priority ${p.label}: ${p.hint}`} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 22, height: 22, padding: '0 6px', borderRadius: 6, fontSize: T.fontSize.xs, fontWeight: 800, background: p.bg, color: p.fg, border: `1px solid ${p.border}` }}>{p.label}</span>
  )
}

/** Verification score: green from 70, amber 50 to 69, grey below that or when not assessed. */
export function ScoreBadge({ score, size = 'md' }) {
  const t = scoreTone(score)
  const big = size === 'lg'
  return (
    <span title={score === null || score === undefined ? 'Verification score: not assessed yet' : `Verification score ${score} out of 100`}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: big ? '5px 12px' : '2px 8px', borderRadius: T.radius.pill, fontSize: big ? T.fontSize.md : T.fontSize.xs, fontWeight: 800, background: t.bg, color: t.fg, whiteSpace: 'nowrap', border: `1px solid ${t.level === 'high' ? T.successBorder : t.level === 'mid' ? '#fde68a' : T.border}` }}>
      <ShieldCheck size={big ? 15 : 12} />{t.label}
    </span>
  )
}

/** The small "self-reported" tag a MOQ carries until GST is verified or a sample is approved. */
export function ClaimTag() {
  return <span title="The partner's own figure. It stays a claim until GST is verified or a sample is approved." style={{ fontSize: T.fontSize.micro, fontWeight: 700, color: '#92400e', background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 5, padding: '1px 6px', textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>self-reported</span>
}

/** Live: the manufacturer has orders with Tradio now. Only a live manufacturer can be given a style. */
export function LiveBadge() {
  return (
    <span title="Live: has orders with Tradio now, and can be given styles" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: T.radius.pill, fontSize: T.fontSize.micro, fontWeight: 800, background: T.successDeep, color: '#fff', whiteSpace: 'nowrap', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
      <Zap size={11} fill="#fff" />Live
    </span>
  )
}

export function OnPlatformBadge() {
  return (
    <span title="Also has a manufacturer account on TextilMarkt" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: T.radius.pill, fontSize: T.fontSize.micro, fontWeight: 800, background: T.masterBg, color: T.master, border: '1px solid #c4b5fd', whiteSpace: 'nowrap', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
      <Link2 size={11} />On platform
    </span>
  )
}

// A few muted tints for the initials placeholder, picked by name so a partner always gets the same one.
const TINTS = [
  { bg: T.primaryLight, fg: T.primaryDeep }, { bg: T.infoBg, fg: T.info }, { bg: T.successBg, fg: T.successDeep },
  { bg: T.masterBg, fg: T.master }, { bg: '#f1f5f9', fg: '#475569' }, { bg: '#fef3c7', fg: '#92400e' },
]
const tintFor = name => {
  let h = 0
  for (const ch of String(name || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return TINTS[h % TINTS.length]
}

/**
 * A partner's tile: the uploaded or linked picture when there is one, otherwise a clean initials placeholder. On the card
 * grid (`thumb`) the small copy comes from one batched request (loadPartnerThumbs); anywhere else the full picture is
 * fetched once the tile scrolls near the screen. Lists never carry image bytes.
 */
export function PartnerImage({ partner, height = 124, rounded = 0, thumb = false }) {
  const { getPartnerImage, partnerThumbs } = useApp()
  const [upload, setUpload] = useState(null)
  const [near, setNear] = useState(false)
  const [broken, setBroken] = useState(false)
  const box = useRef(null)
  const wantsUpload = !!partner.hasUpload && !partner.imageUrl
  const batched = thumb && wantsUpload

  useEffect(() => {
    if (!wantsUpload || batched) return undefined
    const el = box.current
    if (!el || typeof IntersectionObserver === 'undefined') { setNear(true); return undefined }
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setNear(true); io.disconnect() } }, { rootMargin: '240px' })
    io.observe(el)
    return () => io.disconnect()
  }, [partner.id, wantsUpload, batched])

  useEffect(() => {
    if (!wantsUpload || batched || !near) { if (!wantsUpload) setUpload(null); return undefined }
    let live = true
    getPartnerImage(partner.id, partner.updatedAt).then(img => { if (live) setUpload(img) }).catch(() => { if (live) setUpload(null) })
    return () => { live = false }
  }, [partner.id, partner.updatedAt, wantsUpload, batched, near, getPartnerImage])

  useEffect(() => { setBroken(false) }, [partner.imageUrl])

  const src = partner.imageUrl || (batched ? partnerThumbs[partner.id] : upload)
  const tint = tintFor(partner.name)
  return (
    <div ref={box} style={{ position: 'relative', height, background: tint.bg, overflow: 'hidden', borderRadius: rounded, flexShrink: 0 }}>
      {src && !broken ? (
        <img src={src} alt="" onError={() => setBroken(true)} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
      ) : (
        <>
          <Factory size={Math.round(height * 0.9)} color={tint.fg} style={{ position: 'absolute', right: -Math.round(height * 0.12), bottom: -Math.round(height * 0.14), opacity: 0.1 }} />
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: Math.max(20, Math.round(height * 0.3)), fontWeight: 800, color: tint.fg, letterSpacing: '0.02em' }}>{initialsOf(partner.name)}</div>
        </>
      )}
    </div>
  )
}

/** A phone number, email or other value that copies itself when clicked. */
export function CopyChip({ value, icon, mono = false }) {
  const toast = useToast()
  const [done, setDone] = useState(false)
  const copy = async e => {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(value)
    } catch {
      // Clipboard API blocked (an http page, an old browser): fall back to a hidden field and the copy command.
      const ta = document.createElement('textarea')
      ta.value = value; ta.style.position = 'fixed'; ta.style.opacity = '0'
      document.body.appendChild(ta); ta.select()
      try { document.execCommand('copy') } catch { toast('Could not copy', 'error'); ta.remove(); return }
      ta.remove()
    }
    setDone(true); toast('Copied', 'success', 1500)
    setTimeout(() => setDone(false), 1500)
  }
  return (
    <button type="button" onClick={copy} title="Click to copy"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', padding: '2px 0', cursor: 'pointer', fontFamily: mono ? "'JetBrains Mono',monospace" : 'inherit', fontSize: T.fontSize.body, color: T.text, textAlign: 'left', maxWidth: '100%' }}>
      {icon}<span style={{ overflowWrap: 'anywhere' }}>{value}</span>
      {done ? <Check size={12} color={T.success} strokeWidth={3} /> : <Copy size={12} color={T.textLight} />}
    </button>
  )
}

/** The tags of a partner (products, fabrics, trims) as chips, the first few and a "+N" for the rest. */
export function TagChips({ tags, tone = 'plain', max = 4, plain = false }) {
  // `plain` shows keywords as typed (they are words, not snake_case tokens).
  const text = plain ? t => t : labelOf
  const shown = tags.slice(0, max)
  return (
    <>
      {shown.map(t => <Chip key={t} tone={tone}>{text(t)}</Chip>)}
      {tags.length > max && <Chip title={tags.slice(max).map(text).join(', ')}>+{tags.length - max}</Chip>}
    </>
  )
}

/** The categories a partner is in (athleisure, indian, western, fusion, home textiles) as chips. */
export function CategoryChips({ categories = [] }) {
  return <>{categories.map(c => <Chip key={c} tone="category">{CATEGORY_LABEL[c] || labelOf(c)}</Chip>)}</>
}
