import { useEffect, useRef, useState } from 'react'
import { Mic, Square, X, Check, AlertTriangle, Ruler, Download, Eye, CheckCircle2, Camera } from '../../icons.jsx'
import { T, fmtDate } from '../../constants.js'
import { useApp } from '../../context.jsx'
import { capsFor } from '../../caps.js'
import { t, langOf } from '../../coordinatorText.js'
import { measurementsApi, voiceApi } from '../../api.js'
import { useVoiceRecorder } from '../../useVoiceRecorder.js'
import { blobToDataUrl, Btn, FlexRow, useToast } from '../../components/ui.jsx'
import { shrinkImage } from '../../capture.js'
import { PHOTO_OF_SHEET, STAGES, tabForStage, defaultSize, keyTerms, parseTyped, judge, mergeRead, summary, pointsPayload, show, valuesOf, draftFor, lastDoneFor, latestDraft, localKey, readLocal, writeLocal, clearLocal, resumeFrom } from '../../measure.js'

const MAX_RECORD_MS = 3 * 60 * 1000
const chipBtn = on => ({ minHeight: 44, padding: '8px 14px', borderRadius: 12, border: `2px solid ${on ? T.info : T.border}`, background: on ? T.infoBg : '#fff', color: on ? T.info : T.text, fontSize: 15, fontWeight: on ? 600 : 500, cursor: 'pointer', fontFamily: 'inherit' })
const label = { fontSize: 12, fontWeight: 600, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }

async function saveDataUrl(dataUrl, filename) {
  const blob = await (await fetch(dataUrl)).blob()
  const url = URL.createObjectURL(blob); const a = document.createElement('a')
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * Measure one garment against the style's own measurement sheet. He picks the sample stage and the size, then either
 * reads the measurements aloud in one go ("chest 43, shoulder 18 and a half": each number is placed by the name he
 * says) or types them. Every value shows against what the sheet asks for, with the difference and a mark. Saving makes
 * a copy of the sheet with the values filled in, kept on the style and offered as a download. Tradio's coordinator sees
 * it in his language; a factory and Tradio in English.
 */
export function MeasureSheet({ order, factoryId = null, start = null, onClose, onSaved }) {
  const { currentUser, getDocData, refreshDocs } = useApp()
  const lang = capsFor(currentUser).isCoord ? langOf(currentUser) : 'en'
  const [spec, setSpec] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [stage, setStage] = useState('fit')
  const [tabName, setTabName] = useState('')
  const [size, setSize] = useState('')
  const [mfrId, setMfrId] = useState(factoryId ? String(factoryId) : '')
  const [values, setValues] = useState({})          // point index -> what is in its box
  const [transcript, setTranscript] = useState('')
  const [spoke, setSpoke] = useState(false)
  const [fromPhoto, setFromPhoto] = useState(false)
  const [unplaced, setUnplaced] = useState([])
  const [busy, setBusy] = useState('')              // '' | 'reading' | 'saving' | 'download'
  const [note, setNote] = useState('')
  const [saved, setSaved] = useState(null)
  const [sessions, setSessions] = useState([])      // what is already recorded on the style, unfinished ones included
  const [resumed, setResumed] = useState(false)     // the boxes were filled from an unfinished session
  const [saveState, setSaveState] = useState('')    // '' | 'saving' | 'saved' | 'offline'
  const lastSent = useRef('')                       // what the server holds for this garment, to save only real changes
  const loadedKey = useRef('')
  const recorder = useVoiceRecorder()
  const stopTimer = useRef(null)
  const recording = recorder.state === 'recording'

  useEffect(() => {
    let dead = false
    Promise.all([measurementsApi.spec(order.id), measurementsApi.list(order.id).catch(() => [])]).then(([s, list]) => {
      if (dead) return
      const factory = factoryId && s.factories.some(f => f.id === String(factoryId)) ? String(factoryId) : (s.factories[0]?.id || '')
      // Open on the garment he was in the middle of (or the one asked for), else on the fit sample in the sample size.
      const go = start || latestDraft(list, factory)
      const first = go?.stage || (s.tabs.find(x => x.stage === 'fit') ? 'fit' : (s.tabs[0]?.stage || 'fit'))
      const tab = (go?.tab && s.tabs.find(x => x.name === go.tab)) || tabForStage(s.tabs, first)
      setSessions(list); setSpec(s); setMfrId(go?.mfrId && s.factories.some(f => f.id === go.mfrId) ? go.mfrId : factory)
      setStage(first); setTabName(tab?.name || ''); setSize(go?.size && tab?.sizes.includes(go.size) ? go.size : defaultSize(tab))
    }).catch(e => { if (!dead) setLoadError(e?.message || t('failed', lang)) })
    return () => { dead = true; clearTimeout(stopTimer.current); recorder.cancel() }
  }, [order.id])   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (recorder.state === 'error') setNote(t('mic_blocked', lang)) }, [recorder.state])   // eslint-disable-line react-hooks/exhaustive-deps

  const tab = spec?.tabs.find(x => x.name === tabName) || null
  const sum = summary(tab, size, values)
  const key = { mfrId, stage, size }
  const draft = draftFor(sessions, key)
  const lastDone = !draft && !sum.filled ? lastDoneFor(sessions, key) : null
  const pickStage = s => { const next = tabForStage(spec.tabs, s); setStage(s); setTabName(next?.name || ''); if (next && !next.sizes.includes(size)) setSize(defaultSize(next)) }

  // Each stage, size and factory is its own garment. Choosing one brings back what was already filled in for it: the
  // unfinished session on the server, or this device's copy when that is newer (a save that did not get through).
  useEffect(() => {
    if (!spec || !tab || !mfrId || !size) return
    const id = `${mfrId}:${stage}:${size}:${tab.name}`
    if (loadedKey.current === id) return
    loadedKey.current = id
    const mine = draftFor(sessions, key)
    const from = resumeFrom(mine && mine.tab === tab.name ? mine : null, readLocal(localKey(order.id, key)))
    setValues(from?.values || {}); setTranscript(from?.transcript || ''); setSpoke(false); setUnplaced([]); setNote('')
    setResumed(!!from); setSaveState(from?.from === 'server' ? 'saved' : '')
    // Nothing filled in and nothing on the server are the same thing: no save is needed until he enters a value.
    lastSent.current = from?.from === 'server' ? JSON.stringify(pointsPayload(tab, from.values)) : from ? '' : '[]'
  }, [spec, tab, mfrId, stage, size])   // eslint-disable-line react-hooks/exhaustive-deps

  // Saved as he goes: at once on this device, and a moment after he stops typing or speaking on the server.
  useEffect(() => {
    if (!tab || !mfrId || saved || !loadedKey.current) return undefined
    const points = pointsPayload(tab, values); const body = JSON.stringify(points)
    if (body === lastSent.current) return undefined
    const lk = localKey(order.id, key)
    if (points.length) writeLocal(lk, values, transcript); else clearLocal(lk)
    const send = async () => {
      setSaveState('saving')
      try {
        const r = await measurementsApi.saveDraft({ orderId: order.id, mfrId, stage, size, tab: tab.name, points, transcript, method: spoke ? 'voice' : fromPhoto ? 'photo' : 'typed' })
        lastSent.current = body; setSaveState(points.length ? 'saved' : '')
        setSessions(list => [...list.filter(s => !(s.status === 'draft' && s.mfrId === mfrId && s.stage === stage && s.size === size)), ...(r.draft ? [r.draft] : [])])
        if (r.draft) clearLocal(lk)
      } catch { setSaveState('offline') }
    }
    const timer = setTimeout(send, 1200)
    return () => clearTimeout(timer)
  }, [values, tab, mfrId, stage, size, saved])   // eslint-disable-line react-hooks/exhaustive-deps
  // A save that did not get through is tried again when the connection comes back.
  useEffect(() => {
    const again = () => { if (saveState === 'offline') setValues(v => ({ ...v })) }
    window.addEventListener('online', again); const every = setInterval(again, 15000)
    return () => { window.removeEventListener('online', again); clearInterval(every) }
  }, [saveState])
  const startAgain = () => { setValues({}); setTranscript(''); setSpoke(false); setFromPhoto(false); setUnplaced([]); setNote(''); setResumed(false) }
  const continueLast = () => { setValues(valuesOf(lastDone)); setResumed(true) }

  const finishRecording = async () => {
    clearTimeout(stopTimer.current)
    const rec = await recorder.stop()
    if (!rec?.blob) return
    setBusy('reading'); setNote('')
    try {
      const heard = await voiceApi.transcribe(await blobToDataUrl(rec.blob), keyTerms(tab))
      const said = (heard?.transcript || '').trim()
      if (!said) { setNote(t('measure_none_heard', lang)); return }
      const read = await measurementsApi.read(order.id, tab.name, size, said)
      setTranscript(v => (v ? `${v}\n${said}` : said)); setSpoke(true)
      if (!read.values.length && !read.unmatched.length) setNote(t('measure_none_heard', lang))
      setValues(v => mergeRead(v, read.values)); setUnplaced(read.unmatched || [])
    } catch (e) { setNote(e?.code === 'READER_OFF' ? t('measure_reader_off', lang) : (e?.message || t('failed', lang))) }
    finally { setBusy('') }
  }
  // The other way in: he wrote the numbers on paper. A photo of the page (up to three) is read against the sheet and
  // fills the same boxes, for him to check. Shrunk on the phone first, but kept large enough to read handwriting.
  const readPhotos = async files => {
    const list = [...(files || [])].slice(0, 3)
    if (!list.length) return
    setBusy('photo'); setNote('')
    try {
      const photos = []
      for (const f of list) photos.push(await shrinkImage(f, { max: 1600, quality: 0.75 }))
      const read = await measurementsApi.readPhoto(order.id, tab.name, size, photos)
      if (!read.values.length && !read.unmatched.length) setNote(t('measure_none_read', lang))
      if (read.values.length) setFromPhoto(true)
      setValues(v => mergeRead(v, read.values)); setUnplaced(read.unmatched || [])
    } catch (e) { setNote(e?.code === 'READER_OFF' ? t('measure_reader_off', lang) : e?.message === 'not an image' ? t('measure_photo_bad', lang) : (e?.message || t('failed', lang))) }
    finally { setBusy('') }
  }
  const startRecording = async () => {
    setNote(''); recorder.unlock?.()
    await recorder.start()
    stopTimer.current = setTimeout(finishRecording, MAX_RECORD_MS)
  }
  const save = async () => {
    if (sum.bad) { setNote(t('measure_bad_number', lang)); return }
    setBusy('saving'); setNote('')
    try {
      const r = await measurementsApi.save({ orderId: order.id, mfrId, stage, size, tab: tab.name, points: pointsPayload(tab, values), transcript, method: spoke ? 'voice' : fromPhoto ? 'photo' : 'typed' })
      clearLocal(localKey(order.id, key)); lastSent.current = '[]'
      setSessions(list => [...list.filter(s => s.id !== r.session.id), r.session])
      setSaved(r); refreshDocs?.(); onSaved?.(r)
    } catch (e) { setNote(e?.message || t('failed', lang)) } finally { setBusy('') }
  }
  const download = async () => {
    setBusy('download')
    try { const d = await getDocData(saved.documentId); await saveDataUrl(d.dataUrl, saved.fileName) } catch (e) { setNote(e?.message || t('failed', lang)) } finally { setBusy('') }
  }

  const shell = body => (
    <div role="dialog" aria-modal="true" aria-label={t('measure_title', lang)} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', zIndex: 900, display: 'flex', justifyContent: 'center' }}>
      <div style={{ background: '#f8fafc', width: '100%', maxWidth: 680, height: '100%', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', background: '#fff', borderBottom: `1px solid ${T.border}` }}>
          <Ruler size={22} color={T.info} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 17, fontWeight: 600, color: T.text }}>{t('measure_title', lang)}</div>
            <div style={{ fontSize: 13, color: T.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{order.product}{order.styleNumber ? ` · ${order.styleNumber}` : ''}</div>
          </div>
          <button type="button" onClick={onClose} aria-label={t('close', lang)} style={{ width: 44, height: 44, borderRadius: 12, border: `1px solid ${T.border}`, background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}><X size={20} /></button>
        </div>
        {body}
      </div>
    </div>
  )

  if (loadError) return shell(<div style={{ padding: 20, display: 'flex', gap: 10, alignItems: 'flex-start', color: T.dangerDeep, fontSize: 15, lineHeight: 1.5 }}><AlertTriangle size={20} style={{ flexShrink: 0, marginTop: 2 }} /> {loadError}</div>)
  if (!spec || !tab) return shell(<div style={{ padding: 24, fontSize: 15, color: T.textMuted }}>{t('measure_loading', lang)}</div>)

  if (saved) {
    return shell(
      <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14, alignItems: 'stretch' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 19, fontWeight: 600, color: '#166534' }}><CheckCircle2 size={26} /> {t('measure_saved', lang)}</div>
        <div style={{ fontSize: 15, color: T.text, lineHeight: 1.5 }}>{t(`measure_stage_${saved.session.stage}`, lang)} · {t('measure_size', lang)} {saved.session.size}<br />{t('measure_saved_body', lang, { filled: saved.session.measuredCount, out: saved.session.outOfTolerance })}</div>
        <button type="button" onClick={download} disabled={busy === 'download'} style={{ minHeight: 56, borderRadius: 14, border: 'none', background: T.info, color: '#fff', fontSize: 17, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, cursor: 'pointer', fontFamily: 'inherit', opacity: busy === 'download' ? 0.6 : 1 }}><Download size={20} /> {t('measure_download', lang)}</button>
        {note && <div role="alert" style={{ fontSize: 14, color: T.dangerDeep }}>{note}</div>}
        <FlexRow gap={10}>
          <button type="button" onClick={() => { setSaved(null); startAgain() }} style={{ ...chipBtn(false), flex: 1 }}>{t('measure_another', lang)}</button>
          <button type="button" onClick={onClose} style={{ ...chipBtn(true), flex: 1 }}>{t('measure_done', lang)}</button>
        </FlexRow>
      </div>,
    )
  }

  return shell(
    <>
      {/* The scrolling area holds one plain block: as a flex column itself it squeezed the points list (which clips its
          corners) down to the space left over, hiding most of the points, instead of letting the page scroll. */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>
      <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <div style={label}>{t('measure_stage', lang)}</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{STAGES.map(s => <button key={s} type="button" onClick={() => pickStage(s)} style={chipBtn(stage === s)}>{t(`measure_stage_${s}`, lang)}</button>)}</div>
        </div>
        {spec.tabs.length > 1 && (
          <div>
            <div style={label}>{t('measure_sheet', lang)}</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{spec.tabs.map(x => <button key={x.name} type="button" onClick={() => { setTabName(x.name); if (!x.sizes.includes(size)) setSize(defaultSize(x)) }} style={chipBtn(tabName === x.name)}>{x.name}</button>)}</div>
          </div>
        )}
        <div>
          <div style={label}>{t('measure_size', lang)}</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{tab.sizes.map(s => <button key={s} type="button" onClick={() => setSize(s)} style={{ ...chipBtn(size === s), minWidth: 52 }}>{s}</button>)}</div>
        </div>
        {spec.factories.length > 1 && (
          <div>
            <div style={label}>{t('measure_factory', lang)}</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{spec.factories.map(f => <button key={f.id} type="button" onClick={() => setMfrId(f.id)} style={chipBtn(mfrId === f.id)}>{f.name}</button>)}</div>
          </div>
        )}

        {resumed && sum.filled > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 14, color: '#166534', background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 12, padding: '8px 12px' }}>
            <span style={{ flex: 1, minWidth: 0 }}>{t('measure_resumed', lang)} {t('measure_filled', lang, { filled: sum.filled, total: sum.total })}</span>
            <button type="button" onClick={startAgain} style={{ background: 'none', border: 'none', color: T.info, fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', minHeight: 36 }}>{t('measure_start_again', lang)}</button>
          </div>
        )}
        {lastDone && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 14, color: T.text, background: '#fff', border: `1px solid ${T.border}`, borderRadius: 12, padding: '8px 12px' }}>
            <span style={{ flex: 1, minWidth: 0 }}>{t('measure_last_done', lang, { date: fmtDate(lastDone.at), name: lastDone.byName, filled: lastDone.measuredCount, total: lastDone.points.length })}</span>
            <button type="button" onClick={continueLast} style={{ background: 'none', border: 'none', color: T.info, fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', minHeight: 36 }}>{t('measure_continue_last', lang)}</button>
          </div>
        )}
        <div style={{ background: '#fff', border: `1.5px solid ${recording ? T.danger : T.infoBorder}`, borderRadius: 14, padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <button type="button" disabled={busy === 'reading' || busy === 'photo'} onClick={recording ? finishRecording : startRecording}
            style={{ minHeight: 60, borderRadius: 14, border: 'none', background: recording ? T.danger : T.info, color: '#fff', fontSize: 18, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, cursor: 'pointer', fontFamily: 'inherit', opacity: busy === 'reading' ? 0.6 : 1 }}>
            {recording ? <Square size={20} /> : <Mic size={22} />} {busy === 'reading' ? t('measure_reading', lang) : recording ? t('measure_stop', lang) : t(sum.filled ? 'measure_record_more' : 'measure_record', lang)}
          </button>
          <div style={{ fontSize: 13.5, color: recording ? T.dangerDeep : T.textMuted, lineHeight: 1.45 }}>{recording ? t('measure_listening', lang) : t('measure_hint', lang)}</div>
          {PHOTO_OF_SHEET && !recording && (
            <>
              <label aria-disabled={!!busy} style={{ minHeight: 52, borderRadius: 14, border: `2px solid ${T.info}`, background: '#fff', color: T.info, fontSize: 16, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }}>
                <Camera size={20} /> {busy === 'photo' ? t('measure_photo_reading', lang) : t('measure_photo', lang)}
                <input type="file" accept="image/*" capture="environment" multiple disabled={!!busy} style={{ display: 'none' }} onChange={e => { readPhotos(e.target.files); e.target.value = '' }} />
              </label>
              <div style={{ fontSize: 13.5, color: T.textMuted, lineHeight: 1.45 }}>{t('measure_photo_hint', lang)}</div>
            </>
          )}
          {unplaced.length > 0 && <div style={{ fontSize: 13.5, color: T.warning, background: T.warningBg, border: `1px solid ${T.warningBorder}`, borderRadius: 10, padding: '8px 10px' }}>{t('measure_unplaced', lang, { what: unplaced.map(u => `"${u.heard}"`).join(', ') })}</div>}
        </div>

        <div style={{ background: '#fff', border: `1px solid ${T.border}`, borderRadius: 14, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 78px 96px', gap: 8, padding: '8px 12px', background: '#f1f5f9', fontSize: 12, fontWeight: 600, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            <span>{t('measure_point', lang)}</span><span style={{ textAlign: 'center' }}>{t('measure_required', lang)}</span><span style={{ textAlign: 'center' }}>{t('measure_measured', lang)}</span>
          </div>
          {tab.points.map((p, i) => {
            const raw = values[i] ?? ''; const n = parseTyped(raw); const invalid = String(raw).trim() !== '' && n == null
            const v = judge(p.values[size], p.tol, n)
            const tone = invalid ? T.warning : v.ok === false ? T.danger : v.ok === true ? '#16a34a' : T.border
            return (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 78px 96px', gap: 8, alignItems: 'center', padding: '9px 12px', borderTop: `1px solid ${T.border}`, background: v.ok === false ? '#fef2f2' : '#fff' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14.5, fontWeight: 500, color: T.text, lineHeight: 1.3, overflowWrap: 'anywhere' }}>{p.name}</div>
                  {v.diff != null && <div style={{ fontSize: 12.5, marginTop: 2, fontWeight: 600, color: v.ok === false ? T.dangerDeep : v.ok === true ? '#166534' : T.textMuted, display: 'inline-flex', alignItems: 'center', gap: 4 }}>{v.ok === true && <Check size={12} strokeWidth={3} />}{v.diff === 0 ? 'ok' : `${v.diff > 0 ? '+' : ''}${show(v.diff)}`}</div>}
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 15, fontWeight: 600, color: T.text }}>{show(p.values[size]) || '-'}</div>
                  {p.tol != null && <div style={{ fontSize: 11.5, color: T.textMuted }}>±{show(p.tol)}</div>}
                </div>
                <input value={raw} onChange={e => setValues(x => ({ ...x, [i]: e.target.value }))} inputMode="decimal" aria-label={`${p.name}: ${t('measure_measured', lang)}`} aria-invalid={invalid}
                  style={{ width: '100%', boxSizing: 'border-box', minHeight: 44, borderRadius: 10, border: `2px solid ${tone}`, textAlign: 'center', fontSize: 17, fontWeight: 600, fontFamily: 'inherit', color: T.text, background: '#fff' }} />
              </div>
            )
          })}
        </div>
      </div>
      </div>
      <div style={{ padding: 12, background: '#fff', borderTop: `1px solid ${T.border}`, display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 14, fontWeight: 500, color: T.text }}>
          <span>{t('measure_filled', lang, { filled: sum.filled, total: sum.total })}</span>
          {sum.filled > 0 && <span style={{ color: sum.out ? T.dangerDeep : '#166534', fontWeight: 600 }}>{sum.out ? t('measure_out', lang, { n: sum.out }) : t('measure_all_ok', lang)}</span>}
          {saveState && saveState !== 'offline' && <span style={{ marginLeft: 'auto', fontSize: 12.5, color: T.textMuted, display: 'inline-flex', alignItems: 'center', gap: 4 }}>{saveState === 'saved' && <Check size={12} strokeWidth={3} />}{t(saveState === 'saved' ? 'measure_autosaved' : 'measure_autosaving', lang)}</span>}
        </div>
        {saveState === 'offline' && <div style={{ fontSize: 13, color: T.warning }}>{t('measure_offline', lang)}</div>}
        {note && <div role="alert" style={{ fontSize: 14, color: T.dangerDeep, display: 'flex', gap: 6, alignItems: 'flex-start' }}><AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 2 }} /> {note}</div>}
        <button type="button" onClick={save} disabled={!sum.filled || !mfrId || !!busy || recording}
          style={{ minHeight: 56, borderRadius: 14, border: 'none', background: '#16a34a', color: '#fff', fontSize: 17, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', opacity: (!sum.filled || !mfrId || busy || recording) ? 0.5 : 1 }}>
          {busy === 'saving' ? t('measure_saving', lang) : t('measure_finish', lang)}
        </button>
      </div>
    </>,
  )
}

/**
 * The garments measured on a style, on its page: stage, size, who and when, how many points were outside tolerance, and
 * the workbook. Tradio, the factory and the customer (once shared) see it; whoever may record gets the button; a Tradio
 * admin shares a record with the customer. A coordinator has the button on his simple top instead.
 */
export function MeasuredSection({ order, factoryId = null }) {
  const { currentUser, getDocData } = useApp()
  const caps = capsFor(currentUser)
  const toast = useToast()
  const [sessions, setSessions] = useState(null)
  const [open, setOpen] = useState(null)   // null, or { start } with the garment to open on
  const [busy, setBusy] = useState('')
  const load = () => measurementsApi.list(order.id).then(setSessions).catch(() => setSessions([]))
  useEffect(() => { load() }, [order.id])   // eslint-disable-line react-hooks/exhaustive-deps
  if (caps.isCoord) return null
  const mayRecord = caps.recordMeasurements && (order.assignments || []).length > 0
  if (!mayRecord && !(sessions || []).length) return null
  const get = async s => { setBusy(s.id); try { const d = await getDocData(s.documentId); await saveDataUrl(d.dataUrl, `${order.styleNumber || order.id}-${s.stage}-${s.size}.xlsx`) } catch (e) { toast(e?.message || 'Could not download it', 'error') } finally { setBusy('') } }
  const share = async s => { setBusy(s.id); try { await measurementsApi.release(s.id); toast('Shown to the customer', 'success'); load() } catch (e) { toast(e?.message || 'Could not share it', 'error') } finally { setBusy('') } }
  return (
    <div style={{ marginTop: 16 }}>
      <FlexRow gap={8} style={{ marginBottom: 7 }}>
        <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 9, fontWeight: 700, color: T.textLight, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Measured garments{sessions?.length ? ` · ${sessions.length}` : ''}</div>
        {mayRecord && <Btn size="sm" variant="ghost" onClick={() => setOpen({ start: null })} icon={<Ruler size={11} />}>Measure a garment</Btn>}
      </FlexRow>
      {sessions && sessions.length === 0 && <div style={{ fontSize: 12, color: T.textMuted }}>None yet. Measure a fit, PP or final QC garment against the measurement sheet: speak or type the values and the Excel is made for you.</div>}
      {(sessions || []).length > 0 && (
        <div style={{ border: `1px solid ${T.border}`, borderRadius: 10, background: '#fff', overflow: 'hidden' }}>
          {sessions.map((s, i) => (
            <div key={s.id} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '8px 10px', borderTop: i ? `1px solid ${T.border}` : 'none' }}>
              <div style={{ flex: '1 1 220px', minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{s.stageName} · size {s.size}</div>
                <div style={{ fontSize: 11.5, color: T.textMuted, marginTop: 1 }}>{s.byName}, {fmtDate(s.at)} · {s.measuredCount} of {s.points.length} points{s.method === 'voice' ? ' · by voice' : s.method === 'photo' ? ' · from a photo of the sheet' : ''}</div>
              </div>
              {s.status === 'draft' && <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 8, background: T.warningBg, color: T.warning, border: `1px solid ${T.warningBorder}` }}>in progress</span>}
              <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 8, background: s.outOfTolerance ? T.dangerBg : T.successBg, color: s.outOfTolerance ? T.dangerDeep : T.successDeep, border: `1px solid ${s.outOfTolerance ? T.dangerBorder : T.successBorder}` }}>{s.outOfTolerance ? `${s.outOfTolerance} outside tolerance` : s.status === 'draft' ? 'within tolerance so far' : 'all within tolerance'}</span>
              {s.status === 'draft' && mayRecord && <Btn size="sm" variant="secondary" onClick={() => setOpen({ start: s })} icon={<Ruler size={12} />}>Continue</Btn>}
              {!caps.isBuyer && s.status !== 'draft' && (s.released ? <span style={{ fontSize: 11, color: T.successDeep, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}><Eye size={11} /> shown to the customer</span> : <span style={{ fontSize: 11, color: T.textLight }}>not shown to the customer yet</span>)}
              {s.documentId && <Btn size="sm" variant="secondary" disabled={busy === s.id} onClick={() => get(s)} icon={<Download size={12} />}>Excel</Btn>}
              {caps.shareMeasurements && !s.released && <Btn size="sm" variant="secondary" disabled={busy === s.id} onClick={() => share(s)} icon={<Eye size={12} />}>Show to customer</Btn>}
            </div>
          ))}
        </div>
      )}
      {open && <MeasureSheet order={order} factoryId={open.start?.mfrId || factoryId} start={open.start} onClose={() => { setOpen(null); load() }} onSaved={load} />}
    </div>
  )
}
