import { useRef, useEffect } from 'react'
import { T } from '../../constants.js'
import { PageHeader, Card, Textarea, Btn, EmptyState } from '../../components/ui.jsx'
import { useKriyaaChat } from '../../kriyaaChatContext.jsx'

function fmtTime(d) {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

// Full-page view of the same conversation the floating widget
// (components/KriyaaWidget.jsx) shows — both read/write the one shared
// thread in KriyaaChatProvider, so switching between the bubble and this
// page never loses context. This page is just a bigger, more comfortable
// surface for a longer back-and-forth.
export function KriyaaPage() {
  const { messages, input, setInput, busy, slow, send } = useKriyaaChat()
  const bottomRef = useRef(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, busy])

  const handleKeyDown = e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <PageHeader title="Kriyaa" subtitle="TextilMarkt's AI assistant — ask what's pending, narrate a status change, or ask about delivery risk, in plain language." />

      <Card pad={false} style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 400, marginTop: 16 }}>
        <div style={{ flex: 1, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {messages.length === 0 && (
            <EmptyState icon="🤖" title="Nothing here yet" desc={'Try: "what\'s overdue right now?" or "mark the lab dip on the poplin dress done, finished yesterday."'} />
          )}
          {messages.map((m, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
              <div style={{
                maxWidth: '75%', padding: '10px 14px', borderRadius: 12,
                background: m.role === 'user' ? T.primary : (m.isError ? T.dangerBg : T.bg),
                color: m.role === 'user' ? '#fff' : (m.isError ? T.danger : T.text),
                border: m.role === 'user' ? 'none' : `1px solid ${m.isError ? T.dangerBorder : T.border}`,
                fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap',
              }}>
                {m.content}
                <div style={{ fontSize: 10, marginTop: 6, opacity: 0.65 }}>{fmtTime(m.at)}</div>
              </div>
            </div>
          ))}
          {busy && (
            <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
              <div style={{ padding: '10px 14px', borderRadius: 12, background: T.bg, border: `1px solid ${T.border}`, fontSize: 13, color: T.textMuted }}>
                {slow ? 'Still working — cross-order questions can take a bit longer…' : 'Thinking…'}
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        <div style={{ borderTop: `1px solid ${T.border}`, padding: 14, display: 'flex', gap: 10, alignItems: 'flex-end' }}>
          <div style={{ flex: 1 }}>
            <Textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask about pending items, or tell it what changed…"
            />
          </div>
          <Btn onClick={send} disabled={busy || !input.trim()}>{busy ? 'Sending…' : 'Send'}</Btn>
        </div>
      </Card>
    </div>
  )
}
