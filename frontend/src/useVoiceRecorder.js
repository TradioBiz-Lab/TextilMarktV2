import { useCallback, useEffect, useRef, useState } from 'react'

// Records a mic clip via MediaRecorder for Kriyaa voice input. Deliberately
// NOT shared React Context (unlike kriyaaChatContext.jsx) — recording is
// transient per-surface UI state (whichever of KriyaaWidget/KriyaaPage has
// an open mic button right now), not shared conversation data. Both
// surfaces call this hook independently and funnel the result into the
// same useKriyaaChat().send().
export function useVoiceRecorder() {
  const [state, setState] = useState('idle') // idle | recording | error
  const [errorMsg, setErrorMsg] = useState(null)
  const mediaRecorderRef = useRef(null)
  const chunksRef = useRef([])
  const streamRef = useRef(null)

  // Silence-detection plumbing (fullscreen voice mode only — the inline
  // mic button never passes `opts.silence`, so none of this activates for
  // it). ampRef is a plain ref, not React state: a 60fps setState would
  // thrash re-renders on every consumer of this hook. getAmplitude() lets
  // a caller (the orb) poll it inside its own animation loop instead.
  //
  // recAudioCtxRef is PERSISTENT — created and resumed exactly once, via
  // unlock() called synchronously from a real click (same pattern as
  // useVoicePlayback's audioElRef). Recreating+resuming an AudioContext
  // fresh on every start() (the original approach) happens after the
  // getUserMedia await, well outside any user-gesture call stack —
  // .resume() there can silently fail under Chrome's autoplay policy
  // (swallowed by its own .catch), leaving the analyser reading ~0
  // forever even though nothing throws. A context resumed once from a
  // real gesture stays usable for every later async start() call, exactly
  // like the persistent <audio> element does for playback.
  const recAudioCtxRef = useRef(null)
  const analyserRef = useRef(null)
  const sourceRef = useRef(null)
  // setInterval, deliberately NOT requestAnimationFrame — this loop drives
  // a real functional decision (when to auto-stop recording), not just a
  // visual. rAF throttles hard (often to near-zero) whenever
  // document.visibilityState isn't 'visible' — a tab switch or a
  // momentarily-backgrounded window mid-conversation would otherwise stall
  // silence detection indefinitely. setInterval keeps ticking (Chrome only
  // clamps it to a 1s minimum after being hidden for a while, which is
  // still far more responsive than rAF's near-total pause) at the cost of
  // being a plain timer rather than paint-synced — irrelevant here, since
  // this loop never touches the DOM.
  const tickTimerRef = useRef(null)
  const ampRef = useRef(0)
  const onAutoStopRef = useRef(null)
  // True once ANY sample during the current recording has crossed
  // thresholdRms. ASR models (Sarvam's included) don't reliably return an
  // empty transcript on genuinely silent audio — they can hallucinate a
  // short spurious word ("hello", "thank you") instead, confirmed live.
  // Gating on this in performStop means silence never reaches
  // voiceApi.transcribe at all when auto-stopped on silence/max-duration,
  // rather than relying on the model to self-report "nothing was said."
  const hadSpeechRef = useRef(false)

  // Deliberately does NOT close recAudioCtxRef — that context is
  // persistent/reused across every recording (see its comment above);
  // closing it here would make the next start() try to resume a
  // permanently-closed context. Only the per-recording analyser node
  // (implicitly disconnected once its source stream stops) and this
  // recording's tick timer are torn down.
  const cleanupAnalyser = () => {
    if (tickTimerRef.current) { clearInterval(tickTimerRef.current); tickTimerRef.current = null }
    // Explicitly disconnect rather than relying solely on the stopped
    // MediaStreamTrack to silence these — belt-and-suspenders so a prior
    // recording's source/analyser can never keep feeding stale data into
    // the persistent audioCtx's graph across a retry.
    try { sourceRef.current?.disconnect() } catch { /* already disconnected */ }
    try { analyserRef.current?.disconnect() } catch { /* already disconnected */ }
    sourceRef.current = null
    analyserRef.current = null
    ampRef.current = 0
  }

  // Call synchronously from a real click (fullscreen voice mode's enter(),
  // alongside playback.unlock()) — spends that gesture creating+resuming
  // the one persistent AudioContext used for every later silence-detection
  // analyser, so subsequent async start() calls never need to resume one
  // themselves. Safe to call repeatedly; only does real work once.
  const unlock = useCallback(() => {
    if (!recAudioCtxRef.current) {
      const AudioCtxClass = window.AudioContext || window.webkitAudioContext
      if (AudioCtxClass) recAudioCtxRef.current = new AudioCtxClass()
    }
    recAudioCtxRef.current?.resume().catch(() => {})
  }, [])

  const releaseStream = () => {
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
  }

  // The hands-free loop calls start() again immediately after the previous
  // stream's tracks were just .stop()'d (releaseStream, via the prior
  // recorder's onstop). On some OS/driver combos the audio device isn't
  // released instantly, so that immediate re-acquisition can throw a
  // transient NotReadableError ("device in use") rather than a real
  // permission problem — indistinguishable from NotAllowedError in the UI
  // otherwise, and with no recovery path: every subsequent "Try again"
  // repeats the same instant re-acquire and can hit the same transient
  // failure again. One short-delay retry absorbs that race instead of
  // surfacing a permanent-looking error for what's actually a timing issue.
  const acquireStream = async () => {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (err) {
      if (err?.name !== 'NotReadableError' && err?.name !== 'TrackStartError') throw err
      await new Promise(r => setTimeout(r, 300))
      return await navigator.mediaDevices.getUserMedia({ audio: true })
    }
  }

  // Shared by the public stop() and the silence-detection auto-stop path.
  // `reason` is only set for an auto-stop (never for a manual stop()) —
  // that's what gates whether onAutoStopRef's callback fires, so a manual
  // caller relying on the returned Promise never gets double-notified.
  const performStop = useCallback((reason) => new Promise(resolve => {
    const recorder = mediaRecorderRef.current
    cleanupAnalyser()
    if (!recorder || recorder.state === 'inactive') {
      setState('idle')
      resolve(null)
      if (reason) onAutoStopRef.current?.(null, reason)
      return
    }
    recorder.onstop = () => {
      releaseStream()
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
      setState('idle')
      // A manual stop() (reason undefined — no silence detection ran, so
      // hadSpeechRef was never tracked) always trusts the recorded blob.
      // An auto-stop only counts as a real result if some sample actually
      // crossed thresholdRms during the recording — see hadSpeechRef above.
      const hasRealSpeech = !reason || hadSpeechRef.current
      const result = (blob.size > 0 && hasRealSpeech) ? { blob, mimeType: blob.type } : null
      resolve(result)
      if (reason) onAutoStopRef.current?.(result, reason)
    }
    recorder.stop()
  }), [])

  // opts.silence, when passed, turns on hands-free auto-stop: taps the same
  // MediaStream already handed to MediaRecorder with an AnalyserNode (NOT
  // connected to audioCtx.destination — that would route the mic back out
  // to speakers as feedback), and watches its RMS volume on a timer loop
  // (see tickTimerRef above for why setInterval, not rAF). Omitting opts
  // (today's only other call site, the inline mic button) preserves the
  // original manual tap-to-start/tap-to-stop behavior exactly — no
  // analyser, no auto-stop.
  const start = useCallback(async (opts) => {
    setErrorMsg(null)
    onAutoStopRef.current = opts?.silence?.onAutoStop ?? null
    if (!navigator.mediaDevices?.getUserMedia) {
      setState('error')
      setErrorMsg('Voice input is not supported in this browser.')
      return
    }
    try {
      const stream = await acquireStream()
      streamRef.current = stream
      // Browser default mimeType — audio/webm;codecs=opus on Chrome/Firefox,
      // audio/mp4 on Safari. Sarvam's speech-to-text accepts both directly,
      // no client-side transcoding needed.
      const recorder = new MediaRecorder(stream)
      chunksRef.current = []
      recorder.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      recorder.start()
      mediaRecorderRef.current = recorder
      setState('recording')

      if (opts?.silence) {
        hadSpeechRef.current = false
        // initialSilenceMs is the grace period before ANY speech has been
        // heard yet — deliberately longer than silenceMs (the trailing-pause
        // cutoff once the user is mid-sentence). Right after Kriyaa finishes
        // speaking and the mic reopens, the user needs a beat to notice it's
        // their turn before starting to talk; using silenceMs (1500ms) for
        // that grace period too meant it could auto-stop as "silent" before
        // they'd even started, especially first thing in a hands-free loop.
        const { thresholdRms = 0.012, silenceMs = 1500, initialSilenceMs = 4000, minSpeechMs = 300, maxDurationMs = 30000 } = opts.silence
        // Falls back to creating+resuming one here if the caller never
        // called unlock() from a real gesture (defensive only — every
        // known call site does call it) — same best-effort resume as
        // before for that fallback path only.
        if (!recAudioCtxRef.current) {
          const AudioCtxClass = window.AudioContext || window.webkitAudioContext
          recAudioCtxRef.current = new AudioCtxClass()
        }
        const audioCtx = recAudioCtxRef.current
        audioCtx.resume().catch(() => {})
        const source = audioCtx.createMediaStreamSource(stream)
        const analyser = audioCtx.createAnalyser()
        analyser.fftSize = 512
        source.connect(analyser)
        sourceRef.current = source
        analyserRef.current = analyser

        const buf = new Float32Array(analyser.fftSize)
        const startTime = performance.now()
        let lastLoudTime = startTime

        // 100ms is plenty of resolution for a 1500ms-scale silence
        // threshold, and keeps this well clear of Chrome's ~1s minimum
        // clamp for backgrounded-tab timers (see tickTimerRef above).
        tickTimerRef.current = setInterval(() => {
          // Belt-and-suspenders beyond unlock()'s one-time resume — mobile
          // browsers can suspend an AudioContext mid-session on their own
          // (screen lock, OS audio-focus handoff right after Kriyaa's own
          // TTS played through the speaker, tab backgrounding), not just
          // fail to resume it initially. A no-op when already running;
          // catches re-suspension every 100ms instead of only once at
          // start(), which silently stalled every sample after the point
          // it happened rather than erroring.
          if (audioCtx.state !== 'running') audioCtx.resume().catch(() => {})
          analyser.getFloatTimeDomainData(buf)
          let sum = 0
          for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
          const rms = Math.sqrt(sum / buf.length)
          ampRef.current = rms

          const now = performance.now()
          if (rms > thresholdRms) { lastLoudTime = now; hadSpeechRef.current = true }
          const elapsed = now - startTime

          // maxDurationMs is a hard backstop independent of amplitude — a
          // noisy room that never drops below thresholdRms would otherwise
          // never auto-stop at all.
          if (elapsed >= maxDurationMs) { performStop('max-duration'); return }
          // minSpeechMs guards against auto-stopping the instant start()
          // is called into a silent room, with nothing captured yet.
          const silenceLimit = hadSpeechRef.current ? silenceMs : initialSilenceMs
          if (elapsed >= minSpeechMs && (now - lastLoudTime) >= silenceLimit) { performStop('silence') }
        }, 100)
      }
    } catch (err) {
      // getUserMedia can have already succeeded (stream assigned to
      // streamRef.current) before something later in this try block throws
      // (e.g. AudioContext/analyser setup) — without this, that stream was
      // never released, so the mic stayed open while the UI said 'error',
      // and a "Try again" click's fresh start() piled a second live stream
      // on top of it instead of cleanly replacing it.
      cleanupAnalyser()
      releaseStream()
      setState('error')
      // err.name logged (not shown) — the UI message stays a plain sentence
      // per this app's error-copy convention, but a masked NotReadableError
      // ("device still in use" after acquireStream's one retry already
      // failed) vs. NotAllowedError vs. anything else is otherwise
      // indistinguishable from the browser console alone.
      console.error('[voice] getUserMedia failed:', err?.name, err?.message)
      setErrorMsg(err?.name === 'NotAllowedError'
        ? 'Microphone access was denied. Allow it in your browser settings to use voice input.'
        : 'Could not access the microphone.')
    }
  }, [performStop])

  // Resolves { blob, mimeType } once the recorder has flushed, or null on
  // an empty/failed recording.
  const stop = useCallback(() => performStop(), [performStop])

  // For interruption — widget closed, page navigated away mid-recording.
  // Releases the mic stream without resolving a result.
  const cancel = useCallback(() => {
    const recorder = mediaRecorderRef.current
    cleanupAnalyser()
    onAutoStopRef.current = null
    if (recorder && recorder.state !== 'inactive') recorder.stop()
    releaseStream()
    setState('idle')
  }, [])

  const getAmplitude = useCallback(() => ampRef.current, [])

  // Safety net for KriyaaVoiceMode's fullscreen mode, whose host page
  // (KriyaaPage) can genuinely unmount mid-recording on navigation —
  // releases the mic/analyser regardless of whether cancel()/stop() was
  // ever called. The persistent recAudioCtxRef is only actually closed
  // here, on unmount — never mid-conversation (see cleanupAnalyser above).
  useEffect(() => () => {
    cleanupAnalyser()
    releaseStream()
    recAudioCtxRef.current?.close().catch(() => {})
  }, [])

  return { state, errorMsg, start, stop, cancel, unlock, getAmplitude }
}
