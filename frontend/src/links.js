// Shortens a pasted Amazon product link to https://www.amazon.<site>/dp/<ASIN>, dropping the title, tracking and the
// colour or size picked (th=1&psc=1). Anything that is not an Amazon product page is returned as it was. The server does the
// same on save (backend/src/lib/links.js: keep the two in step); this is so the box shows the short link as soon as it is pasted.
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

/** What a link box should hold after the person typed or pasted `value`: the short form when it is an Amazon product link, else unchanged. */
export function autoShortenLink(value) {
  const t = String(value ?? '').trim()
  // A link pasted without https:// ("www.amazon.in/...") is still shortened, the way the server reads it (normalizeLink).
  const s = shortenAmazonLink(/^[\w-]+(\.[\w-]+)+(:\d+)?([/?#]\S*)?$/.test(t) ? `https://${t}` : t)
  return s !== t ? s : value
}
