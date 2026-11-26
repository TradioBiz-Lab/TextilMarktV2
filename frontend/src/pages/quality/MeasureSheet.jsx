import { useEffect, useRef, useState } from 'react'
import { Mic, Square, X, Check, AlertTriangle, Ruler, Download, Eye, CheckCircle2 } from '../../icons.jsx'
import { T, fmtDate } from '../../constants.js'
import { useApp } from '../../context.jsx'
import { capsFor } from '../../caps.js'
import { t, langOf } from '../../coordinatorText.js'
import { measurementsApi, voiceApi } from '../../api.js'
import { useVoiceRecorder } from '../../useVoiceRecorder.js'
import { blobToDataUrl, Btn, FlexRow, useToast } from '../../components/ui.jsx'
import { STAGES, tabForStage, defaultSize, keyTerms, parseTyped, judge, mergeRead, summary, pointsPayload, show } from '../../measure.js'

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
export function MeasureSheet({ order, factoryId = null, onClose, onSaved }) {
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
  const [unplaced, setUnplaced] = useState([])
  const [busy, setBusy] = useState('')              // '' | 'reading' | 'saving' | 'download'
  const [note, setNote] = useState('')
  const [saved, setSaved] = useState(null)
  const recorder = useVoiceRecorder()
  const stopTimer = useRef(null)
  const recording = recorder.state === 'recording'

  useEffect(() => {
    let dead = false
    measurementsApi.spec(order.id).then(s => {
      if (dead) return
      setSpec(s)
      const first = s.tabs.find(x => x.stage === 'fit') ? 'fit' : (s.tabs[0]?.stage || 'fit')
      const tab = tabForStage(s.tabs, first)
      setStage(first); setTabName(tab?.name || ''); setSize(defaultSize(tab))
      setMfrId(m => (m && s.factories.some(f => f.id === m) ? m : (s.factories[0]?.id || '')))
    }).catch(e => { if (!dead) setLoadError(e?.message || t('failed', lang)) })
    return () => { dead = true; clearTimeout(stopTimer.current); recorder.cancel() }
  }, [order.id])   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (recorder.state === 'error') setNote(t('mic_blocked', lang)) }, [recorder.state])   // eslint-disable-line react-hooks/exhaustive-deps

  const tab = spec?.tabs.find(x => x.name === tabName) || null
  const sum = summary(tab, size, values)
  // A new stage, tab or size is a new garment: what was filled in belongs to the old one.
  const fresh = () => { setValues({}); setTranscript(''); setSpoke(false); setUnplaced([]); setNote('') }
  const pickStage = s => { const next = tabForStage(spec.tabs, s); setStage(s); setTabName(next?.name || ''); if (next && !next.sizes.includes(size)) setSize(defaultSize(next)); fresh() }

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
  const startRecording = async () => {
    setNote(''); recorder.unlock?.()
    await recorder.start()
    stopTimer.current = setTimeout(finishRecording, MAX_RECORD_MS)
  }
  const save = async () => {
    if (sum.bad) { setNote(t('measure_bad_number', lang)); return }
    setBusy('saving'); setNote('')
    try {
      const r = await measurementsApi.save({ orderId: order.id, mfrId, stage, size, tab: tab.name, points: pointsPayload(tab, values), transcript, method: spoke ? 'voice' : 'typed' })
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
          <button type="button" onClick={() => { setSaved(null); fresh() }} style={{ ...chipBtn(false), flex: 1 }}>{t('measure_another', lang)}</button>
          <button type="button" onClick={onClose} style={{ ...chipBtn(true), flex: 1 }}>{t('measure_done', lang)}</button>
        </FlexRow>
      </div>,
    )
  }

  return shell(
    <>
      <div style={{ flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <div style={label}>{t('measure_stage', lang)}</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{STAGES.map(s => <button key={s} type="button" onClick={() => pickStage(s)} style={chipBtn(stage === s)}>{t(`measure_stage_${s}`, lang)}</button>)}</div>
        </div>
        {spec.tabs.length > 1 && (
          <div>
            <div style={label}>{t('measure_sheet', lang)}</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{spec.tabs.map(x => <button key={x.name} type="button" onClick={() => { setTabName(x.name); if (!x.sizes.includes(size)) setSize(defaultSize(x)); fresh() }} style={chipBtn(tabName === x.name)}>{x.name}</button>)}</div>
          </div>
        )}
        <div>
          <div style={label}>{t('measure_size', lang)}</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{tab.sizes.map(s => <button key={s} type="button" onClick={() => { setSize(s); fresh() }} style={{ ...chipBtn(size === s), minWidth: 52 }}>{s}</button>)}</div>
        </div>
        {spec.factories.length > 1 && (
          <div>
            <div style={label}>{t('measure_factory', lang)}</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{spec.factories.map(f => <button key={f.id} type="button" onClick={() => setMfrId(f.id)} style={chipBtn(mfrId === f.id)}>{f.name}</button>)}</div>
          </div>
        )}

        <div style={{ background: '#fff', border: `1.5px solid ${recording ? T.danger : T.infoBorder}`, borderRadius: 14, padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <button type="button" disabled={busy === 'reading'} onClick={recording ? finishRecording : startRecording}
            style={{ minHeight: 60, borderRadius: 14, border: 'none', background: recording ? T.danger : T.info, color: '#fff', fontSize: 18, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, cursor: 'pointer', fontFamily: 'inherit', opacity: busy === 'reading' ? 0.6 : 1 }}>
            {recording ? <Square size={20} /> : <Mic size={22} />} {busy === 'reading' ? t('measure_reading', lang) : recording ? t('measure_stop', lang) : t(sum.filled ? 'measure_record_more' : 'measure_record', lang)}
          </button>
          <div style={{ fontSize: 13.5, color: recording ? T.dangerDeep : T.textMuted, lineHeight: 1.45 }}>{recording ? t('measure_listening', lang) : t('measure_hint', lang)}</div>
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
      <div style={{ padding: 12, background: '#fff', borderTop: `1px solid ${T.border}`, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 14, fontWeight: 500, color: T.text }}>
          <span>{t('measure_filled', lang, { filled: sum.filled, total: sum.total })}</span>
          {sum.filled > 0 && <span style={{ color: sum.out ? T.dangerDeep : '#166534', fontWeight: 600 }}>{sum.out ? t('measure_out', lang, { n: sum.out }) : t('measure_all_ok', lang)}</span>}
        </div>
        {note && <div role="alert" style={{ fontSize: 14, color: T.dangerDeep, display: 'flex', gap: 6, alignItems: 'flex-start' }}><AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 2 }} /> {note}</div>}
        <button type="button" onClick={save} disabled={!sum.filled || !mfrId || !!busy || recording}
          style={{ minHeight: 56, borderRadius: 14, border: 'none', background: '#16a34a', color: '#fff', fontSize: 17, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', opacity: (!sum.filled || !mfrId || busy || recording) ? 0.5 : 1 }}>
          {busy === 'saving' ? t('measure_saving', lang) : t('measure_save', lang)}
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
  const [open, setOpen] = useState(false)
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
        {mayRecord && <Btn size="sm" variant="ghost" onClick={() => setOpen(true)} icon={<Ruler size={11} />}>Measure a garment</Btn>}
      </FlexRow>
      {sessions && sessions.length === 0 && <div style={{ fontSize: 12, color: T.textMuted }}>None yet. Measure a fit, PP or final QC garment against the measurement sheet: speak or type the values and the Excel is made for you.</div>}
      {(sessions || []).length > 0 && (
        <div style={{ border: `1px solid ${T.border}`, borderRadius: 10, background: '#fff', overflow: 'hidden' }}>
          {sessions.map((s, i) => (
            <div key={s.id} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '8px 10px', borderTop: i ? `1px solid ${T.border}` : 'none' }}>
              <div style={{ flex: '1 1 220px', minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{s.stageName} · size {s.size}</div>
                <div style={{ fontSize: 11.5, color: T.textMuted, marginTop: 1 }}>{s.byName}, {fmtDate(s.at)} · {s.measuredCount} of {s.points.length} points{s.method === 'voice' ? ' · by voice' : ''}</div>
              </div>
              <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 8, background: s.outOfTolerance ? T.dangerBg : T.successBg, color: s.outOfTolerance ? T.dangerDeep : T.successDeep, border: `1px solid ${s.outOfTolerance ? T.dangerBorder : T.successBorder}` }}>{s.outOfTolerance ? `${s.outOfTolerance} outside tolerance` : 'all within tolerance'}</span>
              {!caps.isBuyer && (s.released ? <span style={{ fontSize: 11, color: T.successDeep, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}><Eye size={11} /> shown to the customer</span> : <span style={{ fontSize: 11, color: T.textLight }}>not shown to the customer yet</span>)}
              {s.documentId && <Btn size="sm" variant="secondary" disabled={busy === s.id} onClick={() => get(s)} icon={<Download size={12} />}>Excel</Btn>}
              {caps.shareMeasurements && !s.released && <Btn size="sm" variant="secondary" disabled={busy === s.id} onClick={() => share(s)} icon={<Eye size={12} />}>Show to customer</Btn>}
            </div>
          ))}
        </div>
      )}
      {open && <MeasureSheet order={order} factoryId={factoryId} onClose={() => setOpen(false)} onSaved={load} />}
    </div>
  )
}
