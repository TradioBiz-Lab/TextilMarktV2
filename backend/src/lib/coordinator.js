// The Ops & QC coordinator (role 'coordinator') is fail-closed: this is the whole list of requests that role may make,
// reads included. requireAuth refuses anything else before a route runs, because most routes deny buyers, scope
// manufacturers and let every other role through as if it were an admin. To give a coordinator something new, add a
// line here first; the route's own checks then narrow it further.
export const COORDINATOR_ROLE = 'coordinator'

const ID = '[^/]+'
export const COORDINATOR_ALLOWED = [
  // Session
  ['GET', /^\/api\/auth\/me$/],
  ['POST', /^\/api\/auth\/(change-password|logout|language)$/],
  ['GET', /^\/api\/notifications$/],
  ['POST', new RegExp(`^/api/notifications/(${ID}/read|mark-all-read)$`)],
  ['GET', /^\/api\/ribbons$/],
  // Phase 1: factory visits
  ['GET', /^\/api\/visits\/mine$/],
  ['POST', /^\/api\/visits\/check-in$/],
  ['POST', new RegExp(`^/api/visits/${ID}/check-out$`)],
  // Phase 2: the styles at his factories, read only. Each of these routes scopes what it returns to req.user.factoryIds.
  ['GET', /^\/api\/orders$/],
  ['GET', new RegExp(`^/api/orders/${ID}$`)],
  ['GET', /^\/api\/documents$/],
  ['GET', new RegExp(`^/api/documents/${ID}/(data|versions)$`)],
  ['GET', /^\/api\/master-orders$/],
  ['GET', /^\/api\/floor\/feed$/],
]

/**
 * Whose splits of a style a viewer is sent: a factory its own, a coordinator those at his factories, anyone else all
 * (null). The value goes to enrichOrder, which drops every other split.
 */
export const viewerSplits = user => (user?.role === 'manufacturer' ? String(user.id)
  : user?.role === COORDINATOR_ROLE ? (user.factoryIds || []).map(String) : null)

/** The path as the gate compares it: no query string, no trailing slash. */
export const gatePath = url => String(url || '').split('?')[0].replace(/\/+$/, '')

export function coordinatorMay(method, url) {
  const m = String(method || '').toUpperCase()
  const path = gatePath(url)
  return COORDINATOR_ALLOWED.some(([am, re]) => am === m && re.test(path))
}
