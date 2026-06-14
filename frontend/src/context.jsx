import { createContext, useContext, useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { authApi, ordersApi, documentsApi, usersApi, notificationsApi, auditApi, ribbonsApi, masterOrdersApi, setStoredToken } from './api.js'
import { isExpiringSoon, isExpired } from './constants.js'

const AppContext = createContext(null)
export const useApp = () => useContext(AppContext)

export function AppProvider({ children }) {
  const [currentUser, setCurrentUser] = useState(null)
  const [users, setUsers]             = useState([])
  const [orders, setOrders]           = useState([])
  const [docs, setDocs]               = useState([])
  const [notifs, setNotifs]           = useState([])
  const [audit, setAudit]             = useState([])
  const [serverRibbons, setServerRibbons] = useState([])
  const [masterOrders, setMasterOrders] = useState([])
  const [loading, setLoading]         = useState(false)
  const [loadError, setLoadError]     = useState(false)

  const loadingRef = useRef(false)
  const docDataCache = useRef({})
  const loadData = useCallback(async (user) => {
    if (loadingRef.current) return // prevent duplicate calls from StrictMode
    loadingRef.current = true
    setLoading(true)
    setLoadError(false)
    try {
      // Single batch: fetch everything in parallel
      const isAdmin = user.role === 'admin'
      const isMfr   = user.role === 'manufacturer'
      const promises = [
        ordersApi.list(),
        documentsApi.list(),
        notificationsApi.list(),
        ribbonsApi.list(),
        isMfr ? Promise.resolve([]) : masterOrdersApi.list(), // manufacturers cannot access master orders
        ...(isAdmin ? [usersApi.list(), auditApi.list()] : []),
      ]
      const results = await Promise.all(promises)
      setOrders(results[0])
      setDocs(results[1])
      setNotifs(results[2])
      setServerRibbons(results[3])
      setMasterOrders(results[4])
      if (isAdmin) {
        setUsers(results[5])
        // audit endpoint now returns { total, limit, skip, items }
        const auditResult = results[6]
        setAudit(Array.isArray(auditResult) ? auditResult : (auditResult?.items ?? []))
        // Cert expiry check — fire and forget, don't re-fetch notifications
        documentsApi.checkCertExpiry().catch(() => {})
      } else {
        setUsers([{ id: user.id, name: user.name, company: user.company, email: user.email, role: user.role }])
      }
    } catch {
      setLoadError(true)
    } finally {
      setLoading(false)
      loadingRef.current = false
    }
  }, [])

  const login = useCallback(async (email, password) => {
    const { user } = await authApi.login(email, password)
    setStoredToken(user.id) // sentinel: carry user ID so other tabs can detect a different user logged in
    setCurrentUser(user)
    await loadData(user)
    return user
  }, [loadData])

  const logout = useCallback(async () => {
    try { await authApi.logout() } catch { /* best-effort */ }
    setStoredToken(null)
    setCurrentUser(null)
    setOrders([])
    setDocs([])
    setNotifs([])
    setAudit([])
    setUsers([])
    setServerRibbons([])
    setMasterOrders([])
    docDataCache.current = {}
  }, [])

  // Restore session on page load via httpOnly cookie (no token in JS)
  // If the URL contains ?login=1 (e.g. from a welcome email), force a fresh login by
  // clearing any existing session — the link recipient is not whoever is already logged in.
  useEffect(() => {
    let cancelled = false
    const params = new URLSearchParams(window.location.search)
    const forceLogin = params.has('login')

    const init = async () => {
      if (forceLogin) {
        try { await authApi.logout() } catch { /* best-effort */ }
        setStoredToken(null)
        // Clean the URL so a future refresh doesn't keep forcing logout
        params.delete('login')
        const clean = window.location.pathname + (params.toString() ? '?' + params.toString() : '')
        window.history.replaceState({}, '', clean)
        return
      }
      try {
        const { user } = await authApi.me()
        if (cancelled) return
        setStoredToken(user.id)
        setCurrentUser(user)
        loadData(user)
      } catch {
        setStoredToken(null) // no valid session — stay on login
      }
    }
    init()
    return () => { cancelled = true }
  }, [loadData])

  // ── Refresh JWT cookie every 45 min so active sessions never expire ──
  useEffect(() => {
    if (!currentUser) return
    const iv = setInterval(async () => {
      try {
        await authApi.me() // backend re-issues cookie; nothing to store in JS
      } catch { /* session expired — next API call will trigger 401 reload */ }
    }, 30 * 60 * 1000)
    return () => clearInterval(iv)
  }, [currentUser])

  // ── Cross-tab session sync: detect login/logout from another tab ──
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key !== 'tradio_session') return
      if (!e.newValue) {
        // Another tab logged out — clear local state and go to login
        setCurrentUser(null)
        setOrders([]); setDocs([]); setNotifs([]); setAudit([])
        setUsers([]); setServerRibbons([]); setMasterOrders([])
        docDataCache.current = {}
        return
      }
      if (!e.oldValue) {
        // This tab had no session — another tab just logged in, pick it up
        window.location.reload()
        return
      }
      if (e.newValue !== e.oldValue) {
        // A *different* user logged in on another tab — the backend cookie is now theirs.
        // Log this tab out to avoid the session mismatch silently serving wrong data.
        setCurrentUser(null)
        setOrders([]); setDocs([]); setNotifs([]); setAudit([])
        setUsers([]); setServerRibbons([]); setMasterOrders([])
        docDataCache.current = {}
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  // ── Poll server ribbons every 60s so buyers/mfrs see new admin-published ribbons ──
  useEffect(() => {
    if (!currentUser) return
    const iv = setInterval(async () => {
      try {
        const active = await ribbonsApi.list()
        setServerRibbons(active)
      } catch { /* best-effort poll */ }
    }, 60_000)
    return () => clearInterval(iv)
  }, [currentUser])

  // ── Derived: ribbon alerts for the current user ───────────────────────────
  const ribbons = useMemo(() => {
    if (!currentUser) return []
    const r = []

    if (currentUser.role === 'buyer') {
      const uid = String(currentUser.id)
      const myOrders = orders.filter(o => String(o.buyerId) === uid)

      const late = myOrders.filter(o =>
        (o.assignments || []).length > 0 &&
        new Date(o.delivery) < new Date() &&
        !(o.assignments || []).every(a => a.status === 'Delivered')
      )
      if (late.length > 0) {
        r.push({
          id: 'late-orders', type: 'warning',
          msg: `${late.length} order${late.length > 1 ? 's are' : ' is'} past the delivery date and not yet delivered.`,
        })
      }

      const myOrderIds = new Set(myOrders.map(o => o.id))
      const myMfrIds = new Set(myOrders.flatMap(o => (o.assignments || []).map(a => String(a.mid))))
      const myDocs = docs.filter(d => d.isActive !== false && (
        (d.orderId && myOrderIds.has(String(d.orderId))) ||
        (d.mfrId && myMfrIds.has(String(d.mfrId)) && !d.orderId)
      ))

      const expired  = myDocs.filter(d => d.expiryDate && isExpired(d.expiryDate))
      const expiring = myDocs.filter(d => d.expiryDate && isExpiringSoon(d.expiryDate) && !isExpired(d.expiryDate))
      if (expired.length > 0) {
        r.push({
          id: 'cert-expired', type: 'urgent',
          msg: `${expired.length} compliance certificate${expired.length > 1 ? 's have' : ' has'} expired — contact your manufacturer.`,
        })
      }
      if (expiring.length > 0) {
        r.push({
          id: 'cert-expiring', type: 'warning',
          msg: `${expiring.length} compliance certificate${expiring.length > 1 ? 's are' : ' is'} expiring within 30 days.`,
        })
      }
    }

    if (currentUser.role === 'manufacturer') {
      const uid = String(currentUser.id)
      // Late orders (past delivery, not delivered)
      const myOrders = orders.filter(o => (o.assignments || []).some(a => String(a.mid) === uid))
      const late = myOrders.filter(o => {
        const mine = (o.assignments || []).find(a => String(a.mid) === uid)
        return mine && new Date(o.delivery) < new Date() && mine.status !== 'Delivered'
      })
      if (late.length > 0) {
        r.push({
          id: 'mfr-late-orders', type: 'warning',
          msg: `${late.length} order${late.length > 1 ? 's are' : ' is'} past the delivery date and not yet delivered.`,
        })
      }

      // Expired / expiring certificates
      const expired  = docs.filter(d => String(d.mfrId) === uid && d.expiryDate && isExpired(d.expiryDate))
      const expiring = docs.filter(d => String(d.mfrId) === uid && d.expiryDate && isExpiringSoon(d.expiryDate) && !isExpired(d.expiryDate))
      if (expired.length > 0) {
        r.push({
          id: 'mfr-cert-expired', type: 'urgent',
          msg: `${expired.length} of your compliance certificate${expired.length > 1 ? 's have' : ' has'} expired — please renew immediately.`,
        })
      }
      if (expiring.length > 0) {
        r.push({
          id: 'mfr-cert-expiring', type: 'warning',
          msg: `${expiring.length} of your compliance certificate${expiring.length > 1 ? 's are' : ' is'} expiring within 30 days.`,
        })
      }
    }

    // Merge admin-published ribbons from server — guard by role in case of stale state
    for (const sr of serverRibbons) {
      if (sr.audience === 'all' || sr.audience === currentUser.role) {
        r.push({ id: `srv-${sr.id}`, type: sr.type, msg: sr.message })
      }
    }

    return r
  }, [currentUser, orders, docs, serverRibbons])

  // ── Actions ───────────────────────────────────────────────────────────────
  const addAudit = useCallback(async (action, detail) => {
    // Only admins can write audit logs via the API; non-admin actions are logged server-side in route handlers
    if (currentUser?.role !== 'admin') return
    const entry = await auditApi.add(action, detail)
    setAudit(p => [{ ...entry, action, detail, by: currentUser?.id, at: new Date().toISOString() }, ...p])
  }, [currentUser])

  const pushNotif = useCallback(async (toUser, type, msg, orderId = null) => {
    try {
      await notificationsApi.create({ toUser, type, msg, orderId })
      // Only update local state after the API call succeeds and the notification is for the current user
      if (toUser === currentUser?.id) {
        setNotifs(p => [{ id: Date.now(), to: toUser, type, msg, orderId, read: false, at: new Date().toISOString() }, ...p])
      }
    } catch {
      // Non-admin users can't create notifications for others — server-side handlers cover cross-user notifications
    }
  }, [currentUser])

  const updateStage = useCallback(async (orderId, mfrId, stageIndex, data) => {
    // Capture old values for audit logging
    const oldOrder = orders.find(o => o.id === orderId)
    const oldStage = oldOrder?.assignments?.find(a => String(a.mid) === String(mfrId))?.stages?.[stageIndex]
    const oldUnits = oldStage?.unitsDone ?? 0

    const updated = await ordersApi.updateStage(orderId, mfrId, stageIndex, data)
    setOrders(p => p.map(o => o.id === orderId ? updated : o))

    const stageName = (updated.assignments || []).find(a => String(a.mid) === String(mfrId))?.stages?.[stageIndex]?.name || `Stage ${stageIndex + 1}`
    if (updated.buyerId) {
      await pushNotif(updated.buyerId, 'status', `Production update on ${orderId}: ${stageName} progress updated`, orderId)
    }
    await addAudit('Stage Update', `${orderId}: ${stageName} — units ${oldUnits} → ${data.unitsDone}${data.note ? ' | Note: ' + data.note : ''}`)
    return updated
  }, [orders, pushNotif, addAudit])

  const updateAssignment = useCallback(async (orderId, mfrId, status, note) => {
    const updated = await ordersApi.updateAssignment(orderId, mfrId, status, note)
    setOrders(p => p.map(o => o.id === orderId ? updated : o))
    if (updated.buyerId) {
      await pushNotif(updated.buyerId, 'status', `Order ${orderId} status updated to: ${status}`, orderId)
      if (currentUser?.role === 'admin') {
        await pushNotif(mfrId, 'status', `Your order ${orderId} was updated to: ${status}`, orderId)
      }
    }
    await addAudit('Status Update', `${orderId}: → ${status}${note ? ' | Note: ' + note : ''}`)
    return updated
  }, [currentUser, pushNotif, addAudit])

  const uploadDoc = useCallback(async (data) => {
    const doc = await documentsApi.upload(data)
    setDocs(p => [doc, ...p])
    await addAudit('Document Uploaded', `${data.name} (${data.type})${data.orderId ? ' for order ' + data.orderId : ''}`)

    // BRD §8: "Document uploaded to order → Buyer + Admin"
    if (data.orderId) {
      const order = orders.find(o => o.id === data.orderId)
      if (order?.buyerId && order.buyerId !== currentUser?.id) {
        await pushNotif(order.buyerId, 'order', `New document uploaded to order ${data.orderId}: ${data.name}`, data.orderId)
      }
      // Notify all admins (except current user if they are admin)
      const adminUsers = users.filter(u => u.role === 'admin' && u.id !== currentUser?.id)
      for (const admin of adminUsers) {
        await pushNotif(admin.id, 'order', `New document uploaded to order ${data.orderId}: ${data.name}`, data.orderId)
      }
    }
    return doc
  }, [orders, users, currentUser, addAudit, pushNotif])

  const createMasterOrder = useCallback(async (data) => {
    const mo = await masterOrdersApi.create(data)
    setMasterOrders(p => [mo, ...p])
    await addAudit('Master Order Created', `${data.id} — ${data.orderName}`)
    return mo
  }, [addAudit])

  const createOrder = useCallback(async (data) => {
    const order = await ordersApi.create(data)
    setOrders(p => [order, ...p])
    await pushNotif(data.buyerId, 'order', `New order created: ${data.id}`, data.id)
    for (const a of data.assignments) {
      await pushNotif(a.mid, 'order', `New order assigned to you: ${data.id}`, data.id)
    }
    await addAudit('Order Created', `${data.id} — ${data.product}`)
    return order
  }, [pushNotif, addAudit])

  const editOrder = useCallback(async (id, data) => {
    const updated = await ordersApi.update(id, data)
    setOrders(p => p.map(o => o.id === id ? updated : o))
    await addAudit('Order Edited', `${id}: ${Object.keys(data).join(', ')} updated`)
    return updated
  }, [addAudit])

  const deleteOrder = useCallback(async (id) => {
    const order = orders.find(o => o.id === id)
    await ordersApi.delete(id)
    setOrders(p => p.filter(o => o.id !== id))
    await addAudit('Order Deleted', `${id}${order ? ' — ' + order.product : ''}`)
  }, [orders, addAudit])

  const createUser = useCallback(async (data) => {
    const user = await usersApi.create(data)
    setUsers(p => [...p, user])
    await addAudit('User Created', `${data.role} account created: ${data.email} (${data.company})`)
    return user
  }, [addAudit])

  const updateUser = useCallback(async (id, data) => {
    const updated = await usersApi.update(id, data)
    setUsers(p => p.map(u => u.id === id ? updated : u))
    await addAudit('User Updated', `Updated user details for: ${updated.email}`)
    return updated
  }, [addAudit])

  const toggleUser = useCallback(async (id) => {
    const user = users.find(u => u.id === id)
    const updated = await usersApi.toggle(id)
    setUsers(p => p.map(u => u.id === id ? updated : u))
    try {
      await addAudit(updated.isActive ? 'User Activated' : 'User Deactivated', `Account: ${user?.email}`)
    } catch { /* audit is best-effort */ }
    return updated
  }, [users, addAudit])

  const resetUserPw = useCallback(async (id) => {
    const user = users.find(u => u.id === id)
    const result = await usersApi.resetPassword(id)
    setUsers(p => p.map(u => u.id === id ? { ...u, mustChangePw: true } : u))
    await addAudit('Password Reset', `Forced password reset for: ${user?.email}`)
    return result
  }, [users, addAudit])

  const markAllRead = useCallback(async () => {
    await notificationsApi.markAllRead()
    setNotifs(p => p.map(n => ({ ...n, read: true })))
  }, [])

  const markOneRead = useCallback(async (id) => {
    try {
      await notificationsApi.markOneRead(id)
    } catch { /* best-effort */ }
    setNotifs(p => p.map(n => n.id === id ? { ...n, read: true } : n))
  }, [])

  const refreshOrders = useCallback(async () => {
    const o = await ordersApi.list()
    setOrders(o)
  }, [])

  const getDocData = useCallback(async (id) => {
    if (docDataCache.current[id]) return docDataCache.current[id]
    const data = await documentsApi.getData(id)
    docDataCache.current[id] = data
    return data
  }, [])

  // ── Ribbon management (admin only) ──
  const listAllRibbons = useCallback(async () => {
    return ribbonsApi.listAll()
  }, [])

  const createRibbon = useCallback(async (data) => {
    const ribbon = await ribbonsApi.create(data)
    // Refresh active ribbons
    const active = await ribbonsApi.list()
    setServerRibbons(active)
    return ribbon
  }, [])

  const updateRibbon = useCallback(async (id, data) => {
    const ribbon = await ribbonsApi.update(id, data)
    const active = await ribbonsApi.list()
    setServerRibbons(active)
    return ribbon
  }, [])

  const removeRibbon = useCallback(async (id) => {
    await ribbonsApi.remove(id)
    const active = await ribbonsApi.list()
    setServerRibbons(active)
  }, [])

  const unread = notifs.filter(n => !n.read).length

  return (
    <AppContext.Provider value={{
      currentUser, users, orders, docs, notifs, audit, loading, loadError, unread, ribbons, masterOrders,
      login, logout,
      updateStage, updateAssignment, uploadDoc, createOrder, createMasterOrder,
      editOrder, deleteOrder,
      createUser, updateUser, toggleUser, resetUserPw,
      markAllRead, markOneRead, getDocData, addAudit, pushNotif,
      refreshOrders, listAllRibbons, createRibbon, updateRibbon, removeRibbon,
    }}>
      {children}
    </AppContext.Provider>
  )
}
