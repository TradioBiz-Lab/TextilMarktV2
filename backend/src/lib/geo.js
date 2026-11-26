// Where a factory is, and how far a phone was from it. Pure: nothing here fetches a pasted link.

const inRange = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
const NUM = '(-?\\d{1,3}(?:\\.\\d+)?)'
const PAIR = new RegExp(`^\\s*${NUM}\\s*[, ]\\s*${NUM}\\s*$`)
// In a Google Maps link, in order of trust: the place's own pin (!3d..!4d..), a q/query/ll/destination pair, then the
// centre of the view (@lat,lng), which is only roughly where the place is.
const IN_LINK = [
  new RegExp(`!3d${NUM}!4d${NUM}`),
  new RegExp(`[?&](?:q|query|ll|destination|daddr)=(?:loc:)?${NUM}(?:,|%2C)\\s*${NUM}`, 'i'),
  new RegExp(`@${NUM},${NUM}`),
]

export const mapsUrlFor = (lat, lng) => `https://www.google.com/maps?q=${lat},${lng}`

/** Whether lat and lng are real coordinates. */
export const validLatLng = (lat, lng) => typeof lat === 'number' && typeof lng === 'number' && inRange(lat, lng)

/**
 * Reads a location someone pasted: "26.9124, 75.7873" or a full Google Maps link.
 * Returns null for nothing, { lat, lng, mapsUrl } when read, or { error } when it cannot be.
 * The link kept is always one built from the coordinates, never the pasted text.
 */
export function parseMapsLocation(text) {
  if (text === undefined || text === null) return null
  if (typeof text !== 'string') return { error: 'Location must be a Google Maps link or "latitude, longitude"' }
  const t = text.trim()
  if (!t) return null
  if (t.length > 2000) return { error: 'That location is too long' }
  const done = (a, b) => {
    const lat = Number(a), lng = Number(b)
    if (!inRange(lat, lng)) return { error: 'Those coordinates are not a real place (latitude -90 to 90, longitude -180 to 180)' }
    const r = n => Math.round(n * 1e6) / 1e6
    return { lat: r(lat), lng: r(lng), mapsUrl: mapsUrlFor(r(lat), r(lng)) }
  }
  const pair = t.match(PAIR)
  if (pair) return done(pair[1], pair[2])
  if (/^https?:\/\/(maps\.app\.goo\.gl|goo\.gl|g\.co)\//i.test(t))
    return { error: 'A short Maps link does not carry the location. Open it, then paste the full link from the address bar, or paste "latitude, longitude"' }
  if (/^https?:\/\//i.test(t)) {
    for (const re of IN_LINK) { const m = t.match(re); if (m) return done(m[1], m[2]) }
    return { error: 'No location found in that link. Paste the full Google Maps link, or "latitude, longitude"' }
  }
  return { error: 'Location must be a Google Maps link or "latitude, longitude"' }
}

/** Metres between two { lat, lng } points (haversine), or null when either is missing. */
export function distanceM(a, b) {
  if (!a || !b || !inRange(a.lat, a.lng) || !inRange(b.lat, b.lng)) return null
  const rad = d => (d * Math.PI) / 180
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2
  return Math.round(2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h))))
}

// A reading further than this from the factory's pin, beyond its own accuracy, is marked "away" for admins. It is never
// refused: GPS inside a shed can be 100 m off.
export const AWAY_METRES = 300
export const isAway = point => point?.distanceM != null && point.distanceM > AWAY_METRES + (point.accuracy || 0)

/**
 * What a phone sent with a tap: { lat, lng, accuracy?, deviceAt? } -> a clean point, or { error }.
 * Location is required: a check-in with no position is refused.
 */
export function cleanPoint(body) {
  const lat = body?.lat, lng = body?.lng
  if (!validLatLng(lat, lng)) return { error: 'Location is needed. Turn on location on the phone and try again.', code: 'LOCATION_REQUIRED' }
  let accuracy = null
  if (body.accuracy !== undefined && body.accuracy !== null) {
    if (typeof body.accuracy !== 'number' || !Number.isFinite(body.accuracy) || body.accuracy < 0) return { error: 'Invalid location accuracy' }
    accuracy = Math.min(Math.round(body.accuracy), 100000)
  }
  let deviceAt = null
  if (body.deviceAt !== undefined && body.deviceAt !== null) {
    const d = typeof body.deviceAt === 'string' || typeof body.deviceAt === 'number' ? new Date(body.deviceAt) : null
    if (!d || isNaN(d.getTime())) return { error: 'Invalid device time' }
    deviceAt = d
  }
  const r = n => Math.round(n * 1e6) / 1e6
  return { point: { lat: r(lat), lng: r(lng), accuracy, deviceAt } }
}

const IST_MS = 5.5 * 60 * 60 * 1000
/** The calendar day in India (YYYY-MM-DD) of a moment. */
export const dayIST = (d = new Date()) => new Date(new Date(d).getTime() + IST_MS).toISOString().slice(0, 10)
/** The moment a day in India starts (YYYY-MM-DD -> Date), or null. */
export const startOfDayIST = day => {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
  const d = new Date(`${day}T00:00:00.000Z`)
  return isNaN(d.getTime()) ? null : new Date(d.getTime() - IST_MS)
}
