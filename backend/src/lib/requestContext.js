// Per-request context that follows a request through every await, without threading `req` into
// code that does not have it (model hooks, helpers). requireAuth fills it in once.
import { AsyncLocalStorage } from 'node:async_hooks'

export const requestContext = new AsyncLocalStorage()

/** The master admin behind a "view as" session, or null for an ordinary request. */
export function viewAsActor() {
  const s = requestContext.getStore()
  return s?.viewAsBy ? { id: s.viewAsBy, name: s.viewAsByName || 'an admin' } : null
}
