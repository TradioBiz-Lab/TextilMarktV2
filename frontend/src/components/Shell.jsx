import { useState, useEffect } from 'react'
import { T } from '../constants.js'
import { Btn, RibbonBanner } from './ui.jsx'
import { NotifPanel } from './NotifPanel.jsx'
import { useApp } from '../context.jsx'

function NetworkBanner() {
  const [online, setOnline] = useState(navigator.onLine)
  const [justRestored, setJustRestored] = useState(false)

  useEffect(() => {
    const goOffline = () => { setOnline(false); setJustRestored(false) }
    const goOnline  = () => {
      setOnline(true)
      setJustRestored(true)
      setTimeout(() => setJustRestored(false), 3000)
    }
    window.addEventListener('offline', goOffline)
    window.addEventListener('online',  goOnline)
    return () => {
      window.removeEventListener('offline', goOffline)
      window.removeEventListener('online',  goOnline)
    }
  }, [])

  if (online && !justRestored) return null

  if (!online) return (
    <div style={{ background: '#1e293b', borderBottom: '1px solid #334155', padding: '9px 24px', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0, zIndex: 400 }}>
      <span style={{ fontSize: 15 }}>📡</span>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#f8fafc' }}>No internet connection</div>
        <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 1 }}>Some features may not work. Check your network and try again.</div>
      </div>
      <span style={{ fontSize: 11, fontWeight: 700, color: '#64748b', background: '#0f172a', padding: '2px 8px', borderRadius: 6, whiteSpace: 'nowrap' }}>Offline</span>
    </div>
  )

  return (
    <div style={{ background: '#f0fdf4', borderBottom: '1px solid #86efac', padding: '7px 24px', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, zIndex: 400 }}>
      <span style={{ fontSize: 13, fontWeight: 800, color: '#15803d' }}>✓</span>
      <span style={{ fontSize: 12, fontWeight: 600, color: '#15803d' }}>Connection restored</span>
    </div>
  )
}


function Logo() {
  return (
    <div style={{ display: 'inline-flex', flexDirection: 'column', gap: 1 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', lineHeight: 1 }}>
        <span style={{ fontSize: 17, fontWeight: 800, color: '#003B73', letterSpacing: '-0.02em', fontFamily: 'inherit' }}>Textil</span>
        <span style={{ fontSize: 17, fontWeight: 800, color: '#C2410C', letterSpacing: '-0.02em', fontFamily: 'inherit' }}>Markt</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end' }}>
        <div style={{ width: 14, height: 1.5, background: '#C2410C', borderRadius: 1 }} />
        <span style={{ fontSize: 7, fontWeight: 700, color: '#94a3b8', letterSpacing: '0.08em', textTransform: 'uppercase' }}>by Tradio</span>
      </div>
    </div>
  )
}

export function Shell({ view, setView, children, onOpenOrder }) {
  const { currentUser: user, logout, unread, ribbons } = useApp()
  const [notifOpen, setNotifOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  const nav = {
    buyer: [
      { id: 'dashboard', icon: '🏠', label: 'Dashboard' },
      { id: 'submit_req', icon: '📋', label: 'Submit Requirement' },
      { id: 'documents', icon: '📁', label: 'Documents' },
    ],
    manufacturer: [
      { id: 'dashboard', icon: '🏠', label: 'Dashboard' },
      { id: 'certs', icon: '🛡', label: 'Certificates' },
    ],
    admin: [
      { id: 'dashboard', icon: '🏠', label: 'Dashboard' },
      { id: 'orders',    icon: '📦', label: 'Orders' },
      { id: 'documents', icon: '📁', label: 'Documents' },
      { id: 'audit',     icon: '🔍', label: 'Audit Log' },
      ...(user?.adminType === 'master' ? [{ id: 'users', icon: '👥', label: 'User Setup' }] : []),
    ],
  }[user?.role] || []

  const roleLabel = user?.role === 'admin'
    ? (user?.adminType === 'master' ? 'Master Admin' : 'Admin Portal')
    : user?.role === 'buyer' ? 'Buyer Portal' : 'Manufacturer Portal'

  const roleColor = user?.role === 'admin'
    ? (user?.adminType === 'master' ? T.master : T.primary)
    : user?.role === 'buyer' ? '#0f766e' : '#c2410c'

  const handleNav = id => {
    setView(id)
    setSidebarOpen(false)
  }

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>

      {/* ── Sidebar overlay (mobile) ── */}
      <div
        className={`sidebar-overlay${sidebarOpen ? ' open' : ''}`}
        onClick={() => setSidebarOpen(false)}
      />

      {/* ── Sidebar ── */}
      <aside className={`shell-sidebar${sidebarOpen ? ' open' : ''}${sidebarCollapsed ? ' collapsed' : ''}`} style={{ background: T.sidebar, display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: sidebarCollapsed ? '20px 8px 16px' : '20px 16px 16px', borderBottom: `1px solid ${T.sidebarBorder}` }}>
          {sidebarCollapsed
            ? <div style={{ display: 'flex', justifyContent: 'center' }}><span style={{ fontSize: 16, fontWeight: 800, color: roleColor, letterSpacing: '-0.02em' }}>⬡</span></div>
            : <div style={{ fontSize: 20, fontWeight: 800, color: roleColor, textTransform: 'uppercase', letterSpacing: '0.06em', textAlign: 'center', lineHeight: 1.2 }}>{roleLabel}</div>
          }
        </div>

        <nav style={{ flex: 1, padding: sidebarCollapsed ? '8px 4px' : '8px', display: 'flex', flexDirection: 'column', gap: 2, overflowY: 'auto' }}>
          {nav.map(n => {
            const active = view === n.id
            return (
              <button key={n.id} onClick={() => handleNav(n.id)} title={sidebarCollapsed ? n.label : undefined}
                style={{ display: 'flex', alignItems: 'center', justifyContent: sidebarCollapsed ? 'center' : 'flex-start', gap: 10, padding: sidebarCollapsed ? '9px 0' : '9px 12px', borderRadius: 9, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: active ? 700 : 500, textAlign: 'left', background: active ? 'rgba(255,255,255,0.12)' : 'transparent', color: active ? '#fff' : 'rgba(255,255,255,0.55)', transition: 'all 0.12s', fontFamily: 'inherit' }}>
                <span style={{ fontSize: 16, lineHeight: 1 }}>{n.icon}</span>{!sidebarCollapsed && n.label}
              </button>
            )
          })}
        </nav>

        {/* Collapse toggle */}
        <button className="sidebar-collapse-btn" onClick={() => setSidebarCollapsed(p => !p)}
          style={{ padding: '10px', background: 'none', border: 'none', borderTop: `1px solid ${T.sidebarBorder}`, cursor: 'pointer', color: 'rgba(255,255,255,0.45)', fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontFamily: 'inherit', transition: 'color 0.15s' }}>
          <span style={{ transform: sidebarCollapsed ? 'rotate(180deg)' : 'none', transition: 'transform 0.25s', display: 'inline-block' }}>«</span>
          {!sidebarCollapsed && <span style={{ fontSize: 11, fontWeight: 600 }}>Collapse</span>}
        </button>

        {!sidebarCollapsed && (
          <div style={{ padding: '12px 14px', borderTop: `1px solid ${T.sidebarBorder}` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <div style={{ width: 30, height: 30, borderRadius: '50%', background: '#002B5B', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 800, color: '#e2e8f0', flexShrink: 0, border: '1px solid rgba(255,255,255,0.15)' }}>{user?.name?.[0]}</div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.name}</div>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.company}</div>
              </div>
            </div>
          </div>
        )}
        {sidebarCollapsed && (
          <div style={{ padding: '12px 0', borderTop: `1px solid ${T.sidebarBorder}`, display: 'flex', justifyContent: 'center' }}>
            <div style={{ width: 30, height: 30, borderRadius: '50%', background: '#002B5B', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 800, color: '#e2e8f0', border: '1px solid rgba(255,255,255,0.15)' }}>{user?.name?.[0]}</div>
          </div>
        )}
      </aside>

      {/* ── Main area ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0, minHeight: 0 }}>

        {/* Header */}
        <header className="shell-header" style={{ background: T.surface, borderBottom: `1px solid ${T.border}`, height: 54, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0, position: 'relative', zIndex: 300 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {/* Hamburger for mobile */}
            <button className="hamburger-btn" onClick={() => setSidebarOpen(true)}>
              ☰
            </button>
            <Logo />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ position: 'relative' }}>
              <button onClick={() => setNotifOpen(p => !p)}
                style={{ background: '#f8fafc', border: `1px solid ${T.border}`, borderRadius: 9, width: 36, height: 36, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 17 }}>🔔</button>
              {unread > 0 && (
                <span style={{ position: 'absolute', top: -4, right: -4, background: '#ef4444', color: '#fff', borderRadius: 10, fontSize: 9, fontWeight: 800, minWidth: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 3px', border: '2px solid #fff' }}>{unread}</span>
              )}
            </div>
            <div className="header-user-info" style={{ alignItems: 'center', gap: 9 }}>
              <div style={{ width: 32, height: 32, borderRadius: '50%', background: T.primaryLight, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 800, color: T.primary }}>{user?.name?.[0]}</div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{user?.name}</div>
                <div style={{ fontSize: 10, color: T.textLight }}>{user?.role === 'admin' ? (user?.adminType === 'master' ? 'Master Admin' : 'Admin User') : user?.role} · {user?.code}</div>
              </div>
            </div>
            <Btn variant="secondary" size="sm" onClick={logout}>Sign out</Btn>
          </div>
        </header>

        {/* Network status banner */}
        <NetworkBanner />

        {/* Ribbon banners */}
        <div style={{ position: 'relative', zIndex: 299, flexShrink: 0 }}>
          <RibbonBanner ribbons={ribbons} />
        </div>

        {/* Notification panel */}
        {notifOpen && <NotifPanel onClose={() => setNotifOpen(false)} onOpenOrder={onOpenOrder} />}

        {/* Page content */}
        <main className="main-content" style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>{children}</main>
      </div>
    </div>
  )
}
