import 'dotenv/config'
import crypto from 'node:crypto'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import cookieParser from 'cookie-parser'
import rateLimit from 'express-rate-limit'
import mongoose from 'mongoose'
import { connectDB } from './db/index.js'
import { sanitizeBody } from './middleware/auth.js'
import authRouter          from './routes/auth.js'
import ordersRouter        from './routes/orders.js'
import documentsRouter     from './routes/documents.js'
import usersRouter         from './routes/users.js'
import notificationsRouter from './routes/notifications.js'
import auditRouter         from './routes/audit.js'
import ribbonsRouter       from './routes/ribbons.js'
import masterOrdersRouter  from './routes/masterOrders.js'
import signupRouter         from './routes/signup.js'

// ── Validate required env vars at startup ──────────────────────────────────
const isProd = process.env.NODE_ENV === 'production'
const REQUIRED_ENV = ['JWT_SECRET', 'MONGO_DB_URI']
if (isProd) REQUIRED_ENV.push('FRONTEND_URL')
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`[FATAL] Missing required environment variable: ${key}`)
    process.exit(1)
  }
}
if (process.env.JWT_SECRET === 'change_this_to_a_long_random_secret_key') {
  if (isProd) {
    console.error('[FATAL] JWT_SECRET must not use the default placeholder in production')
    process.exit(1)
  }
  console.warn('[WARN] JWT_SECRET is set to the default placeholder — change before deploying to production')
}
if (!process.env.RESEND_API_KEY) {
  console.warn('[WARN] RESEND_API_KEY not set — all emails will be silently skipped')
}

const app = express()

// ── Security headers ────────────────────────────────────────────────────────
app.use(helmet({
  crossOriginEmbedderPolicy: false, // allow embedded iframes (PDF viewer)
  contentSecurityPolicy: isProd ? {
    directives: {
      defaultSrc:    ["'self'"],
      scriptSrc:     ["'self'", "'unsafe-inline'"], // React inline scripts in SPA
      styleSrc:      ["'self'", "'unsafe-inline'"],
      imgSrc:        ["'self'", 'data:', 'blob:'],
      connectSrc:    ["'self'"],
      fontSrc:       ["'self'", 'data:'],
      objectSrc:     ["'none'"],
      frameSrc:      ["'self'", 'blob:'],
      upgradeInsecureRequests: isProd ? [] : null,
    },
  } : false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  hsts: isProd ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
}))
app.use(cookieParser())

// ── CORS ────────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  ...(isProd ? [] : ['http://localhost:5173', 'http://127.0.0.1:5173']),
  ...(process.env.FRONTEND_URL ? [process.env.FRONTEND_URL] : []),
]
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true)
    cb(new Error('CORS: origin not allowed'))
  },
  credentials: true,
}))

// ── Request ID — attach a unique ID to every request for log correlation ──
app.use((req, _res, next) => {
  req.id = crypto.randomUUID()
  next()
})

// ── Trust proxy — required when behind Render/Vercel reverse proxy ──────────
// Without this, req.ip is always the proxy IP and rate-limit keys are useless
if (isProd) app.set('trust proxy', 1)

// ── Global rate limiter ─────────────────────────────────────────────────────
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isProd ? 500 : 2000,
  standardHeaders: true,
  legacyHeaders: false,
  skip: req => req.path === '/api/health',
  validate: false,
}))

// 14 MB ceiling: 10 MB file → ~13.4 MB base64 + headers
app.use(express.json({ limit: '14mb' }))
app.use(express.urlencoded({ extended: true, limit: '14mb' }))
app.use(sanitizeBody)

// ── Request logging — never log Authorization headers or body passwords ─────
const SENSITIVE_FIELDS = new Set(['password', 'currentPassword', 'newPassword', 'passwordHash', 'Authorization'])

function redact(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 3) return obj
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    out[k] = SENSITIVE_FIELDS.has(k) ? '[REDACTED]' : redact(v, depth + 1)
  }
  return out
}

app.use((req, res, next) => {
  const start = Date.now()
  res.on('finish', () => {
    const ms = Date.now() - start
    const slow = ms > 3000
    const isError = res.statusCode >= 400
    if (!isProd || slow || isError) {
      const entry = {
        id:     req.id,
        ts:     new Date().toISOString(),
        method: req.method,
        path:   req.originalUrl,
        status: res.statusCode,
        ms,
        ip:     req.ip,
        ...(isError && req.body && Object.keys(req.body).length
          ? { body: redact(req.body) }
          : {}),
        ...(slow ? { slow: true } : {}),
      }
      const line = JSON.stringify(entry)
      if (isError) console.error(line)
      else         console.log(line)
    }
  })
  next()
})

// ── Routes ──────────────────────────────────────────────────────────────────
app.use('/api/auth',          authRouter)
app.use('/api/orders',        ordersRouter)
app.use('/api/documents',     documentsRouter)
app.use('/api/users',         usersRouter)
app.use('/api/notifications', notificationsRouter)
app.use('/api/audit',         auditRouter)
app.use('/api/ribbons',       ribbonsRouter)
app.use('/api/master-orders', masterOrdersRouter)
app.use('/api/signup',        signupRouter)

// ── Health check ────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  const dbState = mongoose.connection.readyState // 0=disconnected,1=connected,2=connecting,3=disconnecting
  const dbOk = dbState === 1
  const status = dbOk ? 200 : 503
  res.status(status).json({
    ok:     dbOk,
    db:     dbOk ? 'connected' : 'unavailable',
    uptime: Math.floor(process.uptime()),
  })
})

// ── 404 handler ─────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' })
})

// ── Global error handler ─────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error(JSON.stringify({
    id:     req.id,
    ts:     new Date().toISOString(),
    event:  'unhandled_error',
    error:  err.message,
    path:   req.originalUrl,
    method: req.method,
    ...(!isProd ? { stack: err.stack } : {}),
  }))
  res.status(err.status || 500).json({
    error: isProd ? 'Internal server error' : err.message,
  })
})

// ── Process safety net ───────────────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  console.error(JSON.stringify({ ts: new Date().toISOString(), event: 'unhandledRejection', reason: String(reason) }))
})
process.on('uncaughtException', (err) => {
  console.error(JSON.stringify({ ts: new Date().toISOString(), event: 'uncaughtException', error: err.message }))
  process.exit(1)
})

// ── Start ────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT, 10) || 3001

connectDB()
  .then(() => {
    const server = app.listen(PORT, () => {
      console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'server_start', port: PORT, env: isProd ? 'production' : 'development' }))
    })

    const shutdown = (signal) => {
      console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'shutdown', signal }))
      server.close(async () => {
        await mongoose.disconnect().catch(() => {})
        console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'shutdown_complete' }))
        process.exit(0)
      })
      // Force kill after 10 s if graceful close stalls
      setTimeout(() => {
        console.error(JSON.stringify({ ts: new Date().toISOString(), event: 'forced_shutdown' }))
        process.exit(1)
      }, 10000).unref()
    }
    process.on('SIGTERM', () => shutdown('SIGTERM'))
    process.on('SIGINT',  () => shutdown('SIGINT'))
  })
  .catch(err => {
    console.error(JSON.stringify({ ts: new Date().toISOString(), event: 'db_connect_failed', error: err.message }))
    process.exit(1)
  })

export default app
