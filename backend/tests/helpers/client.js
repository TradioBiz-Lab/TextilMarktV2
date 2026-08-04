// HTTP client over the real Express app.
//
// Binds port 0 (kernel-assigned) so parallel suites never collide, and talks to
// it with global fetch — no supertest, keeping the backend's dependency list as
// short as it already is.

import jwt from 'jsonwebtoken'

let server = null
let baseUrl = null

export async function startServer() {
  if (server) return baseUrl
  // Imported lazily: app.js reads env at module scope, so startTestDb() must
  // have run first.
  const { default: app } = await import('../../src/app.js')
  await new Promise(resolve => {
    server = app.listen(0, resolve)
  })
  baseUrl = `http://127.0.0.1:${server.address().port}`
  return baseUrl
}

export async function stopServer() {
  if (!server) return
  await new Promise(resolve => server.close(resolve))
  server = null
  baseUrl = null
}

/**
 * Mint a token for a user document directly, matching the payload the login
 * route signs. Skips bcrypt, which would otherwise dominate suite runtime.
 */
export function tokenFor(user) {
  return jwt.sign({
    id: user._id.toString(),
    email: user.email,
    role: user.role,
    adminType: user.adminType,
    name: user.name,
    company: user.company,
    code: user.code,
    mustChangePw: user.mustChangePw,
  }, process.env.JWT_SECRET, { expiresIn: '60m' })
}

/**
 * @returns {{status: number, body: any}} — body is parsed JSON, or raw text
 * when the response isn't JSON (404 HTML, empty bodies).
 */
export async function req(method, path, { token, body } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      // Mirrors the frontend, which sends text/plain to dodge the CORS
      // preflight; express.json() is configured to parse both.
      'Content-Type': 'text/plain;charset=UTF-8',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  let parsed
  try { parsed = text ? JSON.parse(text) : null } catch { parsed = text }
  return { status: res.status, body: parsed }
}

/** Bind a token once and get {get, post} that carry it. */
export function as(user) {
  const token = tokenFor(user)
  return {
    token,
    get:  (path)       => req('GET',  path, { token }),
    post: (path, body) => req('POST', path, { token, body }),
  }
}
