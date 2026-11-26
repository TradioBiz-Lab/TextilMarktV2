// The quality module on the page: choosing the tab and size to measure, the words given to the transcriber, and what a
// measured value means against the sheet. Pure: no React, no network. The server works every difference out again.
export const STAGES = ['fit', 'pp', 'production', 'inline', 'final']

/** The tab to measure against for a stage: the sheet's own tab for it, else the first (Final QC has none of its own). */
export const tabForStage = (tabs, stage) => (tabs || []).find(t => t.stage === stage) || (tabs || [])[0] || null

/** The size to start on: the one the sheet was reviewed in, else the middle of the range. */
export const defaultSize = tab => (tab ? tab.sampleSize || tab.sizes[Math.floor((tab.sizes.length - 1) / 2)] || '' : '')

/** Words that help the transcriber hear the point names: the first few words of each, at most 50, none over 5 words. */
export function keyTerms(tab) {
  const seen = new Set(); const out = []
  for (const p of tab?.points || []) {
    const term = String(p.name).replace(/[^A-Za-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 4).join(' ').slice(0, 50)
    if (term.length < 3 || seen.has(term.toLowerCase())) continue
    seen.add(term.toLowerCase()); out.push(term)
    if (out.length >= 50) break
  }
  return out
}

/** A typed value as a number: "16.5", "16 1/2", "16,5". null for anything else. */
export function parseTyped(v) {
  const s = String(v ?? '').trim().replace(',', '.')
  if (s === '') return null
  const frac = /^(\d+)?\s*(\d+)\s*\/\s*(\d+)$/.exec(s)
  if (frac && Number(frac[3])) return Math.round((Number(frac[1] || 0) + Number(frac[2]) / Number(frac[3])) * 1000) / 1000
  return /^\d+(\.\d+)?$/.test(s) ? Number(s) : null
}

/** The same verdict the server gives: the difference, and whether it is inside tolerance (null when not judged). */
export function judge(spec, tol, measured) {
  if (typeof spec !== 'number' || typeof measured !== 'number' || !Number.isFinite(measured)) return { diff: null, ok: null }
  const diff = Math.round((measured - spec) * 1000) / 1000
  return { diff, ok: typeof tol === 'number' ? Math.abs(diff) <= tol + 1e-9 : null }
}

/** What was read from a recording, laid over what is already filled in: only the points he named change. */
export function mergeRead(values, read) {
  const next = { ...values }
  for (const v of read || []) next[v.index] = String(v.value)
  return next
}

/** How the session stands: how many points have a value, how many are still empty, how many are outside tolerance. */
export function summary(tab, size, values) {
  let filled = 0; let out = 0; let bad = 0
  ;(tab?.points || []).forEach((p, i) => {
    const raw = values[i]; if (raw == null || String(raw).trim() === '') return
    const n = parseTyped(raw); if (n == null) { bad++; return }
    filled++; if (judge(p.values[size], p.tol, n).ok === false) out++
  })
  return { filled, missing: (tab?.points || []).length - filled - bad, out, bad, total: (tab?.points || []).length }
}

/** The points as the server takes them: the index and the measured number, empty ones left out. */
export const pointsPayload = (tab, values) => (tab?.points || []).map((_, i) => ({ index: i, measured: parseTyped(values[i]) })).filter(p => p.measured != null)

/** A number as people read it: no trailing zeros, at most three decimals. */
export const show = n => (typeof n === 'number' ? String(Math.round(n * 1000) / 1000) : n == null ? '' : String(n))

/** What a saved session holds, as the boxes on the page: point index -> the number as text. */
export const valuesOf = session => Object.fromEntries((session?.points || []).map((p, i) => [i, p.measured]).filter(([, m]) => m != null).map(([i, m]) => [i, String(m)]))

/** The unfinished session for a garment (style is implied by the list), or null. */
export const draftFor = (sessions, { mfrId, stage, size }) => (sessions || []).find(s => s.status === 'draft' && s.mfrId === String(mfrId) && s.stage === stage && s.size === size) || null
/** The last finished session for the same garment, to continue from if he wants. */
export const lastDoneFor = (sessions, { mfrId, stage, size }) => (sessions || []).filter(s => s.status !== 'draft' && s.mfrId === String(mfrId) && s.stage === stage && s.size === size).sort((a, b) => new Date(b.at) - new Date(a.at))[0] || null
/** Where to open the page: the unfinished session touched last at this factory, when there is one. */
export const latestDraft = (sessions, mfrId) => (sessions || []).filter(s => s.status === 'draft' && (!mfrId || s.mfrId === String(mfrId))).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0] || null

// A copy on the device, written at once, for when the connection drops between two saves.
export const localKey = (orderId, { mfrId, stage, size }) => `tradio_measure:${orderId}:${mfrId}:${stage}:${size}`
export function readLocal(key) { try { const v = JSON.parse(localStorage.getItem(key) || 'null'); return v && typeof v.values === 'object' ? v : null } catch { return null } }
export function writeLocal(key, values, transcript = '') { try { localStorage.setItem(key, JSON.stringify({ values, transcript, at: Date.now() })) } catch { /* the server copy is the one that counts */ } }
export function clearLocal(key) { try { localStorage.removeItem(key) } catch { /* nothing to clear */ } }
/** What to start from: the device's copy when it is newer than the server's, else the server's, else nothing. */
export function resumeFrom(draft, local) {
  const serverAt = draft ? new Date(draft.updatedAt).getTime() : 0
  if (local && Object.keys(local.values).length && local.at > serverAt) return { values: local.values, transcript: local.transcript || '', from: 'device' }
  return draft ? { values: valuesOf(draft), transcript: '', from: 'server' } : null
}

