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
}

export const ordersApi = {
  list: () => api.get('/orders'),
  get: id => api.get(`/orders/${id}`),
  create: data => api.post('/orders', data),
  update: (id, data) => api.post(`/orders/${id}`, data),
  delete: id => api.post(`/orders/${id}/delete`),
  updateAssignment: (orderId, mfrId, status, note) =>
    api.post(`/orders/${orderId}/assignments/${mfrId}`, { status, note }),
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
  bulkCreate: (masterOrderId, rows) =>
    api.post('/orders/bulk', { masterOrderId, rows }),
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
  materialsBulkUpload: (rows) =>
    api.post('/orders/materials/bulk', { rows }),
}

export const documentsApi = {
  list: () => api.get('/documents'),
  getData: id => api.get(`/documents/${id}/data`),
  upload: data => api.post('/documents', data),
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
  list: () => api.get('/audit'),
  add: (action, detail) => api.post('/audit', { action, detail }),
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
  remove: id => api.post(`/action-items/${id}/delete`),
}

export const assistantApi = {
  // A broad question can fan out into several tool calls, each its own
  // Anthropic round-trip (up to MAX_TOOL_LOOP_ITERATIONS server-side) — this
  // routinely takes longer than the client's default 30s timeout, so it gets
  // its own generous override rather than raising the default for every
  // other (much faster) endpoint.
  chat: (messages) => api.post('/assistant/chat', { messages }, { timeout: 120000 }),
}

export const wikiPagesApi = {
  list: () => api.get('/wiki-pages'),
  get: id => api.get(`/wiki-pages/${id}`),
  create: data => api.post('/wiki-pages', data),
  update: (id, data) => api.post(`/wiki-pages/${id}`, data),
  remove: id => api.post(`/wiki-pages/${id}/delete`),
}

export const masterOrdersApi = {
  list: () => api.get('/master-orders'),
  create: data => api.post('/master-orders', data),
  delete: id => api.post(`/master-orders/${id}/delete`),
}

export const materialDefinitionsApi = {
  list: (category) => api.get('/material-definitions' + (category ? `?category=${category}` : '')),
  create: data => api.post('/material-definitions', data),
  update: (id, data) => api.post(`/material-definitions/${id}`, data),
}

export const materialRequirementsApi = {
  get: ({ orderId, mfrProjectId }) => api.get(`/material-requirements?${orderId ? `orderId=${orderId}` : `mfrProjectId=${mfrProjectId}`}`),
  addLine: data => api.post('/material-requirements', data),
  updateLine: (reqId, lineId, data) => api.post(`/material-requirements/${reqId}/lines/${lineId}`, data),
  removeLine: (reqId, lineId) => api.post(`/material-requirements/${reqId}/lines/${lineId}/delete`),
  push: (reqId, lineId, data) => api.post(`/material-requirements/${reqId}/lines/${lineId}/push`, data),
  bulk: (rows) => api.post('/material-requirements/bulk', { rows }),
  duplicate: (reqId, data) => api.post(`/material-requirements/${reqId}/duplicate`, data),
  generatePo: (reqId, data) => api.post(`/material-requirements/${reqId}/generate-po`, data),
  aiDraft: data => api.post('/material-requirements/ai-draft', data, { timeout: 90000 }),
}

export const suppliersApi = {
  list: () => api.get('/suppliers'),
  create: data => api.post('/suppliers', data),
  update: (id, data) => api.post(`/suppliers/${id}`, data),
  remove: id => api.post(`/suppliers/${id}/delete`),
}

export const costSheetsApi = {
  list: ({ orderId, mfrProjectId }) => api.get(`/cost-sheets?${orderId ? `orderId=${orderId}` : `mfrProjectId=${mfrProjectId}`}`),
  get: id => api.get(`/cost-sheets/${id}`),
  save: data => api.post('/cost-sheets', data),
  setMargin: (id, data) => api.post(`/cost-sheets/${id}/margin`, data),
  saveActuals: (id, data) => api.post(`/cost-sheets/${id}/actuals`, data),
  submit: id => api.post(`/cost-sheets/${id}/submit`, {}),
  withdraw: id => api.post(`/cost-sheets/${id}/withdraw`, {}),
  approve: id => api.post(`/cost-sheets/${id}/approve`, {}),
  duplicate: (id, data) => api.post(`/cost-sheets/${id}/duplicate`, data),
  exportUrl: (id, internal) => `${api.defaults.baseURL}/cost-sheets/${id}/export.xlsx${internal ? '?view=internal' : ''}`,
}

export const inventoryApi = {
  list: () => api.get('/inventory'),
}

export const mfrProjectsApi = {
  listMasterProjects: () => api.get('/mfr-master-projects'),
  createMasterProject: data => api.post('/mfr-master-projects', data),
  deleteMasterProject: id => api.post(`/mfr-master-projects/${id}/delete`),
  list: (mfrMasterProjectId) => api.get('/mfr-projects' + (mfrMasterProjectId ? `?mfrMasterProjectId=${mfrMasterProjectId}` : '')),
  create: data => api.post('/mfr-projects', data),
  update: (id, data) => api.post(`/mfr-projects/${id}`, data),
  delete: id => api.post(`/mfr-projects/${id}/delete`),
  bulkCreate: (mfrMasterProjectId, rows) => api.post('/mfr-projects/bulk', { mfrMasterProjectId, rows }),
  // TNA (Order Setup Wizard, Phase 4) - mirrors ordersApi's stage methods
  // one-for-one, minus the mfrId segment (a project has exactly one owner).
  seedStages: (id, data) => api.post(`/mfr-projects/${id}/stages/seed`, data),
  updateStage: (id, stageIndex, data) => api.post(`/mfr-projects/${id}/stages/${stageIndex}`, data),
  updateStageDates: (id, stageIndex, dates) => api.post(`/mfr-projects/${id}/stages/${stageIndex}/eta`, dates),
  bulkUpdateStages: (id, stages) => api.post(`/mfr-projects/${id}/stages/bulk`, { stages }),
  removeStage: (id, stageIndex) => api.post(`/mfr-projects/${id}/stages/${stageIndex}/delete`),
  addStageUpdate: (id, stageIndex, text) => api.post(`/mfr-projects/${id}/stages/${stageIndex}/updates`, { text }),
  addStageItem: (id, stageIndex, data) => api.post(`/mfr-projects/${id}/stages/${stageIndex}/items`, data),
  updateStageItem: (id, stageIndex, lineIndex, data) => api.post(`/mfr-projects/${id}/stages/${stageIndex}/items/${lineIndex}`, data),
  removeStageItem: (id, stageIndex, lineIndex) => api.post(`/mfr-projects/${id}/stages/${stageIndex}/items/${lineIndex}/delete`),
  addStageMaterial: (id, stageIndex, data) => api.post(`/mfr-projects/${id}/stages/${stageIndex}/materials`, data),
  updateStageMaterial: (id, stageIndex, lineIndex, data) => api.post(`/mfr-projects/${id}/stages/${stageIndex}/materials/${lineIndex}`, data),
  removeStageMaterial: (id, stageIndex, lineIndex) => api.post(`/mfr-projects/${id}/stages/${stageIndex}/materials/${lineIndex}/delete`),
}

export default api
