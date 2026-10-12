// Per-request context that follows a request through every await, without threading `req` into
// code that does not have it (model hooks, helpers). requireAuth fills it in once.
import { AsyncLocalStorage } from 'node:async_hooks'

export const requestContext = new AsyncLocalStorage()

/** The master admin behind a "view as" session, or null for an ordinary request. */
export function viewAsActor() {
  const s = requestContext.getStore()
  return s?.viewAsBy ? { id: s.viewAsBy, name: s.viewAsByName || 'an admin' } : null
}

/**
 * For a teammate's request: the person who acted and the party (their organization) they acted as.
 * Null for everyone else. Routes write audit entries as `byUser: req.user.id`, which for a teammate
 * is the organization's primary account; the audit log swaps in the real person from here.
 */
export function teamActor() {
  const s = requestContext.getStore()
  return s?.actorId && s?.partyId && s.actorId !== s.partyId ? { actorId: s.actorId, partyId: s.partyId } : null
}
