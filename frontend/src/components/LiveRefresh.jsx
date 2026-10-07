import { useEffect, useRef } from 'react'
import { floorApi } from '../api.js'
import { useApp } from '../context.jsx'

const POLL_MS = 3000

/**
 * Renders nothing. Polls a tiny feed endpoint and refetches orders and
 * documents whenever the feed's version moves: a factory message landed, or
 * anyone edited, added or removed one of this user's orders. For admins it
 * also refetches the action-item list when that changes. So the dashboard and
 * its summary stay current with no page refresh, including after other
 * people's edits. Polling (not SSE) on purpose: Catalyst AppSail's edge may
 * buffer long-lived responses. The poll skips while the tab is hidden and the
 * first tick after it is shown again catches up on anything missed.
 */
export function LiveRefresh() {
  const { refreshOrders, refreshDocs, refreshActionItems } = useApp()
  const version = useRef(null)
  const itemsVersion = useRef(null)
  // True once a tick was skipped because the tab was hidden. If that happens
  // before the first baseline version is taken (a tab opened in the background),
  // the data on screen is already as old as the page load, so the first visible
  // tick refetches once instead of silently adopting a possibly newer baseline.
  const skippedWhileHidden = useRef(false)

  useEffect(() => {
    let dead = false
    const tick = async () => {
      if (document.hidden) { skippedWhileHidden.current = true; return }
      try {
        const f = await floorApi.feed()
        if (dead) return
        const changed = version.current !== null && f.version !== version.current
        const missedWhileHidden = version.current === null && skippedWhileHidden.current
        if (changed || missedWhileHidden) { refreshOrders(); refreshDocs() }
        version.current = f.version
        if (f.itemsVersion != null) {
          if ((itemsVersion.current !== null && f.itemsVersion !== itemsVersion.current) || (itemsVersion.current === null && missedWhileHidden)) refreshActionItems()
          itemsVersion.current = f.itemsVersion
        }
      } catch { /* transient, next tick retries */ }
    }
    tick()
    const t = setInterval(tick, POLL_MS)
    return () => { dead = true; clearInterval(t) }
  }, [refreshOrders, refreshDocs, refreshActionItems])

  return null
}
