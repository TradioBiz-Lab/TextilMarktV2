import { useMemo, useRef, useState, useEffect } from 'react'
import { Search, Folder, X } from '../icons.jsx'
import { T } from '../constants.js'
import { ProductThumb } from './ui.jsx'
import { useApp } from '../context.jsx'
import { buildSearchIndex, searchItems } from '../search.js'

// The search box in the top bar. Type a customer, a master order, a style name, or a style ID (the last four digits are
// enough); Enter opens the best match, the arrows move through the rest. A style opens its page, a master order its page.
// "/" or Ctrl/Cmd+K jumps here from anywhere.
export function GlobalSearch({ onOpenOrder, onOpenMo }) {
  const { orders, masterOrders, currentUser } = useApp()
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const input = useRef(null)
  const index = useMemo(() => buildSearchIndex({ orders, masterOrders }), [orders, masterOrders])
  const results = useMemo(() => searchItems(index, q), [index, q])
  useEffect(() => { setActive(0) }, [q])

  useEffect(() => {
    const onKey = e => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) { e.preventDefault(); input.current?.focus(); setOpen(true) }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const go = item => {
    if (!item) return
    setOpen(false); setQ(''); input.current?.blur()
    if (item.kind === 'style') onOpenOrder?.(item.id)
    else onOpenMo?.(item.id)
  }
  const onKeyDown = e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive(a => Math.min(a + 1, results.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); go(results[active]) }
    else if (e.key === 'Escape') { setOpen(false); input.current?.blur() }
  }

  const isAdmin = currentUser?.role === 'admin'
  return (
    <div className="global-search" style={{ position: 'relative', flex: 1, maxWidth: 520, minWidth: 0, margin: '0 16px' }}>
      <Search size={15} color={T.textLight} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} />
      <input ref={input} value={q} onChange={e => { setQ(e.target.value); setOpen(true) }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 120)} onKeyDown={onKeyDown}
        placeholder={isAdmin ? 'Search customer, master order, style or style ID' : 'Search your styles and orders'} aria-label="Search"
        role="combobox" aria-expanded={open && !!q.trim()} aria-controls="global-search-results"
        style={{ width: '100%', boxSizing: 'border-box', border: `1px solid ${T.border}`, borderRadius: 9, padding: '8px 30px 8px 32px', fontSize: 13, color: T.text, background: '#f8fafc', fontFamily: 'inherit' }} />
      {q && <button onMouseDown={e => e.preventDefault()} onClick={() => { setQ(''); input.current?.focus() }} aria-label="Clear the search" style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', padding: 2, display: 'flex', color: T.textLight }}><X size={14} /></button>}

      {open && q.trim() && (
        <div id="global-search-results" role="listbox" style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0, minWidth: 280, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, boxShadow: '0 12px 32px rgba(15,23,42,0.16)', padding: 6, zIndex: 400, maxHeight: '70vh', overflowY: 'auto' }}>
          {results.length === 0 && <div style={{ padding: '12px 10px', fontSize: 13, color: T.textMuted }}>Nothing matches "{q.trim()}".</div>}
          {results.map((r, i) => (
            <div key={`${r.kind}:${r.id}`} role="option" aria-selected={i === active} onMouseDown={e => e.preventDefault()} onClick={() => go(r)} onMouseEnter={() => setActive(i)}
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 8px', borderRadius: 8, cursor: 'pointer', background: i === active ? T.primaryLight : 'transparent' }}>
              {r.kind === 'style'
                ? <div style={{ transform: 'scale(0.75)', transformOrigin: 'center', margin: -6, flexShrink: 0 }}><ProductThumb order={r.order} /></div>
                : <span style={{ width: 36, height: 36, borderRadius: 8, background: '#eef2ff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Folder size={16} color="#4338ca" /></span>}
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</div>
                <div style={{ fontSize: 11.5, color: T.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.sub}</div>
              </div>
              {r.badge && <span style={{ fontSize: 10, fontWeight: 800, color: T.textMuted, background: '#f1f5f9', border: `1px solid ${T.border}`, borderRadius: 999, padding: '1px 8px', whiteSpace: 'nowrap', flexShrink: 0 }}>{r.badge}</span>}
            </div>
          ))}
          {results.length > 0 && <div style={{ padding: '6px 8px 2px', fontSize: 10.5, color: T.textLight }}>Enter opens the first; arrows move. Press / to search from anywhere.</div>}
        </div>
      )}
    </div>
  )
}
