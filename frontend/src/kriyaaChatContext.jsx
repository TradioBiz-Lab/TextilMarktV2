import { createContext, useContext, useState, useCallback, useRef } from 'react'
import { useApp } from './context.jsx'
import { assistantApi, styleImportsApi } from './api.js'
import { sheetFileProblem, readSheetFile, withAttachment } from './styleImport.js'

// One shared conversation, consumed by both the floating widget
// (components/KriyaaWidget.jsx, always mounted from Shell) and the dedicated
// full-page view (pages/admin/KriyaaPage.jsx). Lives in its own small
// context rather than context.jsx — it's a private, ephemeral UI
// conversation, not fetched/shared app data, so it doesn't belong in the
// "data + mutating actions" store — but it needs one place to live so both
// surfaces show the identical thread instead of two independent ones.
const KriyaaChatContext = createContext(null)

export function KriyaaChatProvider({ children }) {
  const { refreshOrders, refreshActionItems, currentUser } = useApp()
  const [messages, setMessages] = useState([]) // [{role, content, at}]
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [slow, setSlow] = useState(false)
  // A sheet of styles the admin attached with the paperclip: { id, filename } once uploaded. It rides on the next message
  // (see withAttachment), where Kriyaa's preview and create tools find its id. Only admins can create styles.
  const [attachment, setAttachment] = useState(null)
  const [attaching, setAttaching] = useState(false)
  const [attachError, setAttachError] = useState('')
  const canAttach = currentUser?.role === 'admin'
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

  // `busy` is state, so two sends in the same tick (a double click on a chip, or Enter plus a
  // click) both read it as false. A ref flips immediately, so only the first goes through. That
  // matters because Kriyaa's tools can change orders, and the second send used to overwrite the
  // first message in the history.
  const sendingRef = useRef(false)

  const attach = useCallback(async file => {
    const problem = sheetFileProblem(file)
    if (problem) { setAttachError(problem); return }
    setAttaching(true); setAttachError('')
    try {
      const { filename, data } = await readSheetFile(file)
      const up = await styleImportsApi.upload(filename, data)
      setAttachment({ id: up.id, filename: up.filename })
    } catch (err) {
      setAttachError(err?.message || 'Could not upload that file.')
    } finally { setAttaching(false) }
  }, [])
  const clearAttachment = useCallback(() => { setAttachment(null); setAttachError('') }, [])

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
    const typed = (overrideText ?? input).trim()
    if ((!typed && !attachment) || busy || sendingRef.current) return
    const text = withAttachment(typed, attachment)
    sendingRef.current = true
    setAttachment(null)
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
      setMessages(m => [...m, { role: 'assistant', content: err?.message || 'Something went wrong - please try again.', at: new Date(), isError: true }])
    } finally {
      clearTimeout(slowTimer)
      sendingRef.current = false
      setBusy(false)
      setSlow(false)
    }
  }, [input, busy, messages, attachment, refreshOrders, refreshActionItems])

  return (
    <KriyaaChatContext.Provider value={{ messages, input, setInput, busy, slow, send, lastAutoSpokenRef, attachment, attaching, attachError, canAttach, attach, clearAttachment }}>
      {children}
    </KriyaaChatContext.Provider>
  )
}

export function useKriyaaChat() {
  return useContext(KriyaaChatContext)
}
