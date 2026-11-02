// Web links typed into a style (the e-commerce listing, the tech pack). They are shown to buyers and factories as
// clickable links, so each must be a real http(s) address: anything else (javascript:, data:, ...) is refused rather
// than rendered. People paste "amazon.in/x" without the scheme, so a bare web address gets https:// added; anything
// that already names a scheme is left alone so a javascript: or data: link still fails validation.
export const normalizeLink = v => {
  const t = String(v ?? '').trim()
  if (!t || /^[a-z][a-z0-9+.-]*:/i.test(t)) return t
  return /^[\w-]+(\.[\w-]+)+(:\d+)?([/?#]\S*)?$/.test(t) ? `https://${t}` : t
}

export const isHttpUrl = v => { try { const u = new URL(String(v)); return u.protocol === 'http:' || u.protocol === 'https:' } catch { return false } }

/** A web link as stored, or { error } naming `label`. Blank is allowed. */
export const cleanLink = (v, label) => {
  if (v === undefined || v === null) return { link: '' }
  if (typeof v !== 'string') return { error: `${label} must be text` }
  const link = normalizeLink(v)
  if (link.length > 2000) return { error: `${label} too long` }
  if (link && !isHttpUrl(link)) return { error: `${label} must be a full web address starting with http:// or https://` }
  return { link }
}
