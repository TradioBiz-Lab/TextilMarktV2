import { createContext, useContext, useState, useCallback, useRef } from 'react'
import { useApp } from './context.jsx'
import { assistantApi } from './api.js'

// One shared conversation, consumed by both the floating widget
// (components/KriyaaWidget.jsx, always mounted from Shell) and the dedicated
// full-page view (pages/admin/KriyaaPage.jsx). Lives in its own small
// context rather than context.jsx — it's a private, ephemeral UI
// conversation, not fetched/shared app data, so it doesn't belong in the
// "data + mutating actions" store — but it needs one place to live so both
// surfaces show the identical thread instead of two independent ones.
const KriyaaChatContext = createContext(null)

export function KriyaaChatProvider({ children }) {
  const { refreshOrders, refreshActionItems } = useApp()
  const [messages, setMessages] = useState([]) // [{role, content, at}]
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [slow, setSlow] = useState(false)
  // Shared across EVERY mounted Kriyaa surface — KriyaaWidget is always
  // mounted globally (from Shell.jsx) alongside KriyaaPage whenever the
  // admin is actually on the Kriyaa page, so there can be up to four
  // independent voice-auto-play watchers alive at once (each surface's own
  // useKriyaaVoice + useVoiceMode). A per-hook-instance "already spoken"
  // ref doesn't work across that — each instance has no visibility into
  // the others and would all independently auto-play the same reply
  // (confirmed live: this caused a real double-speak bug). This ref lives
  // here instead, on the one thing that's actually shared, so whichever
  // watcher's effect runs first claims a given message index and every
  // other watcher sees it's already handled.
  const lastAutoSpokenRef = useRef(-1)

  // overrideText lets a caller (a suggestion chip, or a voice transcript)
  // send specific text in the same tick without waiting on the
  // setInput('...') state update to land — the default (no arg) keeps
  // reading the live input box, unchanged.
  //
  // voiceOriginated/languageCode (from useVoiceRecorder + voiceApi.transcribe)
  // tag this turn as voice-triggered, so the resulting assistant reply
  // carries the same flags forward for useVoicePlayback to auto-speak it.
  // When set and the detected language isn't English, a one-line
  // instruction is prepended to what's SENT to the model only — never into
  // the displayed bubble content (userMsg.content stays the clean
  // transcript), and never into the cached system prompt
  // (assistant.js:349's cache_control sits on the system block specifically
  // so it can be reused across a turn's tool-loop and across separate
  // turns; a per-turn-varying language directive there would bust that
  // cache on every voice turn and leak into unrelated later turns).
  const send = useCallback(async (overrideText, { voiceOriginated = false, languageCode = null } = {}) => {
    const text = (overrideText ?? input).trim()
    if (!text || busy) return
    const userMsg = { role: 'user', content: text, at: new Date() }
    const nextMessages = [...messages, userMsg]
    setMessages(nextMessages)
    setInput('')
    setBusy(true)
    setSlow(false)
    const slowTimer = setTimeout(() => setSlow(true), 8000)
    const languageHint = voiceOriginated && languageCode && languageCode !== 'en-IN'
      ? `[Voice message, detected language: ${languageCode}. Reply in this same language.]\n`
      : ''
    try {
      const payload = nextMessages.map(({ role, content }) => ({ role, content }))
      if (languageHint) payload[payload.length - 1].content = languageHint + payload[payload.length - 1].content
      const { reply, mutated } = await assistantApi.chat(payload)
      setMessages(m => [...m, { role: 'assistant', content: reply, at: new Date(), voiceOriginated, languageCode }])
      if (mutated) {
        refreshOrders().catch(() => {})
        refreshActionItems().catch(() => {})
      }
    } catch (err) {
      setMessages(m => [...m, { role: 'assistant', content: err?.message || 'Something went wrong — please try again.', at: new Date(), isError: true }])
    } finally {
      clearTimeout(slowTimer)
      setBusy(false)
      setSlow(false)
    }
  }, [input, busy, messages, refreshOrders, refreshActionItems])

  return (
    <KriyaaChatContext.Provider value={{ messages, input, setInput, busy, slow, send, lastAutoSpokenRef }}>
      {children}
    </KriyaaChatContext.Provider>
  )
}

export function useKriyaaChat() {
  return useContext(KriyaaChatContext)
}
