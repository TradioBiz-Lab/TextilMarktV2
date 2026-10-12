import { useRef, useState } from 'react'
import { Camera, ClipboardList, MessageSquare, X } from '../icons.jsx'
import { T } from '../constants.js'
import { Btn, Alert, Select, Textarea, blobToDataUrl, useToast } from './ui.jsx'
import { useApp } from '../context.jsx'
import { grnsApi, inboundApi } from '../api.js'
import { compressImage } from '../lib/imageCompress.js'

// What the factory floor sends: the supplier's delivery paper, a photo of progress on an order, or a short note. One
// camera button on every screen of a factory's app (beside Kriyaa's), so capturing is one tap from wherever the person
// is. A delivery paper becomes a draft goods received note to check; a progress photo or note goes to the same
// pipeline a WhatsApp message does (the AI reads the step; anything unsure waits for a person), told which order it
// is for when the person says.
const STATE_TEXT = {
  auto_applied: m => `Done${m.stageApplied ? `: ${m.stageApplied} updated` : ''}.`,
  needs_review: m => `Sent. ${m.reviewReason || 'It needs a person to look at it'}.`,
  applied: () => 'Done.',
}

export function CaptureSheet({ onNavigate }) {
  const toast = useToast()
  const { orders } = useApp()
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState(null)             // null | 'paper' | 'photo' | 'note'
  const [orderId, setOrderId] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [result, setResult] = useState('')
  const paperCam = useRef(null)
  const photoCam = useRef(null)

  const live = (orders || []).filter(o => o.assignments?.[0]?.status !== 'Delivered').sort((a, b) => String(a.product).localeCompare(String(b.product)))
  const close = () => { if (busy) return; setOpen(false); setMode(null); setErr(''); setResult(''); setText('') }

  const toDataUrl = async file => blobToDataUrl(await compressImage(file, { maxEdge: 2000, quality: 0.85, minBytes: 300 * 1024 }))

  const sendPaper = async file => {
    if (!file) return
    setBusy(true); setErr('')
    try {
      const g = await grnsApi.scan({ dataUrl: await toDataUrl(file) })
      toast('Challan read: check it and post it', 'success')
      setOpen(false); setMode(null)
      onNavigate('grn', { grn: g.id })
    } catch (e) { setErr(e?.message || 'The document could not be read. Try a clearer photo') } finally { setBusy(false) }
  }

  const sendPhoto = async file => {
    if (!file) return
    setBusy(true); setErr('')
    try {
      const r = await inboundApi.upload({ type: 'image', fileDataUrl: await toDataUrl(file), ...(orderId ? { orderId } : {}) })
      const m = r.message || {}
      setResult((STATE_TEXT[m.state] || (() => 'Sent.'))(m))
    } catch (e) { setErr(e?.message || 'The photo could not be sent') } finally { setBusy(false) }
  }

  const sendNote = async () => {
    setBusy(true); setErr('')
    try {
      const r = await inboundApi.upload({ type: 'text', text: text.trim(), ...(orderId ? { orderId } : {}) })
      const m = r.message || {}
      setResult((STATE_TEXT[m.state] || (() => 'Sent.'))(m))
      setText('')
    } catch (e) { setErr(e?.message || 'The note could not be sent') } finally { setBusy(false) }
  }

  const choice = (icon, title, hint, onClick) => (
    <button type="button" onClick={onClick} disabled={busy}
      style={{ display: 'flex', gap: 14, alignItems: 'center', width: '100%', textAlign: 'left', border: `1px solid ${T.border}`, borderRadius: 14, background: T.surface, padding: '14px 16px', minHeight: 68, cursor: 'pointer', fontFamily: 'inherit' }}>
      <span style={{ width: 44, height: 44, borderRadius: 12, background: T.primaryLight, color: T.primaryDark, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{icon}</span>
      <span><span style={{ display: 'block', fontSize: 15, fontWeight: 800, color: T.text }}>{title}</span><span style={{ display: 'block', fontSize: 12, color: T.textMuted, marginTop: 2 }}>{hint}</span></span>
    </button>
  )

  return (
    <>
      <button className="capture-fab" onClick={() => setOpen(true)} title="Send a photo or a note" aria-label="Send a photo or a note"
        style={{ position: 'fixed', bottom: 'var(--kriyaa-bottom, 24px)', right: 90, zIndex: 500, width: 52, height: 52, borderRadius: '50%', border: `1px solid ${T.border}`, cursor: 'pointer', background: T.surface, color: T.primaryDark, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 6px 20px rgba(15,23,42,0.18)' }}>
        <Camera size={24} />
      </button>

      {open && (
        <div role="dialog" aria-label="Send a photo or a note" onClick={e => { if (e.target === e.currentTarget) close() }}
          style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(15,23,42,0.55)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
          <div style={{ background: T.surface, width: '100%', maxWidth: 520, borderRadius: '18px 18px 0 0', padding: '18px 18px 24px', maxHeight: '88vh', overflowY: 'auto', boxShadow: '0 -12px 40px rgba(0,0,0,0.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div style={{ fontSize: 17, fontWeight: 800, color: T.text }}>{mode === 'paper' ? 'Delivery paper' : mode === 'photo' ? 'Progress photo' : mode === 'note' ? 'Short note' : 'What are you sending?'}</div>
              <button type="button" onClick={close} aria-label="Close" style={{ border: 'none', background: '#f1f5f9', width: 34, height: 34, borderRadius: 10, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><X size={16} /></button>
            </div>

            {err && <div style={{ marginBottom: 12 }}><Alert type="danger">{err}</Alert></div>}
            {result && <div style={{ marginBottom: 12 }}><Alert type="success">{result}</Alert></div>}

            {!mode && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {choice(<ClipboardList size={22} />, 'Delivery paper', 'Photograph the supplier\'s challan or invoice. The goods are filled in for you to check.', () => { setMode('paper'); paperCam.current?.click() })}
                {choice(<Camera size={22} />, 'Progress photo', 'Cutting, stitching, packing: the step is read from the photo.', () => setMode('photo'))}
                {choice(<MessageSquare size={22} />, 'Short note', 'Type or dictate: "stitching done on the hoodie".', () => setMode('note'))}
              </div>
            )}

            {mode === 'paper' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {busy ? <div role="status" style={{ fontSize: 14, fontWeight: 700, color: T.primaryDark, padding: '14px 0' }}>Reading the document... this takes a few seconds.</div> : (
                  <>
                    <div style={{ fontSize: 13, color: T.textMuted }}>Take a photo of the whole paper, flat and in good light.</div>
                    <Btn size="lg" icon={<Camera size={18} />} onClick={() => paperCam.current?.click()}>Take a photo</Btn>
                    <Btn variant="secondary" onClick={() => setMode(null)}>Back</Btn>
                  </>
                )}
              </div>
            )}

            {(mode === 'photo' || mode === 'note') && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <Select label="Which order (if you know)" value={orderId} onChange={e => setOrderId(e.target.value)}>
                  <option value="">Work it out from the photo</option>
                  {live.map(o => <option key={o.id} value={o.id}>{o.product}{o.styleNumber ? ` (${o.styleNumber})` : ''}</option>)}
                </Select>
                {mode === 'photo' ? (
                  busy ? <div role="status" style={{ fontSize: 14, fontWeight: 700, color: T.primaryDark, padding: '10px 0' }}>Sending...</div> : (
                    <Btn size="lg" icon={<Camera size={18} />} onClick={() => photoCam.current?.click()}>Take a photo</Btn>
                  )
                ) : (
                  <>
                    <Textarea label="What happened" value={text} onChange={e => setText(e.target.value)} rows={3} maxLength={2000} placeholder="Cutting finished, stitching starts tomorrow" />
                    <Btn size="lg" onClick={sendNote} disabled={busy || !text.trim()}>{busy ? 'Sending...' : 'Send the note'}</Btn>
                  </>
                )}
                <Btn variant="secondary" onClick={() => { setMode(null); setResult(''); setErr('') }} disabled={busy}>Back</Btn>
              </div>
            )}
          </div>
        </div>
      )}
      <input ref={paperCam} type="file" accept="image/*,application/pdf" capture="environment" style={{ display: 'none' }} aria-label="Take a photo of the delivery paper" onChange={e => { sendPaper(e.target.files?.[0]); e.target.value = '' }} />
      <input ref={photoCam} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} aria-label="Take a progress photo" onChange={e => { sendPhoto(e.target.files?.[0]); e.target.value = '' }} />
    </>
  )
}
