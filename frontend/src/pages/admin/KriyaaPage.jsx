import { useRef, useEffect } from 'react'
import { Bot, Sparkles, ShieldAlert, PenLine, ListTodo } from 'lucide-react'
import { T } from '../../constants.js'
import { PageHeader, Card, Textarea, Btn } from '../../components/ui.jsx'
import { useKriyaaChat } from '../../kriyaaChatContext.jsx'
import { useApp } from '../../context.jsx'

function fmtTime(d) {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

// Suggestion chips for the empty state — borrows the reference AI-Studio
// demo's "organized tool cards" visual language (icon badge + label +
// one-line description, in a grid) without adopting its multi-tool-mode
// architecture: Kriyaa here is one chat thread, these are conversation
// starters, not separate modes. Prompts are real capabilities each role's
// tool set actually has (see assistant.js's TOOLS_BY_ROLE) — never a
// promise of something Kriyaa can't do.
const SUGGESTIONS_BY_ROLE = {
  admin: [
    { icon: ListTodo, label: "What's overdue right now?", desc: 'A quick sweep across every order', prompt: "What's overdue right now, across all orders?" },
    { icon: ShieldAlert, label: 'Check delivery risk', desc: 'See if a stage slip threatens the ship date', prompt: 'Check delivery risk on my most urgent order.' },
    { icon: PenLine, label: 'Narrate a status change', desc: 'Mark progress in plain language', prompt: 'Mark the lab dip on the poplin dress done, finished yesterday.' },
    { icon: Sparkles, label: 'Review open action items', desc: "What's still waiting on someone", prompt: 'What action items are still open?' },
  ],
  manufacturer: [
    { icon: ListTodo, label: "What's pending on my orders?", desc: 'A quick sweep across your assignments', prompt: "What's pending on my orders right now?" },
    { icon: ShieldAlert, label: 'Check delivery risk', desc: 'See if a stage slip threatens the ship date', prompt: 'Check delivery risk on my most urgent order.' },
    { icon: PenLine, label: 'Log today\'s progress', desc: 'Narrate a stage update in plain language', prompt: 'Mark cutting done on my current order, finished today.' },
  ],
  buyer: [
    { icon: ListTodo, label: "What's pending on my orders?", desc: 'A quick sweep across your orders', prompt: "What's pending on my orders right now?" },
    { icon: ShieldAlert, label: 'Check delivery risk', desc: 'See if a stage slip threatens the ship date', prompt: 'Check delivery risk on my most urgent order.' },
    { icon: PenLine, label: 'Approve a stage', desc: "Move forward a step you're responsible for", prompt: 'Approve the stage I own that\'s ready to move forward.' },
  ],
}

function SuggestionGrid({ role, onPick }) {
  const items = SUGGESTIONS_BY_ROLE[role] || SUGGESTIONS_BY_ROLE.admin
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10, width: '100%', maxWidth: 640 }}>
      {items.map((s, i) => (
        <button key={i} onClick={() => onPick(s.prompt)} type="button"
          style={{
            textAlign: 'left', background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.radius.md,
            padding: '14px 16px', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 8,
            boxShadow: T.shadow.xs, transition: 'box-shadow 0.15s, border-color 0.15s, transform 0.15s', fontFamily: 'inherit',
          }}
          onMouseEnter={e => { e.currentTarget.style.boxShadow = T.shadow.md; e.currentTarget.style.borderColor = T.borderHover; e.currentTarget.style.transform = 'translateY(-1px)' }}
          onMouseLeave={e => { e.currentTarget.style.boxShadow = T.shadow.xs; e.currentTarget.style.borderColor = T.border; e.currentTarget.style.transform = 'none' }}>
          <div style={{ width: 32, height: 32, borderRadius: T.radius.sm, background: T.primaryLight, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <s.icon size={16} color={T.primaryDark} />
          </div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{s.label}</div>
            <div style={{ fontSize: 11.5, color: T.textMuted, marginTop: 2, lineHeight: 1.4 }}>{s.desc}</div>
          </div>
        </button>
      ))}
    </div>
  )
}

// Full-page view of the same conversation the floating widget
// (components/KriyaaWidget.jsx) shows — both read/write the one shared
// thread in KriyaaChatProvider, so switching between the bubble and this
// page never loses context. This page is just a bigger, more comfortable
// surface for a longer back-and-forth.
export function KriyaaPage() {
  const { messages, input, setInput, busy, slow, send } = useKriyaaChat()
  const { currentUser } = useApp()
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
      <PageHeader
        title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
          <span style={{ width: 32, height: 32, borderRadius: T.radius.sm, background: T.primaryLight, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
            <Bot size={17} color={T.primaryDark} />
          </span>
          Kriyaa
        </span>}
        subtitle="TextilMarkt's AI assistant — ask what's pending, narrate a status change, or ask about delivery risk, in plain language."
      />

      <Card pad={false} style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 400, marginTop: 16 }}>
        <div style={{ flex: 1, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {messages.length === 0 && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 20, padding: '20px 16px', textAlign: 'center' }}>
              <div>
                <div style={{ width: 56, height: 56, borderRadius: T.radius.pill, background: T.primaryLight, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px' }}>
                  <Bot size={26} color={T.primaryDark} />
                </div>
                <div style={{ fontSize: 15, fontWeight: 700, color: T.text }}>Ask Kriyaa anything</div>
                <div style={{ fontSize: 12.5, color: T.textMuted, marginTop: 4 }}>Pick a starting point, or just type below</div>
              </div>
              <SuggestionGrid role={currentUser?.role} onPick={text => send(text)} />
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
              {m.role !== 'user' && (
                <div style={{ width: 26, height: 26, borderRadius: '50%', background: m.isError ? T.dangerBg : T.primaryLight, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 2 }}>
                  <Bot size={13} color={m.isError ? T.danger : T.primaryDark} />
                </div>
              )}
              <div style={{
                maxWidth: '75%', padding: '11px 15px', borderRadius: T.radius.md,
                background: m.role === 'user' ? T.primary : (m.isError ? T.dangerBg : T.bg),
                color: m.role === 'user' ? '#fff' : (m.isError ? T.danger : T.text),
                border: m.role === 'user' ? 'none' : `1px solid ${m.isError ? T.dangerBorder : T.border}`,
                fontSize: 13.5, lineHeight: 1.55, whiteSpace: 'pre-wrap',
                boxShadow: m.role === 'user' ? '0 2px 6px rgba(249,115,22,0.18)' : 'none',
              }}>
                {m.content}
                <div style={{ fontSize: 10, marginTop: 6, opacity: 0.6 }}>{fmtTime(m.at)}</div>
              </div>
            </div>
          ))}
          {busy && (
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-start' }}>
              <div style={{ width: 26, height: 26, borderRadius: '50%', background: T.primaryLight, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 2 }}>
                <Bot size={13} color={T.primaryDark} />
              </div>
              <div style={{ padding: '11px 15px', borderRadius: T.radius.md, background: T.bg, border: `1px solid ${T.border}`, fontSize: 13, color: T.textMuted }}>
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
          <Btn onClick={() => send()} disabled={busy || !input.trim()}>{busy ? 'Sending…' : 'Send'}</Btn>
        </div>
      </Card>
    </div>
  )
}
