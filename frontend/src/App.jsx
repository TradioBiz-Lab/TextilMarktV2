import { useState, useEffect, useRef, useCallback } from 'react'
import { CheckCircle2, AlertTriangle } from './icons.jsx'
import { AppProvider, useApp } from './context.jsx'
import { Shell } from './components/Shell.jsx'
import { LoginPage } from './pages/LoginPage.jsx'
import { BuyerSubmitReq } from './pages/buyer/BuyerSubmitReq.jsx'
import { AdminDashboard } from './pages/admin/AdminDashboard.jsx'
import { AdminOrders } from './pages/admin/AdminOrders.jsx'
import { AdminOrderDetail } from './pages/admin/AdminOrderDetail.jsx'
import { AdminDocuments } from './pages/admin/AdminDocuments.jsx'
import { AdminAuditLog } from './pages/admin/AdminAuditLog.jsx'
import { UserSetup } from './pages/admin/UserSetup.jsx'
import { KriyaaPage } from './pages/admin/KriyaaPage.jsx'
import { ReviewQueuePage } from './pages/admin/ReviewQueuePage.jsx'
import { ViewerHome } from './pages/master/ViewerHome.jsx'
import { CompanyPage } from './pages/shared/CompanyPage.jsx'
import { ProcurementProviders } from './stores/procurement.jsx'
import { SuppliersPage } from './pages/procurement/SuppliersPage.jsx'
import { PoListPage } from './pages/procurement/PoListPage.jsx'
import { PoBuilder } from './pages/procurement/PoBuilder.jsx'
import { PoDetail } from './pages/procurement/PoDetail.jsx'
import { ShoppingListPage } from './pages/procurement/ShoppingListPage.jsx'
import { InventoryProviders } from './stores/inventory.jsx'
import { StockPage } from './pages/inventory/StockPage.jsx'
import { GrnPage } from './pages/inventory/GrnPage.jsx'
import { CostingProviders } from './stores/costing.jsx'
import { CostingPage } from './pages/costing/CostingPage.jsx'
import { CostSheetPage } from './pages/costing/CostSheetPage.jsx'
import { LiveRefresh } from './components/LiveRefresh.jsx'
import { KriyaaChatProvider } from './kriyaaChatContext.jsx'
import { ReportingPage } from './pages/shared/ReportingPage.jsx'
import { ActionItemsPage } from './pages/shared/ActionItemsPage.jsx'
import { authApi } from './api.js'
import { capsFor, homeViewFor } from './caps.js'
import { parseDeepLink } from './lib/deepLink.js'
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
      setErr(e?.message || 'Failed to change password. Check your current password.')
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
  const { currentUser: user, loading, orders } = useApp()
  const [view, setView] = useState('dashboard')
  const [selOid, setSelOid] = useState(null)
  const [selMid, setSelMid] = useState(null)
  const [ordersStatus, setOrdersStatus] = useState(null)
  const [ordersPhase, setOrdersPhase] = useState(null)   // 'production' | 'development' to open the Orders page on
  const [ordersMo, setOrdersMo] = useState(null)     // master order to open on the Orders page
  const [reportsMo, setReportsMo] = useState(null)   // master order to open on the Reports page
  const [selPo, setSelPo] = useState(null)           // purchase order open (or being edited) on the purchasing screens
  const [selSupplier, setSelSupplier] = useState(null) // supplier to open on the Suppliers page, or to start a new PO for
  const [selCost, setSelCost] = useState(null)       // cost sheet open on the costing screens
  const [selGrn, setSelGrn] = useState(null)         // goods received note open on the receiving screen (a PO in selPo starts a new one against it)

  // ── Navigation with real history ──
  // Every screen change is a snapshot pushed onto a stack that is mirrored into the browser's own
  // history, so the in-app Back buttons AND the browser's Back/Forward return you to exactly where
  // you came from. Before leaving a list for an order, that list's snapshot is stamped with the
  // order's master order, so coming back re-opens (and scrolls to) the group you were in.
  const hist = useRef({ stack: [], idx: -1 })
  const BLANK = { view: 'dashboard', selOid: null, selMid: null, ordersStatus: null, ordersMo: null, ordersPhase: null, reportsMo: null, selPo: null, selSupplier: null, selCost: null, selGrn: null }
  const apply = useCallback(s => {
    setView(s.view); setSelOid(s.selOid); setSelMid(s.selMid)
    setOrdersStatus(s.ordersStatus); setOrdersMo(s.ordersMo); setOrdersPhase(s.ordersPhase ?? null); setReportsMo(s.reportsMo)
    setSelPo(s.selPo ?? null); setSelSupplier(s.selSupplier ?? null); setSelCost(s.selCost ?? null); setSelGrn(s.selGrn ?? null)
  }, [])
  const go = useCallback(next => {
    const h = hist.current
    const snap = { ...BLANK, ...next }
    h.stack = h.stack.slice(0, h.idx + 1); h.stack.push(snap); h.idx = h.stack.length - 1
    window.history.pushState({ nav: h.idx }, '')
    apply(snap)
  }, [apply])
  const goBack = useCallback(fallback => {
    if (hist.current.idx > 0) window.history.back()
    else go(fallback || { view: 'orders' })
  }, [go])

  // Open what a link names (an email's #cost=..., a notification's link): an order, a PO, a cost sheet or a screen.
  const openLink = useCallback(link => {
    if (!link) return false
    go(link.view === 'order_detail' ? { view: 'order_detail', selOid: link.orderId }
      : link.view === 'po_detail' ? { view: 'po_detail', selPo: link.poId }
      : link.view === 'cost_sheet' ? { view: 'cost_sheet', selCost: link.costId }
      : link.view === 'grn' ? { view: 'grn', selGrn: link.grnId }
      : { view: link.view })
    return true
  }, [go])

  // Start on the user's home screen on login or session restore, with a fresh history: the dashboard,
  // or for the master admin of the standalone product the company directory.
  useEffect(() => {
    if (!user?.id) return
    const home = { ...BLANK, view: homeViewFor(user) }
    hist.current = { stack: [home], idx: 0 }
    window.history.replaceState({ nav: 0 }, '')
    apply(home)
    // A link from an email or message can name a screen (#order=..., #view=orders). Open it once and
    // drop the hash, so reloading does not reopen it and the address stays clean.
    const link = parseDeepLink(window.location.hash)
    if (link) {
      window.history.replaceState({ nav: 0 }, '', window.location.pathname + window.location.search)
      openLink(link)
    }
  }, [user?.id, apply, go, openLink])

  // Browser Back / Forward move along the same stack.
  useEffect(() => {
    const onPop = e => {
      const i = e.state?.nav
      const h = hist.current
      if (typeof i === 'number' && h.stack[i]) { h.idx = i; apply(h.stack[i]) }
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [apply])

  if (loading && !user) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: T.bg }}>
        <div style={{ fontSize: 14, color: T.textMuted }}>Loading…</div>
      </div>
    )
  }

  if (!user) return <LoginPage />

  if (user.mustChangePw) return <ForceChangePassword />

  const caps = capsFor(user)
  const navTo = (v, params) => go({
    view: v,
    ordersStatus: params?.status ?? null,
    ordersPhase: v === 'orders' ? (params?.phase ?? null) : null,
    ordersMo: v === 'orders' ? (params?.mo ?? null) : null,
    reportsMo: v === 'reports' ? (params?.mo ?? null) : null,
    selPo: params?.po ?? null,
    selSupplier: params?.supplier ?? null,
    selCost: params?.cost ?? null,
    selGrn: params?.grn ?? null,
  })
  const openOrder = (id, mid) => {
    // Remember which master order we are leaving from, so Back re-opens that group.
    const h = hist.current
    const here = h.stack[h.idx]
    const mo = orders?.find(o => o.id === id)?.masterOrderId || '__none__'
    if (here) { if (here.view === 'orders') here.ordersMo = mo; if (here.view === 'reports') here.reportsMo = mo }
    go({ view: 'order_detail', selOid: id, selMid: mid ? String(mid) : null })
  }

  const renderView = () => {
    // Action Items and the daily update are one page now — the same job, split
    // across two screens. Shared by all three roles; it scopes rows to what the
    // viewer may act on, and the server enforces the same boundary.
    if (view === 'action_items' || view === 'daily') return <ActionItemsPage onOpen={openOrder} onNavigate={navTo} />

    // One set of screens for every role. Each reads only what the server returns for the
    // signed-in user, and hides the controls that role cannot use (see caps.js).
    if (view === 'dashboard') return <AdminDashboard onNavigate={navTo} onOpen={openOrder} />
    if (view === 'kriyaa') return <KriyaaPage />
    // Suppliers and purchase orders (a manufacturer's own, standalone product). One provider wraps all four
    // screens, in the same place in the tree, so moving between them keeps what was loaded.
    if (caps.seeProcurement && ['suppliers', 'purchase_orders', 'po_builder', 'po_detail'].includes(view)) {
      const toList = () => goBack({ view: 'purchase_orders' })
      return (
        <ProcurementProviders>
          {view === 'suppliers' ? <SuppliersPage key={`s:${selSupplier || 'all'}`} initialSupplier={selSupplier} onNavigate={navTo} />
            : view === 'purchase_orders' ? <PoListPage onNavigate={navTo} />
            : view === 'po_builder' ? <PoBuilder key={`b:${selPo || selSupplier || 'new'}`} poId={selPo} initialSupplier={selSupplier} onBack={toList} onNavigate={navTo} />
            : selPo ? <PoDetail key={`d:${selPo}`} poId={selPo} onBack={toList} onNavigate={navTo} onOpenOrder={openOrder} />
            : <PoListPage onNavigate={navTo} />}
        </ProcurementProviders>
      )
    }
    // The shopping list is a factory's own, built from its frozen bills of materials; it ends in draft POs, so it
    // lives with the purchasing screens and shares their providers.
    if (view === 'shopping_list' && caps.seeBom) {
      return <ProcurementProviders><ShoppingListPage onNavigate={navTo} onOpenOrder={openOrder} /></ProcurementProviders>
    }
    // Stock and goods received (a factory's own). Receiving needs the purchase orders and suppliers, so it shares their providers.
    if (caps.seeInventory && ['inventory', 'grn'].includes(view)) {
      const toStock = () => goBack({ view: 'inventory' })
      return (
        <ProcurementProviders>
          <InventoryProviders>
            {view === 'grn' ? <GrnPage key={`g:${selGrn || selPo || 'new'}`} grnId={selGrn} poId={selGrn ? null : selPo} onBack={toStock} onNavigate={navTo} /> : <StockPage onNavigate={navTo} />}
          </InventoryProviders>
        </ProcurementProviders>
      )
    }
    // Cost sheets: a factory's own, or what has been shared with a brand. One provider for both screens.
    if (caps.seeCosting && ['costing', 'cost_sheet'].includes(view)) {
      const toList = () => goBack({ view: 'costing' })
      return (
        <CostingProviders>
          {view === 'cost_sheet' && selCost ? <CostSheetPage key={`c:${selCost}`} costId={selCost} onBack={toList} onNavigate={navTo} /> : <CostingPage onNavigate={navTo} />}
        </CostingProviders>
      )
    }
    if (view === 'viewer' && caps.seeViewerHome) return <ViewerHome />
    if (view === 'company' && caps.seeCompanyPage) return <CompanyPage />
    if (view === 'orders') return <AdminOrders key={`o:${ordersMo || 'all'}:${ordersPhase || ''}`} onOpen={openOrder} initialStatus={ordersStatus} initialMo={ordersMo} initialPhase={ordersPhase} onSubmitReq={user.role === 'buyer' ? () => navTo('submit_req') : undefined} />
    if (view === 'order_detail' && selOid) return <AdminOrderDetail orderId={selOid} initialMid={selMid} onNavigate={navTo} onBack={() => goBack({ view: 'orders', ordersMo: orders?.find(o => o.id === selOid)?.masterOrderId || '__none__' })} />
    if (view === 'documents') return <AdminDocuments />
    if (view === 'reports') return <ReportingPage key={`r:${reportsMo || 'all'}`} onOpen={openOrder} initialMo={reportsMo} />
    if (user.role === 'buyer' && view === 'submit_req') return <BuyerSubmitReq />
    if (user.role === 'admin') {
      if (view === 'review') return <ReviewQueuePage />
      if (view === 'audit') return <AdminAuditLog />
      if (view === 'users' && caps.seeUserSetup) return <UserSetup />
    }
    return <div style={{ textAlign: 'center', padding: '60px', color: T.textLight }}>Page not found</div>
  }

  return (
    <KriyaaChatProvider>
      <LiveRefresh />
      <Shell view={view} setView={navTo} onOpenOrder={openOrder} onOpenLink={link => openLink(parseDeepLink(link))}>
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
