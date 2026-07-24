import { useState, useEffect } from 'react'
import { AppProvider, useApp } from './context.jsx'
import { Shell } from './components/Shell.jsx'
import { LoginPage } from './pages/LoginPage.jsx'
import { BuyerDashboard } from './pages/buyer/BuyerDashboard.jsx'
import { BuyerOrderDetail } from './pages/buyer/BuyerOrderDetail.jsx'
import { BuyerDocuments } from './pages/buyer/BuyerDocuments.jsx'
import { BuyerSubmitReq } from './pages/buyer/BuyerSubmitReq.jsx'
import { MfrDashboard } from './pages/manufacturer/MfrDashboard.jsx'
import { MfrOrderDetail } from './pages/manufacturer/MfrOrderDetail.jsx'
import { MfrCerts } from './pages/manufacturer/MfrCerts.jsx'
import { AdminDashboard } from './pages/admin/AdminDashboard.jsx'
import { AdminOrders } from './pages/admin/AdminOrders.jsx'
import { AdminOrderDetail } from './pages/admin/AdminOrderDetail.jsx'
import { AdminDocuments } from './pages/admin/AdminDocuments.jsx'
import { AdminAuditLog } from './pages/admin/AdminAuditLog.jsx'
import { UserSetup } from './pages/admin/UserSetup.jsx'
import { ActionItemsCenter } from './pages/admin/ActionItemsCenter.jsx'
import { ReportingPage } from './pages/shared/ReportingPage.jsx'
import { authApi } from './api.js'
import { T } from './constants.js'
import { Input, Btn, ToastProvider } from './components/ui.jsx'

function ForceChangePassword() {
  const { logout } = useApp()
  const [cur, setCur]   = useState('')
  const [nw, setNw]     = useState('')
  const [conf, setConf] = useState('')
  const [err, setErr]   = useState('')
  const [ok, setOk]     = useState(false)
  const [busy, setBusy] = useState(false)

  const submit = async e => {
    e.preventDefault()
    if (nw.length < 8 || !/[A-Z]/.test(nw) || !/[a-z]/.test(nw) || !/[0-9]/.test(nw) || !/[^A-Za-z0-9]/.test(nw)) {
      setErr('Password must be at least 8 characters and include uppercase, lowercase, a number, and a special character.')
      return
    }
    if (nw !== conf)   { setErr('Passwords do not match.'); return }
    setBusy(true); setErr('')
    try {
      await authApi.changePassword(cur, nw)
      setOk(true)
      setTimeout(logout, 2000)
    } catch (e) {
      setErr(typeof e === 'string' ? e : 'Failed to change password. Check your current password.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ minHeight: '100vh', background: T.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: T.surface, borderRadius: 14, border: `1px solid ${T.border}`, padding: 32, width: '100%', maxWidth: 400, boxShadow: '0 8px 32px rgba(0,0,0,0.08)' }}>
        <div style={{ fontSize: 20, fontWeight: 800, color: T.text, marginBottom: 6 }}>Set your password</div>
        <div style={{ fontSize: 13, color: T.textMuted, marginBottom: 24 }}>You must change your temporary password before continuing.</div>
        {ok ? (
          <div style={{ color: T.success, fontWeight: 600, textAlign: 'center', padding: '16px 0' }}>✓ Password changed — redirecting to login…</div>
        ) : (
          <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Input label="Current (temporary) password" type="password" value={cur} onChange={e => { setCur(e.target.value); setErr('') }} required />
            <Input label="New password" type="password" value={nw} onChange={e => { setNw(e.target.value); setErr('') }} required />
            <Input label="Confirm new password" type="password" value={conf} onChange={e => { setConf(e.target.value); setErr('') }} required />
            {err && <div style={{ fontSize: 12, color: T.danger, fontWeight: 500 }}>⚠ {err}</div>}
            <Btn type="submit" block disabled={busy}>{busy ? 'Saving…' : 'Set Password'}</Btn>
            <button type="button" onClick={logout} style={{ background: 'none', border: 'none', fontSize: 12, color: T.textLight, cursor: 'pointer', fontFamily: 'inherit' }}>Sign out instead</button>
          </form>
        )}
      </div>
    </div>
  )
}

function Inner() {
  const { currentUser: user, loading } = useApp()
  const [view, setView] = useState('dashboard')
  const [selOid, setSelOid] = useState(null)
  const [selMid, setSelMid] = useState(null)
  const [ordersStatus, setOrdersStatus] = useState(null)
  // Always start at dashboard on login or session restore
  useEffect(() => {
    if (user?.id) {
      setView('dashboard')
      setSelOid(null)
    }
  }, [user?.id])

  if (loading && !user) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: T.bg }}>
        <div style={{ fontSize: 14, color: T.textMuted }}>Loading…</div>
      </div>
    )
  }

  if (!user) return <LoginPage />

  if (user.mustChangePw) return <ForceChangePassword />

  const navTo = (v, params) => { setView(v); setSelOid(null); setOrdersStatus(params?.status ?? null) }
  const openOrder = (id, mid) => { setSelOid(id); setSelMid(mid ? String(mid) : null); setView('order_detail') }

  const renderView = () => {
    if (user.role === 'buyer') {
      if (view === 'dashboard') return <BuyerDashboard onOpen={openOrder} onSubmitReq={() => navTo('submit_req')} />
      if (view === 'order_detail' && selOid) return <BuyerOrderDetail orderId={selOid} initialMid={selMid} onBack={() => navTo('dashboard')} />
      if (view === 'submit_req') return <BuyerSubmitReq />
      if (view === 'documents') return <BuyerDocuments />
      if (view === 'reports') return <ReportingPage onOpen={openOrder} />
    }
    if (user.role === 'manufacturer') {
      if (view === 'dashboard') return <MfrDashboard onOpen={openOrder} />
      if (view === 'order_detail' && selOid) return <MfrOrderDetail orderId={selOid} onBack={() => navTo('dashboard')} />
      if (view === 'certs') return <MfrCerts />
    }
    if (user.role === 'admin') {
      if (view === 'dashboard') return <AdminDashboard onNavigate={navTo} onOpen={openOrder} />
      if (view === 'orders') return <AdminOrders onOpen={openOrder} initialStatus={ordersStatus} />
      if (view === 'action_items') return <ActionItemsCenter onOpen={openOrder} onNavigate={navTo} />
      if (view === 'order_detail' && selOid) return <AdminOrderDetail orderId={selOid} initialMid={selMid} onBack={() => navTo('orders')} />
      if (view === 'documents') return <AdminDocuments />
      if (view === 'reports') return <ReportingPage onOpen={openOrder} />
      if (view === 'audit') return <AdminAuditLog />
      if (view === 'users' && user.adminType === 'master') return <UserSetup />
    }
    return <div style={{ textAlign: 'center', padding: '60px', color: T.textLight }}>Page not found</div>
  }

  return (
    <Shell view={view} setView={navTo} onOpenOrder={openOrder}>
      {renderView()}
    </Shell>
  )
}

export default function App() {
  return (
    <ToastProvider>
      <AppProvider>
        <Inner />
      </AppProvider>
    </ToastProvider>
  )
}
