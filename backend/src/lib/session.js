// Who a signed-in person acts as.
//
// Two ids matter and they must never be confused:
//   actorId  the PERSON who signed in (their own user document). Sign-in, password changes, the JWT
//            claim and the audit trail are about this one.
//   id       the PARTY they act as: their organization's primary account for a teammate, themself
//            otherwise. Orders, assignments, documents and stage owners reference parties, so every
//            permission check that compares `req.user.id` with one of those keeps working for the
//            whole team unchanged. requireAuth sets `req.user.id` to this.
import { ensureOrgForUser, isPartyRole } from './orgs.js'
import { platformMode } from './platform.js'

/** Resolve a user document (lean) to the identity a request runs as. Creates the org on first sight. */
export async function identityFor(dbUser) {
  const actorId = String(dbUser._id)
  if (!isPartyRole(dbUser.role)) return { id: actorId, actorId, orgId: null }
  const org = await ensureOrgForUser(dbUser)
  const isMember = dbUser.orgRole === 'member'
  return {
    id: isMember && org?.ownerUserId ? String(org.ownerUserId) : actorId,
    actorId,
    orgId: org ? String(org._id) : null,
    orgRole: dbUser.orgRole || 'owner',
    orgType: org?.type ?? null,
    orgActive: org ? org.isActive !== false : false,
    tradioEnabled: !!org?.tradioEnabled,
    tradioCanView: org ? org.tradioCanView !== false : true,
  }
}

/** The user object the frontend receives from /login and /me. Never includes secrets. */
export function publicUser(u) {
  return {
    id: u.id, actorId: u.actorId ?? u.id,
    email: u.email, role: u.role, adminType: u.adminType ?? null,
    name: u.name, company: u.company, code: u.code, mustChangePw: !!u.mustChangePw,
    // Which product this deployment is, so the UI can mirror the server's rules (what a brand or
    // manufacturer may create, whether Tradio staff are viewers). The server stays the real gate.
    platformMode: platformMode(),
    ...(u.orgId ? {
      orgId: u.orgId, orgRole: u.orgRole, orgType: u.orgType,
      tradioEnabled: !!u.tradioEnabled, tradioCanView: u.tradioCanView !== false,
    } : {}),
    ...(u.viewAsBy ? { viewAsBy: u.viewAsBy, viewAsByName: u.viewAsByName, actingFor: !!u.actingFor } : {}),
  }
}
