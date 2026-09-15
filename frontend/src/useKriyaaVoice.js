import { useCallback, useEffect, useState } from 'react'
import { useVoiceRecorder } from './useVoiceRecorder.js'
import { useVoicePlayback } from './useVoicePlayback.js'
import { useKriyaaChat } from './kriyaaChatContext.jsx'
import { voiceApi } from './api.js'
import { blobToDataUrl } from './components/ui.jsx'

// Ties useVoiceRecorder + useVoicePlayback + useKriyaaChat().send() together
// for one Kriyaa surface (KriyaaWidget or KriyaaPage). Each surface calls
// this independently — recording/playback stay per-surface transient UI
// state (see useVoiceRecorder/useVoicePlayback's own comments), while
// `messages` itself is the one thing actually shared, via useKriyaaChat.
export function useKriyaaVoice({ active = true, suppressAutoPlay = false } = {}) {
  const { messages, busy, send, lastAutoSpokenRef } = useKriyaaChat()
  const rec = useVoiceRecorder()
  const playback = useVoicePlayback()
  const [transcribing, setTranscribing] = useState(false)
  const [voiceError, setVoiceError] = useState(null)

  const toggleMic = useCallback(async () => {
    setVoiceError(null)
    if (rec.state === 'recording') {
      const result = await rec.stop()
      if (!result) { setVoiceError('No audio captured — try again.'); return }
      setTranscribing(true)
      try {
        const dataUrl = await blobToDataUrl(result.blob)
        const { transcript, languageCode } = await voiceApi.transcribe(dataUrl)
        if (!transcript?.trim()) { setVoiceError("Didn't catch that — try again or type it."); return }
        await send(transcript, { voiceOriginated: true, languageCode })
      } catch (err) {
        setVoiceError(err?.message || 'Voice failed — please type your message instead.')
      } finally {
        setTranscribing(false)
      }
    } else {
      // Synchronous, before any await — spends this click's real user
      // gesture on unlocking the shared <audio> element (see
      // useVoicePlayback's unlock()) so the reply can autoplay later,
      // several awaits downstream, without Chrome's autoplay policy
      // rejecting it.
      playback.unlock()
      await rec.start()
    }
  }, [rec, send, playback])

  // Auto-play the first new voice-originated assistant reply. Reads/writes
  // lastAutoSpokenRef from context (shared across EVERY mounted Kriyaa
  // surface — see kriyaaChatContext.jsx's comment on it), not a local ref:
  // KriyaaWidget is always mounted globally, so it and KriyaaPage can both
  // be alive at once, each with their own useKriyaaVoice + useVoiceMode —
  // up to four independent watchers on the same `messages`. A local ref
  // only stops duplication within one hook instance; the shared ref is
  // what stops a reply being spoken once per mounted surface (confirmed
  // live: this was a real bug). suppressAutoPlay is extra defense-in-depth
  // for the same-component case, not load-bearing on its own now.
  useEffect(() => {
    const i = messages.length - 1
    const m = messages[i]
    if (m?.role === 'assistant' && m.voiceOriginated && i > lastAutoSpokenRef.current) {
      lastAutoSpokenRef.current = i
      if (!suppressAutoPlay) playback.play(m.content, m.languageCode, i)
    }
  }, [messages, playback, suppressAutoPlay, lastAutoSpokenRef])

  // `active` flips false when the surface hosting this hook closes (e.g.
  // KriyaaWidget's panel) without unmounting — release the mic and stop any
  // playback so neither keeps running behind a closed panel.
  useEffect(() => {
    if (!active) {
      if (rec.state === 'recording') rec.cancel()
      playback.stop()
    }
  }, [active])

  return {
    recState: rec.state,
    recErrorMsg: rec.errorMsg,
    transcribing,
    voiceError,
    toggleMic,
    disabled: busy || transcribing,
    speakingIndex: playback.speakingIndex,
    replay: playback.play,
  }
}
