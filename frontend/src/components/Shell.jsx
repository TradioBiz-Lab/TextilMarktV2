import { Logo } from './Brand.jsx'
import { useState, useEffect } from 'react'
import { Home, ClipboardList, ListChecks, Folder, ShieldCheck, Package, History, Users, Bell, Menu, ChevronsLeft, WifiOff, Check, BarChart3, Bot, Hexagon, Inbox, Factory } from '../icons.jsx'
import { T } from '../constants.js'
import { capsFor } from '../caps.js'
import { Btn, RibbonBanner } from './ui.jsx'
import { NotifPanel } from './NotifPanel.jsx'
import { KriyaaWidget } from './KriyaaWidget.jsx'
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
      <WifiOff size={16} color="#f8fafc" />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#f8fafc' }}>No internet connection</div>
        <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 1 }}>Some features may not work. Check your network and try again.</div>
      </div>
      <span style={{ fontSize: 11, fontWeight: 700, color: '#64748b', background: '#0f172a', padding: '2px 8px', borderRadius: 6, whiteSpace: 'nowrap' }}>Offline</span>
    </div>
  )

  return (
    <div style={{ background: '#f0fdf4', borderBottom: '1px solid #86efac', padding: '7px 24px', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, zIndex: 400 }}>
      <Check size={15} color="#15803d" strokeWidth={3} />
      <span style={{ fontSize: 12, fontWeight: 600, color: '#15803d' }}>Connection restored</span>
    </div>
  )
}


export function Shell({ view, setView, children, onOpenOrder }) {
  const { currentUser: user, logout, unread, ribbons } = useApp()
  const [notifOpen, setNotifOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  // Every role gets the same six tabs, in the same order. Admins get three extra
  // management tabs; what each tab shows is scoped to the signed-in user's own data.
  // A customer reads the plan first: Reports sits right under the Dashboard and Orders is called Order TnA.
  const isCustomer = user?.role === 'buyer'
  const reportsTab = { id: 'reports', icon: BarChart3, label: 'Reports' }
  const nav = !user ? [] : [
    { id: 'dashboard', icon: Home, label: 'Dashboard' },
    ...(isCustomer ? [reportsTab] : []),
    { id: 'action_items', icon: ListChecks, label: 'Action Items' },
    { id: 'kriyaa', icon: Bot, label: 'Kriyaa' },
    { id: 'orders', icon: Package, label: isCustomer ? 'Order TnA' : 'Orders' },
    ...(capsFor(user).seeReviewQueue ? [{ id: 'review', icon: Inbox, label: 'Review Queue' }] : []),
    { id: 'documents', icon: Folder, label: 'Documents' },
    ...(isCustomer ? [] : [reportsTab]),
    ...(user.role === 'admin' ? [{ id: 'audit', icon: History, label: 'Audit Log' }] : []),
    ...(capsFor(user).seePartners ? [{ id: 'partners', icon: Factory, label: 'Partners' }] : []),
    ...(user.role === 'admin' && user.adminType === 'master' ? [{ id: 'users', icon: Users, label: 'User Setup' }] : []),
  ]

  const roleLabel = user?.role === 'admin'
    ? (user?.adminType === 'master' ? 'Master Admin' : 'Admin Portal')
    : user?.role === 'buyer' ? 'Buyer Portal' : 'Manufacturer Portal'

  const ROLE_DOT = { master: '#A78BFA', admin: T.primary, buyer: '#7DD3FC', manufacturer: '#FDBA74' }
  const roleDot = user?.role === 'admin'
    ? (user?.adminType === 'master' ? ROLE_DOT.master : ROLE_DOT.admin)
    : user?.role === 'buyer' ? ROLE_DOT.buyer : ROLE_DOT.manufacturer

  // Clicking empty space on the page folds the sidebar to icons, so the work gets the width. A click on a control or a
  // row does its own job and leaves the layout alone, and so does any click inside a pop-up (every dialog, shared or
  // hand-built, sits on a fixed full-screen layer). The drawer on a phone already closes itself.
  const INTERACTIVE = 'button, a, input, select, textarea, label, summary, tr, th, td, [role="button"], [role="tab"], [role="menuitem"], [role="dialog"], [contenteditable="true"]'
  const inOverlay = (el, stop) => {
    for (let n = el; n && n !== stop; n = n.parentElement) if (getComputedStyle(n).position === 'fixed') return true
    return false
  }
  const collapseOnPageClick = e => {
    if (e.target.closest?.(INTERACTIVE) || inOverlay(e.target, e.currentTarget)) return
    if (window.matchMedia('(min-width: 769px)').matches) setSidebarCollapsed(true)
  }

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
      <aside className={`shell-sidebar${sidebarOpen ? ' open' : ''}${sidebarCollapsed ? ' collapsed' : ''}`} onClick={() => { if (sidebarCollapsed) setSidebarCollapsed(false) }} style={{ background: T.sidebarGradient, display: 'flex', flexDirection: 'column' }}>
        {/* Brand first, portal second: the logo lockup (just the mark when collapsed), then which portal this is. */}
        <div style={{ padding: sidebarCollapsed ? '16px 8px 14px' : '18px 16px 16px', borderBottom: `1px solid ${T.sidebarBorder}` }}>
          {sidebarCollapsed
            ? <div title={roleLabel} style={{ display: 'flex', justifyContent: 'center' }}><Logo variant="compact" onDark size={32} /></div>
            : <>
                <div style={{ display: 'flex' }}><Logo onDark size={36} /></div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14 }}>
                  <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', background: roleDot, flexShrink: 0 }} />
                  <span style={{ fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.78)', textTransform: 'uppercase', letterSpacing: '0.09em', whiteSpace: 'nowrap' }}>{roleLabel}</span>
                </div>
              </>
          }
        </div>

        <nav style={{ flex: 1, padding: sidebarCollapsed ? '8px 4px' : '8px', display: 'flex', flexDirection: 'column', gap: 2, overflowY: 'auto' }}>
          {nav.map(n => {
            const active = view === n.id || (n.id === 'orders' && (view === 'order_detail' || view === 'submit_req')) || (n.id === 'partners' && view === 'partner_detail')
            const Icon = n.icon
            return (
              <button key={n.id} onClick={() => handleNav(n.id)} title={sidebarCollapsed ? n.label : undefined}
                className="sidebar-nav-item" aria-current={active ? 'page' : undefined}
                style={{ display: 'flex', alignItems: 'center', justifyContent: sidebarCollapsed ? 'center' : 'flex-start', gap: 10, padding: sidebarCollapsed ? '9px 0' : '9px 12px', borderRadius: 9, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: active ? 700 : 500, textAlign: 'left', background: active ? 'rgba(255,255,255,0.12)' : 'transparent', color: active ? '#fff' : 'rgba(255,255,255,0.55)', transition: 'all 0.12s', fontFamily: 'inherit' }}>
                <Icon size={18} weight={active ? 'fill' : 'regular'} style={{ flexShrink: 0 }} />{!sidebarCollapsed && n.label}
              </button>
            )
          })}
        </nav>

        {/* Collapse toggle */}
        <button className="sidebar-collapse-btn" onClick={() => setSidebarCollapsed(p => !p)}
          style={{ padding: '10px', background: 'none', border: 'none', borderTop: `1px solid ${T.sidebarBorder}`, cursor: 'pointer', color: 'rgba(255,255,255,0.45)', fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontFamily: 'inherit', transition: 'color 0.15s' }}>
          <ChevronsLeft size={15} style={{ transform: sidebarCollapsed ? 'rotate(180deg)' : 'none', transition: 'transform 0.25s' }} />
          {!sidebarCollapsed && <span style={{ fontSize: 11, fontWeight: 600 }}>Collapse</span>}
        </button>

        {!sidebarCollapsed && (
          <div style={{ padding: '12px 14px', borderTop: `1px solid ${T.sidebarBorder}` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <div style={{ width: 30, height: 30, borderRadius: '50%', background: '#273D6D', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 800, color: '#e2e8f0', flexShrink: 0, border: '1px solid rgba(255,255,255,0.15)' }}>{user?.name?.[0]}</div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.name}</div>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.company}</div>
              </div>
            </div>
          </div>
        )}
        {sidebarCollapsed && (
          <div style={{ padding: '12px 0', borderTop: `1px solid ${T.sidebarBorder}`, display: 'flex', justifyContent: 'center' }}>
            <div style={{ width: 30, height: 30, borderRadius: '50%', background: '#273D6D', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 800, color: '#e2e8f0', border: '1px solid rgba(255,255,255,0.15)' }}>{user?.name?.[0]}</div>
          </div>
        )}
      </aside>

      {/* ── Main area ── */}
      <div onClick={collapseOnPageClick} style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0, minHeight: 0 }}>

        {/* Header */}
        <header className="shell-header" style={{ background: T.surface, borderBottom: `1px solid ${T.border}`, height: 54, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0, position: 'relative', zIndex: 300 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {/* Hamburger for mobile */}
            <button className="hamburger-btn" onClick={() => setSidebarOpen(true)} aria-label="Open menu">
              <Menu size={20} />
            </button>
            <div className="header-logo"><Logo size={28} /></div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ position: 'relative' }}>
              <button data-notif-toggle onClick={() => setNotifOpen(p => !p)}
                style={{ background: '#f8fafc', border: `1px solid ${T.border}`, borderRadius: 9, width: 36, height: 36, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Bell size={18} color={T.textMuted} /></button>
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

      {/* Floating AI assistant — admin-only (matches the backend's requireAdmin
          gate), rendered unconditionally so its conversation survives
          navigating between pages within the session. */}
      {/* Hidden on the Kriyaa page itself: the page IS the chat, and the floating button would sit on top of its Send button. The conversation lives in KriyaaChatProvider, so it carries over. */}
      {user && view !== 'kriyaa' && <KriyaaWidget />}
    </div>
  )
}
