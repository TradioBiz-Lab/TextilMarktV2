// What the voice services last refused, kept in memory so a deploy can be checked from outside (GET /api/health) without
// signing in: which service, the HTTP status, and the service's own short reason code. Never the key, never the text.
const last = { listen: null, speak: null }
// The same for Kriyaa's own answer (the AI call): what the AI service last refused, as a status and its error type.
let assistant = null

/** Remembers a failed call. `err.detail` is the service's reply; only a short code is kept from it. */
export function noteVoiceProblem(kind, service, err) {
  const status = Number((/\((\d{3})\)/.exec(err?.message || '') || [])[1]) || null
  let code = null
  try { const d = JSON.parse(err?.detail || '{}'); code = d?.detail?.status || d?.detail?.code || d?.error?.code || null } catch { /* not JSON: no code */ }
  last[kind] = { service, status, code: code ? String(code).slice(0, 60) : null, at: new Date().toISOString() }
}
export function clearVoiceProblem(kind) { last[kind] = null }
export const voiceProblems = () => ({ ...last })

/** Remembers a failed AI call of the assistant: the HTTP status and the service's error type, nothing else. */
export function noteAssistantProblem(err) {
  const type = err?.error?.error?.type || err?.error?.type || err?.type || err?.name || null
  assistant = { status: Number(err?.status) || null, code: type ? String(type).slice(0, 60) : null, at: new Date().toISOString() }
}
export function clearAssistantProblem() { assistant = null }
export const assistantProblem = () => assistant

