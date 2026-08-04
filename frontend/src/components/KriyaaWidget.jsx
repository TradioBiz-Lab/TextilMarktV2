import { useState, useRef, useEffect } from 'react'
import { Bot, X } from 'lucide-react'
import { T } from '../constants.js'
import { Btn, Textarea } from './ui.jsx'
import { useKriyaaChat } from '../kriyaaChatContext.jsx'

function fmtTime(d) {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

// Floating chat widget — rendered once, unconditionally, from Shell.jsx, so
// it's present on every admin page. The conversation itself lives in
// KriyaaChatProvider (kriyaaChatContext.jsx), shared with the dedicated
// pages/admin/KriyaaPage.jsx view — this component only owns its own
// `open` (visibility) toggle, so the same thread continues whether the
// admin uses the bubble or navigates to the full page.
export function KriyaaWidget() {
  const { messages, input, setInput, busy, slow, send } = useKriyaaChat()
  const [open, setOpen] = useState(false)
  const bottomRef = useRef(null)

  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, busy, open])

  const handleKeyDown = e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  return (
    <>
      {open && (
        <div style={{
          position: 'fixed', bottom: 88, right: 24, zIndex: 500,
          width: 380, maxWidth: 'calc(100vw - 32px)', height: 560, maxHeight: 'calc(100vh - 120px)',
          background: T.surface, borderRadius: 14, border: `1px solid ${T.border}`,
          boxShadow: '0 16px 48px rgba(0,0,0,0.18)', display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 800, color: T.text }}>Kriyaa</div>
              <div style={{ fontSize: 10, color: T.textLight }}>TextilMarkt's AI assistant</div>
            </div>
            <button onClick={() => setOpen(false)}
              style={{ background: '#f1f5f9', border: 'none', cursor: 'pointer', width: 26, height: 26, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.textMuted }}>
              <X size={14} />
            </button>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0 }}>
            {messages.length === 0 && (
              <div style={{ fontSize: 12, color: T.textLight, textAlign: 'center', padding: '24px 12px' }}>
                Ask what's pending, narrate a status change, or ask about delivery risk — in plain language.
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
                <div style={{
                  maxWidth: '85%', padding: '9px 12px', borderRadius: 11,
                  background: m.role === 'user' ? T.primary : (m.isError ? T.dangerBg : T.bg),
                  color: m.role === 'user' ? '#fff' : (m.isError ? T.danger : T.text),
                  border: m.role === 'user' ? 'none' : `1px solid ${m.isError ? T.dangerBorder : T.border}`,
                  fontSize: 12.5, lineHeight: 1.5, whiteSpace: 'pre-wrap',
                }}>
                  {m.content}
                  <div style={{ fontSize: 9, marginTop: 5, opacity: 0.65 }}>{fmtTime(m.at)}</div>
                </div>
              </div>
            ))}
            {busy && (
              <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
                <div style={{ padding: '9px 12px', borderRadius: 11, background: T.bg, border: `1px solid ${T.border}`, fontSize: 12.5, color: T.textMuted }}>
                  {slow ? 'Still working — cross-order questions can take a bit longer…' : 'Thinking…'}
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          <div style={{ borderTop: `1px solid ${T.border}`, padding: 12, display: 'flex', gap: 8, alignItems: 'flex-end', flexShrink: 0 }}>
            <div style={{ flex: 1 }}>
              <Textarea
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask, or tell it what changed…"
              />
            </div>
            <Btn size="sm" onClick={send} disabled={busy || !input.trim()}>{busy ? '…' : 'Send'}</Btn>
          </div>
        </div>
      )}

      <button
        onClick={() => setOpen(p => !p)}
        title="Kriyaa — AI assistant"
        style={{
          position: 'fixed', bottom: 24, right: 24, zIndex: 500,
          width: 52, height: 52, borderRadius: '50%', border: 'none', cursor: 'pointer',
          background: T.primary, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 6px 20px rgba(194,65,12,0.35)',
        }}>
        {open ? <X size={22} /> : <Bot size={24} />}
      </button>
    </>
  )
}
