import { createContext, useContext, useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { authApi, ordersApi, documentsApi, usersApi, notificationsApi, auditApi, ribbonsApi, masterOrdersApi, actionItemsApi, setStoredToken, setAuthToken } from './api.js'
import { isExpiringSoon, isExpired, dayNumber, getToday } from './constants.js'

// "Past the delivery date" on the same India-time day boundary as the rest of the app. Comparing
// the date to `new Date()` treats the delivery day as over at 05:30 IST (UTC midnight), so the late
// banner appeared hours before the day had actually ended.
const isPastDelivery = d => {
  const n = dayNumber(d)
  return n != null && n < dayNumber(getToday())
}

const AppContext = createContext(null)
export const useApp = () => useContext(AppContext)

export function AppProvider({ children }) {
  const [currentUser, setCurrentUser] = useState(null)
  const [users, setUsers]             = useState([])
  const [orders, setOrders]           = useState([])
  // When the orders in this browser last changed (a fetch, a refresh or a local edit), so a screen can say how old its data is.
  const [ordersAt, setOrdersAt]         = useState(null)
  const [docs, setDocs]               = useState([])
  const [notifs, setNotifs]           = useState([])
  const [audit, setAudit]             = useState([])
  const [auditTotal, setAuditTotal]     = useState(0)
  const [serverRibbons, setServerRibbons] = useState([])
  const [masterOrders, setMasterOrders] = useState([])
  const [actionItems, setActionItems] = useState([])
  const [loading, setLoading]         = useState(false)
  const [loadError, setLoadError]     = useState(false)

  const loadingRef = useRef(false)
  // Bumped on logout. A load that started under an earlier value belongs to a
  // previous session, so its results are discarded instead of landing in the next user's.
  const sessionGenRef = useRef(0)
  useEffect(() => { setOrdersAt(Date.now()) }, [orders])
  const docDataCache = useRef({})
  const loadData = useCallback(async (user) => {
    if (loadingRef.current) return // prevent duplicate calls from StrictMode
    // Someone on a temporary password may only change it; the server refuses everything else, so
    // there is nothing to load until they have (they sign in again afterwards).
    if (user?.mustChangePw) return
    loadingRef.current = true
    const gen = sessionGenRef.current
    setLoading(true)
    setLoadError(false)
    try {
      // Single batch: fetch everything in parallel
      const isAdmin = user.role === 'admin'
      const promises = [
        ordersApi.list(),
        documentsApi.list(),
        notificationsApi.list(),
        ribbonsApi.list(),
        masterOrdersApi.list(), // scoped by the server: customers see their own, manufacturers only those their orders belong to
        ...(isAdmin ? [usersApi.list(), auditApi.list(), actionItemsApi.list()] : []),
      ]
      const results = await Promise.all(promises)
      if (gen !== sessionGenRef.current) return // logged out while loading
      setOrders(results[0])
      setDocs(results[1])
      setNotifs(results[2])
      setServerRibbons(results[3])
      setMasterOrders(results[4])
      if (isAdmin) {
        setUsers(results[5])
        // audit endpoint now returns { total, limit, skip, items }
        const auditResult = results[6]
        const auditItems = Array.isArray(auditResult) ? auditResult : (auditResult?.items ?? [])
        setAudit(auditItems)
        setAuditTotal(auditResult?.total ?? auditItems.length)
        setActionItems(results[7])
        // Cert expiry check — fire and forget, don't re-fetch notifications
        documentsApi.checkCertExpiry().catch(() => {})
      } else {
        setUsers([{ id: user.id, name: user.name, company: user.company, email: user.email, role: user.role }])
      }
    } catch {
      if (gen === sessionGenRef.current) setLoadError(true)
    } finally {
      if (gen === sessionGenRef.current) {
        setLoading(false)
        loadingRef.current = false
      }
    }
  }, [])

  const login = useCallback(async (email, password) => {
    const { user, token } = await authApi.login(email, password)
    setStoredToken(user.id) // sentinel: carry user ID so other tabs can detect a different user logged in
    setAuthToken(token) // Authorization-header fallback for when the cross-site cookie doesn't survive
    setCurrentUser(user)
    await loadData(user)
    return user
  }, [loadData])

  const logout = useCallback(async () => {
    try { await authApi.logout() } catch { /* best-effort */ }
    setStoredToken(null)
    setAuthToken(null)
    sessionGenRef.current += 1
    loadingRef.current = false
    setLoading(false)
    setCurrentUser(null)
    setOrders([])
    setDocs([])
    setNotifs([])
    setAudit([])
    setAuditTotal(0)
    setUsers([])
    setServerRibbons([])
    setMasterOrders([])
    setActionItems([])
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
        setAuthToken(null)
        // Clean the URL so a future refresh doesn't keep forcing logout
        params.delete('login')
        const clean = window.location.pathname + (params.toString() ? '?' + params.toString() : '')
        window.history.replaceState({}, '', clean)
        return
      }
      try {
        const { user, token } = await authApi.me()
        if (cancelled) return
        setStoredToken(user.id)
        setAuthToken(token)
        setCurrentUser(user)
        loadData(user)
      } catch {
        setStoredToken(null) // no valid session — stay on login
        setAuthToken(null)
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
        const { token } = await authApi.me() // backend re-issues cookie + a fresh fallback token
        setAuthToken(token)
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
        setUsers([]); setServerRibbons([]); setMasterOrders([]); setActionItems([])
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
        setUsers([]); setServerRibbons([]); setMasterOrders([]); setActionItems([])
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
        isPastDelivery(o.delivery) &&
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
        return mine && isPastDelivery(o.delivery) && mine.status !== 'Delivered'
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
  const updateStage = useCallback(async (orderId, mfrId, stageIndex, data) => {
    // The route returns { ...order, warnings } — keep warnings out of the store.
    const { warnings, ...updated } = await ordersApi.updateStage(orderId, mfrId, stageIndex, data)
    setOrders(p => p.map(o => o.id === orderId ? updated : o))

    return { ...updated, warnings: warnings || [] }
  }, [])

  // One request for N stages. Used by the daily-update grid and Bulk Edit, which
  // previously fired one call per changed stage and could exhaust the 120/hr
  // update limiter on a single 27-stage order.
  const bulkUpdateStages = useCallback(async (orderId, mfrId, stages) => {
    const { updated: count, ...updated } = await ordersApi.bulkUpdateStages(orderId, mfrId, stages)
    setOrders(p => p.map(o => o.id === orderId ? updated : o))
    return updated
  }, [])

  const addStageItem = useCallback(async (orderId, mfrId, stageIndex, data) => {
    const updated = await ordersApi.addStageItem(orderId, mfrId, stageIndex, data)
    setOrders(p => p.map(o => o.id === orderId ? updated : o))
    return updated
  }, [])

  const updateStageItem = useCallback(async (orderId, mfrId, stageIndex, lineIndex, data) => {
    const updated = await ordersApi.updateStageItem(orderId, mfrId, stageIndex, lineIndex, data)
    setOrders(p => p.map(o => o.id === orderId ? updated : o))
    return updated
  }, [])

  const removeStageItem = useCallback(async (orderId, mfrId, stageIndex, lineIndex) => {
    const updated = await ordersApi.removeStageItem(orderId, mfrId, stageIndex, lineIndex)
    setOrders(p => p.map(o => o.id === orderId ? updated : o))
    return updated
  }, [])

  const updateAssignment = useCallback(async (orderId, mfrId, status, note) => {
    const updated = await ordersApi.updateAssignment(orderId, mfrId, status, note)
    setOrders(p => p.map(o => o.id === orderId ? updated : o))
    return updated
  }, [])

  const uploadDoc = useCallback(async (data) => {
    const doc = await documentsApi.upload(data)
    setDocs(p => [doc, ...p])
    return doc
  }, [])

  const updateDoc = useCallback(async (id, data) => {
    const doc = await documentsApi.update(id, data)
    setDocs(p => p.map(d => d.id === id ? doc : d))
    return doc
  }, [])

  const deleteDoc = useCallback(async (id) => {
    await documentsApi.remove(id)
    setDocs(p => p.filter(d => d.id !== id))
  }, [])

  const createMasterOrder = useCallback(async (data) => {
    const mo = await masterOrdersApi.create(data)
    setMasterOrders(p => [mo, ...p])
    return mo
  }, [])

  const updateMasterOrder = useCallback(async (id, data) => {
    const updated = await masterOrdersApi.update(id, data)
    setMasterOrders(p => p.map(m => m.id === id ? updated : m))
    return updated
  }, [])

  const deleteMasterOrder = useCallback(async (id, reason) => {
    await masterOrdersApi.delete(id, reason)
    setMasterOrders(p => p.filter(m => m.id !== id))
  }, [])

  const createOrder = useCallback(async (data) => {
    const order = await ordersApi.create(data)
    setOrders(p => [order, ...p])
    return order
  }, [])

  const addAssignment = useCallback(async (orderId, { mfrId, qty, sub }) => {
    const order = await ordersApi.addAssignment(orderId, { mfrId, qty, sub })
    setOrders(p => p.map(o => o.id === orderId ? order : o))
    return order
  }, [])

  const insertStage = useCallback(async (orderId, mfrId, data) => {
    const order = await ordersApi.insertStage(orderId, mfrId, data)
    setOrders(p => p.map(o => o.id === orderId ? order : o))
    return order
  }, [])

  const editOrder = useCallback(async (id, data) => {
    const updated = await ordersApi.update(id, data)
    setOrders(p => p.map(o => o.id === id ? updated : o))
    return updated
  }, [])

  const deleteOrder = useCallback(async (id, reason) => {
    await ordersApi.delete(id, reason)
    setOrders(p => p.filter(o => o.id !== id))
  }, [])

  const createUser = useCallback(async (data) => {
    const user = await usersApi.create(data)
    setUsers(p => [...p, user])
    return user
  }, [])

  const updateUser = useCallback(async (id, data) => {
    const updated = await usersApi.update(id, data)
    setUsers(p => p.map(u => u.id === id ? updated : u))
    return updated
  }, [])

  const toggleUser = useCallback(async (id) => {
    const updated = await usersApi.toggle(id)
    setUsers(p => p.map(u => u.id === id ? updated : u))
    return updated
  }, [])

  const resetUserPw = useCallback(async (id) => {
    const result = await usersApi.resetPassword(id)
    setUsers(p => p.map(u => u.id === id ? { ...u, mustChangePw: true } : u))
    return result
  }, [])

  // The audit log is written by the server only, so the page re-reads it when opened
  // instead of the browser appending its own copy. Older entries load on demand.
  const AUDIT_PAGE = 200
  const refreshAudit = useCallback(async () => {
    const r = await auditApi.list({ limit: AUDIT_PAGE, skip: 0 })
    const items = Array.isArray(r) ? r : (r?.items ?? [])
    setAudit(items)
    setAuditTotal(r?.total ?? items.length)
  }, [])

  const loadMoreAudit = useCallback(async () => {
    const r = await auditApi.list({ limit: AUDIT_PAGE, skip: audit.length })
    const items = Array.isArray(r) ? r : (r?.items ?? [])
    setAudit(p => {
      const seen = new Set(p.map(a => a.id))
      return [...p, ...items.filter(a => !seen.has(a.id))]
    })
    setAuditTotal(r?.total ?? auditTotal)
  }, [audit.length, auditTotal])

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

  // Stage evidence is created server-side by the inbound pipeline, so the
  // document list needs an external refresh path too.
  const refreshDocs = useCallback(async () => {
    setDocs(await documentsApi.list())
  }, [])

  // actionItems is otherwise only fetched once at bootstrap (line ~38) — every
  // existing mutation below refetches inline, but nothing external (like the
  // AI assistant, which can also change ActionItem records) had a way to ask
  // for a refresh until now.
  const refreshActionItems = useCallback(async () => {
    // The action-item task list is the admin team's; other roles have none to refresh.
    if (currentUser?.role !== 'admin') return
    setActionItems(await actionItemsApi.list())
  }, [currentUser?.role])

  const addStageUpdate = useCallback(async (orderId, mfrId, stageIndex, text) => {
    const updated = await ordersApi.addStageUpdate(orderId, mfrId, stageIndex, text)
    setOrders(p => p.map(o => o.id === orderId ? updated : o))
    return updated
  }, [])

  const addStageMaterial = useCallback(async (orderId, mfrId, stageIndex, data) => {
    const updated = await ordersApi.addStageMaterial(orderId, mfrId, stageIndex, data)
    setOrders(p => p.map(o => o.id === orderId ? updated : o))
    return updated
  }, [])

  const updateStageMaterial = useCallback(async (orderId, mfrId, stageIndex, lineIndex, data) => {
    const updated = await ordersApi.updateStageMaterial(orderId, mfrId, stageIndex, lineIndex, data)
    setOrders(p => p.map(o => o.id === orderId ? updated : o))
    return updated
  }, [])

  const removeStageMaterial = useCallback(async (orderId, mfrId, stageIndex, lineIndex) => {
    const updated = await ordersApi.removeStageMaterial(orderId, mfrId, stageIndex, lineIndex)
    setOrders(p => p.map(o => o.id === orderId ? updated : o))
    return updated
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

  // ── Action items (admin only) ──
  const createActionItem = useCallback(async (data) => {
    const item = await actionItemsApi.create(data)
    setActionItems(await actionItemsApi.list())
    return item
  }, [])

  const updateActionItem = useCallback(async (id, data) => {
    const item = await actionItemsApi.update(id, data)
    setActionItems(await actionItemsApi.list())
    return item
  }, [])

  const addActionItemUpdate = useCallback(async (id, text) => {
    const item = await actionItemsApi.addUpdate(id, text)
    setActionItems(await actionItemsApi.list())
    return item
  }, [])

  const removeActionItem = useCallback(async (id) => {
    await actionItemsApi.remove(id)
    setActionItems(await actionItemsApi.list())
  }, [])

  const unread = notifs.filter(n => !n.read).length

  return (
    <AppContext.Provider value={{
      currentUser, users, orders, ordersAt, docs, notifs, audit, auditTotal, loading, loadError, unread, ribbons, masterOrders,
      actionItems,
      login, logout,
      updateStage, addStageUpdate, addStageMaterial, updateStageMaterial, removeStageMaterial,
      bulkUpdateStages, addStageItem, updateStageItem, removeStageItem,
      updateAssignment, addAssignment, insertStage, uploadDoc, updateDoc, deleteDoc, createOrder, createMasterOrder, updateMasterOrder, deleteMasterOrder,
      editOrder, deleteOrder,
      createUser, updateUser, toggleUser, resetUserPw,
      markAllRead, markOneRead, getDocData, refreshAudit, loadMoreAudit,
      refreshOrders, refreshDocs, listAllRibbons, createRibbon, updateRibbon, removeRibbon,
      createActionItem, updateActionItem, addActionItemUpdate, removeActionItem, refreshActionItems,
    }}>
      {children}
    </AppContext.Provider>
  )
}
