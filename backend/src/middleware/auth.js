import jwt from 'jsonwebtoken'
import { User } from '../db/index.js'
import { requestContext } from '../lib/requestContext.js'
import { identityFor } from '../lib/session.js'
import { isStandalone } from '../lib/platform.js'

// ── NoSQL injection protection: strip $ keys from req.body ──
function sanitizeValue(val) {
  if (val === null || val === undefined) return val
  if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') return val
  if (Array.isArray(val)) return val.map(sanitizeValue)
  if (typeof val === 'object') {
    const clean = {}
    for (const [k, v] of Object.entries(val)) {
      if (k.startsWith('$')) continue // strip MongoDB operators
      clean[k] = sanitizeValue(v)
    }
    return clean
  }
  return val
}

export function sanitizeBody(req, res, next) {
  if (req.body && typeof req.body === 'object') {
    req.body = sanitizeValue(req.body)
  }
  next()
}

const MUST_CHANGE_PW_ALLOWED = new Set(['/api/auth/change-password', '/api/auth/me'])

// In the standalone product a master admin looking at an account ("view as") can read but not
// change anything, unless acting for a Tradio-enabled manufacturer. Every write in this API is a
// POST, so a method check is the whole rule; these few POSTs only read or end the session, so
// they stay open. Kriyaa's chat is one of them: its read tools work, and its write tools loop back
// through this same check and are refused.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const VIEW_ONLY_ALLOWED_WRITES = /^\/api\/(auth\/view-as(\/|$)|assistant\/chat$|voice\/(transcribe|speak)$)/
const pathOf = req => req.originalUrl.split('?')[0].replace(/\/+$/, '')

export async function requireAuth(req, res, next) {
  // Read token from httpOnly cookie first, fall back to Authorization header
  const header = req.headers.authorization
  const token = req.cookies?.tradio_token
    || (header?.startsWith('Bearer ') ? header.slice(7) : null)

  if (!token) return res.status(401).json({ error: 'Unauthorized' })

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET)
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }

  // Confirm user still exists, is active, and token was issued after last password change
  try {
    const dbUser = await User.findById(req.user.id, 'isActive passwordChangedAt role adminType company name email code mustChangePw orgId orgRole').lean()
    if (!dbUser || !dbUser.isActive) return res.status(401).json({ error: 'Unauthorized' })
    if (dbUser.passwordChangedAt && req.user.iat) {
      if (req.user.iat * 1000 < dbUser.passwordChangedAt.getTime()) {
        return res.status(401).json({ error: 'Session expired - please log in again' })
      }
    }
    // A buyer or manufacturer belongs to an organization. Deactivating the organization signs out
    // everyone on its team at once.
    const ident = await identityFor(dbUser)
    if (ident.orgId && !ident.orgActive) return res.status(401).json({ error: 'Unauthorized' })

    // The database is the authority on who this is and what they may do, not the claims baked into
    // a token up to an hour ago. A demoted or re-assigned user loses access on their next request.
    // (A view-as token keeps its viewAsBy claim; the identity fields are the viewed user's own.)
    req.user.role = dbUser.role
    req.user.adminType = dbUser.adminType ?? null
    req.user.company = dbUser.company
    req.user.name = dbUser.name
    req.user.email = dbUser.email
    req.user.code = dbUser.code
    req.user.mustChangePw = !!dbUser.mustChangePw
    // `id` is the party this person acts as (their organization's primary account for a teammate);
    // `actorId` stays the person. See lib/session.js.
    req.user.id = ident.id
    req.user.actorId = ident.actorId
    if (ident.orgId) {
      req.user.orgId = ident.orgId
      req.user.orgRole = ident.orgRole
      req.user.orgType = ident.orgType
      req.user.tradioEnabled = ident.tradioEnabled
      req.user.tradioCanView = ident.tradioCanView
    }

    if (req.user.viewAsBy) {
      // The master admin behind a view-as session must still be an active master admin; a token
      // minted before they were demoted or deactivated stops working on the next request.
      const viewer = await User.findById(req.user.viewAsBy, 'isActive role adminType').lean()
      if (!viewer || !viewer.isActive || viewer.role !== 'admin' || viewer.adminType !== 'master')
        return res.status(401).json({ error: 'Unauthorized' })

      if (!isStandalone()) {
        // The sandbox's original view-as: full powers as the viewed user.
        req.user.actingFor = true
      } else {
        // Leaving is always allowed, otherwise a company switching its privacy on mid-view would
        // strand the admin on a session that can do nothing.
        if (ident.orgId && !ident.tradioCanView && pathOf(req) !== '/api/auth/view-as/exit')
          return res.status(403).json({ error: 'This organization has turned off Tradio access', code: 'VIEW_BLOCKED' })
        // Acting is honoured only while the viewed account is still an enabled manufacturer.
        req.user.actingFor = !!req.user.actingFor && dbUser.role === 'manufacturer' && ident.tradioEnabled
        if (!req.user.actingFor && !SAFE_METHODS.has(req.method) && !VIEW_ONLY_ALLOWED_WRITES.test(pathOf(req)))
          return res.status(403).json({ error: 'You are viewing this account read-only. Switch on "act for" to make changes.', code: 'VIEW_ONLY' })
      }
    }
  } catch {
    return res.status(500).json({ error: 'Server error' })
  }

  // A user holding a temporary password may do nothing but change it. This used to be enforced
  // only by the frontend, so the full API stayed open to anyone who skipped that screen.
  if (req.user.mustChangePw && !MUST_CHANGE_PW_ALLOWED.has(req.originalUrl.split('?')[0].replace(/\/+$/, ''))) {
    return res.status(403).json({ error: 'You must change your temporary password first', code: 'MUST_CHANGE_PW' })
  }

  // Everything after this point (handlers, model hooks) can see who is really acting.
  return requestContext.run({
    viewAsBy: req.user.viewAsBy || null, viewAsByName: req.user.viewAsByName || null,
    actorId: req.user.actorId, partyId: req.user.id,
  }, next)
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' })
  next()
}

export function requireMaster(req, res, next) {
  if (req.user?.role !== 'admin' || req.user?.adminType !== 'master') {
    return res.status(403).json({ error: 'Master admin only' })
  }
  next()
}
