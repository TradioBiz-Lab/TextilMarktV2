import { useEffect, useRef } from 'react'
import { floorApi } from '../api.js'
import { useApp } from '../context.jsx'

const POLL_MS = 3000

/**
 * Renders nothing. Polls a tiny feed endpoint and, when a factory message
 * changes an order, refetches orders and documents so the stage progress and
 * its Stage Evidence update with no page refresh. Polling (not SSE) on
 * purpose: Catalyst AppSail's edge may buffer long-lived responses.
 */
export function LiveRefresh() {
  const { refreshOrders, refreshDocs } = useApp()
  const version = useRef(null)

  useEffect(() => {
    let dead = false
    const tick = async () => {
      if (document.hidden) return
      try {
        const f = await floorApi.feed()
        if (dead) return
        if (version.current !== null && f.version !== version.current) { refreshOrders(); refreshDocs() }
        version.current = f.version
      } catch { /* transient, next tick retries */ }
    }
    tick()
    const t = setInterval(tick, POLL_MS)
    return () => { dead = true; clearInterval(t) }
  }, [refreshOrders, refreshDocs])

  return null
}
