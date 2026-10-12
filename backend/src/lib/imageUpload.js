// Checking a photo sent as a data URL. The type a browser declares is only a claim, so the first bytes
// are read too: a text/html payload dressed up as an image is refused before it is stored.
export const MAX_PHOTO_BYTES = 4 * 1024 * 1024

const SIGNATURES = {
  'image/jpeg': b => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': b => b.length >= 4 && b[0] === 0x89 && b.subarray(1, 4).toString('latin1') === 'PNG',
  'image/webp': b => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
}
const HEAD = /^data:(image\/(?:jpeg|png|webp));base64,/i

/**
 * @returns {{ ok: true, mimeType: string, size: number } | { ok: false, error: string }}
 */
export function checkPhoto(dataUrl, declaredMime) {
  if (typeof dataUrl !== 'string') return { ok: false, error: 'Send the photo as a data URL' }
  const head = HEAD.exec(dataUrl.slice(0, 40))
  if (!head) return { ok: false, error: 'Only JPG, PNG or WebP photos are allowed' }
  const mimeType = head[1].toLowerCase()
  if (declaredMime && String(declaredMime).toLowerCase() !== mimeType) return { ok: false, error: 'The photo does not match its declared type' }
  const b64 = dataUrl.slice(head[0].length)
  const size = Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0)
  if (size <= 0) return { ok: false, error: 'The photo is empty' }
  if (size > MAX_PHOTO_BYTES) return { ok: false, error: 'The photo is too large (most 4 MB). Try again at a lower quality' }
  if (!SIGNATURES[mimeType](Buffer.from(b64.slice(0, 32), 'base64'))) return { ok: false, error: 'The photo contents do not match its declared type' }
  return { ok: true, mimeType, size }
}

export const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024

/**
 * A photo, or a PDF, of a document a person wants read (a challan or an invoice). Same checks as a photo, plus PDF,
 * with a larger size limit.
 * @returns {{ ok: true, mimeType: string, size: number, buffer: Buffer } | { ok: false, error: string }}
 */
export function checkDocumentFile(dataUrl) {
  if (typeof dataUrl !== 'string') return { ok: false, error: 'Send the document as a data URL' }
  const head = /^data:(image\/(?:jpeg|png|webp)|application\/pdf);base64,/i.exec(dataUrl.slice(0, 40))
  if (!head) return { ok: false, error: 'Only a photo (JPG, PNG, WebP) or a PDF can be read' }
  const mimeType = head[1].toLowerCase()
  const b64 = dataUrl.slice(head[0].length)
  const size = Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0)
  if (size <= 0) return { ok: false, error: 'The file is empty' }
  if (size > MAX_DOCUMENT_BYTES) return { ok: false, error: 'The file is too large (most 8 MB). Try a lower quality photo' }
  const buffer = Buffer.from(b64, 'base64')
  const sniff = mimeType === 'application/pdf' ? buffer.subarray(0, 4).toString('latin1') === '%PDF' : SIGNATURES[mimeType](buffer.subarray(0, 32))
  if (!sniff) return { ok: false, error: 'The file contents do not match its type' }
  return { ok: true, mimeType, size, buffer }
}
