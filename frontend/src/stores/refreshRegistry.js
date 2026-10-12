// A small switchboard between the live feed and the feature stores. A store registers a refresh
// function under a key ("materials", "invoices"); when the feed reports that resource changed,
// LiveRefresh calls bump(key) and the store refetches. No React, no dependencies.

const DEBOUNCE_MS = 250
const refreshers = new Map() // key -> refresh function
const timers = new Map() // key -> pending timeout

/** Register `fn` as the refresher for `key`. Returns a function that unregisters it. */
export function register(key, fn) {
  refreshers.set(key, fn)
  return function unregister() {
    // Remove only our own registration: a store that remounted has already replaced it.
    if (refreshers.get(key) !== fn) return
    refreshers.delete(key)
    clearTimeout(timers.get(key))
    timers.delete(key)
  }
}

/**
 * Ask the refresher registered under `key` to run. Debounced per key: bumps that land within 250ms
 * of each other become one refresh, 250ms after the last. Does nothing if no refresher is registered.
 */
export function bump(key) {
  if (!refreshers.has(key)) return
  clearTimeout(timers.get(key))
  timers.set(key, setTimeout(() => {
    timers.delete(key)
    const fn = refreshers.get(key) // whoever is registered when the timer fires, not when it was set
    if (!fn) return
    try {
      const result = fn()
      if (result && typeof result.catch === 'function') result.catch(() => {})
    } catch { /* one failing store must not stop the others; stores report their own errors */ }
  }, DEBOUNCE_MS))
}

/** bump() every registered key. */
export function bumpAll() {
  for (const key of [...refreshers.keys()]) bump(key)
}

/**
 * The keys whose version moved between two polls of the feed's `versions` map. A key seen for the
 * first time counts as moved; a key that has gone does not. With no previous map (the first poll)
 * nothing has moved yet, which is what makes the first poll a baseline rather than a change.
 */
export function changedVersionKeys(prev, next) {
  if (!prev || !next || typeof next !== 'object' || Array.isArray(next)) return []
  return Object.keys(next).filter(k => next[k] !== prev[k])
}
