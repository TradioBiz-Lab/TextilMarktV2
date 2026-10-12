import { useState } from 'react'
import { T } from '../../constants.js'
import { Btn, Card, SectionLabel, Textarea } from '../../components/ui.jsx'
import { Pill } from '../procurement/common.jsx'

const ago = at => {
  const s = Math.max(0, (Date.now() - new Date(at).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return new Date(at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
}

/**
 * The talk about one shared version of a cost sheet: what the brand asked and what the factory answered.
 * `canComment` is false for a version nobody can talk about any more (a replaced one).
 * `onSend(text, kind)` resolves when saved; the box clears only then.
 */
export function CommentsThread({ comments, canComment, canRequestChanges, onSend, theirName }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const send = async kind => {
    if (!text.trim()) return
    setBusy(true)
    try { await onSend(text.trim(), kind); setText('') } catch { /* the caller toasts the reason; what was typed stays */ } finally { setBusy(false) }
  }
  return (
    <Card>
      <SectionLabel>Comments{comments.length ? ` (${comments.length})` : ''}</SectionLabel>
      {comments.length === 0 && <div style={{ fontSize: 13, color: T.textMuted, margin: '10px 0 4px', lineHeight: 1.55 }}>{canComment ? `Nothing said yet. Ask ${theirName || 'them'} a question, or say what you would change.` : 'Nothing was said on this version.'}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: comments.length ? 12 : 0 }}>
        {comments.map(c => (
          <div key={c.id} style={{ borderLeft: `3px solid ${c.role === 'buyer' ? T.info : T.primary}`, paddingLeft: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 3 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{c.by}</span>
              <Pill tone={c.role === 'buyer' ? 'info' : 'neutral'}>{c.role === 'buyer' ? 'Customer' : 'Factory'}</Pill>
              {c.kind === 'changes' && <Pill tone="warn">Changes requested</Pill>}
              <span style={{ fontSize: 11, color: T.textLight }}>{ago(c.at)}</span>
            </div>
            <div style={{ fontSize: 13, color: T.text, lineHeight: 1.55, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{c.text}</div>
          </div>
        ))}
      </div>
      {canComment && (
        <div style={{ marginTop: 16 }}>
          <Textarea value={text} onChange={e => setText(e.target.value)} rows={3} maxLength={2000} placeholder="Write a comment" aria-label="Write a comment" />
          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <Btn variant="secondary" disabled={busy || !text.trim()} onClick={() => send('comment')}>{busy ? 'Sending...' : 'Send comment'}</Btn>
            {canRequestChanges && <Btn variant="outline" disabled={busy || !text.trim()} onClick={() => send('changes')}>Request changes</Btn>}
          </div>
        </div>
      )}
    </Card>
  )
}
