import { createContext, useContext, useEffect, useRef, useState } from 'react'

// What each screen remembers for the history entry it was opened in, so Back (the in-app button or the browser's) returns
// to the screen as it was left: the filter, the search, the tab, which groups were open. App.jsx provides `current`, a
// function that returns the entry being shown; the entry is also where it keeps the scroll position.
export const NavEntryContext = createContext(null)

/**
 * `useState` for the parts of a screen worth coming back to. The value is read from the history entry when the screen
 * opens (a fresh visit has none, so `initial` is used) and written back on every change. `initial` may be a function.
 */
export function useNavState(key, initial) {
  const current = useContext(NavEntryContext)
  const entry = useRef(undefined)
  if (entry.current === undefined) entry.current = (current && current()) || null
  const [value, setValue] = useState(() => {
    const saved = entry.current?.ui?.[key]
    if (saved !== undefined) return saved
    return typeof initial === 'function' ? initial() : initial
  })
  useEffect(() => {
    const e = entry.current
    if (e) { if (!e.ui) e.ui = {}; e.ui[key] = value }
  }, [key, value])
  return [value, setValue]
}
