import { useState, useEffect } from 'react'
import { CheckCircle2, AlertTriangle } from 'lucide-react'
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
import { MfrMaterials } from './pages/manufacturer/MfrMaterials.jsx'
import { MfrCosting } from './pages/manufacturer/MfrCosting.jsx'
import { MfrProjects } from './pages/manufacturer/MfrProjects.jsx'
import { AdminDashboard } from './pages/admin/AdminDashboard.jsx'
import { OrderWizard } from './pages/shared/wizard/OrderWizard.jsx'
import { AdminOrders } from './pages/admin/AdminOrders.jsx'
import { AdminMaterials } from './pages/admin/AdminMaterials.jsx'
import { AdminCosting } from './pages/admin/AdminCosting.jsx'
import { InventoryPage } from './pages/shared/InventoryPage.jsx'
import { AdminOrderDetail } from './pages/admin/AdminOrderDetail.jsx'
import { AdminDocuments } from './pages/admin/AdminDocuments.jsx'
import { AdminAuditLog } from './pages/admin/AdminAuditLog.jsx'
import { UserSetup } from './pages/admin/UserSetup.jsx'
import { KriyaaPage } from './pages/admin/KriyaaPage.jsx'
import { KriyaaChatProvider } from './kriyaaChatContext.jsx'
import { ReportingPage } from './pages/shared/ReportingPage.jsx'
import { ActionItemsPage } from './pages/shared/ActionItemsPage.jsx'
import { WikiPage } from './pages/shared/WikiPage.jsx'
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
          <div style={{ color: T.success, fontWeight: 600, textAlign: 'center', padding: '16px 0', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}><CheckCircle2 size={16} /> Password changed — redirecting to login…</div>
        ) : (
          <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Input label="Current (temporary) password" type="password" value={cur} onChange={e => { setCur(e.target.value); setErr('') }} required />
            <Input label="New password" type="password" value={nw} onChange={e => { setNw(e.target.value); setErr('') }} required />
            <Input label="Confirm new password" type="password" value={conf} onChange={e => { setConf(e.target.value); setErr('') }} required />
            {err && <div style={{ fontSize: 12, color: T.danger, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 5 }}><AlertTriangle size={13} /> {err}</div>}
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
    // Action Items and the daily update are one page now — the same job, split
    // across two screens. Shared by all three roles; it scopes rows to what the
    // viewer may act on, and the server enforces the same boundary.
    if (view === 'action_items' || view === 'daily') return <ActionItemsPage onOpen={openOrder} onNavigate={navTo} />

    if (user.role === 'buyer') {
      // Swapped on purpose: Dashboard (homepage) shows the KPI/Gantt reporting
      // view; Reports shows the order List/Matrix table. See git history if
      // this ever needs to go back the other way.
      if (view === 'dashboard') return <ReportingPage onOpen={openOrder} />
      if (view === 'order_detail' && selOid) return <BuyerOrderDetail orderId={selOid} initialMid={selMid} onBack={() => navTo('dashboard')} />
      if (view === 'kriyaa') return <KriyaaPage />
      if (view === 'submit_req') return <BuyerSubmitReq />
      if (view === 'documents') return <BuyerDocuments />
      if (view === 'reports') return <BuyerDashboard onOpen={openOrder} onSubmitReq={() => navTo('submit_req')} />
    }
    if (user.role === 'manufacturer') {
      if (view === 'dashboard') return <MfrDashboard onOpen={openOrder} />
      if (view === 'order_wizard') return <OrderWizard onNavigate={navTo} onOpenOrder={openOrder} />
      if (view === 'order_detail' && selOid) return <MfrOrderDetail orderId={selOid} onBack={() => navTo('dashboard')} />
      if (view === 'certs') return <MfrCerts />
      if (view === 'kriyaa') return <KriyaaPage />
      if (view === 'materials') return <MfrMaterials />
      if (view === 'costing') return <MfrCosting />
      if (view === 'inventory') return <InventoryPage />
      if (view === 'projects') return <MfrProjects onNavigate={navTo} />
      // Manufacturers have no general document repository — the Wiki (Tech
      // Packs/SOPs/Inspection Forms) is their entire "Documents" experience today.
      if (view === 'documents') return <WikiPage />
    }
    if (user.role === 'admin') {
      if (view === 'dashboard') return <AdminDashboard onNavigate={navTo} onOpen={openOrder} />
      if (view === 'order_wizard') return <OrderWizard onNavigate={navTo} onOpenOrder={openOrder} />
      if (view === 'orders') return <AdminOrders onOpen={openOrder} onNavigate={navTo} initialStatus={ordersStatus} />
      if (view === 'materials') return <AdminMaterials />
      if (view === 'costing') return <AdminCosting />
      if (view === 'inventory') return <InventoryPage />
      if (view === 'order_detail' && selOid) return <AdminOrderDetail orderId={selOid} initialMid={selMid} onBack={() => navTo('orders')} />
      if (view === 'documents') return <AdminDocuments />
      if (view === 'reports') return <ReportingPage onOpen={openOrder} />
      if (view === 'audit') return <AdminAuditLog />
      if (view === 'kriyaa') return <KriyaaPage />
      if (view === 'users' && user.adminType === 'master') return <UserSetup />
    }
    return <div style={{ textAlign: 'center', padding: '60px', color: T.textLight }}>Page not found</div>
  }

  return (
    <KriyaaChatProvider>
      <Shell view={view} setView={navTo} onOpenOrder={openOrder}>
        {renderView()}
      </Shell>
    </KriyaaChatProvider>
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
