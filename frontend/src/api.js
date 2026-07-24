import axios from 'axios'

// Token is stored in an httpOnly cookie (set by the backend) — not accessible via JS.
// setStoredToken stores the user's ID (not the token) as a cross-tab sentinel so tabs
// can detect when a different user logs in and clear their stale session state.
const SENTINEL_KEY = 'tradio_session'
export const getStoredToken = () => localStorage.getItem(SENTINEL_KEY)
export const setStoredToken = (userId) => userId
  ? localStorage.setItem(SENTINEL_KEY, userId)
  : localStorage.removeItem(SENTINEL_KEY)

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api',
  timeout: 30000,
  withCredentials: true, // sends the httpOnly cookie automatically
  // Sent as text/plain (a CORS-simple content type) so browsers skip the OPTIONS
  // preflight — Catalyst AppSail's edge doesn't add CORS headers to preflight
  // responses, which blocks the real request. Body is still JSON underneath.
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
      // Only reload if we had an active session — avoids reload loops on first page load
      if (hadSession) window.location.reload()
    }
    return Promise.reject(err.response?.data?.error || 'Request failed')
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

export const masterOrdersApi = {
  list: () => api.get('/master-orders'),
  create: data => api.post('/master-orders', data),
  delete: id => api.post(`/master-orders/${id}/delete`),
}

export default api
