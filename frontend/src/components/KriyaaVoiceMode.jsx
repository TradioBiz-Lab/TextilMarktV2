import { useEffect, useRef } from 'react'
import { X, Mic } from 'lucide-react'
import { T } from '../constants.js'

const PHASE_LABEL = {
  idle: '',
  listening: 'Listening…',
  thinking: 'Thinking…',
  speaking: 'Speaking…',
  error: '',
}

// Maps live RMS (roughly 0-0.3 in practice) to an orb scale/glow range —
// shared by both the listening (mic input) and speaking (playback output)
// states, since both ultimately feed this the same shape of number.
function ampToScale(amp) {
  const clamped = Math.min(amp / 0.18, 1)
  return 1 + clamped * 0.22 // 1.0 - 1.22 — a raw waveform's RMS swings a
  // lot sample to sample even within one word, so a wide range here reads
  // as jittery; kept the pulse noticeable but subtler than the initial 1.35.
}
function ampToGlow(amp) {
  const clamped = Math.min(amp / 0.18, 1)
  return 20 + clamped * 25 // px blur radius
}

// ChatGPT-style voice-mode overlay for Kriyaa, scoped to whichever
// container renders it — the widget's small floating panel, or the full
// page's chat Card — rather than taking over the whole viewport. The
// caller is responsible for giving that container `position: relative`
// (or `fixed`, which already qualifies) so this absolutely-positioned
// overlay fills exactly that box, clipped to its existing border radius
// via the container's own `overflow: hidden`.
export function KriyaaVoiceMode({ voice }) {
  const orbRef = useRef(null)
  const rafRef = useRef(null)
  // Exponential moving average of the raw amplitude — the underlying RMS
  // value (used as-is for silence-detection decisions elsewhere) jumps a
  // lot frame to frame even within steady speech, and animating the orb
  // directly off it reads as jittery rather than a graceful pulse. Smoothed
  // here only, purely cosmetic — never feeds back into any real decision.
  const smoothedAmpRef = useRef(0)

  useEffect(() => {
    const tick = () => {
      const el = orbRef.current
      if (el) {
        if (voice.phase === 'listening' || voice.phase === 'speaking') {
          const raw = voice.phase === 'listening' ? voice.getListenAmplitude() : voice.getSpeakAmplitude()
          // Low alpha = slow, graceful follow rather than snapping to
          // every instantaneous spike.
          smoothedAmpRef.current += (raw - smoothedAmpRef.current) * 0.12
          const amp = smoothedAmpRef.current
          el.style.transform = `scale(${ampToScale(amp)})`
          el.style.boxShadow = `0 0 ${ampToGlow(amp)}px ${ampToGlow(amp) / 2}px rgba(249,115,22,0.45)`
        } else {
          // idle/thinking/error get a fixed-tempo CSS animation instead
          // (see the <style> block below) — clear any inline override from
          // a previous listening/speaking phase so that animation shows.
          smoothedAmpRef.current = 0
          el.style.transform = ''
          el.style.boxShadow = ''
        }
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [voice])

  useEffect(() => {
    const h = e => e.key === 'Escape' && voice.exit()
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [voice])

  const isError = voice.phase === 'error'
  const orbColor = isError ? T.danger : '#F97316'
  const orbClass = voice.phase === 'idle' ? 'kriyaa-orb-idle' : voice.phase === 'thinking' ? 'kriyaa-orb-thinking' : ''

  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 50,
      background: 'linear-gradient(160deg, #1e293b, #0f172a)',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 18,
      padding: '16px 12px',
    }}>
      <style>{`
        @keyframes kriyaa-orb-idle-pulse { 0%,100% { transform: scale(1); opacity: 0.85 } 50% { transform: scale(1.06); opacity: 1 } }
        @keyframes kriyaa-orb-thinking-pulse { 0%,100% { transform: scale(1); opacity: 0.9 } 50% { transform: scale(1.14); opacity: 1 } }
        .kriyaa-orb-idle { animation: kriyaa-orb-idle-pulse 2.6s ease-in-out infinite; }
        .kriyaa-orb-thinking { animation: kriyaa-orb-thinking-pulse 1s ease-in-out infinite; }
      `}</style>

      <button onClick={voice.exit} title="Exit voice mode"
        style={{
          position: 'absolute', top: 12, right: 12, background: 'rgba(255,255,255,0.1)', border: 'none',
          cursor: 'pointer', width: 30, height: 30, borderRadius: 9, display: 'flex', alignItems: 'center',
          justifyContent: 'center', color: '#fff',
        }}>
        <X size={16} />
      </button>

      <div
        ref={orbRef}
        onClick={voice.phase === 'speaking' ? voice.bargeIn : undefined}
        title={voice.phase === 'speaking' ? 'Tap to interrupt' : undefined}
        className={orbClass}
        style={{
          width: 96, height: 96, borderRadius: '50%', flexShrink: 0,
          background: `radial-gradient(circle at 35% 30%, ${orbColor}, ${orbColor}cc 60%, ${orbColor}88 100%)`,
          boxShadow: `0 0 40px 10px ${orbColor}55`,
          cursor: voice.phase === 'speaking' ? 'pointer' : 'default',
          transition: voice.phase === 'listening' || voice.phase === 'speaking' ? 'none' : 'transform 0.2s, box-shadow 0.2s',
        }}
      />

      <div style={{ textAlign: 'center', maxWidth: '100%', padding: '0 16px' }}>
        {isError ? (
          <>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#fca5a5', marginBottom: 4 }}>{voice.errorMsg}</div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 12 }}>
              <button onClick={voice.retryFromError}
                style={{ background: '#F97316', color: '#fff', border: 'none', borderRadius: 8, padding: '7px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
                Try again
              </button>
              <button onClick={voice.exit}
                style={{ background: 'rgba(255,255,255,0.1)', color: '#fff', border: 'none', borderRadius: 8, padding: '7px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
                Exit
              </button>
            </div>
          </>
        ) : (
          <>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.6)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {voice.phase === 'listening' && <Mic size={12} />}
              {PHASE_LABEL[voice.phase]}
            </div>
            {(voice.phase === 'thinking' || voice.phase === 'speaking') && voice.lastTranscript && (
              <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', marginTop: 6 }}>"{voice.lastTranscript}"</div>
            )}
            {voice.phase === 'speaking' && voice.lastReplyText && (
              <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.75)', marginTop: 8, lineHeight: 1.5, whiteSpace: 'pre-wrap', maxHeight: 120, overflowY: 'auto' }}>{voice.lastReplyText}</div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
