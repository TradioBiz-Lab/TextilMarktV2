import { useEffect, useRef, useState } from 'react'
import { Camera, Mic, X, CheckCircle2, AlertTriangle, Square, Send } from '../../icons.jsx'
import { T } from '../../constants.js'
import { useApp } from '../../context.jsx'
import { t, langOf } from '../../coordinatorText.js'
import { shrinkImage, MAX_PHOTOS, draftKey, readDraft, writeDraft, clearDraft, spokenTerms } from '../../capture.js'
import { getPosition } from '../../geolocate.js'
import { useVoiceRecorder } from '../../useVoiceRecorder.js'
import { voiceApi } from '../../api.js'
import { blobToDataUrl } from '../../components/ui.jsx'
import { BigBtn } from './FactoriesPage.jsx'

const MAX_RECORD_MS = 2 * 60 * 1000

// A square button with a picture and one word: the three ways to say what he saw.
function Tile({ icon, label, onClick, active, disabled }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      style={{ flex: 1, minHeight: 96, borderRadius: 16, border: `2px solid ${active ? T.danger : T.borderHover}`, background: active ? T.dangerBg : '#fff', color: active ? T.dangerDeep : T.text, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, fontSize: 17, fontWeight: 800, fontFamily: 'inherit', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1 }}>
      {icon}{label}
    </button>
  )
}

/**
 * One update on one step, the same for every step: photos, a spoken note (written out for him to check) and typed
 * words, any or all. Nothing here changes the step: an account manager reads it and does that. An unsent update is
 * kept on the phone, so a failed send or a closed page loses nothing.
 */
export function AddUpdateSheet({ order, factoryId, stageIndex, stage, onClose, onNextProduct }) {
  const { currentUser, sendFieldUpdate } = useApp()
  const lang = langOf(currentUser)
  const key = draftKey(currentUser.id, order.id, factoryId, stageIndex)
  const [photos, setPhotos] = useState([])
  const [text, setText] = useState('')
  const [viaVoice, setViaVoice] = useState(false)
  const [audio, setAudio] = useState(null)             // the recording, as a data URL
  const [busy, setBusy] = useState('')                 // '' | 'photo' | 'transcribing' | 'sending'
  const [note, setNote] = useState(null)               // { tone: 'info' | 'error', text }
  const [sent, setSent] = useState(false)
  const fileInput = useRef(null)
  const recorder = useVoiceRecorder()
  const recording = recorder.state === 'recording'
  const stopTimer = useRef(null)

  // Bring back what was not sent.
  useEffect(() => {
    const d = readDraft(key)
    if (d) { setText(d.text); setPhotos(d.photos); setViaVoice(!!d.viaVoice); setNote({ tone: 'info', text: t('draft_restored', lang) }) }
  }, [key])   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!sent) writeDraft(key, { text, photos, viaVoice }) }, [key, text, photos, viaVoice, sent])
  useEffect(() => () => { clearTimeout(stopTimer.current); recorder.cancel() }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  const addPhotos = async e => {
    const files = [...(e.target.files || [])]
    e.target.value = ''
    if (!files.length) return
    const room = MAX_PHOTOS - photos.length
    if (room <= 0) { setNote({ tone: 'error', text: t('photos_max', lang) }); return }
    setBusy('photo'); setNote(null)
    const added = []
    let bad = false
    for (const f of files.slice(0, room)) {
      try { added.push(await shrinkImage(f)) } catch { bad = true }
    }
    setPhotos(p => [...p, ...added])
    if (bad) setNote({ tone: 'error', text: t('photo_bad', lang) })
    else if (files.length > room) setNote({ tone: 'error', text: t('photos_max', lang) })
    setBusy('')
  }

  const finishRecording = async () => {
    clearTimeout(stopTimer.current)
    const rec = await recorder.stop()
    if (!rec?.blob) return
    setBusy('transcribing'); setNote(null)
    try {
      const dataUrl = await blobToDataUrl(rec.blob)
      setAudio(dataUrl)
      try {
        // The style's own names go with the recording, so a client or a colour is written as it is spelt.
        const split = (order.assignments || []).find(a => String(a.mid) === String(factoryId))
        const r = await voiceApi.transcribe(dataUrl, spokenTerms(order, split))
        const said = (r?.transcript || '').trim()
        if (said) { setText(prev => (prev.trim() ? `${prev.trim()} ${said}` : said)); setViaVoice(true); setNote({ tone: 'info', text: t('voice_kept', lang) }) }
        else setNote({ tone: 'info', text: t('voice_no_text', lang) })
      } catch { setNote({ tone: 'info', text: t('voice_no_text', lang) }) }
    } finally { setBusy('') }
  }
  const toggleSpeak = async () => {
    if (recording) { finishRecording(); return }
    setNote(null)
    recorder.unlock?.()
    await recorder.start()
    stopTimer.current = setTimeout(finishRecording, MAX_RECORD_MS)
  }
  useEffect(() => { if (recorder.state === 'error') setNote({ tone: 'error', text: t('mic_blocked', lang) }) }, [recorder.state])   // eslint-disable-line react-hooks/exhaustive-deps

  const send = async () => {
    if (!text.trim() && !photos.length && !audio) { setNote({ tone: 'error', text: t('add_something', lang) }); return }
    setBusy('sending'); setNote(null)
    try {
      // Where he is, if the phone says so quickly; an update is never held back for it.
      const place = await getPosition({ timeout: 6000 }).catch(() => null)
      await sendFieldUpdate({
        orderId: order.id, mfrId: String(factoryId), stageIndex, text: text.trim(), viaVoice, photos, audio: audio || undefined,
        ...(place ? { lat: place.lat, lng: place.lng, accuracy: place.accuracy } : {}), deviceAt: new Date().toISOString(),
      })
      clearDraft(key)
      setSent(true)
    } catch (e) {
      setNote({ tone: 'error', text: e?.message && e.message !== 'Request failed' ? e.message : t('send_failed', lang) })
    } finally { setBusy('') }
  }
  const again = () => { setPhotos([]); setText(''); setViaVoice(false); setAudio(null); setNote(null); setSent(false) }

  const stepName = stage?.name || `Step ${stageIndex + 1}`
  return (
    <div role="dialog" aria-modal="true" aria-label={t('add_update', lang)} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', zIndex: 900, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <div style={{ background: '#fff', width: '100%', maxWidth: 520, maxHeight: '94vh', overflowY: 'auto', borderRadius: '20px 20px 0 0', padding: '18px 16px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 21, fontWeight: 800, color: T.text, lineHeight: 1.2, overflowWrap: 'anywhere' }}>{stepName}</div>
            <div style={{ fontSize: 14, color: T.textMuted, marginTop: 2, overflowWrap: 'anywhere' }}>{order.product}{order.buyerCompany ? ` · ${order.buyerCompany}` : ''}</div>
          </div>
          <button type="button" onClick={onClose} aria-label={t('close', lang)} style={{ width: 44, height: 44, borderRadius: 12, border: `1.5px solid ${T.borderHover}`, background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}><X size={20} color={T.text} /></button>
        </div>

        {sent ? (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '18px 0 6px' }}>
              <CheckCircle2 size={64} color="#15803d" weight="fill" />
              <div style={{ fontSize: 24, fontWeight: 800, color: '#15803d' }}>{t('sent_title', lang)}</div>
            </div>
            <BigBtn onClick={again} icon={<Camera size={22} />}>{t('another_here', lang)}</BigBtn>
            {onNextProduct && <BigBtn tone="plain" onClick={onNextProduct}>{t('next_product', lang)}</BigBtn>}
            <BigBtn tone="plain" onClick={onClose}>{t('close', lang)}</BigBtn>
          </>
        ) : (
          <>
            <input ref={fileInput} type="file" accept="image/*" capture="environment" multiple onChange={addPhotos} style={{ display: 'none' }} />
            <div style={{ display: 'flex', gap: 12 }}>
              <Tile icon={<Camera size={34} color={T.primaryDeep} />} label={busy === 'photo' ? '…' : t('photo', lang)} onClick={() => fileInput.current?.click()} disabled={!!busy || recording} />
              <Tile icon={recording ? <Square size={30} weight="fill" /> : <Mic size={34} color={T.primaryDeep} />} label={recording ? t('stop', lang) : audio ? t('speak_again', lang) : t('speak', lang)} onClick={toggleSpeak} active={recording} disabled={!!busy} />
            </div>
            {recording && <div style={{ fontSize: 15, fontWeight: 700, color: T.dangerDeep, textAlign: 'center' }}>{t('listening', lang)}</div>}
            {busy === 'transcribing' && <div style={{ fontSize: 15, fontWeight: 700, color: T.textMuted, textAlign: 'center' }}>{t('writing', lang)}</div>}

            {photos.length > 0 && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
                {photos.map((p, i) => (
                  <div key={i} style={{ position: 'relative', aspectRatio: '1 / 1', borderRadius: 12, overflow: 'hidden', border: `1px solid ${T.border}` }}>
                    <img src={p} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    <button type="button" onClick={() => setPhotos(ps => ps.filter((_, j) => j !== i))} aria-label={t('remove_photo', lang)}
                      style={{ position: 'absolute', top: 4, right: 4, width: 32, height: 32, borderRadius: '50%', border: 'none', background: 'rgba(15,23,42,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}><X size={16} color="#fff" /></button>
                  </div>
                ))}
              </div>
            )}
            {audio && !recording && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <audio controls src={audio} style={{ flex: 1, minWidth: 0, height: 40 }} />
                <button type="button" onClick={() => { setAudio(null); setViaVoice(false) }} aria-label={t('remove_voice', lang)} style={{ width: 40, height: 40, borderRadius: 10, border: `1px solid ${T.border}`, background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}><X size={16} color={T.textMuted} /></button>
              </div>
            )}

            {/* What he said is written here for him to read and correct before it goes. */}
            <textarea value={text} onChange={e => setText(e.target.value.slice(0, 2000))} placeholder={t('type_here', lang)} rows={text.length > 120 ? 6 : 3}
              style={{ width: '100%', boxSizing: 'border-box', border: `1.5px solid ${T.borderHover}`, borderRadius: 14, padding: '12px 14px', fontSize: 17, lineHeight: 1.45, color: T.text, fontFamily: 'inherit', resize: 'vertical' }} />

            {note && (
              <div role={note.tone === 'error' ? 'alert' : 'status'} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', borderRadius: 12, padding: '10px 12px', fontSize: 15, fontWeight: 600, background: note.tone === 'error' ? T.dangerBg : T.infoBg, color: note.tone === 'error' ? T.dangerDeep : T.info, border: `1px solid ${note.tone === 'error' ? T.dangerBorder : T.infoBorder}` }}>
                {note.tone === 'error' && <AlertTriangle size={18} style={{ flexShrink: 0, marginTop: 2 }} />}{note.text}
              </div>
            )}
            <BigBtn tone="green" onClick={send} disabled={!!busy || recording} icon={<Send size={22} />}>{busy === 'sending' ? t('sending', lang) : t('send', lang)}</BigBtn>
          </>
        )}
      </div>
    </div>
  )
}
