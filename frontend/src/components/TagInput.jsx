import { useState } from 'react'
import { X } from '../icons.jsx'
import { T } from '../constants.js'
import { snakeOf, labelOf } from '../partners.js'

// A list of short tags typed one at a time: Enter or a comma adds one, Backspace on an empty box takes the last
// away, and the tags already used elsewhere in the directory are offered as you type. `snake` keeps product, fabric
// and category tags in the one form the server stores them in (sports_bra); keywords stay plain lower-case words.
export function TagInput({ label, value, onChange, suggestions = [], placeholder, snake = false, keepCase = false, hint }) {
  const [text, setText] = useState('')
  const [focus, setFocus] = useState(false)
  // `keepCase` is for names (brands) that are shown as typed; otherwise tags are lower-case.
  const norm = t => (snake ? snakeOf(t) : keepCase ? String(t).trim().replace(/\s+/g, ' ') : String(t).trim().toLowerCase().replace(/\s+/g, ' '))
  const sameTag = (a, b) => (keepCase ? a.toLowerCase() === b.toLowerCase() : a === b)
  const show = t => (snake ? labelOf(t) : t)

  const add = raw => {
    const fresh = String(raw).split(/[,;]/).map(norm).filter(t => t && t.length <= 60 && !value.some(v => sameTag(v, t)))
    const unique = fresh.filter((t, i) => fresh.findIndex(u => sameTag(u, t)) === i)
    if (unique.length) onChange([...value, ...unique].slice(0, 40))
    setText('')
  }
  const needle = norm(text).toLowerCase()
  const matches = suggestions.filter(s => !value.some(v => sameTag(v, s)) && (!needle || s.toLowerCase().includes(needle))).slice(0, 8)

  return (
    <div style={{ position: 'relative' }}>
      {label && <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 5 }}>{label}</label>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center', border: `1px solid ${focus ? T.primary : T.border}`, borderRadius: 8, padding: '5px 8px', background: T.surface, minHeight: 38 }}>
        {value.map(t => (
          <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 4px 2px 9px', borderRadius: T.radius.pill, fontSize: T.fontSize.sm, fontWeight: 600, background: T.primaryLight, color: T.primaryDeep, border: `1px solid ${T.warningBorder}` }}>
            {show(t)}
            <button type="button" onClick={() => onChange(value.filter(x => x !== t))} aria-label={`Remove ${show(t)}`}
              style={{ background: 'none', border: 'none', padding: 2, cursor: 'pointer', display: 'flex', color: T.primaryDeep }}><X size={11} /></button>
          </span>
        ))}
        <input value={text} placeholder={value.length ? '' : placeholder}
          onChange={e => { const v = e.target.value; if (/[,;]/.test(v)) add(v); else setText(v) }}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); if (text.trim()) add(text) }
            else if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1))
          }}
          onFocus={() => setFocus(true)} onBlur={() => { setFocus(false); if (text.trim()) add(text) }}
          style={{ flex: 1, minWidth: 110, border: 'none', outline: 'none', fontSize: 13, fontFamily: 'inherit', color: T.text, background: 'transparent', padding: '3px 2px' }} />
      </div>
      {focus && matches.length > 0 && (
        <div style={{ position: 'absolute', zIndex: 20, left: 0, right: 0, top: '100%', marginTop: 4, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8, boxShadow: T.shadow.md, padding: 4, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {matches.map(s => (
            <button key={s} type="button" onMouseDown={e => { e.preventDefault(); add(s) }}
              style={{ border: `1px solid ${T.border}`, background: '#f8fafc', borderRadius: T.radius.pill, padding: '2px 10px', fontSize: T.fontSize.sm, fontWeight: 600, color: T.textMuted, cursor: 'pointer', fontFamily: 'inherit' }}>{show(s)}</button>
          ))}
        </div>
      )}
      {hint && <div style={{ fontSize: 11, color: T.textLight, marginTop: 3 }}>{hint}</div>}
    </div>
  )
}
