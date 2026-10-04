import { useEffect, useRef, useState } from 'react'
import { Camera, AlertTriangle, Mic, FileText, MessageSquare } from 'lucide-react'
import { floorApi, reviewApi } from '../api.js'
import { useApp } from '../context.jsx'
import { T } from '../constants.js'
import { Card } from './ui.jsx'

const POLL_MS = 3000

// Authenticated thumbnail: fetched as a blob so the cookie/auth applies.
function Media({ id }) {
  const [src, setSrc] = useState(null)
  useEffect(() => {
    let url, dead = false
    reviewApi.media(id).then(blob => { if (!dead) { url = URL.createObjectURL(blob); setSrc(url) } }).catch(() => {})
    return () => { dead = true; if (url) URL.revokeObjectURL(url) }
  }, [id])
  return src
    ? <img src={src} alt="" style={{ width: '100%', height: 92, objectFit: 'cover', display: 'block' }} />
    : <div style={{ height: 92, background: T.bg }} />
}

const ICON = { image: Camera, audio: Mic, document: FileText, text: MessageSquare }

/**
 * Live floor strip. Polls a tiny feed endpoint; when its version changes the
 * orders are refetched, so a factory's photo turns a stage green with no page
 * refresh. Polling (not SSE) on purpose: Catalyst AppSail's edge may buffer
 * long-lived responses.
 */
export function FloorFeed() {
  const { refreshOrders } = useApp()
  const [items, setItems] = useState([])
  const [fresh, setFresh] = useState(new Set())
  const version = useRef(null)
  const seen = useRef(new Set())

  useEffect(() => {
    let dead = false
    const tick = async () => {
      if (document.hidden) return
      try {
        const f = await floorApi.feed()
        if (dead) return
        if (version.current !== null && f.version !== version.current) refreshOrders()
        version.current = f.version
        const isNew = f.items.filter(i => seen.current.size && !seen.current.has(i.id)).map(i => i.id)
        f.items.forEach(i => seen.current.add(i.id))
        if (isNew.length) { setFresh(new Set(isNew)); setTimeout(() => setFresh(new Set()), 4000) }
        setItems(f.items)
      } catch { /* transient, next tick retries */ }
    }
    tick()
    const t = setInterval(tick, POLL_MS)
    return () => { dead = true; clearInterval(t) }
  }, [refreshOrders])

  if (!items.length) return null
  return (
    <Card style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: T.text, marginBottom: 10 }}>Live from the floor</div>
      <div style={{ display: 'flex', gap: 10, overflowX: 'auto', paddingBottom: 4 }}>
        {items.slice(0, 12).map(i => {
          const Icon = ICON[i.type] || MessageSquare
          return (
            <div key={i.id} style={{
              flex: '0 0 160px', border: `1px solid ${i.issue ? T.danger : T.border}`, borderRadius: 10, overflow: 'hidden', background: T.surface,
              transition: 'box-shadow .4s, transform .4s', boxShadow: fresh.has(i.id) ? `0 0 0 3px ${T.success}` : 'none', transform: fresh.has(i.id) ? 'scale(1.03)' : 'none',
            }}>
              {i.hasMedia && i.type === 'image' ? <Media id={i.id} /> : <div style={{ height: 92, background: T.bg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon size={26} color={T.textLight} /></div>}
              <div style={{ padding: '6px 8px', fontSize: 11 }}>
                <div style={{ fontWeight: 700, color: i.issue ? T.danger : T.text, display: 'flex', alignItems: 'center', gap: 4 }}>
                  {i.issue && <AlertTriangle size={11} />}{i.stage || 'Update'}
                </div>
                <div style={{ color: T.textMuted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{i.orderId}</div>
                <div style={{ color: T.textLight }}>{new Date(i.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
              </div>
            </div>
          )
        })}
      </div>
    </Card>
  )
}
