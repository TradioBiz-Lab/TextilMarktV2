import { useEffect, useState, useCallback } from 'react'
import { Inbox, Check, X, AlertTriangle, FileSpreadsheet, RefreshCw } from '../../icons.jsx'
import { T } from '../../constants.js'
import { Btn, Card, EmptyState, FlexRow, LoadingScreen, Modal, PageHeader, Textarea, useToast } from '../../components/ui.jsx'
import { StyleImportPreview } from '../../components/StyleImportPreview.jsx'
import { useApp } from '../../context.jsx'
import { styleRequestsApi } from '../../api.js'
import { REQUEST_STATUS, requestTitle, requestWhen } from '../../styleRequests.js'

// The master admin's review queue: what customers send (a sheet of NPD/Replen styles, or a replen of a style in production)
// waits here. Approving creates the styles; declining says why. Nothing exists as a style until it is approved.
function ReviewModal({ request, onClose, onDecided }) {
  const { refreshOrders } = useApp()
  const toast = useToast()
  const [detail, setDetail] = useState(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')
  const [declining, setDeclining] = useState(false)
  const [reason, setReason] = useState('')

  useEffect(() => {
    let stale = false
    styleRequestsApi.preview(request.id).then(d => { if (!stale) setDetail(d) }).catch(e => { if (!stale) setErr(e?.message || 'Could not open this request.') })
    return () => { stale = true }
  }, [request.id])

  const approve = async () => {
    setBusy('approve'); setErr('')
    try {
      const r = await styleRequestsApi.approve(request.id)
      refreshOrders().catch(() => {})
      toast(`Approved: ${r.created.length} style${r.created.length !== 1 ? 's' : ''} created`, 'success')
      onDecided()
    } catch (e) { setErr(e?.message || 'Could not approve it.'); setBusy('') }
  }
  const decline = async () => {
    setBusy('decline'); setErr('')
    try { await styleRequestsApi.decline(request.id, reason.trim()); toast('Declined, and the customer is told', 'success'); onDecided() }
    catch (e) { setErr(e?.message || 'Could not decline it.'); setBusy('') }
  }

  const src = detail?.source
  const okRows = detail?.summary?.ok
  return (
    <Modal title={request.kind === 'replen' ? 'Replen request' : 'Style sheet request'} subtitle={`${request.buyerCompany} · ${request.requestedByName} · ${requestWhen(request.createdAt)}${request.masterOrderName ? ` · ${request.masterOrderName}` : ''}`} onClose={() => { if (!busy) onClose() }} size="xxl" float>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {!detail && !err && <div style={{ fontSize: 13, color: T.textMuted }}>Opening…</div>}

        {detail && request.kind === 'replen' && (
          <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            {src?.image && <img src={src.image} alt="" style={{ width: 84, height: 110, objectFit: 'cover', borderRadius: 8, border: `1px solid ${T.border}` }} />}
            <div style={{ fontSize: 13.5, color: T.text, lineHeight: 1.7 }}>
              <div><b>{request.product}</b>{request.styleNumber ? ` (${request.styleNumber})` : ''}</div>
              <div>Reorder: <b>{Number(request.quantity).toLocaleString('en-IN')} pcs</b>{src?.totalQty ? ` (the first order was ${src.totalQty.toLocaleString('en-IN')} pcs)` : ''}</div>
              {request.note && <div>Note: {request.note}</div>}
              {!src && <div style={{ color: T.danger, fontWeight: 600 }}>The style it reorders no longer exists, so this cannot be approved.</div>}
              {src && src.phase !== 'production' && <div style={{ color: T.danger, fontWeight: 600 }}>That style is no longer in production, so this cannot be approved.</div>}
              <div style={{ color: T.textMuted, fontSize: 12.5 }}>Approving adds it as a new style in Replen, in the same master order, with no factory yet.</div>
            </div>
          </div>
        )}

        {detail && request.kind === 'import' && (detail.rows
          ? <>
              <div style={{ fontSize: 12.5, color: T.textMuted }}>
                <FileSpreadsheet size={13} style={{ verticalAlign: -2, marginRight: 5 }} />{request.filename}. This is the sheet as it reads now, checked the same way as when it was sent.
                {request.summary?.errors > 0 && ' The customer asked for the valid rows only.'}
              </div>
              <StyleImportPreview preview={detail} />
            </>
          : <div style={{ fontSize: 13, color: T.textMuted }}>The sheet is no longer kept for this request.</div>)}

        {err && <div style={{ fontSize: 12.5, color: T.danger, fontWeight: 600, background: T.dangerBg, border: `1px solid ${T.dangerBorder}`, borderRadius: 8, padding: '8px 12px' }}><AlertTriangle size={12} style={{ verticalAlign: -2, marginRight: 4 }} /> {err}</div>}

        {declining && <Textarea label="Why? (the customer sees this)" value={reason} onChange={e => setReason(e.target.value)} rows={3} maxLength={300} placeholder="Optional, e.g. Photos are missing for two styles" />}

        {request.status === 'pending' && (
          <FlexRow justify="flex-end" gap={8}>
            <Btn variant="secondary" onClick={onClose} disabled={!!busy}>Close</Btn>
            {!declining
              ? <Btn variant="secondary" onClick={() => setDeclining(true)} disabled={!!busy} icon={<X size={13} />}>Decline</Btn>
              : <Btn variant="secondary" onClick={decline} disabled={!!busy} icon={<X size={13} />}>{busy === 'decline' ? 'Declining…' : 'Confirm decline'}</Btn>}
            <Btn onClick={approve} disabled={!!busy || !detail || (request.kind === 'import' && !okRows) || (request.kind === 'replen' && (!src || src.phase !== 'production'))} icon={<Check size={13} />}>
              {busy === 'approve' ? 'Approving…' : request.kind === 'import' ? `Approve${okRows ? ` ${okRows} style${okRows !== 1 ? 's' : ''}` : ''}` : 'Approve'}
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
                  <span style={{ width: 34, height: 34, borderRadius: 9, background: r.kind === 'replen' ? '#ccfbf1' : T.primaryLight, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    {r.kind === 'replen' ? <RefreshCw size={16} color="#0f766e" /> : <FileSpreadsheet size={16} color={T.primaryDeep} />}
                  </span>
                  <div style={{ flex: 1, minWidth: 220 }}>
                    <div style={{ fontSize: 14, fontWeight: 800, color: T.text }}>{requestTitle(r)}</div>
                    <div style={{ fontSize: 12, color: T.textMuted }}>
                      {r.buyerCompany} · {r.requestedByName} · {requestWhen(r.createdAt)}{r.masterOrderName ? ` · ${r.masterOrderName}` : ''}
                      {r.kind === 'import' && r.summary ? ` · ${r.summary.ok} ready${r.summary.errors ? `, ${r.summary.errors} with problems` : ''}${r.summary.exists ? `, ${r.summary.exists} already there` : ''}` : ''}
                    </div>
                    {r.kind === 'replen' && r.note && <div style={{ fontSize: 12, color: T.text, marginTop: 2 }}>Note: {r.note}</div>}
                    {r.status === 'declined' && r.decisionNote && <div style={{ fontSize: 12, color: T.danger, marginTop: 2 }}>Reason: {r.decisionNote}</div>}
                  </div>
                  <span style={{ fontSize: 11, fontWeight: 800, color: st.fg, background: st.bg, border: `1px solid ${st.bd}`, borderRadius: 999, padding: '2px 10px' }}>{st.label}</span>
                  {r.status === 'approved' && r.createdOrderIds.length > 0 && (
                    <button onClick={() => onOpen?.(r.createdOrderIds[0])} style={{ fontSize: 12, fontWeight: 700, color: T.primaryDeep, background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>Open {r.createdOrderIds.length > 1 ? `first of ${r.createdOrderIds.length}` : r.createdOrderIds[0]} ↗</button>
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
