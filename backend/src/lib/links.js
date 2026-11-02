// Web links typed into a style (the e-commerce listing, the tech pack). They are shown to buyers and factories as
// clickable links, so each must be a real http(s) address: anything else (javascript:, data:, ...) is refused rather
// than rendered. People paste "amazon.in/x" without the scheme, so a bare web address gets https:// added; anything
// that already names a scheme is left alone so a javascript: or data: link still fails validation.
// An Amazon product link as it is copied from the browser is long: the product's title, tracking (ref=, crid=, dib=, qid=,
// sprefix=), the colour or size picked (th=1&psc=1). Only the ASIN identifies the product, so it is kept as the short form
// https://www.amazon.<site>/dp/<ASIN>. Anything that is not an Amazon product page (a search, a shop page, another site, an
// amzn.in short link) is left exactly as it was. Keep in step with frontend/src/links.js.
const AMAZON_HOST = /(?:^|\.)(amazon\.(?:co\.|com\.)?[a-z]{2,3})$/i
const AMAZON_ASIN = /\/(?:dp|gp\/product|gp\/aw\/d|exec\/obidos\/ASIN|product)\/([A-Z0-9]{10})(?:\/|$)/i
export function shortenAmazonLink(url) {
  try {
    const u = new URL(String(url))
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return url
    const host = AMAZON_HOST.exec(u.hostname)
    const asin = host && AMAZON_ASIN.exec(u.pathname)
    return asin ? `https://www.${host[1].toLowerCase()}/dp/${asin[1].toUpperCase()}` : url
  } catch { return url }
}

export const normalizeLink = v => {
  const t = String(v ?? '').trim()
  if (!t) return t
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return shortenAmazonLink(t)
  return shortenAmazonLink(/^[\w-]+(\.[\w-]+)+(:\d+)?([/?#]\S*)?$/.test(t) ? `https://${t}` : t)
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
