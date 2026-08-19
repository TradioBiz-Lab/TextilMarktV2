// Shared product-photo validation — extracted from routes/orders.js so
// mfrProjects.js's own image fields (Order Setup Wizard, line items step) don't
// duplicate the same JPEG/PNG-only, 1MB-cap, mutually-exclusive-with-a-link rule.
// Called with the already-resolved next values (an update route merges "unset
// keeps the existing value" itself before calling this — same as both existing
// call sites in orders.js did inline).

export const MAX_PRODUCT_PHOTO_SIZE = 1024 * 1024 // 1MB raw — reference thumbnail, not full-res

/**
 * @returns {{ok: true} | {ok: false, error: string}}
 */
export function validateImagePayload(imageDataUrl, imageUrl) {
  if (imageDataUrl && imageUrl) return { ok: false, error: 'Provide either an uploaded photo or a link, not both' }
  if (imageDataUrl) {
    const m = /^data:(image\/jpeg|image\/jpg|image\/png);base64,(.+)$/.exec(imageDataUrl)
    if (!m) return { ok: false, error: 'Photo must be a JPEG or PNG image' }
    if (m[2].length * 0.75 > MAX_PRODUCT_PHOTO_SIZE) return { ok: false, error: 'Photo too large — keep it under 1MB' }
  }
  if (imageUrl) {
    if (imageUrl.trim().length > 2000) return { ok: false, error: 'Image URL too long' }
    try {
      const u = new URL(imageUrl.trim())
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error()
    } catch {
      return { ok: false, error: 'Invalid image URL — must be a valid http(s) link' }
    }
  }
  return { ok: true }
}
