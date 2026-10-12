import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Plus, Trash2, Check, Download, ReceiveGoods, Camera, Sparkles } from '../../icons.jsx'
import { T } from '../../constants.js'
import { Btn, Card, Alert, Input, Textarea, SectionLabel, LoadingScreen, FlexRow, FileViewer, blobToDataUrl, useToast } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'
import { capsFor } from '../../caps.js'
import { grnsApi } from '../../api.js'
import { posStore, suppliersStore } from '../../stores/procurement.jsx'
import { stockStore, grnsStore } from '../../stores/inventory.jsx'
import { fmtQty, fmtDay, OPEN_STATUSES, poStatusLabel } from '../../lib/procurement.js'
import {
  decimal, blankLine, formFromGrn, payloadFromForm, formKey, readiness, lineHint, suggestItems, acceptedOf, adoptIds, grnStateLabel, SOURCE_LABEL, stockMatch,
} from '../../lib/inventory.js'
import { Pill, Progress } from '../procurement/common.jsx'
import { PhotoStrip } from './PhotoStrip.jsx'
import { compressImage } from '../../lib/imageCompress.js'

const UNITS = ['kg', 'm', 'pcs', 'yds', 'set', 'roll', 'cone', 'box', 'carton']
const TONE = { good: { bg: T.successBg, c: T.successDeep || T.success }, warn: { bg: T.warningBg, c: T.warning }, bad: { bg: T.dangerBg, c: T.dangerDeep || T.danger }, info: { bg: T.infoBg, c: T.info } }

/**
 * Receive goods. Built for someone standing at the gate with a phone: photograph the challan first, type what
 * arrived beside what was ordered, and post. The note is a draft on the server from the first moment (so
 * photos are kept as they are taken, and a half-finished note is still there on another phone); every change is
 * saved a moment after it is typed. Posting is what adds to stock.
 *
 *   grnId   an existing note to open
 *   poId    start a note against this purchase order (its outstanding lines are filled in)
 *   neither shows the choice: against a PO, or without one
 */
export function GrnPage({ grnId, poId, onBack, onNavigate }) {
  const toast = useToast()
  const { currentUser } = useApp()
  const caps = capsFor(currentUser)
  const { items: pos, refresh: refreshPos } = posStore.useStore()
  const { items: suppliers } = suppliersStore.useStore()
  const stock = stockStore.useStore()
  const grns = grnsStore.useStore()

  const [phase, setPhase] = useState(grnId || poId ? 'loading' : 'choose')
  const [grn, setGrn] = useState(null)
  const [form, setForm] = useState(null)
  const [photos, setPhotos] = useState([])
  const [error, setError] = useState('')
  const [save, setSave] = useState('saved')        // saved | saving | failed
  const [posting, setPosting] = useState(false)
  const [done, setDone] = useState(null)           // what posting returned
  const [pdf, setPdf] = useState(null)
  const [starting, setStarting] = useState(false)
  const [scanning, setScanning] = useState(false)
  const scanCam = useRef(null)
  const scanFileInput = useRef(null)

  const savedKey = useRef('')
  const formRef = useRef(null)
  const grnRef = useRef(null)
  formRef.current = form
  grnRef.current = grn
  const pending = useRef(null)

  const adopt = useCallback(g => {
    const f = formFromGrn(g)
    setGrn(g); setForm(f); setPhotos(g.photos || []); setPhase('edit'); setError('')
    savedKey.current = formKey(f)
    setSave('saved')
  }, [])

  // Open the note, or begin one against a PO.
  useEffect(() => {
    if (!grnId && !poId) return undefined
    let dead = false
    ;(async () => {
      try {
        let g
        if (grnId) g = await grnsApi.get(grnId)
        else { pending.current ||= grnsApi.create({ poId }); g = await pending.current; grns.refresh() }
        if (!dead) adopt(g)
      } catch (e) { if (!dead) { setError(e?.message || 'This note could not be opened'); setPhase('error') } }
    })()
    return () => { dead = true }
  }, [grnId, poId]) // eslint-disable-line react-hooks/exhaustive-deps

  const start = async po => {
    setStarting(true); setError('')
    try { const g = await grnsApi.create(po ? { poId: po.id } : {}); adopt(g); grns.refresh() }
    catch (e) { setError(e?.message || 'Could not start a note') } finally { setStarting(false) }
  }

  // A photo or PDF of the supplier's challan: it is read, and a draft note is made for the person to check.
  const scanFile = async file => {
    if (!file) return
    setScanning(true); setError('')
    try {
      const isPdf = file.type === 'application/pdf'
      if (!isPdf && !file.type.startsWith('image/')) throw new Error('Choose a photo or a PDF')
      if (isPdf && file.size > 6 * 1024 * 1024) throw new Error('That PDF is too large. Try a photo of the paper instead')
      const dataUrl = await blobToDataUrl(isPdf ? file : await compressImage(file, { maxEdge: 2000, quality: 0.85, minBytes: 300 * 1024 }))
      const g = await grnsApi.scan({ dataUrl })
      adopt(g); grns.refresh()
    } catch (e) { setError(e?.message || 'The document could not be read. Try again, or start the note by hand') } finally { setScanning(false) }
  }

  const isDraft = grn?.status === 'draft'
  const dirty = !!form && isDraft && formKey(form) !== savedKey.current

  // Save a moment after the last change.
  const saveNow = useCallback(async () => {
    const f = formRef.current, g = grnRef.current
    if (!f || !g || g.status !== 'draft') return true
    if (formKey(f) === savedKey.current) return true
    setSave('saving')
    try {
      const sent = await grnsApi.update(g.id, payloadFromForm(f))
      const next = adoptIds(f, sent.lines)
      savedKey.current = formKey(next)
      const byKey = new Map(next.lines.map(l => [l.key, l]))
      setForm(cur => ({ ...cur, lines: cur.lines.map(l => { const n = byKey.get(l.key); return n && !l.lineId ? { ...l, lineId: n.lineId, itemId: n.itemId, unit: n.unit } : l }) }))
      setGrn(prev => ({ ...prev, po: sent.po || prev.po, updatedAt: sent.updatedAt }))
      setSave('saved'); setError('')
      return true
    } catch (e) { setSave('failed'); setError(e?.message || 'Your changes could not be saved'); return false }
  }, [])
  useEffect(() => {
    if (!dirty) return undefined
    setSave('saving')
    const t = setTimeout(() => { saveNow() }, 800)
    return () => clearTimeout(t)
  }, [form]) // eslint-disable-line react-hooks/exhaustive-deps

  const set = patch => setForm(f => ({ ...f, ...patch }))
  const setLine = (key, patch) => setForm(f => ({ ...f, lines: f.lines.map(l => (l.key === key ? { ...l, ...patch } : l)) }))
  const addLine = () => setForm(f => ({ ...f, lines: [...f.lines, blankLine()] }))
  const removeLine = key => setForm(f => ({ ...f, lines: f.lines.filter(l => l.key !== key) }))

  const poLines = useMemo(() => new Map((grn?.po?.lines || []).map(l => [l.lineId, l])), [grn?.po])
  const ready = form ? readiness(form) : { ok: false }
  const stockItems = stock.items.items

  const fillAll = () => setForm(f => ({ ...f, lines: f.lines.map(l => { const p = poLines.get(l.poLineId); return p && p.outstanding > 0 ? { ...l, qty: String(p.outstanding) } : l }) }))

  const post = async () => {
    if (!(await saveNow())) return
    setPosting(true); setError('')
    try {
      const posted = await grnsApi.post(grn.id)
      adopt(await grnsApi.get(posted.id))
      setDone({ number: posted.number, po: posted.po ? { id: posted.po.id, status: posted.po.status } : null, notice: posted.notice })
      toast(`Goods received: ${posted.number}`, 'success')
      grns.refresh(); stock.refresh(); refreshPos()
    } catch (e) { setError(e?.message || 'The note could not be posted'); setSave('saved') } finally { setPosting(false) }
  }

  const leave = async () => {
    // An untouched draft (nothing typed, no photo) is not worth keeping.
    if (grn?.status === 'draft' && form && photos.length === 0 && payloadFromForm(form).lines.length === 0 && !form.challanNo.trim() && !form.note.trim()) {
      try { await grnsApi.remove(grn.id); grns.refresh() } catch { /* a stray empty draft is harmless */ }
    } else if (dirty) await saveNow()
    onBack()
  }

  const discard = async () => {
    if (!window.confirm('Throw this draft away? The photos go with it.')) return
    try { await grnsApi.remove(grn.id); grns.refresh(); toast('Draft deleted', 'success'); onBack() } catch (e) { setError(e?.message || 'The draft could not be deleted') }
  }

  const openPdf = async () => {
    try { setPdf(await grnsApi.pdf(grn.id)) } catch (e) { toast(e?.message || 'Could not open the PDF', 'error') }
  }

  // The bar that pins to the bottom on a phone (and lifts the Kriyaa button above it).
  const showBar = phase === 'edit' && isDraft
  useEffect(() => {
    if (!showBar) return undefined
    document.body.classList.add('has-action-bar')
    return () => document.body.classList.remove('has-action-bar')
  }, [showBar])

  const back = (
    <Btn variant="secondary" size="sm" icon={<ArrowLeft size={13} />} onClick={phase === 'edit' ? leave : onBack}>Back</Btn>
  )

  if (!caps.manageInventory && phase !== 'edit') {
    return <div>{back}<div style={{ height: 14 }} /><Alert type="info">Only the factory's own team can receive goods. Open a posted note from the Stock page to read it.</Alert></div>
  }
  if (phase === 'loading') return <LoadingScreen message="Opening..." />
  if (phase === 'error') return <div>{back}<div style={{ height: 14 }} /><Alert type="danger">{error}</Alert></div>

  // ── Where is it from? ──
  if (phase === 'choose') {
    const open = pos.filter(p => OPEN_STATUSES.includes(p.status))
    return (
      <div style={{ maxWidth: 760, margin: '0 auto' }}>
        {back}
        <h1 style={{ fontSize: 22, fontWeight: 800, color: T.text, margin: '14px 0 4px' }}>Receive goods</h1>
        <div style={{ fontSize: 13, color: T.textMuted, marginBottom: 16 }}>Is it against a purchase order you raised?</div>
        {error && <div style={{ marginBottom: 12 }}><Alert type="danger">{error}</Alert></div>}
        <div style={{ border: `1px solid ${T.primary}`, background: T.primaryLight, borderRadius: 14, padding: '16px 18px', marginBottom: 16 }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: T.text, display: 'flex', alignItems: 'center', gap: 8 }}><Sparkles size={16} color={T.primaryDark} /> Read the challan for me</div>
          <div style={{ fontSize: 12, color: T.textMuted, margin: '4px 0 12px' }}>Photograph the supplier's challan or invoice. The goods, quantities and purchase order are filled in, and you check them before anything is added to stock.</div>
          {scanning ? (
            <div role="status" style={{ fontSize: 14, fontWeight: 700, color: T.primaryDark, padding: '14px 0' }}>Reading the document... this takes a few seconds.</div>
          ) : (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" onClick={() => scanCam.current?.click()} disabled={starting}
                style={{ flex: '1 1 200px', minHeight: 56, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 10, border: 'none', borderRadius: 12, background: T.primaryDeep, color: '#fff', fontSize: 16, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
                <Camera size={22} /> Take a photo
              </button>
              <Btn variant="secondary" size="lg" onClick={() => scanFileInput.current?.click()} disabled={starting}>Choose a photo or PDF</Btn>
            </div>
          )}
          <input ref={scanCam} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} aria-label="Take a photo of the challan" onChange={e => { scanFile(e.target.files?.[0]); e.target.value = '' }} />
          <input ref={scanFileInput} type="file" accept="image/*,application/pdf" style={{ display: 'none' }} aria-label="Choose a challan photo or PDF" onChange={e => { scanFile(e.target.files?.[0]); e.target.value = '' }} />
        </div>
        <button type="button" onClick={() => start(null)} disabled={starting || scanning}
          style={{ width: '100%', textAlign: 'left', border: `1px dashed ${T.border}`, borderRadius: 12, background: T.surface, padding: '16px 18px', marginBottom: 16, cursor: 'pointer', fontFamily: 'inherit', minHeight: 64 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: T.text }}>No purchase order</div>
          <div style={{ fontSize: 12, color: T.textMuted, marginTop: 3 }}>Goods bought on the spot, or sent without a PO. You type what they are.</div>
        </button>
        <SectionLabel>Against a purchase order</SectionLabel>
        {open.length === 0 ? (
          <div style={{ fontSize: 13, color: T.textMuted, padding: '14px 0' }}>No purchase order is waiting for goods. A PO that has been sent shows here.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
            {open.map(p => (
              <button key={p.id} type="button" onClick={() => start(p)} disabled={starting}
                style={{ textAlign: 'left', border: `1px solid ${T.border}`, borderRadius: 12, background: T.surface, padding: '14px 16px', cursor: 'pointer', fontFamily: 'inherit', minHeight: 64, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <div style={{ flex: '1 1 200px', minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>{p.supplierName}</div>
                  <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>{p.id}{p.expectedDate ? ` · due ${fmtDay(p.expectedDate)}` : ''}</div>
                </div>
                <div style={{ width: 130 }}><Progress pct={p.receivedPct} tone="warn" /></div>
              </button>
            ))}
          </div>
        )}
      </div>
    )
  }

  // ── The note ──
  const posted = grn.status === 'posted'
  const po = grn.po
  const canType = caps.manageInventory && isDraft
  const input = { minHeight: 46, fontSize: 16 }

  const saveLabel = save === 'failed' ? 'Not saved' : dirty || save === 'saving' ? 'Saving...' : 'All changes saved'

  return (
    <div style={{ maxWidth: 820, margin: '0 auto', paddingBottom: showBar ? 8 : 0 }}>
      <FlexRow justify="space-between" style={{ flexWrap: 'wrap', gap: 8 }}>
        {back}
        <FlexRow gap={8}>
          {isDraft && <span aria-live="polite" style={{ fontSize: 12, color: save === 'failed' ? T.danger : T.textLight }}>{saveLabel}</span>}
          {posted && <Btn variant="secondary" size="sm" icon={<Download size={13} />} onClick={openPdf}>Open PDF</Btn>}
        </FlexRow>
      </FlexRow>

      <FlexRow gap={10} style={{ margin: '14px 0 4px', flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, color: T.text, margin: 0 }}>{posted ? grn.number : 'Receive goods'}</h1>
        <Pill tone={posted ? 'good' : 'warn'}>{grnStateLabel(grn.status)}</Pill>
        {grn.source && grn.source !== 'web' && <Pill tone="info">{SOURCE_LABEL[grn.source]}</Pill>}
      </FlexRow>
      <div style={{ fontSize: 13, color: T.textMuted, marginBottom: 14 }}>
        {po ? <>Against <button type="button" className="gl-link" onClick={() => onNavigate('po_detail', { po: po.id })}>{po.id}</button> · {po.supplierName} ({poStatusLabel(po.status)})</> : (grn.supplierName ? `From ${grn.supplierName}` : 'Without a purchase order')}
      </div>

      {error && <div style={{ marginBottom: 12 }}><Alert type="danger">{error}</Alert></div>}

      {grn.read && isDraft && (
        <div style={{ marginBottom: 12 }}>
          <Alert type={grn.read.confidence != null && grn.read.confidence < 0.7 ? 'warning' : 'info'}>
            <strong>Read from the photo{grn.read.confidence != null ? ` (${Math.round(grn.read.confidence * 100)}% sure)` : ''}.</strong> Check every quantity against the paper before you post it.
            {grn.read.matchReason ? ` ${grn.read.matchReason}.` : ''}
            {grn.read.warnings?.length > 0 && <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>{grn.read.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
          </Alert>
        </div>
      )}

      {done && (
        <div style={{ marginBottom: 14 }}>
          <Alert type="success">
            <strong>Goods received.</strong> {done.number} has been added to stock.
            {done.po ? ` ${done.po.id} is now ${poStatusLabel(done.po.status).toLowerCase()}.` : ''}
            {done.notice?.unlinkedLines?.length ? ` These could not be matched to a material line on an order: ${done.notice.unlinkedLines.join(', ')}.` : ''}
          </Alert>
          <FlexRow gap={8} style={{ marginTop: 10, flexWrap: 'wrap' }}>
            <Btn variant="secondary" icon={<Download size={14} />} onClick={openPdf}>Open the PDF</Btn>
            {done.po && OPEN_STATUSES.includes(done.po.status) && <Btn variant="secondary" icon={<ReceiveGoods size={14} />} onClick={() => onNavigate('grn', { po: done.po.id })}>Receive the rest</Btn>}
            <Btn variant="secondary" onClick={() => onNavigate('grn', {})}>Receive something else</Btn>
            <Btn onClick={() => onNavigate('inventory', {})}>See stock</Btn>
          </FlexRow>
        </div>
      )}

      <Card>
        <SectionLabel>Photos</SectionLabel>
        <div style={{ fontSize: 12, color: T.textLight, margin: '2px 0 10px' }}>{isDraft ? 'Start with the challan, so there is proof of what the supplier sent. They are saved as you take them.' : 'Kept as evidence of this delivery.'}</div>
        <PhotoStrip grnId={grn.id} photos={photos} setPhotos={setPhotos} canAdd={caps.manageInventory} canRemove={canType} onError={setError} />
      </Card>

      <div style={{ height: 14 }} />
      <Card>
        <FlexRow justify="space-between" style={{ flexWrap: 'wrap', gap: 8 }}>
          <div>
            <SectionLabel>What arrived</SectionLabel>
            {po && isDraft && <div style={{ fontSize: 12, color: T.textLight, marginTop: 2 }}>Type the quantity that came on each line. Leave a line empty if it has not come.</div>}
          </div>
          {canType && po && <Btn variant="secondary" size="sm" onClick={fillAll}>Everything as ordered</Btn>}
        </FlexRow>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
          {form.lines.map((l, i) => (
            <LineCard key={l.key} line={l} index={i} poLine={poLines.get(l.poLineId)} canType={canType} posted={posted} items={stockItems}
              onChange={patch => setLine(l.key, patch)} onRemove={() => removeLine(l.key)} />
          ))}
          {form.lines.length === 0 && <div style={{ fontSize: 13, color: T.textMuted, padding: '10px 0' }}>{canType ? 'No items yet. Add what came in.' : 'No items on this note.'}</div>}
        </div>
        {canType && (
          <div style={{ marginTop: 12 }}>
            <Btn variant="secondary" icon={<Plus size={14} />} onClick={addLine}>{po ? 'Add an item that is not on the order' : 'Add an item'}</Btn>
          </div>
        )}
      </Card>

      <div style={{ height: 14 }} />
      <Card>
        <SectionLabel>Delivery details</SectionLabel>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 12, marginTop: 8 }}>
          {!po && (
            <div style={{ gridColumn: '1 / -1' }}>
              <Input label="Supplier" value={form.supplierName} readOnly={!canType} list="grn-suppliers" placeholder="Who sent it"
                inputStyle={input} onChange={e => {
                  const name = e.target.value
                  const match = suppliers.find(s => s.isActive && s.name.toLowerCase() === name.trim().toLowerCase())
                  set({ supplierName: name, supplierId: match ? match.id : '' })
                }} />
              <datalist id="grn-suppliers">{suppliers.filter(s => s.isActive).map(s => <option key={s.id} value={s.name} />)}</datalist>
            </div>
          )}
          <Input label="Challan or invoice no." value={form.challanNo} readOnly={!canType} maxLength={60} inputStyle={input} onChange={e => set({ challanNo: e.target.value })} />
          <Input label="Challan date" type="date" value={form.challanDate} readOnly={!canType} inputStyle={input} onChange={e => set({ challanDate: e.target.value })} />
          <Input label="Vehicle number" value={form.vehicleNo} readOnly={!canType} maxLength={20} inputStyle={{ ...input, textTransform: 'uppercase' }} onChange={e => set({ vehicleNo: e.target.value })} />
          <Input label="Received on" type="date" value={form.receivedOn} readOnly={!canType} inputStyle={input} onChange={e => set({ receivedOn: e.target.value })} />
        </div>
        <div style={{ marginTop: 12 }}>
          <Textarea label="Note" value={form.note} readOnly={!canType} rows={2} maxLength={1000} placeholder="Anything worth keeping about this delivery" onChange={e => set({ note: e.target.value })} />
        </div>
      </Card>

      {showBar && (
        <div className="po-totals-bar" role="region" aria-label="Post this delivery">
          <div className="po-totals-sum">
            <div><span>Items arrived</span><strong>{ready.ok ? ready.count : 0}</strong></div>
            {po && <div><span>Order</span><strong style={{ fontSize: 13 }}>{po.id}</strong></div>}
          </div>
          <div className="po-totals-actions">
            <Btn variant="danger" icon={<Trash2 size={14} />} onClick={discard} disabled={posting}><span className="po-long">Delete draft</span><span className="po-short">Delete</span></Btn>
            <Btn variant="success" size="lg" icon={<Check size={15} />} onClick={post} disabled={!ready.ok || posting || !caps.manageInventory}>{posting ? 'Posting...' : 'Post to stock'}</Btn>
          </div>
          {!ready.ok && <div style={{ width: '100%', fontSize: 12, color: T.textMuted }}>{ready.reason}</div>}
        </div>
      )}
      {pdf && <FileViewer name={`Goods received note ${grn.number || ''}`} fileName={pdf.fileName} dataUrl={pdf.dataUrl} onClose={() => setPdf(null)} />}
    </div>
  )
}

/** One line of the delivery: what it is, what was ordered, and a big field for what came. */
function LineCard({ line, index, poLine, canType, posted, items, onChange, onRemove }) {
  const [more, setMore] = useState(() => !!(line.rejectedQty || line.lot || line.note))
  const hint = posted ? null : lineHint(line, poLine)
  const fromPo = !!line.poLineId
  const suggestions = !fromPo && canType && !line.itemId ? suggestItems(items, line.description, 5) : []
  const listId = `grn-items-${line.key}`
  const accepted = acceptedOf(line)
  const numField = { width: '100%', height: 50, border: `1px solid ${T.border}`, borderRadius: 10, padding: '0 12px', fontSize: 20, fontWeight: 700, textAlign: 'right', fontFamily: 'inherit', fontVariantNumeric: 'tabular-nums', color: T.text, background: T.surface, boxSizing: 'border-box' }

  return (
    <div style={{ border: `1px solid ${hint?.tone === 'bad' ? T.danger : T.border}`, borderRadius: 12, padding: '12px 14px', background: T.surface }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {fromPo || !canType ? (
            <div style={{ fontSize: 14, fontWeight: 700, color: T.text, overflowWrap: 'anywhere' }}>{line.description}</div>
          ) : (
            <>
              <input value={line.description} list={listId} placeholder="What came (for example Polar fleece 300 GSM, black)" aria-label={`Item ${index + 1}`} maxLength={300}
                onChange={e => {
                  const text = e.target.value
                  const hit = items.find(i => i.isActive !== false && i.name.toLowerCase() === text.trim().toLowerCase())
                  onChange(hit ? { description: text, itemId: hit.id, unit: hit.unit } : { description: text, itemId: '' })
                }}
                style={{ width: '100%', border: `1px solid ${T.border}`, borderRadius: 10, padding: '0 12px', minHeight: 46, fontSize: 16, fontFamily: 'inherit', boxSizing: 'border-box' }} />
              <datalist id={listId}>{suggestions.map(i => <option key={i.id} value={i.name} />)}</datalist>
            </>
          )}
          {poLine && (
            <div style={{ fontSize: 12, color: T.textMuted, marginTop: 4 }}>
              Ordered {fmtQty(poLine.ordered)} {poLine.unit}
              {poLine.received > 0 && !posted ? ` · already in ${fmtQty(poLine.received)}` : ''}
              {!posted && <> · to come <strong style={{ color: T.text }}>{fmtQty(poLine.outstanding)} {poLine.unit}</strong></>}
            </div>
          )}
          {line.itemId && !fromPo && <div style={{ fontSize: 11, color: T.textLight, marginTop: 3 }}>In your stock list</div>}
        </div>
        {canType && !fromPo && <button type="button" className="gl-remove" onClick={onRemove} aria-label={`Remove item ${index + 1}`}><Trash2 size={14} /></button>}
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 150px', minWidth: 130 }}>
          <label style={{ display: 'block', fontSize: 10, fontWeight: 800, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>Arrived</label>
          <input inputMode="decimal" value={line.qty} readOnly={!canType} placeholder="0" aria-label={`Quantity arrived for ${line.description || `item ${index + 1}`}`}
            onChange={e => onChange({ qty: decimal(e.target.value) })} style={numField} />
        </div>
        <div style={{ width: fromPo || line.itemId ? 56 : 120 }}>
          <label style={{ display: 'block', fontSize: 10, fontWeight: 800, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>Unit</label>
          {fromPo || line.itemId || !canType ? <div style={{ height: 50, display: 'flex', alignItems: 'center', fontSize: 15, color: T.textMuted }}>{line.unit}</div> : (
            <>
              <input value={line.unit} list="grn-units" maxLength={20} aria-label={`Unit for item ${index + 1}`} onChange={e => onChange({ unit: e.target.value })}
                style={{ width: '100%', height: 50, border: `1px solid ${T.border}`, borderRadius: 10, padding: '0 10px', fontSize: 15, fontFamily: 'inherit', boxSizing: 'border-box' }} />
              <datalist id="grn-units">{UNITS.map(u => <option key={u} value={u} />)}</datalist>
            </>
          )}
        </div>
        {canType && poLine && poLine.outstanding > 0 && (
          <button type="button" className="gl-link" style={{ alignSelf: 'flex-end', paddingBottom: 14 }} onClick={() => onChange({ qty: String(poLine.outstanding) })}>All {fmtQty(poLine.outstanding)}</button>
        )}
      </div>

      {canType && line.description.trim() && <ItemLink line={line} items={items} onChange={onChange} />}

      {hint && <div role="status" style={{ marginTop: 8, display: 'inline-block', fontSize: 12, fontWeight: 600, padding: '3px 9px', borderRadius: 7, background: TONE[hint.tone].bg, color: TONE[hint.tone].c }}>{hint.text}</div>}
      {line.rejectedQty && Number(line.rejectedQty) > 0 && <div style={{ fontSize: 12, color: T.textMuted, marginTop: 6 }}>{fmtQty(accepted)} {line.unit} goes into stock{line.rejectReason ? ` (${fmtQty(Number(line.rejectedQty))} turned away: ${line.rejectReason})` : ''}</div>}

      {(canType || more) && (
        <div style={{ marginTop: 8 }}>
          {canType && !more && <button type="button" className="gl-link" onClick={() => setMore(true)}>Damaged, turned away, or a lot number?</button>}
          {more && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10, marginTop: 4 }}>
              <label><span className="gl-mlabel" style={{ display: 'block' }}>Turned away</span>
                <input inputMode="decimal" value={line.rejectedQty} readOnly={!canType} placeholder="0" aria-label={`Quantity turned away for item ${index + 1}`} onChange={e => onChange({ rejectedQty: decimal(e.target.value) })}
                  style={{ ...numField, height: 42, fontSize: 16 }} />
              </label>
              <label style={{ gridColumn: 'span 2' }}><span className="gl-mlabel" style={{ display: 'block' }}>Why</span>
                <input value={line.rejectReason} readOnly={!canType} maxLength={200} placeholder="Torn, shade band, wrong colour" aria-label={`Reason for item ${index + 1}`} onChange={e => onChange({ rejectReason: e.target.value })}
                  style={{ width: '100%', height: 42, border: `1px solid ${T.border}`, borderRadius: 10, padding: '0 12px', fontSize: 14, fontFamily: 'inherit', boxSizing: 'border-box' }} />
              </label>
              <label><span className="gl-mlabel" style={{ display: 'block' }}>Lot or shade no.</span>
                <input value={line.lot} readOnly={!canType} maxLength={60} aria-label={`Lot for item ${index + 1}`} onChange={e => onChange({ lot: e.target.value })}
                  style={{ width: '100%', height: 42, border: `1px solid ${T.border}`, borderRadius: 10, padding: '0 12px', fontSize: 14, fontFamily: 'inherit', boxSizing: 'border-box' }} />
              </label>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Where a line will be booked: the item it names, one the person confirms, or a new item. */
function ItemLink({ line, items, onChange }) {
  const chosen = line.itemId ? items.find(i => i.id === line.itemId) : null
  const { exact, near } = stockMatch(items, line.description, line.unit)
  const note = { fontSize: 12, color: T.textMuted, marginTop: 8 }
  if (chosen) {
    return (
      <div style={note}>
        Goes into your stock item <strong style={{ color: T.text }}>{chosen.name}</strong>
        {line.poLineId && <> <button type="button" className="gl-link" onClick={() => onChange({ itemId: '' })}>change</button></>}
      </div>
    )
  }
  if (exact) return <div style={note}>Goes into your stock item <strong style={{ color: T.text }}>{exact.name}</strong></div>
  return (
    <div style={note}>
      {near.length > 0 ? (
        <>
          <span>Is this one of your stock items? </span>
          {near.map(i => (
            <button key={i.id} type="button" onClick={() => onChange({ itemId: i.id, unit: i.unit })}
              style={{ margin: '2px 6px 2px 0', padding: '5px 10px', minHeight: 32, borderRadius: 16, border: `1px solid ${T.border}`, background: T.surface, fontSize: 12, fontWeight: 700, color: T.text, cursor: 'pointer', fontFamily: 'inherit' }}>{i.name}</button>
          ))}
          <span style={{ color: T.textLight }}>Otherwise it is added as a new item.</span>
        </>
      ) : <span>Will be added to your stock list as a new item.</span>}
    </div>
  )
}
