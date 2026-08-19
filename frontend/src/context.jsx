import { createContext, useContext, useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { authApi, ordersApi, documentsApi, usersApi, notificationsApi, auditApi, ribbonsApi, masterOrdersApi, actionItemsApi, wikiPagesApi, materialDefinitionsApi, materialRequirementsApi, costSheetsApi, mfrProjectsApi, inventoryApi, setStoredToken, setAuthToken } from './api.js'
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
  const [actionItems, setActionItems] = useState([])
  const [wikiPages, setWikiPages]     = useState([])
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
        wikiPagesApi.list(),
        isMfr ? Promise.resolve([]) : masterOrdersApi.list(), // manufacturers cannot access master orders
        ...(isAdmin ? [usersApi.list(), auditApi.list(), actionItemsApi.list()] : []),
      ]
      const results = await Promise.all(promises)
      setOrders(results[0])
      setDocs(results[1])
      setNotifs(results[2])
      setServerRibbons(results[3])
      setWikiPages(results[4])
      setMasterOrders(results[5])
      if (isAdmin) {
        setUsers(results[6])
        // audit endpoint now returns { total, limit, skip, items }
        const auditResult = results[7]
        setAudit(Array.isArray(auditResult) ? auditResult : (auditResult?.items ?? []))
        setActionItems(results[8])
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
    setCurrentUser(null)
    setOrders([])
    setDocs([])
    setNotifs([])
    setAudit([])
    setUsers([])
    setServerRibbons([])
    setMasterOrders([])
    setActionItems([])
    setWikiPages([])
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
        setUsers([]); setServerRibbons([]); setMasterOrders([]); setActionItems([]); setWikiPages([])
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
        setUsers([]); setServerRibbons([]); setMasterOrders([]); setActionItems([]); setWikiPages([])
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

    // The route returns { ...order, warnings } — keep warnings out of the store.
    const { warnings, ...updated } = await ordersApi.updateStage(orderId, mfrId, stageIndex, data)
    setOrders(p => p.map(o => o.id === orderId ? updated : o))

    const newStage = (updated.assignments || []).find(a => String(a.mid) === String(mfrId))?.stages?.[stageIndex]
    const stageName = newStage?.name || `Stage ${stageIndex + 1}`
    if (updated.buyerId) {
      await pushNotif(updated.buyerId, 'status', `Production update on ${orderId}: ${stageName} progress updated`, orderId)
    }
    // Read the change off the response, not off `data` — a status-only write
    // (milestones, the daily grid) carries no unitsDone and used to log
    // "units 0 → undefined".
    const change = newStage?.kind === 'quantity'
      ? `units ${oldUnits} → ${newStage?.unitsDone ?? oldUnits}`
      : `status → ${newStage?.status ?? 'updated'}`
    await addAudit('Stage Update', `${orderId}: ${stageName} — ${change}${data.note ? ' | Note: ' + data.note : ''}`)
    return { ...updated, warnings: warnings || [] }
  }, [orders, pushNotif, addAudit])

  // One request for N stages. Used by the daily-update grid and Bulk Edit, which
  // previously fired one call per changed stage and could exhaust the 120/hr
  // update limiter on a single 27-stage order.
  const bulkUpdateStages = useCallback(async (orderId, mfrId, stages) => {
    const { updated: count, ...updated } = await ordersApi.bulkUpdateStages(orderId, mfrId, stages)
    setOrders(p => p.map(o => o.id === orderId ? updated : o))
    await addAudit('Stages Bulk Update', `${orderId}: ${count} stage(s) updated`)
    return updated
  }, [addAudit])

  const addStageItem = useCallback(async (orderId, mfrId, stageIndex, data) => {
    const updated = await ordersApi.addStageItem(orderId, mfrId, stageIndex, data)
    setOrders(p => p.map(o => o.id === orderId ? updated : o))
    await addAudit('Stage Item Added', `${orderId}: stage ${stageIndex + 1}`)
    return updated
  }, [addAudit])

  const updateStageItem = useCallback(async (orderId, mfrId, stageIndex, lineIndex, data) => {
    const updated = await ordersApi.updateStageItem(orderId, mfrId, stageIndex, lineIndex, data)
    setOrders(p => p.map(o => o.id === orderId ? updated : o))
    return updated
  }, [])

  const removeStageItem = useCallback(async (orderId, mfrId, stageIndex, lineIndex) => {
    const updated = await ordersApi.removeStageItem(orderId, mfrId, stageIndex, lineIndex)
    setOrders(p => p.map(o => o.id === orderId ? updated : o))
    await addAudit('Stage Item Removed', `${orderId}: stage ${stageIndex + 1}`)
    return updated
  }, [addAudit])

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

  const deleteMasterOrder = useCallback(async (id) => {
    const mo = masterOrders.find(m => m.id === id)
    await masterOrdersApi.delete(id)
    setMasterOrders(p => p.filter(m => m.id !== id))
    await addAudit('Master Order Deleted', `${id}${mo ? ' — ' + mo.orderName : ''}`)
  }, [masterOrders, addAudit])

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

  // actionItems is otherwise only fetched once at bootstrap (line ~38) — every
  // existing mutation below refetches inline, but nothing external (like the
  // AI assistant, which can also change ActionItem records) had a way to ask
  // for a refresh until now.
  const refreshActionItems = useCallback(async () => {
    setActionItems(await actionItemsApi.list())
  }, [])

  const addStageUpdate = useCallback(async (orderId, mfrId, stageIndex, text) => {
    const updated = await ordersApi.addStageUpdate(orderId, mfrId, stageIndex, text)
    setOrders(p => p.map(o => o.id === orderId ? updated : o))
    const stageName = (updated.assignments || []).find(a => String(a.mid) === String(mfrId))?.stages?.[stageIndex]?.name || `Stage ${stageIndex + 1}`
    await addAudit('Stage Update Added', `${orderId}: ${stageName} — ${text.slice(0, 100)}`)
    return updated
  }, [addAudit])

  const addStageMaterial = useCallback(async (orderId, mfrId, stageIndex, data) => {
    const updated = await ordersApi.addStageMaterial(orderId, mfrId, stageIndex, data)
    setOrders(p => p.map(o => o.id === orderId ? updated : o))
    await addAudit('Stage Material Added', `${orderId}: added "${data.name}"`)
    return updated
  }, [addAudit])

  const updateStageMaterial = useCallback(async (orderId, mfrId, stageIndex, lineIndex, data) => {
    const updated = await ordersApi.updateStageMaterial(orderId, mfrId, stageIndex, lineIndex, data)
    setOrders(p => p.map(o => o.id === orderId ? updated : o))
    await addAudit('Stage Material Updated', `${orderId}: material line ${lineIndex + 1}${data.status ? ` → ${data.status}` : ''}`)
    return updated
  }, [addAudit])

  const removeStageMaterial = useCallback(async (orderId, mfrId, stageIndex, lineIndex) => {
    const updated = await ordersApi.removeStageMaterial(orderId, mfrId, stageIndex, lineIndex)
    setOrders(p => p.map(o => o.id === orderId ? updated : o))
    await addAudit('Stage Material Deleted', `${orderId}: removed material line ${lineIndex + 1}`)
    return updated
  }, [addAudit])

  const bulkUploadMaterials = useCallback(async (rows) => {
    const result = await ordersApi.materialsBulkUpload(rows)
    await refreshOrders()
    await addAudit('Bulk Materials Upload', `${result.created} created, ${result.failed} failed`)
    return result
  }, [addAudit, refreshOrders])

  const bulkCreateOrders = useCallback(async (masterOrderId, rows) => {
    const result = await ordersApi.bulkCreate(masterOrderId, rows)

    // The bulk response only returns lightweight per-row results (not full
    // enriched order docs) — refetch so newly-created orders show up in state.
    if (result.created > 0) {
      await refreshOrders()
    }

    const mo = masterOrders.find(m => m.id === masterOrderId)
    if (result.created > 0 && mo) {
      await pushNotif(mo.buyerId, 'order', `${result.created} new order${result.created !== 1 ? 's' : ''} created under Master Order ${masterOrderId}`)

      // One summary notification per distinct manufacturer across successfully-created rows
      const successRows = new Set(result.results.filter(r => r.success).map(r => r.row))
      const mfrIds = new Set()
      rows.forEach((row, i) => {
        if (!successRows.has(i)) return
        ;(row.assignments || []).forEach(a => mfrIds.add(a.mid))
      })
      for (const mid of mfrIds) {
        await pushNotif(mid, 'order', `You were assigned to new orders under Master Order ${masterOrderId}`)
      }
    }

    await addAudit('Bulk Order Upload', `${result.created} created, ${result.failed} failed under ${masterOrderId}`)
    return result
  }, [masterOrders, pushNotif, addAudit, refreshOrders])

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

  // ── Wiki (Tech Pack/SOP pages — admin write, all roles read) ──
  const createWikiPage = useCallback(async (data) => {
    const page = await wikiPagesApi.create(data)
    setWikiPages(await wikiPagesApi.list())
    await addAudit('Wiki Page Created', `${data.title} (${data.category})`)
    return page
  }, [addAudit])

  const updateWikiPage = useCallback(async (id, data) => {
    const page = await wikiPagesApi.update(id, data)
    setWikiPages(await wikiPagesApi.list())
    await addAudit('Wiki Page Updated', `${page.title} (${page.category})`)
    return page
  }, [addAudit])

  const removeWikiPage = useCallback(async (id) => {
    const page = wikiPages.find(p => p.id === id)
    await wikiPagesApi.remove(id)
    setWikiPages(p => p.filter(w => w.id !== id))
    await addAudit('Wiki Page Deleted', page?.title || id)
  }, [wikiPages, addAudit])

  const refreshWikiPages = useCallback(async () => {
    setWikiPages(await wikiPagesApi.list())
  }, [])

  const getWikiPage = useCallback((id) => wikiPagesApi.get(id), [])

  // ── Materials Management + Costing Engine ──
  // On-demand, not bootstrap-loaded: a MaterialRequirement/CostSheet belongs
  // to ONE order or project at a time, same as getDocData/getWikiPage above —
  // there's no sensible "all requirements across every order" global list.
  const listMaterialDefinitions = useCallback((category) => materialDefinitionsApi.list(category), [])
  const createMaterialDefinition = useCallback(async (data) => {
    const def = await materialDefinitionsApi.create(data)
    await addAudit('Material Definition Created', data.name)
    return def
  }, [addAudit])

  const getMaterialRequirement = useCallback((scope) => materialRequirementsApi.get(scope), [])
  const addRequirementLine = useCallback(async (data) => {
    const doc = await materialRequirementsApi.addLine(data)
    await addAudit('Material Requirement Line Added', data.name)
    return doc
  }, [addAudit])
  const updateRequirementLine = useCallback((reqId, lineId, data) => materialRequirementsApi.updateLine(reqId, lineId, data), [])
  const removeRequirementLine = useCallback((reqId, lineId) => materialRequirementsApi.removeLine(reqId, lineId), [])
  const bulkUploadMaterialRequirements = useCallback(async (rows) => {
    const result = await materialRequirementsApi.bulk(rows)
    await addAudit('Bulk Material Requirements Upload', `${result.created} created, ${result.failed} failed`)
    return result
  }, [addAudit])
  const pushRequirementToStage = useCallback(async (reqId, lineId, data) => {
    const doc = await materialRequirementsApi.push(reqId, lineId, data)
    await addAudit('Material Requirement Pushed to Stage', `${data.mfrId} / stage ${data.stageIndex}`)
    refreshOrders().catch(() => {}) // pushed line is now a real stage material line — refresh so Production tab shows it without a reload
    return doc
  }, [addAudit, refreshOrders])

  const listCostSheets = useCallback((scope) => costSheetsApi.list(scope), [])
  const getCostSheet = useCallback((id) => costSheetsApi.get(id), [])
  const saveCostSheet = useCallback(async (data) => {
    const sheet = await costSheetsApi.save(data)
    await addAudit('Cost Sheet Saved', data.orderId || data.mfrProjectId || '')
    return sheet
  }, [addAudit])
  const setCostSheetMargin = useCallback(async (id, data) => {
    const sheet = await costSheetsApi.setMargin(id, data)
    await addAudit('Cost Sheet Margin Set', id)
    return sheet
  }, [addAudit])
  const saveCostSheetActuals = useCallback((id, data) => costSheetsApi.saveActuals(id, data), [])
  const submitCostSheet = useCallback(async (id) => {
    const sheet = await costSheetsApi.submit(id)
    await addAudit('Cost Sheet Submitted', id)
    return sheet
  }, [addAudit])
  const withdrawCostSheet = useCallback((id) => costSheetsApi.withdraw(id), [])
  const approveCostSheet = useCallback(async (id) => {
    const sheet = await costSheetsApi.approve(id)
    await addAudit('Cost Sheet Approved', id)
    return sheet
  }, [addAudit])
  const duplicateCostSheet = useCallback(async (id, data) => {
    const sheet = await costSheetsApi.duplicate(id, data)
    await addAudit('Cost Sheet Duplicated', `${id} -> ${data.targetOrderId || data.targetMfrProjectId}`)
    return sheet
  }, [addAudit])

  const listMfrMasterProjects = useCallback(() => mfrProjectsApi.listMasterProjects(), [])
  const createMfrMasterProject = useCallback((data) => mfrProjectsApi.createMasterProject(data), [])
  const deleteMfrMasterProject = useCallback((id) => mfrProjectsApi.deleteMasterProject(id), [])
  const listMfrProjects = useCallback((mfrMasterProjectId) => mfrProjectsApi.list(mfrMasterProjectId), [])
  const createMfrProject = useCallback((data) => mfrProjectsApi.create(data), [])
  const updateMfrProject = useCallback((id, data) => mfrProjectsApi.update(id, data), [])
  const deleteMfrProject = useCallback((id) => mfrProjectsApi.delete(id), [])

  const listInventory = useCallback(() => inventoryApi.list(), [])

  const unread = notifs.filter(n => !n.read).length

  return (
    <AppContext.Provider value={{
      currentUser, users, orders, docs, notifs, audit, loading, loadError, unread, ribbons, masterOrders,
      actionItems, wikiPages,
      login, logout,
      createWikiPage, updateWikiPage, removeWikiPage, refreshWikiPages, getWikiPage,
      updateStage, addStageUpdate, addStageMaterial, updateStageMaterial, removeStageMaterial, bulkUploadMaterials,
      bulkUpdateStages, addStageItem, updateStageItem, removeStageItem,
      updateAssignment, uploadDoc, createOrder, bulkCreateOrders, createMasterOrder, deleteMasterOrder,
      editOrder, deleteOrder,
      createUser, updateUser, toggleUser, resetUserPw,
      markAllRead, markOneRead, getDocData, addAudit, pushNotif,
      refreshOrders, listAllRibbons, createRibbon, updateRibbon, removeRibbon,
      createActionItem, updateActionItem, addActionItemUpdate, removeActionItem, refreshActionItems,
      listMaterialDefinitions, createMaterialDefinition,
      getMaterialRequirement, addRequirementLine, updateRequirementLine, removeRequirementLine, pushRequirementToStage,
      bulkUploadMaterialRequirements,
      listCostSheets, getCostSheet, saveCostSheet, setCostSheetMargin, saveCostSheetActuals,
      submitCostSheet, withdrawCostSheet, approveCostSheet, duplicateCostSheet,
      listMfrMasterProjects, createMfrMasterProject, deleteMfrMasterProject,
      listMfrProjects, createMfrProject, updateMfrProject, deleteMfrProject,
      listInventory,
    }}>
      {children}
    </AppContext.Provider>
  )
}
