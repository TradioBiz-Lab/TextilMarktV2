// A coordinator's update before it is sent: shrinking photos on the phone, and keeping an unsent update safe.

/** The size an image is drawn at so its longer side is at most `max` (never enlarged). Pure. */
export function fitWithin(width, height, max = 1280) {
  if (!(width > 0) || !(height > 0)) return { width: 0, height: 0 }
  const scale = Math.min(1, max / Math.max(width, height))
  return { width: Math.round(width * scale), height: Math.round(height * scale) }
}

/**
 * A photo from the phone's camera as a small JPEG data URL (about 150 KB), so it sends on mobile data and does not
 * fill the server. Rejects when the file is not an image the browser can read.
 */
export function shrinkImage(file, { max = 1280, quality = 0.75 } = {}) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      try {
        const { width, height } = fitWithin(img.naturalWidth, img.naturalHeight, max)
        const canvas = document.createElement('canvas')
        canvas.width = width; canvas.height = height
        const ctx = canvas.getContext('2d')
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height)   // a transparent PNG becomes white, not black
        ctx.drawImage(img, 0, 0, width, height)
        resolve(canvas.toDataURL('image/jpeg', quality))
      } catch (e) { reject(e) } finally { URL.revokeObjectURL(url) }
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('not an image')) }
    img.src = url
  })
}

export const MAX_PHOTOS = 6

/**
 * The names a coordinator is likely to say in an update on this style: the client, the product, the factory, the
 * colours and the plan's steps. They go with his recording so they are written correctly (a client's name is the
 * word most often mis-heard). Short ones only, no doubles. Pure.
 */
export function spokenTerms(order, split) {
  const all = [order?.buyerCompany, order?.product, order?.brand, split?.mfrCompany, ...(order?.colourways || []).map(c => c.name),
    ...(order?.sizeBreakup?.rows || []).map(r => r.colour), ...(split?.stages || []).map(s => s.name)]
  const out = []
  for (const t of all) {
    const s = String(t || '').replace(/[<>{}[\]\\()&/,]/g, ' ').replace(/\s+/g, ' ').trim()
    if (!s || s.length > 50 || s.split(' ').length > 5) continue
    if (!out.some(x => x.toLowerCase() === s.toLowerCase())) out.push(s)
  }
  return out.slice(0, 50)
}

// ── The unsent update ──
// Kept on the phone so a failed send, a reload or a closed tab loses nothing. One per product and step. Photos are
// kept only while the whole draft is small; the voice recording is not kept (he can speak again).
export const DRAFT_LIMIT_BYTES = 2 * 1024 * 1024
export const draftKey = (userId, orderId, factoryId, stageIndex) => `tradio_update_draft:${userId}:${orderId}:${factoryId}:${stageIndex}`

/** What is worth keeping of an update being written, or null when there is nothing. Pure. */
export function draftOf({ text = '', photos = [], viaVoice = false } = {}) {
  const t = String(text || '')
  if (!t.trim() && !photos.length) return null
  const sized = photos.reduce((n, p) => n + (p?.length || 0), 0)
  return { text: t, viaVoice: !!viaVoice, photos: sized + t.length <= DRAFT_LIMIT_BYTES ? photos : [], droppedPhotos: sized + t.length > DRAFT_LIMIT_BYTES ? photos.length : 0, at: Date.now() }
}

// A draft older than this is not brought back: it is about a visit that is over.
const DRAFT_MAX_AGE_MS = 18 * 60 * 60 * 1000
export function readDraft(key, now = Date.now()) {
  try {
    const d = JSON.parse(localStorage.getItem(key) || 'null')
    if (!d || typeof d.text !== 'string' || !Array.isArray(d.photos) || !(now - d.at < DRAFT_MAX_AGE_MS)) return null
    return d
  } catch { return null }
}
export function writeDraft(key, state) {
  try {
    const d = draftOf(state)
    if (d) localStorage.setItem(key, JSON.stringify(d)); else localStorage.removeItem(key)
  } catch { /* storage full or off: the update is still on screen */ }
}
export function clearDraft(key) { try { localStorage.removeItem(key) } catch { /* nothing to clear */ } }
