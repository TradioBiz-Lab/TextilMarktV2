import { useCallback, useEffect, useRef, useState } from 'react'
import { useVoiceRecorder } from './useVoiceRecorder.js'
import { useVoicePlayback } from './useVoicePlayback.js'
import { useKriyaaChat } from './kriyaaChatContext.jsx'
import { voiceApi } from './api.js'
import { blobToDataUrl } from './components/ui.jsx'

const MAX_EMPTY_STREAK = 3
const SILENCE_OPTS = { thresholdRms: 0.02, silenceMs: 1500, minSpeechMs: 300, maxDurationMs: 30000 }

// Orchestrates Kriyaa's fullscreen hands-free voice loop:
// idle -> listening -> thinking -> speaking -> (loop back to listening),
// with `error` as a side-branch reachable from every async step. Built
// entirely on the three existing voice hooks plus useKriyaaChat().send() —
// this hook owns none of the actual recording/playback/transcription logic
// itself, same one-hook-one-concern shape as useKriyaaVoice.js (the inline
// mic's equivalent, which this hook deliberately does not touch or share
// state with — see KriyaaWidget.jsx/KriyaaPage.jsx for how the two coexist).
export function useVoiceMode() {
  const { messages, send, lastAutoSpokenRef } = useKriyaaChat()
  const rec = useVoiceRecorder()
  const playback = useVoicePlayback()

  const [isOpen, setIsOpen] = useState(false)
  const [phase, setPhase] = useState('idle') // idle | listening | thinking | speaking | error
  const [errorMsg, setErrorMsg] = useState(null)
  const [lastTranscript, setLastTranscript] = useState('')
  const [lastReplyText, setLastReplyText] = useState('')

  const emptyStreakRef = useRef(0)
  const isOpenRef = useRef(false)
  // send() is a useCallback that changes identity on nearly every render
  // (its own deps include `messages`) — handleAutoStop is invoked from
  // outside React's render cycle (the recorder's async silence-detection
  // callback), so it reads send via a ref kept current every render,
  // rather than closing over whichever `send` existed when start() was
  // called.
  const sendRef = useRef(send)

  useEffect(() => { isOpenRef.current = isOpen }, [isOpen])
  useEffect(() => { sendRef.current = send }, [send])

  // Detects a failed rec.start() (permission denied / unsupported browser)
  // reactively off the recorder's own state, rather than inspecting
  // rec.state synchronously right after `await rec.start()` — a setState
  // inside useVoiceRecorder doesn't retroactively update the `rec` object
  // already captured in this function's closure; it only shows up on
  // useVoiceMode's next render, which this effect reacts to.
  useEffect(() => {
    if (phase === 'listening' && rec.state === 'error') {
      setPhase('error')
      setErrorMsg(rec.errorMsg || 'Could not access the microphone.')
    }
  }, [phase, rec.state, rec.errorMsg])

  // startListening/handleAutoStop are mutually recursive (silence loops
  // back to listening; listening's onAutoStop is handleAutoStop) — plain
  // function declarations (hoisted) rather than useCallback sidestep the
  // ordering problem without a ref-forwarding indirection. Neither needs
  // referential stability: they're invoked directly, never passed to a
  // memoized child, and each render's versions close over that render's
  // `rec`/`playback` correctly since they're recreated every render.
  function startListening() {
    setErrorMsg(null)
    setPhase('listening')
    rec.start({ silence: { ...SILENCE_OPTS, onAutoStop: handleAutoStop } })
  }

  async function handleAutoStop(result, reason) {
    if (!isOpenRef.current) return
    if (!result) {
      // No audio captured (silent/empty room) — costs zero backend calls
      // (transcribe is never invoked), so just quietly try again rather
      // than alarming the user. Capped so an indefinitely-open mic in a
      // dead-silent room doesn't look broken forever.
      emptyStreakRef.current += 1
      if (emptyStreakRef.current < MAX_EMPTY_STREAK) { startListening(); return }
      setPhase('error')
      setErrorMsg("Didn't hear anything — try again or exit.")
      return
    }
    emptyStreakRef.current = 0
    setPhase('thinking')
    try {
      const dataUrl = await blobToDataUrl(result.blob)
      const { transcript, languageCode } = await voiceApi.transcribe(dataUrl)
      if (!transcript?.trim()) {
        emptyStreakRef.current += 1
        if (emptyStreakRef.current < MAX_EMPTY_STREAK) { startListening(); return }
        setPhase('error')
        setErrorMsg("Didn't catch that — try again or exit.")
        return
      }
      setLastTranscript(transcript)
      await sendRef.current(transcript, { voiceOriginated: true, languageCode })
      // The resulting assistant reply lands in `messages` asynchronously —
      // the watch effect below picks it up and moves to 'speaking'. Any
      // failure here (including a 429 from voiceLimiter — the axios
      // interceptor in api.js discards the HTTP status code, so its
      // message is all that's available, and it's already the backend's
      // own clear text) falls through to the catch below, which
      // deliberately does NOT loop back into startListening() — a rate
      // limit or a real backend failure won't fix itself by immediately
      // retrying, so the hands-free loop stops and surfaces the error
      // instead of hammering the same failure every silence cycle.
    } catch (err) {
      setPhase('error')
      setErrorMsg(err?.message || 'Voice failed.')
    }
  }

  // Fires once a new assistant reply lands while waiting on one (phase
  // 'thinking'). Reads/writes lastAutoSpokenRef from context — shared
  // across every mounted Kriyaa surface, not a local ref — since
  // KriyaaWidget is always mounted globally and can be alive at the same
  // time as KriyaaPage, each running their own useVoiceMode instance; a
  // local ref only stops this one instance from double-firing, not two
  // separate instances both auto-playing the same reply (see
  // kriyaaChatContext.jsx's comment on lastAutoSpokenRef).
  useEffect(() => {
    if (phase !== 'thinking') return
    const i = messages.length - 1
    const m = messages[i]
    if (!m || m.role !== 'assistant' || i <= lastAutoSpokenRef.current) return
    lastAutoSpokenRef.current = i
    if (m.isError) {
      setPhase('error')
      setErrorMsg(m.content)
      return
    }
    // Stay on 'thinking' through the TTS round-trip — flipping to
    // 'speaking' the instant the reply lands would show that label over a
    // silent gap while Sarvam generates the first chunk's audio, which
    // reads as a delayed/stalled voice rather than still-thinking.
    setLastReplyText(m.content)
    playback.play(m.content, m.languageCode, i, () => setPhase('speaking')).then(() => {
      if (isOpenRef.current) startListening()
    })
  }, [messages, phase, lastAutoSpokenRef])

  // Called synchronously from the fullscreen-voice-mode icon's onClick —
  // a real user gesture, spent priming playback.unlock()'s silent-clip
  // play() + one-time playback-amplitude wiring (useVoicePlayback.js) AND
  // rec.unlock()'s persistent recording AudioContext (useVoiceRecorder.js)
  // before any async work begins — both need a genuine click to reliably
  // resume under browsers' autoplay/audio policies.
  const enter = useCallback(() => {
    playback.unlock()
    rec.unlock()
    emptyStreakRef.current = 0
    // Any assistant message that already exists (from a prior typed or
    // inline-mic turn) must not be auto-spoken just because voice mode
    // opened — only NEW replies generated during this session should be.
    lastAutoSpokenRef.current = messages.length - 1
    setIsOpen(true)
    startListening()
  }, [playback, rec, messages])

  const exit = useCallback(() => {
    setIsOpen(false)
    if (rec.state === 'recording') rec.cancel()
    playback.stop()
    setPhase('idle')
    setErrorMsg(null)
    lastAutoSpokenRef.current = messages.length - 1
  }, [rec, playback, messages])

  // Reachable only while Kriyaa is speaking — no automatic barge-in (the
  // mic isn't listening at all during 'speaking', so there's no live audio
  // to interrupt on; real echo cancellation would be needed to avoid
  // Kriyaa's own voice re-triggering the silence detector on speaker
  // playback, and this app has no AEC pipeline to build on). Tapping the
  // orb gets the same "interrupt" outcome deliberately, without that risk.
  const bargeIn = useCallback(() => {
    if (phase !== 'speaking') return
    playback.stop()
    startListening()
  }, [phase, playback])

  const retryFromError = useCallback(() => {
    emptyStreakRef.current = 0
    setErrorMsg(null)
    startListening()
  }, [])

  return {
    isOpen, phase, errorMsg, lastTranscript, lastReplyText,
    enter, exit, retryFromError, bargeIn,
    getListenAmplitude: rec.getAmplitude,
    getSpeakAmplitude: playback.getAmplitude,
  }
}
