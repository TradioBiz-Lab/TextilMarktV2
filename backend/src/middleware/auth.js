import jwt from 'jsonwebtoken'
import { User } from '../db/index.js'

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
    const dbUser = await User.findById(req.user.id, 'isActive passwordChangedAt').lean()
    if (!dbUser || !dbUser.isActive) return res.status(401).json({ error: 'Unauthorized' })
    if (dbUser.passwordChangedAt && req.user.iat) {
      if (req.user.iat * 1000 < dbUser.passwordChangedAt.getTime()) {
        return res.status(401).json({ error: 'Session expired — please log in again' })
      }
    }
  } catch {
    return res.status(500).json({ error: 'Server error' })
  }

  next()
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
