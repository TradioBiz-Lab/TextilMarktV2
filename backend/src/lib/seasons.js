// Seasons are the customer's own (Cocoblu buys H1 and H2, Fitleasure by line), not one fixed SS/FW list. A customer
// with no list of its own uses the standard one. A season is a short code because it goes into master order and
// style ids (MO-CBNB-H1-001): letters, digits and hyphens, up to 10 characters, stored in capitals.
import { User } from '../models/User.js'

export const DEFAULT_SEASONS = ['SS26', 'FW26', 'SS27', 'FW27', 'SS28']
export const SEASON_RE = /^[A-Z0-9][A-Z0-9-]{0,9}$/

/** A season list from the form ("H1, H2" or ['H1', 'H2']): { list } or { error }. An empty list clears it. */
export function parseSeasonList(value) {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,\n]/) : null
  if (!raw) return { error: 'Seasons must be a list' }
  const list = [...new Set(raw.map(s => String(s).trim().toUpperCase()).filter(Boolean))]
  if (list.length > 30) return { error: 'At most 30 seasons' }
  const bad = list.find(s => !SEASON_RE.test(s))
  if (bad) return { error: `"${bad}" is not a season code: use letters, digits and hyphens, up to 10 characters (for example H1 or SS27)` }
  return { list }
}

export const seasonListOf = user => (user?.seasons?.length ? user.seasons : DEFAULT_SEASONS)

/**
 * Why `season` cannot be used for this customer, or null when it can. The value already on the record
 * (`current`) always stays allowed, so taking a season off the list never breaks an existing order.
 */
export async function seasonError(buyerId, season, current = null) {
  if (season == null || season === '' || season === current) return null
  const buyer = await User.findById(buyerId, 'seasons').lean()
  const list = seasonListOf(buyer)
  return list.includes(season) ? null : `Invalid season. This customer's seasons are: ${list.join(', ')}`
}
