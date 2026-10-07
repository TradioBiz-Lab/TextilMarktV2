import { useEffect, useRef, useState, useCallback } from 'react'
import { Camera, Mic, FileText, MessageSquare, Check, X, Send } from '../../icons.jsx'
import { reviewApi, inboundApi } from '../../api.js'
import { useApp } from '../../context.jsx'
import { T } from '../../constants.js'
import { Card, Btn, Select, PageHeader, EmptyState, useToast } from '../../components/ui.jsx'

const readAsDataUrl = file => new Promise((res, rej) => {
  const r = new FileReader()
  r.onload = () => res(r.result)
  r.onerror = rej
  r.readAsDataURL(file)
})

function Preview({ item }) {
  const [src, setSrc] = useState(null)
  useEffect(() => {
    if (!item.hasMedia) return
    let url, dead = false
    reviewApi.media(item.id).then(b => { if (!dead) { url = URL.createObjectURL(b); setSrc(url) } }).catch(() => {})
    return () => { dead = true; if (url) URL.revokeObjectURL(url) }
  }, [item.id, item.hasMedia])
  if (item.type === 'image' && src) return <img src={src} alt="" style={{ width: 160, height: 120, objectFit: 'cover', borderRadius: 8 }} />
  if (item.type === 'audio' && src) return <audio controls src={src} style={{ width: 200 }} />
  if (item.type === 'document' && src) return <a href={src} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: T.primary }}>Open document</a>
  const Icon = { image: Camera, audio: Mic, document: FileText }[item.type] || MessageSquare
  return <div style={{ width: 160, height: 120, background: T.bg, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon size={28} color={T.textLight} /></div>
}

function QueueItem({ item, onDone }) {
  const toast = useToast()
  const [orderId, setOrderId] = useState(item.orderId || item.candidates[0]?.id || '')
  const cand = item.candidates.find(c => c.id === orderId)
  const [stage, setStage] = useState(item.stageApplied || '')
  // The coordinator picks what happened; it is no longer assumed to be "done".
  const [status, setStatus] = useState(item.parsed?.updates?.[0]?.status === 'in_progress' ? 'in_progress' : 'done')
  const closesDelivery = status === 'done' && /^delivery$/i.test(stage.trim())
  const [busy, setBusy] = useState(false)
  const run = async (fn, okMsg) => {
    setBusy(true)
    try {
      const r = await fn()
      // A stage someone edited after the AI update is left as it is, and the server says so.
      if (r?.warnings?.length) toast(`${okMsg}. ${r.warnings[0]}`, 'warning'); else toast(okMsg)
      onDone()
    } catch (e) { toast(e.message || 'Failed', 'error') } finally { setBusy(false) }
  }
  const guess = item.parsed?.stage || item.parsed?.implied_stage || item.parsed?.updates?.map(u => `${u.stage} ${u.status}`).join(', ')
  return (
    <Card style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        <Preview item={item} />
        <div style={{ flex: 1, minWidth: 240 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{item.factory?.company || item.senderNumber || 'Unknown sender'}</div>
          <div style={{ fontSize: 11, color: T.textLight, marginBottom: 6 }}>{new Date(item.createdAt).toLocaleString()} · {item.type}</div>
          {item.rawText && <div style={{ fontSize: 13, background: T.bg, padding: '6px 8px', borderRadius: 6, marginBottom: 6 }}>"{item.rawText}"</div>}
          <div style={{ fontSize: 12, color: T.textMuted }}>
            <b>Why it's here:</b> {item.reviewReason || 'Needs a human'}<br />
            <b>AI guess:</b> {guess || 'none'}{item.confidence != null && ` (${Math.round(item.confidence * 100)}%)`}
            {item.parsed?.issues?.length > 0 && <><br /><b style={{ color: T.danger }}>Issues:</b> {item.parsed.issues.join(', ')}</>}
            {item.changes?.length > 0 && <><br /><b>Already applied:</b> {item.changes.map(c => c.stageName).join(', ')}</>}
          </div>
          {item.candidates.length > 0 && (
            <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              <Select value={orderId} onChange={e => { setOrderId(e.target.value); setStage('') }} aria-label="Order">
                <option value="">Pick order</option>
                {item.candidates.map(c => <option key={c.id} value={c.id}>{c.styleNumber || c.id} · {c.product}</option>)}
              </Select>
              <Select value={stage} onChange={e => setStage(e.target.value)} aria-label="Stage">
                <option value="">Pick stage</option>
                {(cand?.stages || []).map(s => <option key={s} value={s}>{s}</option>)}
              </Select>
              <Select value={status} onChange={e => setStatus(e.target.value)} aria-label="Status">
                <option value="done">Done</option>
                <option value="in_progress">In progress</option>
              </Select>
            </div>
          )}
          {item.candidates.length > 0 && closesDelivery && (
            <div style={{ fontSize: 12, color: T.danger, marginTop: 6 }}>
              This closes the Delivery step and marks the manufacturer's split Delivered. Only do it if the goods were really delivered.
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <Btn size="sm" icon={<Check size={14} />} disabled={busy} onClick={() => run(() => reviewApi.approve(item.id), 'Approved')}>Approve</Btn>
            <Btn size="sm" variant="secondary" disabled={busy || !orderId || !stage} onClick={() => run(() => reviewApi.correct(item.id, { orderId, stage, status }), 'Corrected and applied')}>{closesDelivery ? 'Close Delivery and apply' : 'Correct and apply'}</Btn>
            <Btn size="sm" variant="secondary" icon={<X size={14} />} disabled={busy} onClick={() => run(() => reviewApi.reject(item.id), 'Rejected')}>Reject</Btn>
          </div>
        </div>
      </div>
    </Card>
  )
}

// Lets a coordinator (or a demo) push a message into the same pipeline a
// WhatsApp webhook uses, on a factory's behalf.
function SimulatePanel({ onSent }) {
  const { users } = useApp()
  const toast = useToast()
  const factories = (users || []).filter(u => u.role === 'manufacturer')
  const [factoryId, setFactoryId] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const file = useRef(null)
  const fid = factoryId || factories[0]?.id || factories[0]?._id || ''

  const send = async (type, body) => {
    setBusy(true)
    try {
      const r = await inboundApi.upload({ type, factoryId: fid, ...body })
      const m = r.message
      toast(m.state === 'auto_applied' ? `Applied: ${m.stageApplied}` : `Sent to review: ${m.reviewReason || m.state}`)
      onSent()
      return true
    } catch (e) { toast(e.message || 'Upload failed', 'error'); return false } finally { setBusy(false); if (file.current) file.current.value = '' }
  }
  const pick = async e => {
    const f = e.target.files?.[0]; if (!f) return
    const type = f.type.startsWith('audio/') ? 'audio' : f.type === 'application/pdf' ? 'document' : 'image'
    send(type, { fileDataUrl: await readAsDataUrl(f) })
  }
  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Send an update on a factory's behalf</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Select value={fid} onChange={e => setFactoryId(e.target.value)} aria-label="Factory">
          {factories.map(f => <option key={f.id || f._id} value={f.id || f._id}>{f.company}</option>)}
        </Select>
        <input ref={file} type="file" accept="image/jpeg,image/png,image/webp,application/pdf,audio/*" onChange={pick} disabled={busy || !fid} aria-label="Photo, document or voice note" />
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <input value={text} onChange={e => setText(e.target.value)} placeholder="or type: cutting ho gaya, kal se stitching" maxLength={2000}
          style={{ flex: 1, padding: '8px 10px', border: `1px solid ${T.border}`, borderRadius: 8, fontFamily: 'inherit', fontSize: 13 }} />
        <Btn size="sm" icon={<Send size={14} />} disabled={busy || !text.trim() || !fid} onClick={() => send('text', { text }).then(ok => { if (ok) setText('') })}>Send</Btn>
      </div>
    </Card>
  )
}

export function ReviewQueuePage() {
  const { refreshOrders } = useApp()
  const [items, setItems] = useState(null)
  const [loadFailed, setLoadFailed] = useState(false)
  // A failed load must not read as "All clear": that would hide messages that need a person.
  const load = useCallback(() => reviewApi.queue()
    .then(r => { setLoadFailed(false); setItems(r) })
    .catch(() => { setLoadFailed(true); setItems(p => p ?? []) }), [])
  useEffect(() => { load() }, [load])
  const done = () => { load(); refreshOrders() }
  return (
    <div>
      <PageHeader title="Review Queue" subtitle="Messages the AI was not sure about. Nothing here has changed an order unless it says Already applied." />
      <SimulatePanel onSent={done} />
      {items === null ? null : loadFailed
        ? <Card>
            <EmptyState icon={<X size={26} color={T.danger} />} title="Could not load the queue" desc="Check your connection, then try again." />
            <div style={{ textAlign: 'center', paddingBottom: 20 }}><Btn size="sm" onClick={load}>Retry</Btn></div>
          </Card>
        : items.length === 0
        ? <Card><EmptyState icon={<Check size={26} color={T.success} />} title="All clear" desc="No messages need review" /></Card>
        : items.map(i => <QueueItem key={i.id} item={i} onDone={done} />)}
    </div>
  )
}
