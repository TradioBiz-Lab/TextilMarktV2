import { useEffect, useState, useCallback } from 'react'
import { Inbox, Check, X, AlertTriangle, FileSpreadsheet, RefreshCw, FlaskConical, ArrowUpRight } from '../../icons.jsx'
import { T, MEASUREMENT_LABEL_NAME, fmtDate } from '../../constants.js'
import { Btn, Card, EmptyState, FlexRow, LoadingScreen, Modal, PageHeader, Textarea, useToast } from '../../components/ui.jsx'
import { StyleImportPreview } from '../../components/StyleImportPreview.jsx'
import { MasterOrderPicker } from '../../components/MasterOrderPicker.jsx'
import { useApp } from '../../context.jsx'
import { styleRequestsApi } from '../../api.js'
import { REQUEST_STATUS, requestTitle, requestWhen } from '../../styleRequests.js'

// The master admin's review queue: what customers send (a sheet of NPD/Replen styles, or a replen of a style in production)
// waits here. Approving creates the styles; declining says why. Nothing exists as a style until it is approved.
const box = { border: `1px solid ${T.border}`, borderRadius: 10, padding: '10px 12px', background: T.surface }
const meta = { fontSize: 12, color: T.textMuted, lineHeight: 1.6 }
const fileChips = files => (files || []).length > 0 && (
  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
    {files.map(f => <span key={f.id} style={{ fontSize: 11, fontWeight: 700, color: '#075985', background: '#e0f2fe', border: '1px solid #7dd3fc', borderRadius: 10, padding: '1px 8px' }}>{f.type === 'measurements' ? `Measurements${f.measurementLabel ? `, ${MEASUREMENT_LABEL_NAME[f.measurementLabel]}` : ''}` : f.type === 'tech_pack' ? 'Tech pack' : 'Pattern'}: {f.name}</span>)}
  </div>
)

function ReviewModal({ request, onClose, onDecided }) {
  const { refreshOrders, createMasterOrder } = useApp()
  const toast = useToast()
  const [detail, setDetail] = useState(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')
  const [declining, setDeclining] = useState(false)
  const [reason, setReason] = useState('')
  const [moId, setMoId] = useState(request.masterOrderId || '')
  const [newMo, setNewMo] = useState(null)

  // A sheet is read again against the chosen master order, so styles already in it show as skipped.
  useEffect(() => {
    let stale = false
    styleRequestsApi.preview(request.id, request.kind === 'import' ? moId : undefined)
      .then(d => {
        if (stale) return
        setDetail(d)
        // A replen whose styles all sit in one master order suggests it.
        if (request.kind === 'replen' && !moId) {
          const mos = [...new Set((d.items || []).map(i => i.source?.masterOrderId).filter(Boolean))]
          if (mos.length === 1) setMoId(mos[0])
        }
      })
      .catch(e => { if (!stale) setErr(e?.message || 'Could not open this request.') })
    return () => { stale = true }
  }, [request.id, request.kind === 'import' ? moId : ''])

  const suggested = request.kind === 'replen' ? (() => { const mos = [...new Set((detail?.items || []).map(i => i.source?.masterOrderId).filter(Boolean))]; return mos.length === 1 ? mos[0] : '' })() : ''

  const approve = async () => {
    setBusy('approve'); setErr('')
    try {
      let target = moId
      if (newMo) {
        if (!newMo.orderName.trim()) { setErr('Give the new master order a name.'); setBusy(''); return }
        const made = await createMasterOrder({ id: 'auto', buyerId: request.buyerId, orderName: newMo.orderName.trim(), season: newMo.season || undefined })
        target = made.id
        setNewMo(null); setMoId(made.id)
      }
      if (!target) { setErr('Choose the master order these styles go under.'); setBusy(''); return }
      const r = await styleRequestsApi.approve(request.id, target)
      refreshOrders().catch(() => {})
      toast(`Approved: ${r.created.length} style${r.created.length !== 1 ? 's' : ''} created${r.failed?.length ? `, ${r.failed.length} could not be` : ''}`, r.failed?.length ? 'warning' : 'success')
      onDecided()
    } catch (e) { setErr(e?.message || 'Could not approve it.'); setBusy('') }
  }
  const decline = async () => {
    setBusy('decline'); setErr('')
    try { await styleRequestsApi.decline(request.id, reason.trim()); toast('Declined, and the customer is told', 'success'); onDecided() }
    catch (e) { setErr(e?.message || 'Could not decline it.'); setBusy('') }
  }

  const items = detail?.items || []
  const okRows = detail?.summary?.ok
  const blockedReplen = request.kind === 'replen' && items.length > 0 && items.every(i => !i.source || i.source.phase !== 'production')
  const title = request.kind === 'replen' ? 'Replen request' : request.kind === 'npd' ? 'New product development request' : 'Style sheet request'
  return (
    <Modal title={title} subtitle={`${request.buyerCompany} · ${request.requestedByName} · ${requestWhen(request.createdAt)}`} onClose={() => { if (!busy) onClose() }} size="xxl" float>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {!detail && !err && <div style={{ fontSize: 13, color: T.textMuted }}>Opening…</div>}

        {detail && request.kind === 'replen' && items.map((it, i) => (
          <div key={i} style={{ ...box, display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            {it.source?.image && <img src={it.source.image} alt="" style={{ width: 64, height: 84, objectFit: 'cover', borderRadius: 8, border: `1px solid ${T.border}` }} />}
            <div style={{ flex: 1, minWidth: 220 }}>
              <div style={{ fontSize: 14, fontWeight: 800, color: T.text }}>{it.product}{it.styleNumber ? ` (${it.styleNumber})` : ''}</div>
              <div style={meta}>
                <div>Quantity: <b style={{ color: T.text }}>{it.quantity ? `${Number(it.quantity).toLocaleString('en-IN')} pcs` : 'not given yet'}</b>{it.source?.totalQty ? ` (last order ${it.source.totalQty.toLocaleString('en-IN')} pcs)` : ''}</div>
                {it.delivery && <div>Expected delivery: <b style={{ color: T.text }}>{fmtDate(it.delivery)}</b></div>}
                <div>Colours: {it.colours?.length ? it.colours.join(', ') : `as before${it.source?.colours?.length ? ` (${it.source.colours.join(', ')})` : ''}`}</div>
                {it.ecommerceLink && <div>Product link: <a href={it.ecommerceLink} target="_blank" rel="noopener noreferrer" style={{ color: T.primaryDeep }}>{it.ecommerceLink}</a></div>}
                {it.techPackLink && <div>Tech pack: <a href={it.techPackLink} target="_blank" rel="noopener noreferrer" style={{ color: T.primaryDeep }}>{it.techPackLink}</a></div>}
                {it.note && <div>Note: {it.note}</div>}
                {!it.source && <div style={{ color: T.danger, fontWeight: 600 }}>The style it reorders no longer exists; it will be skipped.</div>}
                {it.source && it.source.phase !== 'production' && <div style={{ color: T.danger, fontWeight: 600 }}>That style is no longer in production; it will be skipped.</div>}
              </div>
              {fileChips(it.files)}
            </div>
          </div>
        ))}

        {detail && request.kind === 'npd' && items.map((it, i) => (
          <div key={i} style={{ ...box, display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            {it.photos?.[0]?.image && <img src={it.photos[0].image} alt="" style={{ width: 64, height: 84, objectFit: 'cover', borderRadius: 8, border: `1px solid ${T.border}` }} />}
            <div style={{ flex: 1, minWidth: 220 }}>
              <div style={{ fontSize: 14, fontWeight: 800, color: T.text }}>{it.product}{it.styleNumber ? ` (${it.styleNumber})` : ''}</div>
              <div style={meta}>
                <div>{[it.category, it.brand, (it.totalQty ?? it.quantity) ? `${Number(it.totalQty ?? it.quantity).toLocaleString('en-IN')} pcs` : 'quantity not given yet', it.photoCount ? `${it.photoCount} photo${it.photoCount !== 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ')}</div>
                {it.delivery && <div>Expected delivery: <b style={{ color: T.text }}>{fmtDate(it.delivery)}</b></div>}
                {it.colours?.length > 0 && <div>Colours: {it.colours.join(', ')}</div>}
                {it.colourways?.length > 0 && <div>Colourways: {it.colourways.map(c => c.name + (c.code ? ` (${c.code})` : '')).join(', ')}</div>}
                {it.fabricDetails?.length > 0 && <div>Fabric: {it.fabricDetails.map(f => [f.name, f.composition, f.gsm && `${f.gsm} GSM`].filter(Boolean).join(', ')).join('; ')}</div>}
                {it.ecommerceLink && <div>Product link: <a href={it.ecommerceLink} target="_blank" rel="noopener noreferrer" style={{ color: T.primaryDeep }}>{it.ecommerceLink}</a></div>}
                {it.techPackLink && <div>Tech pack: <a href={it.techPackLink} target="_blank" rel="noopener noreferrer" style={{ color: T.primaryDeep }}>{it.techPackLink}</a></div>}
              </div>
              {fileChips(it.files)}
            </div>
          </div>
        ))}

        {detail && request.kind === 'import' && (detail.rows
          ? <>
              <div style={{ fontSize: 12.5, color: T.textMuted }}>
                <FileSpreadsheet size={13} style={{ verticalAlign: -2, marginRight: 5 }} />{request.filename}. This is the sheet as it reads now{moId ? ', checked against the master order chosen below' : ''}.
                {request.summary?.errors > 0 && ' The customer asked for the valid rows only.'}
              </div>
              <StyleImportPreview preview={detail} />
            </>
          : <div style={{ fontSize: 13, color: T.textMuted }}>The sheet is no longer kept for this request.</div>)}

        {request.status === 'pending' && detail && <MasterOrderPicker buyerId={request.buyerId} value={moId} onChange={setMoId} newMo={newMo} setNewMo={setNewMo} suggested={suggested} />}

        {err && <div style={{ fontSize: 12.5, color: T.danger, fontWeight: 600, background: T.dangerBg, border: `1px solid ${T.dangerBorder}`, borderRadius: 8, padding: '8px 12px' }}><AlertTriangle size={12} style={{ verticalAlign: -2, marginRight: 4 }} /> {err}</div>}

        {declining && <Textarea label="Why? (the customer sees this)" value={reason} onChange={e => setReason(e.target.value)} rows={3} maxLength={300} placeholder="Optional, e.g. Photos are missing for two styles" />}

        {request.status === 'pending' && (
          <FlexRow justify="flex-end" gap={8}>
            <Btn variant="secondary" onClick={onClose} disabled={!!busy}>Close</Btn>
            {!declining
              ? <Btn variant="secondary" onClick={() => setDeclining(true)} disabled={!!busy} icon={<X size={13} />}>Decline</Btn>
              : <Btn variant="secondary" onClick={decline} disabled={!!busy} icon={<X size={13} />}>{busy === 'decline' ? 'Declining…' : 'Confirm decline'}</Btn>}
            <Btn onClick={approve} disabled={!!busy || !detail || (!moId && !newMo) || (request.kind === 'import' && !okRows) || blockedReplen} icon={<Check size={13} />}>
              {busy === 'approve' ? 'Approving…' : request.kind === 'import' ? `Approve${okRows ? ` ${okRows} style${okRows !== 1 ? 's' : ''}` : ''}` : `Approve ${items.length} style${items.length !== 1 ? 's' : ''}`}
            </Btn>
          </FlexRow>
        )}
      </div>
    </Modal>
  )
}

export function StyleRequestsPage({ onOpen, onOpenMo }) {
  const [tab, setTab] = useState('pending')
  const [items, setItems] = useState(null)
  const [error, setError] = useState('')
  const [open, setOpen] = useState(null)
  const load = useCallback(() => {
    setItems(null)
    setError('')   // a failed load must not stay on screen once a later one works
    return styleRequestsApi.list(tab).then(setItems).catch(e => setError(e?.message || 'Could not load the requests.'))
  }, [tab])
  useEffect(() => { load() }, [load])

  return (
    <div>
      <PageHeader title="Style Requests" subtitle="What customers ask to add waits here until you approve it. Nothing becomes a style before that." />
      <FlexRow gap={6} style={{ marginBottom: 12 }}>
        {[['pending', 'Waiting'], ['decided', 'Decided']].map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} aria-pressed={tab === id}
            style={{ fontSize: 13, fontWeight: 800, padding: '8px 16px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit', border: `1px solid ${tab === id ? T.primaryDeep : T.border}`, background: tab === id ? T.primaryDeep : T.surface, color: tab === id ? '#fff' : T.text }}>
            {label}{tab === id && items ? ` (${items.length})` : ''}
          </button>
        ))}
      </FlexRow>

      {error && <Card><EmptyState icon={<AlertTriangle size={26} color={T.textLight} />} title="Could not load" desc={error} /></Card>}
      {!error && !items && <LoadingScreen />}
      {items && items.length === 0 && <Card><EmptyState icon={<Inbox size={26} color={T.textLight} />} title={tab === 'pending' ? 'Nothing waiting' : 'Nothing decided yet'} desc={tab === 'pending' ? 'When a customer sends a sheet of styles or asks for a replen, it shows up here.' : 'Approved and declined requests stay here.'} /></Card>}
      {items && items.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {items.map(r => {
            const st = REQUEST_STATUS[r.status]
            return (
              <Card key={r.id} style={{ padding: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '12px 16px' }}>
                  <span style={{ width: 34, height: 34, borderRadius: 9, background: r.kind === 'replen' ? '#ccfbf1' : r.kind === 'npd' ? '#ede9fe' : T.primaryLight, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    {r.kind === 'replen' ? <RefreshCw size={16} color="#0f766e" /> : r.kind === 'npd' ? <FlaskConical size={16} color="#5b21b6" /> : <FileSpreadsheet size={16} color={T.primaryDeep} />}
                  </span>
                  <div style={{ flex: 1, minWidth: 220 }}>
                    <div style={{ fontSize: 14, fontWeight: 800, color: T.text }}>{requestTitle(r)}</div>
                    <div style={{ fontSize: 12, color: T.textMuted }}>
                      {r.buyerCompany} · {r.requestedByName} · {requestWhen(r.createdAt)}{r.masterOrderName ? ` · ${r.masterOrderName}` : ''}
                      {r.kind === 'import' && r.summary ? ` · ${r.summary.ok} ready${r.summary.errors ? `, ${r.summary.errors} with problems` : ''}${r.summary.exists ? `, ${r.summary.exists} already there` : ''}` : ''}
                    </div>
                    {r.status === 'declined' && r.decisionNote && <div style={{ fontSize: 12, color: T.danger, marginTop: 2 }}>Reason: {r.decisionNote}</div>}
                  </div>
                  <span style={{ fontSize: 11, fontWeight: 800, color: st.fg, background: st.bg, border: `1px solid ${st.bd}`, borderRadius: 999, padding: '2px 10px' }}>{st.label}</span>
                  {r.status === 'approved' && r.createdOrderIds.length > 0 && (
                    <button onClick={() => onOpen?.(r.createdOrderIds[0])} style={{ fontSize: 12, fontWeight: 700, color: T.primaryDeep, background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>Open {r.createdOrderIds.length > 1 ? `first of ${r.createdOrderIds.length}` : r.createdOrderIds[0]} <ArrowUpRight size={11} style={{ verticalAlign: -1 }} /></button>
                  )}
                  {r.status === 'pending' && <Btn size="sm" onClick={() => setOpen(r)}>Review</Btn>}
                </div>
              </Card>
            )
          })}
        </div>
      )}

      {open && <ReviewModal request={open} onClose={() => setOpen(null)} onDecided={() => { setOpen(null); load() }} />}
    </div>
  )
}
