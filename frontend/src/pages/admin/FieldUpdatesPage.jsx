import { useEffect, useState, useCallback } from 'react'
import { MapPin, Factory, Clock, RefreshCw, Check, Mic, Image as ImageIcon, X, Sparkles, ArrowUpRight, Eye } from '../../icons.jsx'
import { T, fmtDate } from '../../constants.js'
import { PageHeader, Card, Select, Btn, EmptyState, LoadingScreen, Alert, Modal, FlexRow, useToast } from '../../components/ui.jsx'
import { fieldUpdatesApi } from '../../api.js'
import { useApp } from '../../context.jsx'
import { useNavState } from '../../navState.js'
import { timeIST } from '../../visits.js'
import { suggestionsFor, stageOfUpdate, waitingText, isStale } from '../../fieldUpdates.js'

// A photo or the recording of an update, fetched when its card is on screen.
function useFile(id, getDocData) {
  const [url, setUrl] = useState(null)
  useEffect(() => { let dead = false; getDocData(id).then(d => { if (!dead) setUrl(d?.dataUrl || null) }).catch(() => {}); return () => { dead = true } }, [id, getDocData])
  return url
}
function Photo({ file, getDocData, onOpen }) {
  const url = useFile(file.id, getDocData)
  return (
    <button type="button" onClick={() => url && onOpen(url)} title={file.internal ? 'Not shown to the customer' : 'Shown to the customer'}
      style={{ position: 'relative', width: 92, height: 92, borderRadius: 10, overflow: 'hidden', border: `1px solid ${T.border}`, background: '#f1f5f9', padding: 0, cursor: url ? 'zoom-in' : 'default', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {url ? <img src={url} alt={file.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <ImageIcon size={22} color={T.textLight} />}
      {!file.internal && <span style={{ position: 'absolute', left: 4, bottom: 4, background: '#15803d', color: '#fff', borderRadius: 8, padding: '1px 6px', fontSize: 9, fontWeight: 800 }}>Shared</span>}
    </button>
  )
}
function Recording({ file, getDocData }) {
  const [play, setPlay] = useState(false)
  return play ? <RecordingPlayer file={file} getDocData={getDocData} />
    : <Btn size="sm" variant="secondary" onClick={() => setPlay(true)} icon={<Mic size={12} />}>Play his recording</Btn>
}
function RecordingPlayer({ file, getDocData }) {
  const url = useFile(file.id, getDocData)
  return url ? <audio controls autoPlay src={url} style={{ height: 34, maxWidth: '100%' }} /> : <span style={{ fontSize: 12, color: T.textMuted }}>Loading the recording…</span>
}

// Choose which photos the customer sees. His words go with them; the recording never does.
function ReleaseModal({ update, getDocData, onClose, onDone }) {
  const photos = update.files.filter(f => f.kind === 'photo')
  const [picked, setPicked] = useState(() => photos.map(f => f.id))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const go = async () => {
    setBusy(true); setErr('')
    try { onDone(await fieldUpdatesApi.release(update.id, picked)) } catch (e) { setErr(e?.message || 'Could not share it'); setBusy(false) }
  }
  return (
    <Modal title="Show this update to the customer?" subtitle={`${update.buyerCompany || 'The customer'} · ${update.product || update.orderId} · ${update.stageName}`} onClose={() => !busy && onClose()}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 13, color: T.text, lineHeight: 1.5 }}>The customer will see his words on the step{photos.length ? ' and the photos you leave ticked' : ''}, and is told about it. The voice recording is never shared. This cannot be taken back from here.</div>
        {update.text && <div style={{ fontSize: 13, color: T.text, background: '#f8fafc', border: `1px solid ${T.border}`, borderRadius: 8, padding: '8px 10px', whiteSpace: 'pre-wrap' }}>{update.text}</div>}
        {photos.length > 0 && (
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {photos.map(f => (
              <label key={f.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                <Photo file={f} getDocData={getDocData} onOpen={() => {}} />
                <input type="checkbox" checked={picked.includes(f.id)} onChange={() => setPicked(p => (p.includes(f.id) ? p.filter(x => x !== f.id) : [...p, f.id]))} />
              </label>
            ))}
          </div>
        )}
        {err && <Alert type="danger">{err}</Alert>}
        <FlexRow justify="flex-end" gap={8}>
          <Btn variant="secondary" disabled={busy} onClick={onClose}>Cancel</Btn>
          <Btn disabled={busy} onClick={go} icon={<Eye size={13} />}>{busy ? 'Sharing…' : 'Show to customer'}</Btn>
        </FlexRow>
      </div>
    </Modal>
  )
}

const chip = (bg, fg, bd) => ({ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, padding: '5px 10px', borderRadius: 10, background: bg, color: fg, border: `1px solid ${bd}` })

function UpdateCard({ u, onChange, onOpenStyle, onZoom }) {
  const { orders, getDocData, updateStage, refreshFieldWaiting } = useApp()
  const toast = useToast()
  const [busy, setBusy] = useState('')
  const [releasing, setReleasing] = useState(false)
  const { stage, stages } = stageOfUpdate(orders, u)
  const suggestions = suggestionsFor(u, stage, stages)
  const photos = u.files.filter(f => f.kind === 'photo'); const voice = u.files.find(f => f.kind === 'audio')
  const done = u.state !== 'new'

  const run = async (key, fn, okMsg) => {
    setBusy(key)
    try { onChange(await fn()); refreshFieldWaiting(); if (okMsg) toast(okMsg, 'success') }
    catch (e) { toast(e?.message || 'That did not work', 'error') }
    finally { setBusy('') }
  }
  // A confirmed suggestion goes through the same stage route an admin's own edit uses, then the update is marked dealt with.
  const confirm = s => run(s.key, async () => {
    if (s.kind === 'move') return fieldUpdatesApi.move(u.id, s.toIndex)
    await updateStage(u.orderId, u.factoryId, u.stageIndex, s.apply)
    return fieldUpdatesApi.action(u.id, [s.label])
  }, s.kind === 'move' ? 'Moved' : 'Step updated')

  return (
    <Card style={{ opacity: done ? 0.75 : 1, borderLeft: `4px solid ${done ? T.border : isStale(u.waitingMinutes) ? T.danger : T.primary}` }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 240px', minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: T.text }}>{u.buyerCompany || 'Customer'} · {u.product || u.orderId}</div>
            <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>{u.styleNumber ? `${u.styleNumber} · ` : ''}{u.orderId}</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6, alignItems: 'center' }}>
              <span style={chip(T.infoBg, T.info, T.infoBorder)}>{u.stageName}</span>
              {u.movedFromStageIndex != null && <span style={{ fontSize: 11, color: T.textLight }}>moved from {stages[u.movedFromStageIndex]?.name || `step ${u.movedFromStageIndex + 1}`}</span>}
              {stage && <span style={{ fontSize: 11, color: T.textLight }}>{stage.status === 'done' ? 'done' : stage.status === 'in_progress' ? 'in progress' : 'not started'}{stage.kind === 'quantity' && stage.totalUnits ? `, ${stage.unitsDone || 0} of ${stage.totalUnits}` : ''}{stage.blocked ? ', blocked' : ''}</span>}
            </div>
          </div>
          <div style={{ fontSize: 12, color: T.textMuted, textAlign: 'right', display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'flex-end' }}>
            <span style={{ fontWeight: 700, color: T.text }}>{u.coordinatorName}</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Factory size={12} /> {u.factoryName}</span>
            <span>{fmtDate(u.at)}, {timeIST(u.at)}</span>
            {u.place
              ? <a href={u.place.mapsUrl} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: T.info, fontWeight: 600, textDecoration: 'none' }}><MapPin size={12} /> Where he was{u.place.accuracy != null ? ` (±${u.place.accuracy} m)` : ''}</a>
              : <span style={{ color: T.textLight }}>no location with this update</span>}
            {u.visitAway === true && <span style={{ ...chip(T.dangerBg, T.dangerDeep, T.dangerBorder), fontSize: 10, padding: '1px 7px' }}>checked in away from the factory</span>}
            {u.state === 'new' && <span style={{ ...chip(isStale(u.waitingMinutes) ? T.dangerBg : T.warningBg, isStale(u.waitingMinutes) ? T.dangerDeep : T.warning, isStale(u.waitingMinutes) ? T.dangerBorder : T.warningBorder), fontSize: 10, padding: '1px 7px' }}><Clock size={10} /> waiting {waitingText(u.waitingMinutes)}</span>}
          </div>
        </div>

        {u.text && <div style={{ fontSize: 14, color: T.text, lineHeight: 1.5, whiteSpace: 'pre-wrap', background: '#f8fafc', border: `1px solid ${T.border}`, borderRadius: 10, padding: '10px 12px' }}>{u.text}{u.viaVoice && <span style={{ display: 'block', fontSize: 11, color: T.textLight, marginTop: 4 }}>Written from what he said. Play the recording if a number or a name looks wrong.</span>}</div>}
        {(photos.length > 0 || voice) && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {photos.map(f => <Photo key={f.id} file={f} getDocData={getDocData} onOpen={onZoom} />)}
            {voice && <Recording file={voice} getDocData={getDocData} />}
          </div>
        )}

        {u.ai.state === 'done' && (
          <div style={{ border: `1px solid ${T.border}`, borderRadius: 10, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 11, fontWeight: 800, color: T.master, textTransform: 'uppercase', letterSpacing: '0.06em', display: 'flex', alignItems: 'center', gap: 5 }}><Sparkles size={12} /> Read by AI{u.ai.confidence != null && u.ai.confidence < 0.6 ? ' · unsure, please check' : ''}</div>
            {u.ai.summary && <div style={{ fontSize: 13, color: T.text }}>{u.ai.summary}</div>}
            {suggestions.length === 0 && <div style={{ fontSize: 12, color: T.textMuted }}>Nothing to change on the plan from this.</div>}
            {suggestions.map(s => (
              <div key={s.key} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={chip(s.kind === 'info' ? '#f1f5f9' : T.masterBg, s.kind === 'info' ? T.textMuted : T.master, s.kind === 'info' ? T.border : '#c4b5fd')}>{s.label}</span>
                {s.was && <span style={{ fontSize: 11, color: T.textLight }}>{s.was}</span>}
                {s.kind === 'info' && s.why && <span style={{ fontSize: 11, color: T.textLight }}>{s.why}</span>}
                {/* One update can carry several things to confirm (a count and an issue): each stays confirmable until it has been, even after the update is marked dealt with. */}
                {s.kind !== 'info' && u.state !== 'dismissed' && !u.applied.includes(s.label) && <Btn size="sm" disabled={!!busy} onClick={() => confirm(s)} icon={<Check size={12} strokeWidth={3} />}>{busy === s.key ? 'Working…' : 'Confirm'}</Btn>}
                {u.applied.includes(s.label) && <span style={{ fontSize: 11, fontWeight: 700, color: T.successDeep }}>confirmed</span>}
              </div>
            ))}
          </div>
        )}
        {u.ai.state === 'pending' && <div style={{ fontSize: 12, color: T.textMuted }}>AI is reading this update. Refresh in a moment for its suggestions.</div>}
        {u.ai.state === 'failed' && <div style={{ fontSize: 12, color: T.textMuted }}>AI could not read this one. Read it and update the step yourself.</div>}

        {u.applied.length > 0 && <div style={{ fontSize: 12, color: T.successDeep, fontWeight: 600 }}>Done: {u.applied.join('; ')}{u.actionedByName ? ` (${u.actionedByName})` : ''}</div>}
        {u.state === 'dismissed' && <div style={{ fontSize: 12, color: T.textMuted }}>Dismissed{u.actionedByName ? ` by ${u.actionedByName}` : ''}</div>}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', borderTop: `1px solid ${T.border}`, paddingTop: 10 }}>
          <Btn size="sm" variant="secondary" onClick={() => onOpenStyle(u.orderId, u.factoryId)} icon={<ArrowUpRight size={12} />}>Open the style</Btn>
          {stages.length > 1 && !done && (
            <select value="" disabled={!!busy} onChange={e => e.target.value !== '' && run('move', () => fieldUpdatesApi.move(u.id, Number(e.target.value)), 'Moved')} aria-label="Move to another step"
              style={{ border: `1px solid ${T.border}`, borderRadius: 8, padding: '5px 8px', fontSize: 12, fontFamily: 'inherit', color: T.text, background: '#f8fafc', maxWidth: 190 }}>
              <option value="">Move to another step…</option>
              {stages.map((s, i) => i !== u.stageIndex && <option key={i} value={i}>{s.name}</option>)}
            </select>
          )}
          {u.released
            ? <span style={chip(T.successBg, T.successDeep, T.successBorder)}><Eye size={12} /> Shown to the customer</span>
            : <Btn size="sm" variant="secondary" disabled={!!busy} onClick={() => setReleasing(true)} icon={<Eye size={12} />}>Show to customer</Btn>}
          <div style={{ flex: 1 }} />
          {!done && <Btn size="sm" variant="ghost" disabled={!!busy} onClick={() => run('dismiss', () => fieldUpdatesApi.dismiss(u.id))} icon={<X size={12} />}>Dismiss</Btn>}
          {!done && <Btn size="sm" variant="success" disabled={!!busy} onClick={() => run('done', () => fieldUpdatesApi.action(u.id), 'Marked as dealt with')} icon={<Check size={12} strokeWidth={3} />}>Dealt with</Btn>}
          {done && <Btn size="sm" variant="ghost" disabled={!!busy} onClick={() => run('reopen', () => fieldUpdatesApi.reopen(u.id))}>Put back in the queue</Btn>}
        </div>
      </div>
      {releasing && <ReleaseModal update={u} getDocData={getDocData} onClose={() => setReleasing(false)} onDone={x => { setReleasing(false); onChange(x); toast('Shown to the customer', 'success') }} />}
    </Card>
  )
}

/**
 * The account manager's inbox of updates from the factory floor. Each card is what a coordinator saw on one step, with
 * what the AI made of it. Confirming a suggestion changes the step through the ordinary admin route; nothing reaches
 * the plan, or the customer, without an admin's tap here.
 */
export function FieldUpdatesPage({ onOpenStyle }) {
  const { setFieldWaiting } = useApp()
  const [state, setState] = useNavState('fieldUpdates.state', 'new')
  const [factoryId, setFactoryId] = useNavState('fieldUpdates.factory', '')
  const [buyerId, setBuyerId] = useNavState('fieldUpdates.buyer', '')
  const [coordinatorId, setCoordinatorId] = useNavState('fieldUpdates.coordinator', '')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [zoom, setZoom] = useState(null)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const r = await fieldUpdatesApi.list({ ...(state ? { state } : {}), ...(factoryId ? { factoryId } : {}), ...(buyerId ? { buyerId } : {}), ...(coordinatorId ? { coordinatorId } : {}) })
      setData(r); setFieldWaiting(r.waiting || 0)
    } catch (e) { setError(e?.message || 'Could not load the updates') } finally { setLoading(false) }
  }, [state, factoryId, buyerId, coordinatorId, setFieldWaiting])
  useEffect(() => { load() }, [load])

  if (!data && loading) return <LoadingScreen />
  const updates = data?.updates || []
  // The filter choices come from what is on screen plus what is picked, so a filter never empties its own list.
  const options = (idKey, nameKey) => [...new Map(updates.map(u => [u[idKey], u[nameKey]]).filter(([id]) => id)).entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1])))
  const replace = x => setData(d => ({ ...d, updates: d.updates.map(u => (u.id === x.id ? x : u)) }))

  return (
    <div>
      <PageHeader title="Field Updates" subtitle="What the coordinators report from the factory floor. Confirm what should change on the plan; share with the customer what they should see."
        action={<Btn variant="secondary" onClick={load} disabled={loading} icon={<RefreshCw size={13} />}>Refresh</Btn>} />
      <Card style={{ marginBottom: 14 }}>
        <div className="form-grid-2" style={{ gap: 12 }}>
          <Select label="Show" value={state} onChange={e => setState(e.target.value)}>
            <option value="new">Waiting ({data?.waiting ?? 0})</option>
            <option value="actioned">Dealt with</option>
            <option value="dismissed">Dismissed</option>
            <option value="">All</option>
          </Select>
          <Select label="Factory" value={factoryId} onChange={e => setFactoryId(e.target.value)}>
            <option value="">All factories</option>
            {options('factoryId', 'factoryName').map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </Select>
          <Select label="Customer" value={buyerId} onChange={e => setBuyerId(e.target.value)}>
            <option value="">All customers</option>
            {options('buyerId', 'buyerCompany').map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </Select>
          <Select label="Coordinator" value={coordinatorId} onChange={e => setCoordinatorId(e.target.value)}>
            <option value="">All coordinators</option>
            {options('coordinatorId', 'coordinatorName').map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </Select>
        </div>
      </Card>
      {error && <div style={{ marginBottom: 14 }}><Alert type="danger">{error}</Alert></div>}
      {updates.length === 0 && !loading && <Card><EmptyState icon={<Check size={26} color={T.textLight} />} title={state === 'new' ? 'Nothing is waiting' : 'No updates here'} desc={state === 'new' ? 'New updates from the coordinators appear here as they send them.' : 'Change the filters above.'} /></Card>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {updates.map(u => <UpdateCard key={u.id} u={u} onChange={replace} onOpenStyle={onOpenStyle} onZoom={setZoom} />)}
      </div>
      {zoom && (
        <div role="dialog" aria-modal="true" onClick={() => setZoom(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.85)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, cursor: 'zoom-out' }}>
          <img src={zoom} alt="" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: 6 }} />
        </div>
      )}
    </div>
  )
}
