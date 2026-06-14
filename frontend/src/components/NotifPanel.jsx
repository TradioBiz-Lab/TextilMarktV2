import { useEffect, useRef } from 'react'
import { T } from '../constants.js'
import { EmptyState } from './ui.jsx'
import { useApp } from '../context.jsx'

function fmtAge(at) {
  if (!at) return ''
  const diff = Date.now() - new Date(at).getTime()
  if (diff < 60000)     return 'Just now'
  if (diff < 3600000)   return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000)  return `${Math.floor(diff / 3600000)}h ago`
  return new Date(at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
}

export function NotifPanel({ onClose, onOpenOrder }) {
  const { notifs, markAllRead, markOneRead } = useApp()
  const panelRef = useRef(null)

  useEffect(() => {
    const handler = e => {
      if (panelRef.current && !panelRef.current.contains(e.target)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  const handleNotifClick = n => {
    if (!n.read) markOneRead(n.id)
    if (n.orderId && onOpenOrder) {
      onOpenOrder(n.orderId)
      onClose()
    }
  }

  return (
    <div ref={panelRef} style={{ position: 'fixed', top: 54, right: 16, zIndex: 500, width: 340, background: T.surface, borderRadius: 12, border: `1px solid ${T.border}`, boxShadow: '0 12px 40px rgba(0,0,0,0.14)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px', borderBottom: `1px solid ${T.border}` }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: T.text }}>Notifications</span>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button onClick={markAllRead} style={{ fontSize: 11, color: T.primary, background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}>Mark all read</button>
          <button onClick={onClose} style={{ background: '#f1f5f9', border: 'none', cursor: 'pointer', width: 24, height: 24, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, color: T.textMuted }}>×</button>
        </div>
      </div>
      <div style={{ maxHeight: 360, overflowY: 'auto' }}>
        {notifs.length === 0
          ? <EmptyState icon="🔔" title="All caught up" desc="No notifications" />
          : notifs.map(n => {
            const clickable = !n.read || (n.orderId && onOpenOrder)
            return (
              <div key={n.id} onClick={() => handleNotifClick(n)}
                style={{ padding: '12px 18px', borderBottom: `1px solid ${T.border}`, background: n.read ? T.surface : '#fafbff', display: 'flex', gap: 10, alignItems: 'flex-start', cursor: clickable ? 'pointer' : 'default' }}>
                <span style={{ fontSize: 16, lineHeight: 1, flexShrink: 0 }}>{n.type === 'alert' ? '⚠️' : n.type === 'status' ? '🔄' : '📦'}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: T.text, fontWeight: n.read ? 400 : 600, lineHeight: 1.5 }}>{n.msg}</div>
                  {n.orderId && onOpenOrder && (
                    <div style={{ fontSize: 10, color: T.primary, marginTop: 2, fontWeight: 600 }}>View order →</div>
                  )}
                  <div style={{ fontSize: 10, color: T.textLight, marginTop: 3 }}>{fmtAge(n.at)}</div>
                </div>
                {!n.read && <div style={{ width: 7, height: 7, borderRadius: '50%', background: T.primary, flexShrink: 0, marginTop: 4 }} />}
              </div>
            )
          })}
      </div>
    </div>
  )
}
