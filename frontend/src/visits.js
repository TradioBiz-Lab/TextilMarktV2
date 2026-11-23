// Pure helpers for factory visits (the coordinator's check-in and check-out). Times are shown in India time.
const IST_MS = 5.5 * 60 * 60 * 1000
const ist = d => new Date(new Date(d).getTime() + IST_MS)

/** "10:42" in India, or '' for nothing. */
export const timeIST = d => {
  if (!d || isNaN(new Date(d).getTime())) return ''
  const x = ist(d)
  return `${String(x.getUTCHours()).padStart(2, '0')}:${String(x.getUTCMinutes()).padStart(2, '0')}`
}
/** The India calendar day, YYYY-MM-DD. */
export const dayIST = d => (d && !isNaN(new Date(d).getTime()) ? ist(d).toISOString().slice(0, 10) : '')

/** 153 -> "2 h 33 m", 45 -> "45 m", 120 -> "2 h". */
export function durationText(minutes) {
  if (minutes == null || isNaN(minutes)) return ''
  const m = Math.max(0, Math.round(minutes))
  const h = Math.floor(m / 60), r = m % 60
  return h ? (r ? `${h} h ${r} m` : `${h} h`) : `${r} m`
}

/** 420 -> "420 m", 2400 -> "2.4 km". */
export const distanceText = m => (m == null ? '' : m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`)

/**
 * What a factory's card shows: 'open' (he is checked in here), 'blocked' (he is checked in somewhere else),
 * 'done' (visited today, checked out or not), or 'idle'. `last` is today's latest visit here.
 */
export function factoryCardState(visits, factoryId) {
  const id = String(factoryId)
  const open = visits?.open || null
  const last = (visits?.today || []).find(v => String(v.factoryId) === id) || null
  if (open && String(open.factoryId) === id) return { state: 'open', visit: open, last }
  if (open) return { state: 'blocked', visit: open, last }
  return { state: last ? 'done' : 'idle', visit: null, last }
}

/** Visits grouped by India day, newest day first: [{ day, visits }]. */
export function visitsByDay(visits) {
  const m = new Map()
  for (const v of visits || []) {
    const day = dayIST(v.checkIn?.at)
    if (!m.has(day)) m.set(day, [])
    m.get(day).push(v)
  }
  return [...m].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([day, list]) => ({ day, visits: list }))
}
