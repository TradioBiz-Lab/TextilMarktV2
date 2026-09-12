import { createContext, useContext, useState, useCallback } from 'react'
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

  // overrideText lets a caller (a suggestion chip) send specific text in the
  // same tick without waiting on the setInput('...') state update to land —
  // the default (no arg) keeps reading the live input box, unchanged.
  const send = useCallback(async (overrideText) => {
    const text = (overrideText ?? input).trim()
    if (!text || busy) return
    const userMsg = { role: 'user', content: text, at: new Date() }
    const nextMessages = [...messages, userMsg]
    setMessages(nextMessages)
    setInput('')
    setBusy(true)
    setSlow(false)
    const slowTimer = setTimeout(() => setSlow(true), 8000)
    try {
      const { reply, mutated } = await assistantApi.chat(
        nextMessages.map(({ role, content }) => ({ role, content }))
      )
      setMessages(m => [...m, { role: 'assistant', content: reply, at: new Date() }])
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
    <KriyaaChatContext.Provider value={{ messages, input, setInput, busy, slow, send }}>
      {children}
    </KriyaaChatContext.Provider>
  )
}

export function useKriyaaChat() {
  return useContext(KriyaaChatContext)
}
