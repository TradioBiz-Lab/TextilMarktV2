import { useState, useEffect } from 'react'
import { Factory, MapPin, LogIn, LogOut, Navigation, AlertTriangle, CheckCircle2, ChevronRight } from '../../icons.jsx'
import { T } from '../../constants.js'
import { useApp } from '../../context.jsx'
import { t, langOf } from '../../coordinatorText.js'
import { factoryCardState, timeIST, durationText } from '../../visits.js'
import { LoadingScreen } from '../../components/ui.jsx'

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
      style={{ width: '100%', minHeight: 56, borderRadius: 14, fontSize: 17, fontWeight: 800, fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1, padding: '10px 16px', ...tones, background: tones.bg }}>
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
          <div style={{ fontSize: 20, fontWeight: 800, color: T.text }}>{t('location_title', lang)}</div>
        </div>
        <div style={{ fontSize: 16, lineHeight: 1.55, color: T.text }}>{t(weak ? 'location_weak' : 'location_body', lang)}</div>
        <BigBtn onClick={onRetry} icon={<MapPin size={22} />}>{t('try_again', lang)}</BigBtn>
        <BigBtn tone="plain" onClick={onClose}>{t('close', lang)}</BigBtn>
      </div>
    </div>
  )
}

// One factory. Tapping the card opens that factory's work (onOpen, from Phase 2 on); Check in and Check out are their own buttons.
function FactoryCard({ factory, visits, lang, busy, onCheckIn, onCheckOut, onOpen }) {
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
          <div style={{ fontSize: 19, fontWeight: 800, color: T.text, lineHeight: 1.25, overflowWrap: 'anywhere' }}>{factory.name}</div>
          {factory.city && <div style={{ fontSize: 14, color: T.textMuted, marginTop: 2 }}>{factory.city}</div>}
        </div>
        {onOpen && <ChevronRight size={22} color={T.textLight} />}
      </div>

      {open && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 16, fontWeight: 700, color: '#15803d' }}>
          <CheckCircle2 size={20} /> {t('checked_in_at', lang, { time: timeIST(visit.checkIn.at) })}
        </div>
      )}
      {state !== 'open' && last && (
        <div style={{ fontSize: 15, color: T.textMuted, fontWeight: 600 }}>
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
        ? <a href={factory.directionsUrl} target="_blank" rel="noopener noreferrer" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 44, fontSize: 15, fontWeight: 700, color: T.info, textDecoration: 'none' }}><Navigation size={18} /> {t('directions', lang)}</a>
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
      <div style={{ fontSize: 17, fontWeight: 800, color: T.info }}>{t('add_home_title', lang)}</div>
      <div style={{ fontSize: 15, lineHeight: 1.5, color: T.text }}>{t('add_home_body', lang)}</div>
      <BigBtn tone="plain" onClick={dismiss}>{t('got_it', lang)}</BigBtn>
    </div>
  )
}

/**
 * The coordinator's home: his allocated factories. `onOpenFactory(factoryId)` opens a factory's work; it is also
 * called after a successful check-in, so he lands on what is being made there.
 */
export function FactoriesPage({ onOpenFactory }) {
  const { currentUser, visits, checkIn, checkOut, loading } = useApp()
  const lang = langOf(currentUser)
  const [busyId, setBusyId] = useState(null)
  const [help, setHelp] = useState(null)   // { weak, retry } when the phone gave no position
  const [error, setError] = useState('')

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
      <h1 style={{ fontSize: 24, fontWeight: 800, color: T.text, margin: '0 0 4px', letterSpacing: '-0.02em' }}>{t('factories_title', lang)}</h1>
      <p style={{ fontSize: 15, color: T.textMuted, margin: '0 0 18px' }}>{t('factories_hint', lang)}</p>
      {error && (
        <div role="alert" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', background: T.dangerBg, border: `1px solid ${T.dangerBorder}`, color: T.dangerDeep, borderRadius: 12, padding: '12px 14px', fontSize: 15, fontWeight: 600, marginBottom: 14 }}>
          <AlertTriangle size={18} style={{ flexShrink: 0, marginTop: 2 }} /> {error}
        </div>
      )}
      {factories.length === 0
        ? <div style={{ background: '#fff', border: `1px solid ${T.border}`, borderRadius: 18, padding: '32px 20px', textAlign: 'center', fontSize: 16, color: T.textMuted }}>{t('no_factories', lang)}</div>
        : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {factories.map(f => (
              <FactoryCard key={f.id} factory={f} visits={visits} lang={lang} busy={busyId === f.id}
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
