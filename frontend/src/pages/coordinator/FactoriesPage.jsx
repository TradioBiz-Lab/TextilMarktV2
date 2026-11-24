import { useState, useEffect } from 'react'
import { Factory, MapPin, LogIn, LogOut, Navigation, AlertTriangle, CheckCircle2, ChevronRight, ChevronDown, ClipboardList } from '../../icons.jsx'
import { T } from '../../constants.js'
import { useApp } from '../../context.jsx'
import { t, langOf } from '../../coordinatorText.js'
import { factoryCardState, timeIST, durationText } from '../../visits.js'
import { LoadingScreen } from '../../components/ui.jsx'
import { visitsApi } from '../../api.js'
import { stepInstruction } from '../../workToday.js'

// A big, plain button: the coordinator's screens are used on a phone, by people who are not at home in apps.
export function BigBtn({ children, onClick, tone = 'primary', disabled, icon }) {
  const tones = {
    primary: { bg: T.primaryDeep, color: '#fff', border: 'none' },
    green: { bg: '#15803d', color: '#fff', border: 'none' },
    plain: { bg: '#fff', color: T.text, border: `1.5px solid ${T.borderHover}` },
    danger: { bg: '#fff', color: T.dangerDeep, border: `1.5px solid ${T.dangerBorder}` },
  }[tone]
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      style={{ width: '100%', minHeight: 56, borderRadius: 14, fontSize: 17, fontWeight: 600, fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1, padding: '10px 16px', ...tones, background: tones.bg }}>
      {icon}{children}
    </button>
  )
}

/** Shown when the phone would not give a position: what to do, in plain words, and a way to try again. */
export function LocationHelp({ lang, weak, onRetry, onClose }) {
  return (
    <div role="dialog" aria-modal="true" style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)', zIndex: 900, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <div style={{ background: '#fff', width: '100%', maxWidth: 480, borderRadius: '20px 20px 0 0', padding: '24px 20px 28px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ width: 52, height: 52, borderRadius: '50%', background: T.warningBg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><MapPin size={28} color={T.warning} /></span>
          <div style={{ fontSize: 20, fontWeight: 600, color: T.text }}>{t('location_title', lang)}</div>
        </div>
        <div style={{ fontSize: 16, lineHeight: 1.55, color: T.text }}>{t(weak ? 'location_weak' : 'location_body', lang)}</div>
        <BigBtn onClick={onRetry} icon={<MapPin size={22} />}>{t('try_again', lang)}</BigBtn>
        <BigBtn tone="plain" onClick={onClose}>{t('close', lang)}</BigBtn>
      </div>
    </div>
  )
}

const KIND_TONE = { late: { bg: '#fee2e2', fg: '#991b1b' }, due_today: { bg: '#ffedd5', fg: '#9a3412' }, running: { bg: '#dcfce7', fg: '#166534' } }
const kindLabel = (s, lang) => (s.kind === 'late' ? (s.daysLate === 1 ? t('work_one_day_late', lang) : t('work_days_late', lang, { n: s.daysLate })) : s.kind === 'due_today' ? t('work_due_today', lang) : t('work_in_progress', lang))

/**
 * Today's work at one factory, on its card: the steps that are late, due today or running (from the plan), what Tradio
 * is following up on its styles, and what was reported from the floor yesterday. Three lines at first, the rest behind
 * one tap. Tapping a line opens that style.
 */
function WorkToday({ work, lang, onOpenOrder }) {
  const [all, setAll] = useState(false)
  if (!work) return null
  const { steps = [], counts = {}, actionItems = [], yesterday = [] } = work
  const empty = !steps.length && !actionItems.length && !yesterday.length
  const more = steps.length > 3 || actionItems.length > 0 || yesterday.length > 0
  const row = { display: 'flex', alignItems: 'flex-start', gap: 8, width: '100%', textAlign: 'left', background: '#fff', border: `1px solid ${T.border}`, borderRadius: 10, padding: '8px 10px', fontFamily: 'inherit', cursor: onOpenOrder ? 'pointer' : 'default' }
  const heading = { fontSize: 12, fontWeight: 600, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 4 }
  return (
    <div style={{ background: '#f8fafc', border: `1px solid ${T.border}`, borderRadius: 14, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 16, fontWeight: 600, color: T.text }}><ClipboardList size={19} /> {t('work_today', lang)}</span>
        {counts.late > 0 && <span style={{ fontSize: 12.5, fontWeight: 600, padding: '2px 9px', borderRadius: 10, background: KIND_TONE.late.bg, color: KIND_TONE.late.fg }}>{t('work_late', lang, { n: counts.late })}</span>}
        {counts.dueToday > 0 && <span style={{ fontSize: 12.5, fontWeight: 600, padding: '2px 9px', borderRadius: 10, background: KIND_TONE.due_today.bg, color: KIND_TONE.due_today.fg }}>{t('work_due', lang, { n: counts.dueToday })}</span>}
        {counts.running > 0 && <span style={{ fontSize: 12.5, fontWeight: 600, padding: '2px 9px', borderRadius: 10, background: KIND_TONE.running.bg, color: KIND_TONE.running.fg }}>{t('work_running', lang, { n: counts.running })}</span>}
      </div>
      {empty && <div style={{ fontSize: 14, color: T.textMuted }}>{t('work_none', lang)}</div>}
      {(all ? steps : steps.slice(0, 3)).map((s, i) => (
        <button key={`${s.orderId}:${s.stageIndex}:${i}`} type="button" style={row} onClick={() => onOpenOrder?.(s.orderId)}>
          <span style={{ flex: 1, minWidth: 0 }}>
            {/* What to do, said plainly; under it, which style and which step of its plan it comes from. */}
            <span style={{ display: 'block', fontSize: 15, fontWeight: 500, color: T.text, lineHeight: 1.4, overflowWrap: 'anywhere' }}>{stepInstruction(s.stageName, lang)}</span>
            <span style={{ display: 'block', fontSize: 13, color: T.textMuted, marginTop: 2, overflowWrap: 'anywhere' }}>{s.product}{s.client ? ` · ${s.client}` : ''} · {s.stageName}</span>
          </span>
          <span style={{ fontSize: 12, fontWeight: 600, padding: '2px 8px', borderRadius: 10, background: KIND_TONE[s.kind].bg, color: KIND_TONE[s.kind].fg, whiteSpace: 'nowrap', flexShrink: 0 }}>{kindLabel(s, lang)}</span>
        </button>
      ))}
      {all && actionItems.length > 0 && <div style={heading}>{t('work_action_items', lang)}</div>}
      {all && actionItems.map(a => (
        <button key={a.id} type="button" style={row} onClick={() => onOpenOrder?.(a.orderId)}>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 15, fontWeight: 500, color: T.text, lineHeight: 1.3, overflowWrap: 'anywhere' }}>{t('work_follow_up', lang, { what: a.title })}</span>
            <span style={{ display: 'block', fontSize: 13, color: T.textMuted, marginTop: 1 }}>{a.product}{a.stageName ? ` · ${a.stageName}` : ''}</span>
          </span>
        </button>
      ))}
      {all && yesterday.length > 0 && <div style={heading}>{t('work_yesterday', lang)}</div>}
      {all && yesterday.map((u, i) => (
        <button key={i} type="button" style={row} onClick={() => onOpenOrder?.(u.orderId)}>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 14.5, color: T.text, lineHeight: 1.35, overflowWrap: 'anywhere' }}>{t('work_recheck', lang, { what: u.text || u.stageName })}</span>
            <span style={{ display: 'block', fontSize: 13, color: T.textMuted, marginTop: 1 }}>{u.product} · {u.stageName}{u.byName ? ` · ${u.byName}` : ''}</span>
          </span>
        </button>
      ))}
      {more && (
        <button type="button" onClick={() => setAll(v => !v)} aria-expanded={all}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: 40, background: 'none', border: 'none', fontSize: 14, fontWeight: 500, color: T.info, cursor: 'pointer', fontFamily: 'inherit' }}>
          {all ? t('work_show_less', lang) : `${t('work_show_all', lang)}${actionItems.length ? ` · ${t('work_action_items', lang)} (${actionItems.length})` : ''}${yesterday.length ? ` · ${t('work_yesterday', lang)} (${yesterday.length})` : ''}`}
          <ChevronDown size={15} style={{ transform: all ? 'rotate(180deg)' : 'none', flexShrink: 0 }} />
        </button>
      )}
    </div>
  )
}

// One factory. Tapping the card opens that factory's work (onOpen, from Phase 2 on); Check in and Check out are their own buttons.
function FactoryCard({ factory, visits, lang, busy, work, onCheckIn, onCheckOut, onOpen, onOpenOrder }) {
  const { state, visit, last } = factoryCardState(visits, factory.id)
  const open = state === 'open'
  return (
    <div style={{ background: open ? '#f0fdf4' : '#fff', border: `2px solid ${open ? '#22c55e' : T.border}`, borderRadius: 18, padding: 16, display: 'flex', flexDirection: 'column', gap: 14, boxShadow: T.shadow.sm }}>
      <div role={onOpen ? 'button' : undefined} tabIndex={onOpen ? 0 : undefined} onClick={onOpen} onKeyDown={e => { if (onOpen && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onOpen() } }}
        style={{ display: 'flex', alignItems: 'center', gap: 12, cursor: onOpen ? 'pointer' : 'default' }}>
        <span style={{ width: 52, height: 52, borderRadius: 14, background: open ? '#dcfce7' : T.infoBg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <Factory size={28} color={open ? '#15803d' : T.info} weight="duotone" />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 19, fontWeight: 600, color: T.text, lineHeight: 1.25, overflowWrap: 'anywhere' }}>{factory.name}</div>
          {factory.city && <div style={{ fontSize: 14, color: T.textMuted, marginTop: 2 }}>{factory.city}</div>}
        </div>
        {onOpen && <ChevronRight size={22} color={T.textLight} />}
      </div>

      <WorkToday work={work} lang={lang} onOpenOrder={onOpenOrder} />

      {open && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 16, fontWeight: 500, color: '#15803d' }}>
          <CheckCircle2 size={20} /> {t('checked_in_at', lang, { time: timeIST(visit.checkIn.at) })}
        </div>
      )}
      {state !== 'open' && last && (
        <div style={{ fontSize: 15, color: T.textMuted, fontWeight: 500 }}>
          {last.checkOut
            ? t('visit_span', lang, { from: timeIST(last.checkIn.at), to: timeIST(last.checkOut.at), duration: durationText(last.minutes) })
            : `${timeIST(last.checkIn.at)} · ${t('did_not_check_out', lang)}`}
        </div>
      )}

      {open
        ? <BigBtn tone="danger" disabled={busy} onClick={onCheckOut} icon={<LogOut size={22} />}>{busy ? t('getting_location', lang) : t('check_out', lang)}</BigBtn>
        : <BigBtn tone="green" disabled={busy || state === 'blocked'} onClick={onCheckIn} icon={<LogIn size={22} />}>{busy ? t('getting_location', lang) : t('check_in', lang)}</BigBtn>}
      {state === 'blocked' && <div style={{ fontSize: 14, color: T.textMuted, textAlign: 'center' }}>{t('check_out_first', lang, { name: visit.factoryName || '' })}</div>}

      {factory.directionsUrl
        ? <a href={factory.directionsUrl} target="_blank" rel="noopener noreferrer" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 44, fontSize: 15, fontWeight: 500, color: T.info, textDecoration: 'none' }}><Navigation size={18} /> {t('directions', lang)}</a>
        : <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 13, color: T.textLight }}><MapPin size={14} /> {t('no_factory_location', lang)}</div>}
    </div>
  )
}

// Shown once on a coordinator's phone until he says OK: how to keep the app on the home screen. Not shown when it is
// already opened from there.
const distanceText = m => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m || 0} m`)

const HINT_KEY = 'tradio_add_home_seen'
function AddToHomeHint({ lang }) {
  const [show, setShow] = useState(false)
  useEffect(() => {
    try {
      const installed = window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true
      setShow(!installed && localStorage.getItem(HINT_KEY) !== '1')
    } catch { setShow(false) }
  }, [])
  if (!show) return null
  const dismiss = () => { try { localStorage.setItem(HINT_KEY, '1') } catch { /* it will show again, which is harmless */ } setShow(false) }
  return (
    <div style={{ background: T.infoBg, border: `1px solid ${T.infoBorder}`, borderRadius: 16, padding: 14, marginTop: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 17, fontWeight: 600, color: T.info }}>{t('add_home_title', lang)}</div>
      <div style={{ fontSize: 15, lineHeight: 1.5, color: T.text }}>{t('add_home_body', lang)}</div>
      <BigBtn tone="plain" onClick={dismiss}>{t('got_it', lang)}</BigBtn>
    </div>
  )
}

/**
 * The coordinator's home: his allocated factories. `onOpenFactory(factoryId)` opens a factory's work; it is also
 * called after a successful check-in, so he lands on what is being made there.
 */
export function FactoriesPage({ onOpenFactory, onOpenOrder }) {
  const { currentUser, visits, checkIn, checkOut, loading } = useApp()
  const lang = langOf(currentUser)
  const [busyId, setBusyId] = useState(null)
  const [help, setHelp] = useState(null)   // { weak, retry } when the phone gave no position
  const [error, setError] = useState('')
  // Today's work per factory: asked once when the page opens. The cards work without it (it is extra, never a blocker).
  const [work, setWork] = useState(null)
  useEffect(() => { let dead = false; visitsApi.work().then(r => { if (!dead) setWork(r?.factories || {}) }).catch(() => {}); return () => { dead = true } }, [])

  if (loading && !visits) return <LoadingScreen />
  const factories = visits?.factories || []

  const run = async (factoryId, action) => {
    setBusyId(factoryId); setError(''); setHelp(null)
    try { await action() }
    catch (e) {
      if (e?.code === 'denied' || e?.code === 'unsupported') setHelp({ weak: false, retry: () => run(factoryId, action) })
      else if (e?.code === 'unavailable') setHelp({ weak: true, retry: () => run(factoryId, action) })
      // Not at the factory: the server refused the check-in. Say so in his language, with how far away the phone is.
      else if (e?.code === 'NOT_AT_FACTORY') setError(t('not_at_factory', lang, { name: e.data?.factoryName || '', distance: distanceText(e.data?.distanceM) }))
      else setError(e?.message || t('failed', lang))
    } finally { setBusyId(null) }
  }

  return (
    <div style={{ maxWidth: 560, margin: '0 auto', padding: '4px 0 32px' }}>
      <h1 style={{ fontSize: 24, fontWeight: 600, color: T.text, margin: '0 0 4px', letterSpacing: '-0.02em' }}>{t('factories_title', lang)}</h1>
      <p style={{ fontSize: 15, color: T.textMuted, margin: '0 0 18px' }}>{t('factories_hint', lang)}</p>
      {error && (
        <div role="alert" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', background: T.dangerBg, border: `1px solid ${T.dangerBorder}`, color: T.dangerDeep, borderRadius: 12, padding: '12px 14px', fontSize: 15, fontWeight: 500, marginBottom: 14 }}>
          <AlertTriangle size={18} style={{ flexShrink: 0, marginTop: 2 }} /> {error}
        </div>
      )}
      {factories.length === 0
        ? <div style={{ background: '#fff', border: `1px solid ${T.border}`, borderRadius: 18, padding: '32px 20px', textAlign: 'center', fontSize: 16, color: T.textMuted }}>{t('no_factories', lang)}</div>
        : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {factories.map(f => (
              <FactoryCard key={f.id} factory={f} visits={visits} lang={lang} busy={busyId === f.id} work={work?.[f.id]}
                onOpenOrder={onOpenOrder ? id => onOpenOrder(id, f.id) : undefined}
                onOpen={onOpenFactory ? () => onOpenFactory(f.id) : undefined}
                onCheckIn={() => run(f.id, async () => { await checkIn(f.id); onOpenFactory?.(f.id) })}
                onCheckOut={() => run(f.id, () => checkOut(visits.open.id))} />
            ))}
          </div>
        )}
      <AddToHomeHint lang={lang} />
      {help && <LocationHelp lang={lang} weak={help.weak} onRetry={help.retry} onClose={() => setHelp(null)} />}
    </div>
  )
}
