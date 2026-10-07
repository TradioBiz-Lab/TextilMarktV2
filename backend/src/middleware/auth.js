import jwt from 'jsonwebtoken'
import { User } from '../db/index.js'
import { requestContext } from '../lib/requestContext.js'

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
    const dbUser = await User.findById(req.user.id, 'isActive passwordChangedAt role adminType company name email code mustChangePw').lean()
    if (!dbUser || !dbUser.isActive) return res.status(401).json({ error: 'Unauthorized' })
    if (dbUser.passwordChangedAt && req.user.iat) {
      if (req.user.iat * 1000 < dbUser.passwordChangedAt.getTime()) {
        return res.status(401).json({ error: 'Session expired — please log in again' })
      }
    }
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
  } catch {
    return res.status(500).json({ error: 'Server error' })
  }

  // A user holding a temporary password may do nothing but change it. This used to be enforced
  // only by the frontend, so the full API stayed open to anyone who skipped that screen.
  if (req.user.mustChangePw && !MUST_CHANGE_PW_ALLOWED.has(req.originalUrl.split('?')[0].replace(/\/+$/, ''))) {
    return res.status(403).json({ error: 'You must change your temporary password first', code: 'MUST_CHANGE_PW' })
  }

  // Everything after this point (handlers, model hooks) can see who is really acting.
  return requestContext.run({ viewAsBy: req.user.viewAsBy || null, viewAsByName: req.user.viewAsByName || null }, next)
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
