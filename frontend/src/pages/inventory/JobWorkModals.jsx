import { useEffect, useMemo, useState } from 'react'
import { Plus, Trash2, Download } from '../../icons.jsx'
import { T } from '../../constants.js'
import { Modal, Btn, Alert, Input, Select, Textarea, FlexRow, SectionLabel, LoadingScreen, FileViewer, useToast } from '../../components/ui.jsx'
import { jobworkApi } from '../../api.js'
import { fmtQty, fmtDay } from '../../lib/procurement.js'
import { decimal, issueProblems, PROCESSES, JOBWORK_STATE, lossNote, returnProblems } from '../../lib/inventory.js'
import { newKey } from '../../lib/bomUi.js'
import { Pill } from '../procurement/common.jsx'
import { PhotoStrip } from './PhotoStrip.jsx'

const label = { display: 'block', fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 5 }

/**
 * Send goods to a dyer, printer or embroiderer. The store's balance is checked as the quantity is typed, the challan is
 * made on the spot, and the goods stay the factory's, now shown as being with the job worker until they come back.
 */
export function JobWorkSendModal({ items, suppliers, orders, initialItem, onClose, onSent }) {
  const toast = useToast()
  const live = useMemo(() => items.filter(i => i.isActive !== false), [items])
  const workers = useMemo(() => suppliers.filter(s => s.isActive).sort((a, b) => Number(b.type === 'dyer') - Number(a.type === 'dyer') || a.name.localeCompare(b.name)), [suppliers])
  const myOrders = useMemo(() => (orders || []).filter(o => o.assignments?.[0]?.status !== 'Delivered').sort((a, b) => String(a.product).localeCompare(String(b.product))), [orders])
  const [f, setF] = useState({ supplierId: '', process: '', orderId: '', expectedBack: '', vehicleNo: '', note: '' })
  const [lines, setLines] = useState(() => [{ key: newKey(), itemId: initialItem?.id || '', qty: '', rate: initialItem?.lastRate ? String(initialItem.lastRate) : '' }])
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(null)
  const [pdf, setPdf] = useState(null)
  const set = patch => { setF(v => ({ ...v, ...patch })); setErr('') }
  const setLine = (key, patch) => { setLines(ls => ls.map(l => (l.key === key ? { ...l, ...patch } : l))); setErr('') }

  const problems = issueProblems(lines, live, 'issue')
  const filled = lines.filter(l => l.itemId && Number(l.qty) > 0)
  const canSend = !!f.supplierId && !!f.process.trim() && filled.length > 0 && problems.every(p => !p)

  const submit = async () => {
    setBusy(true)
    try {
      const job = await jobworkApi.send({
        supplierId: f.supplierId, process: f.process.trim(), ...(f.orderId ? { orderId: f.orderId } : {}), ...(f.expectedBack ? { expectedBack: f.expectedBack } : {}),
        vehicleNo: f.vehicleNo.trim(), note: f.note.trim(), lines: filled.map(l => ({ itemId: l.itemId, qty: Number(l.qty), rate: Number(l.rate) || 0 })),
      })
      setSent(job); onSent(job)
      toast(`Challan ${job.number} made`, 'success')
    } catch (e) { setErr(e?.message || 'The goods could not be sent'); setBusy(false) }
  }
  const openPdf = async () => { try { setPdf(await jobworkApi.pdf(sent.id)) } catch (e) { toast(e?.message || 'Could not open the PDF', 'error') } }

  if (sent) {
    return (
      <Modal title="Sent for job work" subtitle={`${sent.number} · ${sent.supplierName}`} onClose={onClose}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Alert type="success">{sent.lines.map(l => `${fmtQty(l.qty)} ${l.unit} of ${l.name}`).join('; ')} {sent.lines.length === 1 ? 'is' : 'are'} now with {sent.supplierName} for {sent.process.toLowerCase()}. Send the challan with the goods.</Alert>
          <FlexRow justify="flex-end" gap={8} style={{ flexWrap: 'wrap' }}>
            <Btn variant="secondary" icon={<Download size={14} />} onClick={openPdf}>Open the challan</Btn>
            <Btn onClick={onClose}>Done</Btn>
          </FlexRow>
        </div>
        {pdf && <FileViewer name={`Job work challan ${sent.number}`} fileName={pdf.fileName} dataUrl={pdf.dataUrl} onClose={() => setPdf(null)} />}
      </Modal>
    )
  }

  return (
    <Modal title="Send goods for job work" subtitle="To a dyer, printer, embroiderer or washer. The goods stay yours and show as being with them." onClose={() => !busy && onClose()} size="lg">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
          <Select label="Job worker" value={f.supplierId} onChange={e => set({ supplierId: e.target.value })}>
            <option value="">Choose from your suppliers</option>
            {workers.map(s => <option key={s.id} value={s.id}>{s.name}{s.city ? ` (${s.city})` : ''}</option>)}
          </Select>
          <div>
            <Input label="Work to be done" value={f.process} list="jw-processes" maxLength={80} placeholder="Dyeing" onChange={e => set({ process: e.target.value })} />
            <datalist id="jw-processes">{PROCESSES.map(p => <option key={p} value={p} />)}</datalist>
          </div>
          <Select label="For which order (optional)" value={f.orderId} onChange={e => set({ orderId: e.target.value })}>
            <option value="">Not specified</option>
            {myOrders.map(o => <option key={o.id} value={o.id}>{o.product}{o.styleNumber ? ` (${o.styleNumber})` : ''} - {o.id}</option>)}
          </Select>
          <Input label="Due back by" type="date" value={f.expectedBack} onChange={e => set({ expectedBack: e.target.value })} />
        </div>

        <div>
          <span style={label}>What is being sent</span>
          {lines.map((l, i) => {
            const item = live.find(x => x.id === l.itemId)
            return (
              <div key={l.key} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap', padding: '10px 0', borderBottom: `1px solid ${T.border}` }}>
                <div style={{ flex: '2 1 240px', minWidth: 0 }}>
                  <Select value={l.itemId} onChange={e => { const it = live.find(x => x.id === e.target.value); setLine(l.key, { itemId: e.target.value, ...(it?.lastRate && !l.rate ? { rate: String(it.lastRate) } : {}) }) }} aria-label={`Item ${i + 1}`}>
                    <option value="">Choose an item</option>
                    {live.map(it => <option key={it.id} value={it.id}>{it.name} ({fmtQty(it.onHand)} {it.unit} in store)</option>)}
                  </Select>
                  {problems[i] && <div role="alert" style={{ fontSize: 12, color: T.danger, marginTop: 4 }}>{problems[i]}</div>}
                </div>
                <div style={{ flex: '1 1 120px', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Input inputMode="decimal" value={l.qty} placeholder="0" aria-label={`Quantity for item ${i + 1}`} onChange={e => setLine(l.key, { qty: decimal(e.target.value) })} style={{ flex: 1 }} inputStyle={{ minHeight: 44, fontSize: 18, fontWeight: 700, textAlign: 'right' }} />
                  <span style={{ fontSize: 13, color: T.textMuted, minWidth: 26 }}>{item?.unit || ''}</span>
                </div>
                <div style={{ flex: '1 1 100px' }}>
                  <Input inputMode="decimal" value={l.rate} placeholder="Rate" aria-label={`Value per unit for item ${i + 1}`} onChange={e => setLine(l.key, { rate: decimal(e.target.value) })} inputStyle={{ minHeight: 44, fontSize: 15, textAlign: 'right' }} />
                </div>
                {lines.length > 1 && <button type="button" className="gl-remove" onClick={() => setLines(ls => ls.filter(x => x.key !== l.key))} aria-label={`Remove item ${i + 1}`}><Trash2 size={14} /></button>}
              </div>
            )
          })}
          <div style={{ fontSize: 11, color: T.textLight, marginTop: 6 }}>The rate is what the goods are worth per unit: the challan states a value. It starts from what the item last cost.</div>
          <div style={{ marginTop: 8 }}><Btn variant="secondary" size="sm" icon={<Plus size={12} />} onClick={() => setLines(ls => [...ls, { key: newKey(), itemId: '', qty: '', rate: '' }])}>Add another item</Btn></div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
          <Input label="Vehicle number" value={f.vehicleNo} maxLength={20} onChange={e => set({ vehicleNo: e.target.value })} inputStyle={{ textTransform: 'uppercase' }} />
          <Input label="Note (optional)" value={f.note} maxLength={1000} placeholder="Navy, shade card attached" onChange={e => set({ note: e.target.value })} />
        </div>
        {err && <Alert type="danger">{err}</Alert>}
        <FlexRow justify="flex-end" gap={8}>
          <Btn variant="secondary" onClick={onClose} disabled={busy}>Cancel</Btn>
          <Btn onClick={submit} disabled={!canSend || busy}>{busy ? 'Sending...' : 'Send and make the challan'}</Btn>
        </FlexRow>
      </div>
    </Modal>
  )
}

/** One challan: what went, what has come back, and the ways to account for the rest. */
export function JobWorkModal({ jobId, canWrite, items, onClose, onChanged }) {
  const toast = useToast()
  const [job, setJob] = useState(null)
  const [err, setErr] = useState('')
  const [mode, setMode] = useState('view')              // view | return | writeoff | cancel
  const [photos, setPhotos] = useState([])
  const [pdf, setPdf] = useState(null)
  const [busy, setBusy] = useState(false)
  const [reason, setReason] = useState('')
  const [form, setForm] = useState([])
  const [note, setNote] = useState('')

  const load = async () => {
    try {
      const j = await jobworkApi.get(jobId)
      setJob(j); setErr('')
      jobworkApi.photos(jobId).then(setPhotos).catch(() => {})
      return j
    } catch (e) { setErr(e?.message || 'Could not load this challan'); return null }
  }
  useEffect(() => { load() }, [jobId]) // eslint-disable-line react-hooks/exhaustive-deps

  const live = useMemo(() => (items || []).filter(i => i.isActive !== false), [items])
  const finished = job && !['open', 'partially_returned'].includes(job.status)

  const startReturn = () => {
    setForm(job.lines.filter(l => l.outstanding > 0).map(l => ({ lineId: l.lineId, inputQty: String(l.outstanding), outputs: [{ key: newKey(), itemId: '', description: '', unit: l.unit, qty: '' }] })))
    setNote(''); setErr(''); setMode('return')
  }
  const setOut = (lineId, key, patch) => setForm(fs => fs.map(f => (f.lineId === lineId ? { ...f, outputs: f.outputs.map(o => (o.key === key ? { ...o, ...patch } : o)) } : f)))
  const setIn = (lineId, inputQty) => setForm(fs => fs.map(f => (f.lineId === lineId ? { ...f, inputQty } : f)))
  const addOut = lineId => setForm(fs => fs.map(f => (f.lineId === lineId ? { ...f, outputs: [...f.outputs, { key: newKey(), itemId: '', description: '', unit: job.lines.find(l => l.lineId === lineId).unit, qty: '' }] } : f)))
  const dropOut = (lineId, key) => setForm(fs => fs.map(f => (f.lineId === lineId ? { ...f, outputs: f.outputs.filter(o => o.key !== key) } : f)))

  const problems = job && mode === 'return' ? returnProblems(form, job) : []
  const ready = mode === 'return' && form.some(f => Number(f.inputQty) > 0 && f.outputs.some(o => Number(o.qty) > 0)) && problems.every(p => !p)

  const act = async (fn, ok) => {
    setBusy(true)
    try { const next = await fn(); setJob(next); setMode('view'); setReason(''); toast(ok, 'success'); onChanged(); jobworkApi.photos(jobId).then(setPhotos).catch(() => {}) }
    catch (e) { setErr(e?.message || 'That did not work') } finally { setBusy(false) }
  }
  const submitReturn = () => act(() => jobworkApi.returnGoods(job.id, {
    note: note.trim(),
    lines: form.filter(f => Number(f.inputQty) > 0 && f.outputs.some(o => Number(o.qty) > 0)).map(f => ({
      lineId: f.lineId, inputQty: Number(f.inputQty),
      outputs: f.outputs.filter(o => Number(o.qty) > 0).map(o => (o.itemId ? { itemId: o.itemId, qty: Number(o.qty) } : { description: o.description.trim(), unit: o.unit.trim(), qty: Number(o.qty) })),
    })),
  }), 'Goods back from the job worker recorded')

  const openPdf = async () => { try { setPdf(await jobworkApi.pdf(job.id)) } catch (e) { toast(e?.message || 'Could not open the PDF', 'error') } }

  const state = job ? JOBWORK_STATE[job.status] : null
  return (
    <Modal title={job ? `${job.number}` : 'Job work'} subtitle={job ? `${job.supplierName} · ${job.process}` : ''} onClose={() => !busy && onClose()} size="xl">
      {err && <div style={{ marginBottom: 12 }}><Alert type="danger">{err}</Alert></div>}
      {!job && !err && <LoadingScreen message="Loading..." />}
      {job && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <FlexRow gap={8} style={{ flexWrap: 'wrap' }}>
            <Pill tone={state?.tone}>{state?.label}</Pill>
            {job.overdue && <Pill tone="bad">Overdue</Pill>}
            <span style={{ fontSize: 13, color: T.textMuted }}>Sent {fmtDay(job.sentOn)}{job.expectedBack ? ` · due back ${fmtDay(job.expectedBack)}` : ''}{job.orderId ? ` · for ${job.orderId}` : ''}{job.vehicleNo ? ` · ${job.vehicleNo}` : ''}</span>
          </FlexRow>
          {job.note && <div style={{ fontSize: 13, color: T.textMuted }}>{job.note}</div>}
          {finished && job.closedReason && <Alert type="info">Closed: {job.closedReason}</Alert>}
          {job.status === 'cancelled' && <Alert type="info">Cancelled: {job.cancelReason}. The goods went back to the store.</Alert>}

          <div>
            <SectionLabel>Goods</SectionLabel>
            <div style={{ marginTop: 6 }}>
              {job.lines.map(l => (
                <div key={l.lineId} style={{ display: 'flex', gap: 12, padding: '10px 0', borderBottom: `1px solid ${T.border}`, flexWrap: 'wrap', alignItems: 'baseline' }}>
                  <div style={{ flex: '2 1 220px', minWidth: 0, fontSize: 13, fontWeight: 700, color: T.text, overflowWrap: 'anywhere' }}>{l.name}</div>
                  <div style={{ fontSize: 12, color: T.textMuted, fontVariantNumeric: 'tabular-nums' }}>sent {fmtQty(l.qty)} {l.unit}{l.returnedQty ? ` · accounted for ${fmtQty(l.returnedQty)}` : ''}{l.writtenOffQty ? ` · written off ${fmtQty(l.writtenOffQty)}` : ''}</div>
                  <div style={{ fontSize: 14, fontWeight: 800, color: l.outstanding > 0 ? T.warning : T.success, fontVariantNumeric: 'tabular-nums' }}>{l.outstanding > 0 ? `${fmtQty(l.outstanding)} ${l.unit} still out` : 'All accounted for'}</div>
                </div>
              ))}
            </div>
          </div>

          {mode === 'view' && job.returns.length > 0 && (
            <div>
              <SectionLabel>What came back</SectionLabel>
              {job.returns.map((r, i) => (
                <div key={i} style={{ padding: '10px 0', borderBottom: `1px solid ${T.border}`, fontSize: 13 }}>
                  <div style={{ fontWeight: 700, color: T.text }}>{fmtDay(r.at)}{r.note ? <span style={{ fontWeight: 400, color: T.textMuted }}> · {r.note}</span> : null}</div>
                  {r.lines.map(l => {
                    const sentLine = job.lines.find(x => x.lineId === l.lineId)
                    return <div key={l.lineId} style={{ color: T.textMuted, marginTop: 3 }}>{fmtQty(l.inputQty)} {sentLine?.unit} of {sentLine?.name}: {l.outputs.map(o => `${fmtQty(o.qty)} ${o.unit} ${o.name}`).join(', ')}{(() => { const n = lossNote(l.inputQty, sentLine?.unit, l.outputs); return n && /lost/.test(n) ? ` (${n.split(': ')[1]})` : '' })()}</div>
                  })}
                </div>
              ))}
            </div>
          )}

          {mode === 'return' && (
            <div style={{ border: `1px solid ${T.primary}`, borderRadius: 12, padding: 14, background: T.primaryLight }}>
              <div style={{ fontSize: 14, fontWeight: 800, color: T.text }}>Goods came back</div>
              <div style={{ fontSize: 12, color: T.textMuted, margin: '2px 0 10px' }}>For each line, say how much of what went this delivery accounts for, and what came back (dyed cloth for grey, printed pieces). What came back goes into your store.</div>
              {form.map((f, idx) => {
                const sentLine = job.lines.find(l => l.lineId === f.lineId)
                const note = lossNote(f.inputQty, sentLine.unit, f.outputs.filter(o => Number(o.qty) > 0))
                return (
                  <div key={f.lineId} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, padding: 12, marginBottom: 10 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{sentLine.name} <span style={{ fontWeight: 500, color: T.textMuted }}>({fmtQty(sentLine.outstanding)} {sentLine.unit} still out)</span></div>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 12, color: T.textMuted }}>This delivery accounts for</span>
                      <input inputMode="decimal" value={f.inputQty} aria-label={`How much of ${sentLine.name} this delivery accounts for`} onChange={e => setIn(f.lineId, decimal(e.target.value))}
                        style={{ width: 110, height: 44, border: `1px solid ${T.border}`, borderRadius: 10, padding: '0 10px', fontSize: 16, fontWeight: 700, textAlign: 'right', fontFamily: 'inherit' }} />
                      <span style={{ fontSize: 13, color: T.textMuted }}>{sentLine.unit}</span>
                    </div>
                    {f.outputs.map((o, k) => (
                      <div key={o.key} style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
                        <div style={{ flex: '2 1 200px', minWidth: 0 }}>
                          <input value={o.description} list={`jw-out-${idx}-${k}`} placeholder="What came back (for example Single jersey, navy)" aria-label={`What came back for ${sentLine.name}`} maxLength={300}
                            onChange={e => { const text = e.target.value; const hit = live.find(i => i.name.toLowerCase() === text.trim().toLowerCase()); setOut(f.lineId, o.key, hit ? { description: text, itemId: hit.id, unit: hit.unit } : { description: text, itemId: '' }) }}
                            style={{ width: '100%', height: 44, border: `1px solid ${T.border}`, borderRadius: 10, padding: '0 10px', fontSize: 14, fontFamily: 'inherit', boxSizing: 'border-box' }} />
                          <datalist id={`jw-out-${idx}-${k}`}>{live.map(i => <option key={i.id} value={i.name} />)}</datalist>
                        </div>
                        <input inputMode="decimal" value={o.qty} placeholder="0" aria-label={`Quantity that came back for ${sentLine.name}`} onChange={e => setOut(f.lineId, o.key, { qty: decimal(e.target.value) })}
                          style={{ width: 100, height: 44, border: `1px solid ${T.border}`, borderRadius: 10, padding: '0 10px', fontSize: 16, fontWeight: 700, textAlign: 'right', fontFamily: 'inherit' }} />
                        {o.itemId ? <span style={{ fontSize: 13, color: T.textMuted, minWidth: 30 }}>{o.unit}</span> : (
                          <input value={o.unit} maxLength={20} aria-label="Unit" onChange={e => setOut(f.lineId, o.key, { unit: e.target.value })} style={{ width: 60, height: 44, border: `1px solid ${T.border}`, borderRadius: 10, padding: '0 8px', fontSize: 14, fontFamily: 'inherit' }} />
                        )}
                        {f.outputs.length > 1 && <button type="button" className="gl-remove" onClick={() => dropOut(f.lineId, o.key)} aria-label="Remove this line"><Trash2 size={14} /></button>}
                      </div>
                    ))}
                    <div style={{ display: 'flex', gap: 12, marginTop: 6, flexWrap: 'wrap' }}>
                      <button type="button" className="gl-link" onClick={() => addOut(f.lineId)}>Add another thing that came back</button>
                      {!f.outputs.some(o => o.itemId === sentLine.itemId) && <button type="button" className="gl-link" onClick={() => setOut(f.lineId, f.outputs[0].key, { itemId: sentLine.itemId, description: sentLine.name, unit: sentLine.unit })}>Same as what was sent</button>}
                    </div>
                    {problems[idx] && <div role="alert" style={{ fontSize: 12, color: T.danger, marginTop: 6 }}>{problems[idx]}</div>}
                    {note && !problems[idx] && <div style={{ fontSize: 12, color: T.textMuted, marginTop: 6 }}>{note}</div>}
                  </div>
                )
              })}
              <Input label="Note (optional)" value={note} maxLength={500} onChange={e => setNote(e.target.value)} placeholder="Lorry number, shade, anything worth keeping" />
              <FlexRow justify="flex-end" gap={8} style={{ marginTop: 10 }}>
                <Btn variant="secondary" onClick={() => setMode('view')} disabled={busy}>Back</Btn>
                <Btn onClick={submitReturn} disabled={!ready || busy}>{busy ? 'Saving...' : 'Record what came back'}</Btn>
              </FlexRow>
            </div>
          )}

          {(mode === 'writeoff' || mode === 'cancel') && (
            <div style={{ border: `1px solid ${T.border}`, borderRadius: 12, padding: 14, background: T.bg }}>
              <div style={{ fontSize: 14, fontWeight: 800, color: T.text }}>{mode === 'writeoff' ? 'Write off what is still out' : 'Cancel this challan'}</div>
              <div style={{ fontSize: 12, color: T.textMuted, margin: '2px 0 10px' }}>
                {mode === 'writeoff' ? 'Use this when the job worker will not return the rest (a loss you have agreed). The goods come off what is with them, and the challan closes.' : 'Use this only if the goods were sent by mistake. They go back to your store. It cannot be done once anything has come back.'}
              </div>
              <Textarea label="Why" value={reason} onChange={e => setReason(e.target.value)} rows={2} maxLength={500} />
              <FlexRow justify="flex-end" gap={8} style={{ marginTop: 10 }}>
                <Btn variant="secondary" onClick={() => setMode('view')} disabled={busy}>Back</Btn>
                <Btn variant="danger" disabled={!reason.trim() || busy} onClick={() => act(() => (mode === 'writeoff' ? jobworkApi.close(job.id, reason.trim()) : jobworkApi.cancel(job.id, reason.trim())), mode === 'writeoff' ? 'Written off and closed' : 'Challan cancelled')}>{mode === 'writeoff' ? 'Write off and close' : 'Cancel the challan'}</Btn>
              </FlexRow>
            </div>
          )}

          {mode === 'view' && (
            <>
              <FlexRow gap={8} style={{ flexWrap: 'wrap' }}>
                {canWrite && !finished && <Btn onClick={startReturn}>Goods came back</Btn>}
                <Btn variant="secondary" icon={<Download size={14} />} onClick={openPdf}>Open the challan</Btn>
                {canWrite && !finished && <Btn variant="ghost" onClick={() => { setReason(''); setMode('writeoff') }}>Write off the rest</Btn>}
                {canWrite && job.status === 'open' && job.returns.length === 0 && <Btn variant="ghost" onClick={() => { setReason(''); setMode('cancel') }}>Sent by mistake</Btn>}
              </FlexRow>
              <div>
                <SectionLabel>Photos</SectionLabel>
                <div style={{ marginTop: 8 }}>
                  <PhotoStrip grnId={job.id} photos={photos} setPhotos={setPhotos} canAdd={canWrite} canRemove={canWrite && job.status === 'open'} onError={setErr} api={jobworkApi} />
                </div>
              </div>
            </>
          )}
        </div>
      )}
      {pdf && job && <FileViewer name={`Job work challan ${job.number}`} fileName={pdf.fileName} dataUrl={pdf.dataUrl} onClose={() => setPdf(null)} />}
    </Modal>
  )
}

