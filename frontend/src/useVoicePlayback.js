import { useCallback, useEffect, useRef, useState } from 'react'
import { voiceApi } from './api.js'
import { dataUrlToBlobUrl } from './components/ui.jsx'

const MAX_TTS_CHARS = 2500

// Splits text into <=maxChars chunks on sentence boundaries (falling back
// to whitespace) so a chunk never cuts off mid-word. Kriyaa's system prompt
// already biases toward short replies, so this almost always returns a
// single chunk — it exists for the rare long one, since Sarvam's TTS caps
// a single request at 2500 characters and the backend rejects rather than
// silently truncates.
function chunkText(text, maxChars = MAX_TTS_CHARS) {
  if (text.length <= maxChars) return [text]
  const chunks = []
  let rest = text.trim()
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf('. ', maxChars)
    if (cut < maxChars * 0.5) cut = rest.lastIndexOf(' ', maxChars)
    if (cut < 1) cut = maxChars
    chunks.push(rest.slice(0, cut + 1).trim())
    rest = rest.slice(cut + 1).trim()
  }
  if (rest) chunks.push(rest)
  return chunks
}

// A single silent, near-zero-length WAV — used only to "unlock" the shared
// <audio> element via a real user gesture (see unlock() below).
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA='

// Plays back a Kriyaa reply via Bulbul TTS. Transient per-surface UI state,
// same reasoning as useVoiceRecorder — not shared React Context.
export function useVoicePlayback() {
  const [speakingIndex, setSpeakingIndex] = useState(null)
  // One <audio> element, reused for every play() call (including across
  // separate messages) rather than a fresh `new Audio()` per chunk.
  // Chrome's autoplay policy rejects .play() once it's no longer inside the
  // synchronous call stack of a real user gesture — and by the time a
  // voice-triggered reply is ready, we're several awaits deep (transcribe →
  // send → speak), well past that window. But once THIS SPECIFIC element
  // has successfully played from a genuine gesture (unlock(), below), Chrome
  // keeps allowing programmatic .play() on it afterward, even from async
  // code — so the fix is priming this one persistent element synchronously
  // inside the mic-click handler, not creating a new element per reply.
  const audioElRef = useRef(typeof Audio !== 'undefined' ? new Audio() : null)
  const blobRef = useRef(null)
  const cancelledRef = useRef(false)

  // Playback-amplitude plumbing (fullscreen voice mode's "speaking" orb
  // only — plain audio.play() via the inline mic doesn't touch any of
  // this). Same ref-not-state reasoning as useVoiceRecorder's ampRef.
  const audioCtxRef = useRef(null)
  const analyserRef = useRef(null)
  const mediaSourceRef = useRef(null) // guards createMediaElementSource — throws if called twice on the same element
  const rafRef = useRef(null)
  const ampRef = useRef(0)

  const startAmpLoop = () => {
    const analyser = analyserRef.current
    if (!analyser) return
    const buf = new Float32Array(analyser.fftSize)
    const tick = () => {
      analyser.getFloatTimeDomainData(buf)
      let sum = 0
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
      ampRef.current = Math.sqrt(sum / buf.length)
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }

  const stopAmpLoop = () => {
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
    ampRef.current = 0
  }

  // Call synchronously from a real user gesture (the mic-click for the
  // inline button, or fullscreen voice mode's enter()), before any `await`
  // — spent on a silent clip so the element is "activated" for the real,
  // async-delivered reply later.
  const unlock = useCallback(() => {
    const audio = audioElRef.current
    if (!audio) return
    audio.src = SILENT_WAV
    audio.play().catch(() => {})

    // Lazily wire the playback-amplitude analyser exactly once — this
    // element is persistent/reused across every reply, and
    // createMediaElementSource throws InvalidStateError if called twice on
    // the same element, so this has to happen here (same real gesture as
    // the priming play() above), not inside play() which runs every reply.
    if (!mediaSourceRef.current) {
      try {
        const AudioCtxClass = window.AudioContext || window.webkitAudioContext
        const audioCtx = new AudioCtxClass()
        const source = audioCtx.createMediaElementSource(audio)
        const analyser = audioCtx.createAnalyser()
        analyser.fftSize = 512
        // MUST reconnect to destination — createMediaElementSource captures
        // the element's normal DOM audio output into the Web Audio graph.
        // Skip this and playback goes silently silent, with no error thrown.
        source.connect(analyser)
        analyser.connect(audioCtx.destination)
        audioCtxRef.current = audioCtx
        analyserRef.current = analyser
        mediaSourceRef.current = source
      } catch {
        // Non-fatal — the orb just won't be amplitude-reactive while
        // speaking; audible playback itself doesn't depend on this.
      }
    }
    audioCtxRef.current?.resume().catch(() => {})
  }, [])

  const stop = useCallback(() => {
    cancelledRef.current = true
    stopAmpLoop()
    audioElRef.current?.pause()
    blobRef.current?.revoke()
    blobRef.current = null
    setSpeakingIndex(null)
  }, [])

  // onFirstAudio, if given, fires right before the first chunk actually
  // starts playing — not when play() is called. The Sarvam TTS round-trip
  // for the first chunk can take a noticeable beat, and a caller showing a
  // "speaking" indicator from the moment play() is invoked reads as a
  // stalled/delayed voice rather than a still-thinking one; firing this
  // callback only once real audio begins lets the caller keep showing
  // "thinking" through that gap instead.
  const play = useCallback(async (text, languageCode, index, onFirstAudio) => {
    stop()
    cancelledRef.current = false
    setSpeakingIndex(index)
    startAmpLoop()
    try {
      let first = true
      for (const chunk of chunkText(text)) {
        if (cancelledRef.current) return
        const { audioDataUrl } = await voiceApi.speak(chunk, languageCode)
        if (cancelledRef.current) return
        const blob = dataUrlToBlobUrl(audioDataUrl)
        if (!blob) continue
        blobRef.current = blob
        const audio = audioElRef.current
        audio.src = blob.url
        if (first) { first = false; onFirstAudio?.() }
        await new Promise((resolve, reject) => {
          audio.onended = resolve
          audio.onerror = reject
          audio.play().catch(reject)
        })
        blob.revoke()
        blobRef.current = null
      }
    } catch {
      // Playback failure isn't fatal — the text reply is already on screen.
    } finally {
      stopAmpLoop()
      if (!cancelledRef.current) setSpeakingIndex(null)
    }
  }, [stop])

  const getAmplitude = useCallback(() => ampRef.current, [])

  useEffect(() => () => stop(), [stop])

  return { speakingIndex, play, stop, unlock, getAmplitude }
}
