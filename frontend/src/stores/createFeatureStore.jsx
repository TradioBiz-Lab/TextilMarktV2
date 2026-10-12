import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { register } from './refreshRegistry.js'

/**
 * One small store per feature, instead of growing the global AppProvider.
 *
 *   const materials = createFeatureStore('materials', { load: () => materialsApi.list(), initial: [] })
 *   // somewhere above the pages that need it:
 *   <materials.Provider> ... </materials.Provider>
 *   // in those pages:
 *   const { items, loading, error, refresh, setItems } = materials.useStore()
 *
 * The Provider loads when it first mounts (so nothing is fetched at login, only when someone opens
 * the feature), registers `refresh` with the refresh registry under `name` so the live feed can
 * trigger it, and unregisters when it unmounts.
 *
 *   items     what `load` last returned (`initial` until the first load finishes)
 *   loading   true while a load is in flight, including the first
 *   error     the Error from the last load, or null. A failed refresh keeps the old items.
 *   refresh   load again now; resolves when done and never rejects (failures land in `error`)
 *   setItems  replace the items directly, for optimistic updates (accepts a value or an updater function)
 */
export function createFeatureStore(name, { load, initial = [] }) {
  const Context = createContext(null)

  function Provider({ children }) {
    const [items, setItems] = useState(initial)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState(null)
    // The latest `load`, so a Provider re-rendered with a fresh inline function still calls the current one.
    const loadRef = useRef(load)
    loadRef.current = load
    // Each load takes a number; only the newest one may write state, and none may after unmount.
    const loadId = useRef(0)

    const refresh = useCallback(async () => {
      const mine = ++loadId.current
      setLoading(true)
      try {
        const next = await loadRef.current()
        if (mine !== loadId.current) return
        setItems(next)
        setError(null)
      } catch (e) {
        if (mine !== loadId.current) return
        setError(e instanceof Error ? e : new Error(String(e)))
      } finally {
        if (mine === loadId.current) setLoading(false)
      }
    }, [])

    useEffect(() => {
      const unregister = register(name, refresh)
      refresh()
      return () => {
        unregister()
        loadId.current++ // anything still in flight is now stale
      }
    }, [refresh])

    const value = useMemo(() => ({ items, loading, error, refresh, setItems }), [items, loading, error, refresh])
    return <Context.Provider value={value}>{children}</Context.Provider>
  }

  function useStore() {
    const value = useContext(Context)
    if (!value) throw new Error(`The "${name}" store was used outside its Provider.`)
    return value
  }

  return { Provider, useStore }
}
