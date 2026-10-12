import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, Pencil, Send, Download, Eye, Trash2, Check, Package } from '../../icons.jsx'
import { T } from '../../constants.js'
import { Btn, Card, Modal, Alert, FlexRow, SectionLabel, LoadingScreen, Textarea, Mono, FileViewer, useToast } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'
import { capsFor } from '../../caps.js'
import { purchaseOrdersApi } from '../../api.js'
import { posStore } from '../../stores/procurement.jsx'
import { rupees, fmtQty, fmtDay, OPEN_STATUSES } from '../../lib/procurement.js'
import { DataTable } from '../../components/DataTable.jsx'
import { StatusPill, Progress, Fact } from './common.jsx'
import { SendPoModal } from './SendPoModal.jsx'
import { ReceiveModal } from './ReceiveModal.jsx'

const receivedColor = l => (l.receivedQty >= l.qty ? T.success : l.receivedQty ? T.warning : T.textLight)

/** One purchase order: what it says, where it stands, and what can be done with it next. */
export function PoDetail({ poId, onBack, onNavigate, onOpenOrder }) {
  const toast = useToast()
  const { currentUser } = useApp()
  const caps = capsFor(currentUser)
  const { items: list, refresh } = posStore.useStore()
  const [po, setPo] = useState(null)
  const [error, setError] = useState('')
  const [dialog, setDialog] = useState(null)        // 'send' | 'receive' | 'ack' | 'close' | 'cancel' | 'delete'
  const [pdf, setPdf] = useState(null)              // { fileName, dataUrl }
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try { setPo(await purchaseOrdersApi.get(poId)); setError('') } catch (e) { setError(e?.message || 'Could not load this purchase order') }
  }, [poId])
  useEffect(() => { load() }, [load])

  // Someone else (a teammate on another phone) moved this PO: the list store notices, and so do we.
  const seen = list.find(p => p.id === poId)
  const signature = seen ? `${seen.status}|${seen.receivedPct}|${seen.grandTotal}` : ''
  useEffect(() => { if (signature && po && signature !== `${po.status}|${po.receivedPct}|${po.totals.grandTotal}`) load() }, [signature]) // eslint-disable-line react-hooks/exhaustive-deps

  const changed = async next => { setPo(next); await refresh() }

  const preview = async () => {
    setBusy(true)
    try { setPdf(await purchaseOrdersApi.pdf(poId)) } catch (e) { toast(e?.message || 'Could not open the PDF', 'error') } finally { setBusy(false) }
  }

  if (error) return <div><Btn variant="secondary" size="sm" onClick={onBack} icon={<ArrowLeft size={13} />}>Back</Btn><div style={{ height: 14 }} /><Alert type="danger">{error}</Alert></div>
  if (!po) return <LoadingScreen message="Loading purchase order..." />

  const can = caps.manageProcurement
  const draft = po.status === 'draft'
  const open = OPEN_STATUSES.includes(po.status)
  const hasReceipts = po.receipts.length > 0
  const t = po.totals

  const lineColumns = [
    { key: 'description', header: 'Item', primary: true, render: l => (
      <div>
        <div style={{ fontWeight: 600, color: T.text, fontSize: 13 }}>{l.description}</div>
        <div style={{ fontSize: 11, color: T.textLight, marginTop: 2, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {l.hsnCode && <span>HSN {l.hsnCode}</span>}
          {l.materialRef && <button type="button" onClick={() => onOpenOrder(l.materialRef.orderId)} style={{ background: 'none', border: 'none', padding: 0, color: T.primaryDeep, cursor: 'pointer', fontFamily: 'inherit', fontSize: 11, fontWeight: 600 }}>For order {l.materialRef.orderId}</button>}
          {l.note && <span>{l.note}</span>}
        </div>
      </div>
    ) },
    { key: 'qty', header: 'Ordered', numeric: true, render: l => `${fmtQty(l.qty)} ${l.unit}` },
    { key: 'received', header: 'Received', numeric: true, render: l => <span style={{ color: receivedColor(l), fontWeight: 600 }}>{l.receivedQty ? `${fmtQty(l.receivedQty)} ${l.unit}` : '-'}</span> },
    { key: 'rate', header: 'Rate', numeric: true, render: l => rupees(l.rate) },
    { key: 'taxPct', header: 'GST', numeric: true, render: l => `${fmtQty(l.taxPct)}%` },
    { key: 'amount', header: 'Amount', numeric: true, render: l => <strong>{rupees(l.amount)}</strong> },
  ]

  return (
    <div style={{ maxWidth: 1040 }}>
      <FlexRow gap={10} style={{ marginBottom: 14, flexWrap: 'wrap' }}>
        <Btn variant="secondary" size="sm" onClick={onBack} icon={<ArrowLeft size={13} />}>Back</Btn>
      </FlexRow>

      <Card>
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 260px', minWidth: 0 }}>
            <FlexRow gap={10} style={{ flexWrap: 'wrap' }}>
              <Mono style={{ fontSize: 17, fontWeight: 800, color: T.text }}>{po.id}</Mono>
              <StatusPill status={po.status} />
            </FlexRow>
            <div style={{ fontSize: 14, color: T.textMuted, marginTop: 6 }}>
              To <button type="button" onClick={() => onNavigate('suppliers', { supplier: po.supplierId })} style={{ background: 'none', border: 'none', padding: 0, color: T.primaryDeep, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', fontSize: 14 }}>{po.supplierName}</button>
            </div>
          </div>
          <FlexRow gap={8} style={{ flexWrap: 'wrap' }}>
            {draft && can && <Btn icon={<Send size={14} />} onClick={() => setDialog('send')}>Send to supplier</Btn>}
            {draft && can && <Btn variant="secondary" icon={<Pencil size={13} />} onClick={() => onNavigate('po_builder', { po: po.id })}>Edit</Btn>}
            {open && can && po.lines.some(l => l.receivedQty < l.qty) && <Btn variant="success" icon={<Package size={14} />} onClick={() => setDialog('receive')}>Goods received</Btn>}
            {po.status === 'sent' && can && <Btn variant="secondary" icon={<Check size={13} />} onClick={() => setDialog('ack')}>Supplier confirmed</Btn>}
            <Btn variant="secondary" icon={draft ? <Eye size={13} /> : <Download size={13} />} disabled={busy} onClick={preview}>{draft ? 'Preview PDF' : 'View PDF'}</Btn>
            {open && can && <Btn variant="secondary" onClick={() => setDialog('close')}>Close</Btn>}
            {(draft || po.status === 'sent' || po.status === 'acknowledged') && !hasReceipts && can && <Btn variant="danger" onClick={() => setDialog(draft ? 'delete' : 'cancel')} icon={draft ? <Trash2 size={13} /> : undefined}>{draft ? 'Delete draft' : 'Cancel PO'}</Btn>}
          </FlexRow>
        </div>

        {po.warnings?.length > 0 && <div style={{ marginTop: 14 }}><Alert type="warning">{po.warnings.map((w, i) => <div key={i}>{w.message}</div>)}</Alert></div>}
        {po.status === 'cancelled' && <div style={{ marginTop: 14 }}><Alert type="danger">Cancelled{po.cancelReason ? `: ${po.cancelReason}` : ''}</Alert></div>}
        {po.status === 'closed' && po.closedReason && <div style={{ marginTop: 14 }}><Alert type="info">Closed: {po.closedReason}</Alert></div>}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 16, marginTop: 18, paddingTop: 16, borderTop: `1px solid ${T.border}` }}>
          <Fact label="Total">{rupees(t.grandTotal)}</Fact>
          <Fact label="Delivery by">{po.expectedDate && fmtDay(po.expectedDate)}</Fact>
          <Fact label="Sent">{po.sentAt && fmtDay(po.sentAt)}</Fact>
          <Fact label="Emailed to">{po.sentTo.join(', ')}</Fact>
          <Fact label="Payment terms">{po.paymentTerms}</Fact>
          <Fact label="Received">{(open || po.status === 'closed') && <div style={{ minWidth: 120 }}><Progress pct={po.receivedPct} tone={po.status === 'closed' ? 'good' : 'warn'} /></div>}</Fact>
        </div>
      </Card>

      <div style={{ height: 14 }} />
      <Card pad={false}>
        <div style={{ padding: '16px 20px 8px' }}><SectionLabel>Items ({po.lines.length})</SectionLabel></div>
        <DataTable columns={lineColumns} rows={po.lines} rowKey="lineId" stickyHeader={false} style={{ border: 0, borderRadius: 0 }} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '14px 20px 18px', borderTop: `1px solid ${T.border}` }}>
          <div style={{ width: 'min(100%, 300px)' }}>
            <TotalRow label="Subtotal" value={t.subtotal} />
            {t.discount > 0 && <TotalRow label="Discount" value={-t.discount} />}
            <TotalRow label="Taxable value" value={t.taxable} />
            {po.taxMode === 'intra' && t.byRate.filter(g => g.rate).flatMap(g => [<TotalRow key={`c${g.rate}`} label={`CGST @ ${fmtQty(g.rate / 2)}%`} value={g.cgst} />, <TotalRow key={`s${g.rate}`} label={`SGST @ ${fmtQty(g.rate / 2)}%`} value={g.sgst} />])}
            {po.taxMode === 'inter' && t.byRate.filter(g => g.rate).map(g => <TotalRow key={g.rate} label={`IGST @ ${fmtQty(g.rate)}%`} value={g.igst} />)}
            {po.taxMode === 'unknown' && t.byRate.filter(g => g.rate).map(g => <TotalRow key={g.rate} label={`GST @ ${fmtQty(g.rate)}%`} value={g.gst} />)}
            {t.roundOff !== 0 && <TotalRow label="Round off" value={t.roundOff} />}
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, paddingTop: 10, borderTop: `2px solid ${T.text}`, fontSize: 16, fontWeight: 800 }}>
              <span>Total</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>{rupees(t.grandTotal)}</span>
            </div>
            {po.taxMode === 'unknown' && <div style={{ fontSize: 11, color: T.warning, marginTop: 8, lineHeight: 1.45 }}>GST is shown as one figure because the supplier's or your own state is not set.</div>}
          </div>
        </div>
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14, marginTop: 14 }}>
        <Card>
          <SectionLabel>History</SectionLabel>
          <div style={{ marginTop: 8 }}>
            {[...po.timeline].reverse().map((e, i) => (
              <div key={i} style={{ display: 'flex', gap: 12, padding: '9px 0', borderBottom: i < po.timeline.length - 1 ? `1px solid ${T.border}` : 'none' }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: i === 0 ? T.primary : T.border, marginTop: 6, flexShrink: 0 }} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{e.action}</div>
                  <div style={{ fontSize: 11, color: T.textLight, marginTop: 1 }}>{fmtDay(e.at)}{e.byName ? ` · ${e.byName}` : ''}</div>
                  {e.note && <div style={{ fontSize: 12, color: T.textMuted, marginTop: 3, lineHeight: 1.45 }}>{e.note}</div>}
                </div>
              </div>
            ))}
          </div>
        </Card>
        <Card>
          <SectionLabel>Supplier and delivery</SectionLabel>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 14, marginTop: 10 }}>
            <Fact label="Supplier">{po.supplier.name}</Fact>
            <Fact label="GSTIN">{po.supplier.gstin}</Fact>
            <Fact label="State">{po.supplier.stateName}</Fact>
            <Fact label="Email">{po.supplier.email}</Fact>
            <Fact label="Deliver to">{po.shipTo || [po.buyer.address, po.buyer.city].filter(Boolean).join(', ')}</Fact>
            <Fact label="Tax">{po.taxMode === 'intra' ? 'CGST + SGST (same state)' : po.taxMode === 'inter' ? 'IGST (another state)' : 'GST (state not set)'}</Fact>
          </div>
          {po.terms && <div style={{ marginTop: 14 }}><SectionLabel>Terms</SectionLabel><div style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.55, whiteSpace: 'pre-wrap', marginTop: 4 }}>{po.terms}</div></div>}
          {po.internalNote && <div style={{ marginTop: 14 }}><SectionLabel>Your note (not on the PDF)</SectionLabel><div style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.55, whiteSpace: 'pre-wrap', marginTop: 4 }}>{po.internalNote}</div></div>}
        </Card>
      </div>

      {po.receipts.length > 0 && (
        <>
          <div style={{ height: 14 }} />
          <Card>
            <SectionLabel>Deliveries received</SectionLabel>
            {po.receipts.map((r, i) => (
              <div key={i} style={{ padding: '10px 0', borderBottom: `1px solid ${T.border}`, fontSize: 13 }}>
                <div style={{ fontWeight: 700, color: T.text }}>{fmtDay(r.at)}{r.note ? <span style={{ fontWeight: 400, color: T.textMuted }}> · {r.note}</span> : null}</div>
                <div style={{ color: T.textMuted, marginTop: 3 }}>{r.lines.map(rl => { const l = po.lines.find(x => x.lineId === rl.lineId); return l ? `${fmtQty(rl.qty)} ${l.unit} of ${l.description}` : null }).filter(Boolean).join('; ')}</div>
              </div>
            ))}
          </Card>
        </>
      )}

      {pdf && <FileViewer name={`Purchase order ${po.id}`} fileName={pdf.fileName} dataUrl={pdf.dataUrl} onClose={() => setPdf(null)} />}
      {dialog === 'send' && <SendPoModal po={po} onClose={() => setDialog(null)} onSent={async (sent, notice) => {
        setDialog(null)
        await changed(sent)
        if (notice.emailSkipped) toast('Marked as sent, but no email went out: email is not set up on this server', 'warning')
        else toast(`Sent to ${(notice.emailed || []).join(', ')}`, 'success')
        if (notice.unlinkedLines?.length) toast(`Could not link: ${notice.unlinkedLines.join(', ')} (the material is no longer on the order)`, 'warning')
      }} />}
      {dialog === 'receive' && <ReceiveModal po={po} onClose={() => setDialog(null)} onReceived={async (next, notice) => {
        setDialog(null); await changed(next)
        toast(next.status === 'closed' ? 'All goods received' : 'Delivery recorded', 'success')
        if (notice.unlinkedLines?.length) toast(`Could not update: ${notice.unlinkedLines.join(', ')} (the material is no longer on the order)`, 'warning')
      }} />}
      {dialog === 'ack' && <AckDialog po={po} onClose={() => setDialog(null)} onDone={async next => { setDialog(null); await changed(next); toast('Marked as confirmed by the supplier', 'success') }} />}
      {dialog === 'close' && <ReasonDialog title="Close this purchase order?" blurb="Use this when the supplier has delivered what they will, even if it is short. Nothing more is expected." action="Close purchase order" optional
        onClose={() => setDialog(null)} onSubmit={reason => purchaseOrdersApi.close(po.id, reason)} onDone={async next => { setDialog(null); await changed(next); toast('Purchase order closed', 'success') }} />}
      {dialog === 'cancel' && <ReasonDialog title="Cancel this purchase order?" blurb="The supplier is not notified automatically: tell them. Material lines held on this PO go back to being unordered." action="Cancel purchase order" danger
        onClose={() => setDialog(null)} onSubmit={reason => purchaseOrdersApi.cancel(po.id, reason)} onDone={async next => { setDialog(null); await changed(next); toast('Purchase order cancelled', 'success') }} />}
      {dialog === 'delete' && <ConfirmDelete po={po} onClose={() => setDialog(null)} onDone={async () => { await refresh(); toast('Draft deleted', 'success'); onBack() }} />}
    </div>
  )
}

function TotalRow({ label, value }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 13, color: T.textMuted }}>
      <span>{label}</span><span style={{ fontVariantNumeric: 'tabular-nums', color: T.text }}>{value < 0 ? '-' : ''}{rupees(Math.abs(value))}</span>
    </div>
  )
}

function AckDialog({ po, onClose, onDone }) {
  const [date, setDate] = useState(po.expectedDate || '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const go = async () => {
    setBusy(true)
    try { onDone(await purchaseOrdersApi.acknowledge(po.id, date ? { expectedDate: date } : {})) } catch (e) { setErr(e?.message || 'That did not work'); setBusy(false) }
  }
  return (
    <Modal title="Supplier confirmed" subtitle={po.id} onClose={() => !busy && onClose()} size="sm">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.5 }}>Record that {po.supplierName} has confirmed this order. If they promised a different delivery date, set it.</div>
        <label style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Delivery promised
          <input type="date" value={date} onChange={e => setDate(e.target.value)} style={{ display: 'block', width: '100%', marginTop: 5, border: `1px solid ${T.border}`, borderRadius: 8, padding: '9px 12px', fontSize: 14, fontFamily: 'inherit', boxSizing: 'border-box' }} />
        </label>
        {err && <Alert type="danger">{err}</Alert>}
        <FlexRow justify="flex-end" gap={8}><Btn variant="secondary" onClick={onClose} disabled={busy}>Cancel</Btn><Btn onClick={go} disabled={busy}>{busy ? 'Saving...' : 'Save'}</Btn></FlexRow>
      </div>
    </Modal>
  )
}

function ReasonDialog({ title, blurb, action, optional, danger, onClose, onSubmit, onDone }) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const go = async () => {
    if (!optional && !reason.trim()) { setErr('Say why'); return }
    setBusy(true)
    try { onDone(await onSubmit(reason.trim())) } catch (e) { setErr(e?.message || 'That did not work'); setBusy(false) }
  }
  return (
    <Modal title={title} onClose={() => !busy && onClose()} size="sm">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.5 }}>{blurb}</div>
        <Textarea label={optional ? 'Reason (optional)' : 'Reason'} value={reason} onChange={e => { setReason(e.target.value); setErr('') }} rows={3} maxLength={500} />
        {err && <Alert type="danger">{err}</Alert>}
        <FlexRow justify="flex-end" gap={8}><Btn variant="secondary" onClick={onClose} disabled={busy}>Not now</Btn><Btn variant={danger ? 'danger' : 'primary'} onClick={go} disabled={busy}>{busy ? 'Working...' : action}</Btn></FlexRow>
      </div>
    </Modal>
  )
}

function ConfirmDelete({ po, onClose, onDone }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const go = async () => { setBusy(true); try { await purchaseOrdersApi.remove(po.id); onDone() } catch (e) { setErr(e?.message || 'That did not work'); setBusy(false) } }
  return (
    <Modal title="Delete this draft?" subtitle={po.id} onClose={() => !busy && onClose()} size="sm">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.5 }}>The draft is thrown away. It was never sent, so nobody is affected.</div>
        {err && <Alert type="danger">{err}</Alert>}
        <FlexRow justify="flex-end" gap={8}><Btn variant="secondary" onClick={onClose} disabled={busy}>Keep it</Btn><Btn variant="danger" onClick={go} disabled={busy}>{busy ? 'Deleting...' : 'Delete draft'}</Btn></FlexRow>
      </div>
    </Modal>
  )
}
