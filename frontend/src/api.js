import axios from 'axios'

// Token is primarily an httpOnly cookie (set by the backend) — not accessible via JS.
// setStoredToken stores the user's ID (not the token) as a cross-tab sentinel so tabs
// can detect when a different user logs in and clear their stale session state.
const SENTINEL_KEY = 'tradio_session'
export const getStoredToken = () => localStorage.getItem(SENTINEL_KEY)
export const setStoredToken = (userId) => userId
  ? localStorage.setItem(SENTINEL_KEY, userId)
  : localStorage.removeItem(SENTINEL_KEY)

// Fallback auth token — stored, but NOT currently sent. It was meant to travel as an
// Authorization header when the cross-site cookie doesn't survive (iOS WebKit), but any
// custom header forces a CORS preflight, and Catalyst AppSail's edge answers preflight
// OPTIONS itself with no CORS headers (see the text/plain comment below) — so attaching
// this header doesn't fall back gracefully, it hard-blocks EVERY request for EVERYONE,
// not just iOS. Confirmed live: identical fetch with vs without the header goes from a
// normal 401 to a network-level "Failed to fetch". Left in place (unused) for whichever
// preflight-safe delivery mechanism (e.g. a query param, at the cost of the token
// appearing in server logs/history) replaces this — do not wire this back up as a
// request header without first confirming AppSail's preflight handling has changed.
const AUTH_TOKEN_KEY = 'tradio_auth_token'
export const getAuthToken = () => localStorage.getItem(AUTH_TOKEN_KEY)
export const setAuthToken = (token) => token
  ? localStorage.setItem(AUTH_TOKEN_KEY, token)
  : localStorage.removeItem(AUTH_TOKEN_KEY)

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api',
  timeout: 30000,
  withCredentials: true, // sends the httpOnly cookie automatically
  // Sent as text/plain (a CORS-simple content type) so browsers skip the OPTIONS
  // preflight — Catalyst AppSail's edge doesn't add CORS headers to preflight
  // responses, which blocks the real request. Body is still JSON underneath.
  // Custom headers (e.g. Authorization) would force a preflight too — don't add any.
  headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
  transformRequest: [data => JSON.stringify(data)],
})

api.interceptors.response.use(
  r => r.data,
  err => {
    const url = err.config?.url || ''
    if (err.response?.status === 401 && !url.includes('/auth/')) {
      const hadSession = getStoredToken() !== null
      setStoredToken(null)
      setAuthToken(null)
      // Only reload if we had an active session — avoids reload loops on first page load
      if (hadSession) window.location.reload()
    }
    // An Error (not a bare string) so every `catch (err) { ... err?.message ... }`
    // call site actually gets the backend's real reason instead of silently
    // falling back to a generic message — a bare string has no .message.
    return Promise.reject(new Error(err.response?.data?.error || 'Request failed'))
  }
)

export const authApi = {
  login: (email, password) => api.post('/auth/login', { email, password }),
  me: () => api.get('/auth/me'),
  logout: () => api.post('/auth/logout'),
  changePassword: (currentPassword, newPassword) => api.post('/auth/change-password', { currentPassword, newPassword }),
  forgotPassword: email => api.post('/auth/forgot-password', { email }),
  resetPassword: (token, password) => api.post('/auth/reset-password', { token, password }),
}

export const ordersApi = {
  list: () => api.get('/orders'),
  get: id => api.get(`/orders/${id}`),
  create: data => api.post('/orders', data),
  update: (id, data) => api.post(`/orders/${id}`, data),
  // The customer's own style: its product photos (Tradio uses update).
  setPhotos: (id, photos) => api.post(`/orders/${id}/photos`, { photos }),
  // `reason` is optional and is kept, with a full copy of the style, in the dropped record.
  delete: (id, reason) => api.post(`/orders/${id}/delete`, reason ? { reason } : {}),
  updateAssignment: (orderId, mfrId, status, note) =>
    api.post(`/orders/${orderId}/assignments/${mfrId}`, { status, note }),
  // Adds a manufacturer to a style that has none yet (or a second split) —
  // starts with an empty stage list; TNA is built separately afterward.
  addAssignment: (orderId, { mfrId, qty, sub, delivery }) =>
    api.post(`/orders/${orderId}/assignments`, { mfrId, qty, sub, ...(delivery ? { delivery } : {}) }),
  // Records how many pieces were actually delivered for a split (a whole number, or null to clear).
  setDeliveredQty: (orderId, mfrId, deliveredQty) =>
    api.post(`/orders/${orderId}/assignments/${mfrId}/delivered-qty`, { deliveredQty }),
  // Hands one manufacturer split to a different manufacturer: { newMfrId, qty? }. Plan and progress stay.
  reassignAssignment: (orderId, mfrId, data) =>
    api.post(`/orders/${orderId}/assignments/${mfrId}/reassign`, data),
  updateStage: (orderId, mfrId, stageIndex, data) =>
    api.post(`/orders/${orderId}/assignments/${mfrId}/stages/${stageIndex}`, data),
  updateStageDates: (orderId, mfrId, stageIndex, dates) =>
    api.post(`/orders/${orderId}/assignments/${mfrId}/stages/${stageIndex}/eta`, dates),
  // One atomic write for many stages — replaces looping updateStageDates per row.
  // `stages` is [{index, status?, eta?, startDate?, responsibleId?, totalUnits?,
  // description?, kind?, blocked?, blockedReason?}].
  bulkUpdateStages: (orderId, mfrId, stages) =>
    api.post(`/orders/${orderId}/assignments/${mfrId}/stages/bulk`, { stages }),
  addStageItem: (orderId, mfrId, stageIndex, data) =>
    api.post(`/orders/${orderId}/assignments/${mfrId}/stages/${stageIndex}/items`, data),
  updateStageItem: (orderId, mfrId, stageIndex, lineIndex, data) =>
    api.post(`/orders/${orderId}/assignments/${mfrId}/stages/${stageIndex}/items/${lineIndex}`, data),
  removeStageItem: (orderId, mfrId, stageIndex, lineIndex) =>
    api.post(`/orders/${orderId}/assignments/${mfrId}/stages/${stageIndex}/items/${lineIndex}/delete`),
  escalate: (id, reason) =>
    api.post(`/orders/${id}/escalate`, { reason }),
  addStageUpdate: (orderId, mfrId, stageIndex, text) =>
    api.post(`/orders/${orderId}/assignments/${mfrId}/stages/${stageIndex}/updates`, { text }),
  addStageMaterial: (orderId, mfrId, stageIndex, data) =>
    api.post(`/orders/${orderId}/assignments/${mfrId}/stages/${stageIndex}/materials`, data),
  updateStageMaterial: (orderId, mfrId, stageIndex, lineIndex, data) =>
    api.post(`/orders/${orderId}/assignments/${mfrId}/stages/${stageIndex}/materials/${lineIndex}`, data),
  removeStageMaterial: (orderId, mfrId, stageIndex, lineIndex) =>
    api.post(`/orders/${orderId}/assignments/${mfrId}/stages/${stageIndex}/materials/${lineIndex}/delete`),
  removeStage: (orderId, mfrId, stageIndex) =>
    api.post(`/orders/${orderId}/assignments/${mfrId}/stages/${stageIndex}/delete`),
  // Inserts a new stage into an already-created order's plan (admin only).
  // `data` is {index?, name, kind?, totalUnits?, startDate, eta, description?,
  // responsibleId?, status?, actualEnd?} — index omitted appends to the end.
  insertStage: (orderId, mfrId, data) =>
    api.post(`/orders/${orderId}/assignments/${mfrId}/stages/insert`, data),
  // Fill an empty plan: { from: 'style', fromOrderId } or { from: 'template', startDate }.
  startPlan: (orderId, mfrId, data) =>
    api.post(`/orders/${orderId}/assignments/${mfrId}/stages/start-plan`, data),
  // Move one step up or down the plan ('up' | 'down'); Delivery stays last.
  moveStage: (orderId, mfrId, stageIndex, direction) =>
    api.post(`/orders/${orderId}/assignments/${mfrId}/stages/${stageIndex}/move`, { direction }),
}

export const documentsApi = {
  list: () => api.get('/documents'),
  getData: id => api.get(`/documents/${id}/data`),
  upload: data => api.post('/documents', data),
  update: (id, data) => api.post(`/documents/${id}`, data),
  versions: id => api.get(`/documents/${id}/versions`),
  fileInto: (id, orderId) => api.post(`/documents/${id}/file`, { orderId }),
  remove: id => api.post(`/documents/${id}/delete`),
  checkCertExpiry: () => api.post('/documents/cert-expiry-check'),
}

export const usersApi = {
  list: () => api.get('/users'),
  create: data => api.post('/users', data),
  update: (id, data) => api.post(`/users/${id}`, data),
  toggle: id => api.post(`/users/${id}/toggle`),
  resetPassword: id => api.post(`/users/${id}/reset-password`),
}

export const notificationsApi = {
  list: () => api.get('/notifications'),
  create: data => api.post('/notifications', data),
  markAllRead: () => api.post('/notifications/mark-all-read'),
  markOneRead: id => api.post(`/notifications/${id}/read`),
}

export const auditApi = {
  list: (params) => api.get('/audit', { params }),
}

export const ribbonsApi = {
  list: () => api.get('/ribbons'),
  listAll: () => api.get('/ribbons/all'),
  create: data => api.post('/ribbons', data),
  update: (id, data) => api.post(`/ribbons/${id}`, data),
  remove: id => api.post(`/ribbons/${id}/delete`),
}

export const actionItemsApi = {
  list: () => api.get('/action-items'),
  create: data => api.post('/action-items', data),
  update: (id, data) => api.post(`/action-items/${id}`, data),
  addUpdate: (id, text) => api.post(`/action-items/${id}/updates`, { text }),
}

export const assistantApi = {
  // A broad question can fan out into several tool calls, each its own
  // Anthropic round-trip (up to MAX_TOOL_LOOP_ITERATIONS server-side) — this
  // routinely takes longer than the client's default 30s timeout, so it gets
  // its own generous override rather than raising the default for every
  // other (much faster) endpoint.
  chat: (messages) => api.post('/assistant/chat', { messages }, { timeout: 120000 }),
}

export const voiceApi = {
  transcribe: (audioDataUrl) => api.post('/voice/transcribe', { audioDataUrl }, { timeout: 30000 }),
  speak: (text, languageCode) => api.post('/voice/speak', { text, languageCode }, { timeout: 30000 }),
}

// A customer's saved production plan (one per customer).
export const planTemplatesApi = {
  get: buyerId => api.get(`/plan-templates/${buyerId}`),
  save: (buyerId, fromOrderId, fromMfrId) => api.post(`/plan-templates/${buyerId}`, { fromOrderId, fromMfrId }),
}

export const masterOrdersApi = {
  list: () => api.get('/master-orders'),
  create: data => api.post('/master-orders', data),
  update: (id, data) => api.post(`/master-orders/${id}`, data),
  delete: (id, reason) => api.post(`/master-orders/${id}/delete`, reason ? { reason } : {}),
  dropped: id => api.get(`/master-orders/${id}/dropped`),
}

// Permanent record of dropped styles and master orders (admin only).
export const droppedApi = {
  list: params => api.get('/dropped', { params }),
  get: id => api.get(`/dropped/${id}`),
}

// The Partner Directory: Tradio's internal sourcing CRM (admin only; the server refuses everyone else).
// (Named partnerDirectoryApi: `partnersApi` below is the brand and manufacturer partnerships of a company.)
export const partnerDirectoryApi = {
  list: params => api.get('/manufacturers', { params }),
  facets: () => api.get('/manufacturers/facets'),
  get: id => api.get(`/manufacturers/${id}`),
  create: data => api.post('/manufacturers', data),
  update: (id, data) => api.post(`/manufacturers/${id}`, data),
  remove: id => api.post(`/manufacturers/${id}/delete`),
  // The uploaded tile, fetched by the page itself (an <img> cannot carry the session); lists never carry image bytes.
  image: id => api.get(`/manufacturers/${id}/image`),
  setImage: (id, image) => api.post(`/manufacturers/${id}/image`, { image }),
  csvPreview: csv => api.post('/manufacturers/csv/preview', { csv }, { timeout: 60000 }),
  importRows: data => api.post('/manufacturers/import', data, { timeout: 90000 }),
}

// The master admin's way into a company (see backend/src/routes/viewAs.js). Read-only by default in
// the standalone product; `act: true` switches on "acting for", which the server only allows for a
// Tradio-enabled manufacturer.
export const viewAsApi = {
  options: () => api.get('/auth/view-as/options'),
  start: (userId, { act = false } = {}) => api.post('/auth/view-as', act ? { userId, act: true } : { userId }),
  exit: () => api.post('/auth/view-as/exit'),
}

// The only other companies a brand or manufacturer can read: the ones it is connected with.
export const partnersApi = {
  list: () => api.get('/partners'),
}

// Companies, their teams, connections and the two Tradio switches (see backend/src/routes/orgs.js).
export const orgsApi = {
  list: () => api.get('/orgs'),                                   // admins
  mine: () => api.get('/orgs/me'),                                // the signed-in company
  create: data => api.post('/orgs', data),                        // master admin
  update: (id, data) => api.post(`/orgs/${id}`, data),            // master admin: name, tradioEnabled, isActive
  addMember: (id, data) => api.post(`/orgs/${id}/members`, data), // master admin
  connect: (id, partnerOrgId) => api.post(`/orgs/${id}/partners`, { partnerOrgId }),
  disconnect: (id, partnerOrgId) => api.post(`/orgs/${id}/partners/${partnerOrgId}/revoke`),
  // Only the company's owner can change who may look at it; Tradio cannot.
  setTradioAccess: tradioCanView => api.post('/orgs/me/privacy', { tradioCanView }),
  // The company's business details (GSTIN, address, state): the header of its purchase orders.
  updateProfile: profile => api.post('/orgs/me/profile', profile),
}

// A manufacturer's private supplier book (standalone product).
export const suppliersApi = {
  list: ({ all = false } = {}) => api.get(`/suppliers${all ? '?all=1' : ''}`),
  get: id => api.get(`/suppliers/${id}`),
  create: data => api.post('/suppliers', data),
  update: (id, data) => api.post(`/suppliers/${id}`, data),
  archive: id => api.post(`/suppliers/${id}/archive`),
  restore: id => api.post(`/suppliers/${id}/restore`),
  bulk: suppliers => api.post('/suppliers/bulk', { suppliers }),
  addItem: (id, data) => api.post(`/suppliers/${id}/items`, data),
  updateItem: (id, itemId, data) => api.post(`/suppliers/${id}/items/${itemId}`, data),
  archiveItem: (id, itemId) => api.post(`/suppliers/${id}/items/${itemId}/archive`),
  restoreItem: (id, itemId) => api.post(`/suppliers/${id}/items/${itemId}/restore`),
  bulkItems: (id, items) => api.post(`/suppliers/${id}/items/bulk`, { items }),
}

// Purchase orders a manufacturer raises with its suppliers (standalone product). Every figure on a PO
// is computed by the server; what is sent here is only what the person typed.
export const purchaseOrdersApi = {
  list: ({ status, supplierId, orderId } = {}) => {
    const q = new URLSearchParams()
    if (status) q.set('status', status)
    if (supplierId) q.set('supplierId', supplierId)
    if (orderId) q.set('orderId', orderId)
    const qs = q.toString()
    return api.get(`/purchase-orders${qs ? `?${qs}` : ''}`)
  },
  get: id => api.get(`/purchase-orders/${id}`),
  create: data => api.post('/purchase-orders', data),
  update: (id, data) => api.post(`/purchase-orders/${id}`, data),
  remove: id => api.post(`/purchase-orders/${id}/delete`),
  pdf: id => api.get(`/purchase-orders/${id}/pdf`),
  // { to?: [emails], message? } - emails the supplier the PDF; slower than the rest (it renders and sends)
  send: (id, data) => api.post(`/purchase-orders/${id}/send`, data || {}, { timeout: 60000 }),
  acknowledge: (id, data) => api.post(`/purchase-orders/${id}/acknowledge`, data || {}),
  close: (id, reason) => api.post(`/purchase-orders/${id}/close`, { reason }),
  cancel: (id, reason) => api.post(`/purchase-orders/${id}/cancel`, { reason }),
  // { lines: [{ lineId, qty }], note? }
  receive: (id, data) => api.post(`/purchase-orders/${id}/receive`, data),
}

// Bills of materials (a factory's, per order), the shopping list across orders, and reading tech packs.
// Quantities are computed by the server; what is sent is what the person typed.
// A factory's stock and the goods it receives (standalone product). The server works every balance from the
// ledger; what is sent here is only what the person typed or photographed.
const query = params => {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== '' && v !== false) q.set(k, v === true ? '1' : String(v))
  const qs = q.toString()
  return qs ? `?${qs}` : ''
}
export const inventoryApi = {
  items: params => api.get(`/inventory/items${query(params)}`),
  item: id => api.get(`/inventory/items/${id}`),
  createItem: data => api.post('/inventory/items', data),
  updateItem: (id, data) => api.post(`/inventory/items/${id}`, data),
  archiveItem: id => api.post(`/inventory/items/${id}/archive`),
  restoreItem: id => api.post(`/inventory/items/${id}/restore`),
  // this item is the same thing as `intoId`: its stock moves there and it is archived
  mergeItem: (id, intoId) => api.post(`/inventory/items/${id}/merge`, { intoId }),
  ledger: params => api.get(`/inventory/ledger${query(params)}`),
  // { itemId, counted | delta, reason }
  adjust: data => api.post('/inventory/adjustments', data),
  // what an order was planned to use (its frozen bill of materials) against what was issued to it
  usage: orderId => api.get(`/inventory/usage${query({ orderId })}`),
  issues: params => api.get(`/inventory/issues${query(params)}`),
  issue: id => api.get(`/inventory/issues/${id}`),
  // { orderId, lines: [{ itemId, qty }], type?: 'issue' | 'return', stageIndex?, note?, issuedOn? }
  createIssue: data => api.post('/inventory/issues', data),
}
export const grnsApi = {
  list: params => api.get(`/grns${query(params)}`),
  get: id => api.get(`/grns/${id}`),
  // { poId?, supplierName?, challanNo?, lines?, post? }: with a PO and no lines it starts from what the PO still waits for
  create: data => api.post('/grns', data || {}),
  // { dataUrl }: a photo or PDF of the supplier's challan or invoice; it is read (slow) and a draft note is made from it
  scan: data => api.post('/grns/scan', data, { timeout: 120000 }),
  update: (id, data) => api.post(`/grns/${id}`, data),
  remove: id => api.post(`/grns/${id}/delete`),
  post: id => api.post(`/grns/${id}/post`, {}, { timeout: 60000 }),
  pdf: id => api.get(`/grns/${id}/pdf`),
  photos: id => api.get(`/grns/${id}/photos`),
  // { dataUrl, kind?: 'challan' | 'goods' | 'damage' | 'other', name?, caption? }
  addPhoto: (id, data) => api.post(`/grns/${id}/photos`, data, { timeout: 60000 }),
  photo: (id, photoId) => api.get(`/grns/${id}/photos/${photoId}`),
  removePhoto: (id, photoId) => api.post(`/grns/${id}/photos/${photoId}/delete`),
}

// Goods sent to job workers (dyers, printers, embroiderers) and what comes back (standalone product).
export const jobworkApi = {
  list: params => api.get(`/jobwork${query(params)}`),
  // every job worker with goods still out
  outstanding: () => api.get('/jobwork/outstanding'),
  get: id => api.get(`/jobwork/${id}`),
  // { supplierId, process, lines: [{ itemId, qty, rate? }], orderId?, sentOn?, expectedBack?, vehicleNo?, note? }
  send: data => api.post('/jobwork', data, { timeout: 60000 }),
  // { lines: [{ lineId, inputQty, outputs: [{ itemId? | description, unit?, qty }] }], note? }
  returnGoods: (id, data) => api.post(`/jobwork/${id}/return`, data),
  close: (id, reason) => api.post(`/jobwork/${id}/close`, { reason }),
  cancel: (id, reason) => api.post(`/jobwork/${id}/cancel`, { reason }),
  pdf: id => api.get(`/jobwork/${id}/pdf`),
  photos: id => api.get(`/jobwork/${id}/photos`),
  addPhoto: (id, data) => api.post(`/jobwork/${id}/photos`, data, { timeout: 60000 }),
  photo: (id, photoId) => api.get(`/jobwork/${id}/photos/${photoId}`),
  removePhoto: (id, photoId) => api.post(`/jobwork/${id}/photos/${photoId}/delete`),
}

export const bomsApi = {
  // the order's versions, the working one in full, and what a new one would start as
  forOrder: orderId => api.get(`/boms?orderId=${encodeURIComponent(orderId)}`),
  create: orderId => api.post('/boms', { orderId }),
  get: id => api.get(`/boms/${id}`),
  // { plan?, lines?, updatedAt?, confirmAll? }
  save: (id, data) => api.post(`/boms/${id}`, data),
  freeze: id => api.post(`/boms/${id}/freeze`),
  revise: id => api.post(`/boms/${id}/revise`),
  remove: id => api.post(`/boms/${id}/delete`),
  // reads a tech pack with AI: the slowest call in the app
  extract: (orderId, documentId) => api.post('/boms/extract', { orderId, documentId }, { timeout: 150000 }),
  aggregate: ({ masterOrderId, orderIds } = {}) => {
    const q = new URLSearchParams()
    if (masterOrderId) q.set('masterOrderId', masterOrderId)
    if (orderIds?.length) q.set('orderIds', orderIds.join(','))
    const qs = q.toString()
    return api.get(`/boms/aggregate${qs ? `?${qs}` : ''}`)
  },
  // { masterOrderId?, orderIds?, keys?, expectedDate? } -> { created, skipped, failed }
  generatePos: data => api.post('/boms/generate-pos', data || {}, { timeout: 60000 }),
}

// Open cost sheets: the factory drafts and shares, the brand comments and approves.
export const costSheetsApi = {
  list: () => api.get('/cost-sheets'),
  get: id => api.get(`/cost-sheets/${id}`),
  // { brandId, styleName, bomId?, orderId?, ...sheet }
  create: data => api.post('/cost-sheets', data),
  save: (id, data) => api.post(`/cost-sheets/${id}`, data),
  remove: id => api.post(`/cost-sheets/${id}/delete`),
  // { message?, extraEmails? } renders the PDF and emails the brand's team, so it is slower than the rest
  share: (id, data) => api.post(`/cost-sheets/${id}/share`, data || {}, { timeout: 60000 }),
  revise: id => api.post(`/cost-sheets/${id}/revise`),
  comment: (id, text, kind = 'comment') => api.post(`/cost-sheets/${id}/comments`, { text, kind }),
  approve: id => api.post(`/cost-sheets/${id}/approve`),
  pdf: id => api.get(`/cost-sheets/${id}/pdf`),
}

// The measurement spec read from a tech pack, by order.
export const specSheetsApi = {
  forOrder: orderId => api.get(`/spec-sheets?orderId=${encodeURIComponent(orderId)}`),
  save: (id, data) => api.post(`/spec-sheets/${id}`, data),
}

export const inboundApi = {
  upload: data => api.post('/inbound/upload', data, { timeout: 90000 }),
}

export const reviewApi = {
  queue: () => api.get('/review/queue'),
  approve: id => api.post(`/review/${id}/approve`, {}),
  correct: (id, body) => api.post(`/review/${id}/correct`, body),
  reject: id => api.post(`/review/${id}/reject`, {}),
  // Authenticated image fetch as a Blob (an <img src> can't carry our auth).
  media: id => api.get(`/review/${id}/media`, { responseType: 'blob' }),
}

export const floorApi = {
  feed: () => api.get('/floor/feed'),
}

export default api
