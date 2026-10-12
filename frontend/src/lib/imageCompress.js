// Shrinks big photos in the browser before they are uploaded. A phone camera photo is easily 3 to 8 MB
// and the upload limit is 10 MB, and factory staff are often on mobile data. Everything here fails
// safe: a file that is not a photo, is small already, or can't be processed comes back untouched.

/**
 * The size to draw an image at so its longest edge is at most `maxEdge`. Pure.
 * Never scales up, rounds to whole pixels, and never returns less than 1px on a side.
 * Unusable input (no width or height) gives { width: 0, height: 0 }; an unusable `maxEdge`
 * means "no limit".
 */
export function fitWithin(width, height, maxEdge) {
  const w = Number(width)
  const h = Number(height)
  if (!(w > 0) || !(h > 0)) return { width: 0, height: 0 }
  const longest = Math.max(w, h)
  const scale = maxEdge > 0 && longest > maxEdge ? maxEdge / longest : 1
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) }
}

/** `name` with its extension swapped for .jpg ("IMG_0012.PNG" -> "IMG_0012.jpg", "scan" -> "scan.jpg"). */
export function jpgName(name) {
  const base = String(name || '').replace(/\.[^./\\]+$/, '')
  return `${base || 'image'}.jpg`
}

// A JPEG re-encode would flatten an animation or turn a drawing into pixels, so these pass through.
const PASS_THROUGH = new Set(['image/gif', 'image/svg+xml'])

// Decode to something drawImage accepts. createImageBitmap applies the photo's EXIF rotation (a phone
// held upright records the picture sideways plus a rotate flag); a browser that lacks it, or rejects
// the option, gets a plain <img>, which modern browsers also draw upright.
async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close?.() }
    } catch { /* fall through to the <img> route */ }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => resolve({ source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(url) })
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('The image could not be decoded.')) }
    img.src = url
  })
}

// The compressed bytes as a File named like the original. If the type changed (a PNG became a JPEG)
// the extension follows it.
function asFile(blob, original) {
  const name = original.type === 'image/jpeg' ? (original.name || 'image.jpg') : jpgName(original.name)
  try {
    return new File([blob], name, { type: 'image/jpeg', lastModified: original.lastModified || Date.now() })
  } catch {
    return blob
  }
}

/**
 * Scale a photo down so its longest edge is at most `maxEdge`, re-encode it as JPEG, and return
 * whichever of the original and the result is smaller. Resolves with the ORIGINAL file, untouched,
 * if it is not an image, is under `minBytes`, or anything at all goes wrong.
 *
 * @param {File|Blob} file
 * @param {{ maxEdge?: number, quality?: number, minBytes?: number }} [opts]
 * @returns {Promise<File|Blob>}
 */
export async function compressImage(file, { maxEdge = 1600, quality = 0.8, minBytes = 600 * 1024 } = {}) {
  try {
    if (!file || typeof file.type !== 'string' || !file.type.startsWith('image/') || PASS_THROUGH.has(file.type)) return file
    if (!(file.size >= minBytes)) return file
    const img = await decode(file)
    try {
      const { width, height } = fitWithin(img.width, img.height, maxEdge)
      if (!width || !height) return file
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) return file
      // JPEG has no transparency: without a white base a transparent PNG would turn black.
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, width, height)
      ctx.drawImage(img.source, 0, 0, width, height)
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality))
      // Hand the pixel memory back now: iOS Safari keeps canvases alive long after they are unused.
      canvas.width = 0
      canvas.height = 0
      if (!blob || blob.size >= file.size) return file
      return asFile(blob, file)
    } finally {
      img.release()
    }
  } catch {
    return file
  }
}
