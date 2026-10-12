import { useState } from 'react'
import { Modal, Btn, Alert, Textarea, FlexRow } from '../../components/ui.jsx'
import { T } from '../../constants.js'
import { purchaseOrdersApi } from '../../api.js'
import { fmtQty } from '../../lib/procurement.js'

/**
 * Goods have come in: type what arrived against each line. Built for a phone at the store: one card per
 * line, big number fields with a decimal keypad, and "Receive everything outstanding" for the usual case.
 */
export function ReceiveModal({ po, onClose, onReceived }) {
  const open = po.lines.filter(l => l.receivedQty < l.qty)
  const [qty, setQty] = useState(() => Object.fromEntries(open.map(l => [l.lineId, ''])))
  const [note, setNote] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const remaining = l => Math.max(0, Math.round((l.qty - l.receivedQty) * 1000) / 1000)
  const entered = open.map(l => ({ lineId: l.lineId, qty: Number(qty[l.lineId]) })).filter(r => Number.isFinite(r.qty) && r.qty > 0)
  const all = () => setQty(Object.fromEntries(open.map(l => [l.lineId, String(remaining(l))])))

  const submit = async () => {
    if (entered.length === 0) { setErr('Type how much has arrived against at least one line'); return }
    setBusy(true); setErr('')
    try {
      const r = await purchaseOrdersApi.receive(po.id, { lines: entered, note: note.trim() || undefined })
      onReceived(r, r.notice || {})
    } catch (e) { setErr(e?.message || 'Could not record the delivery'); setBusy(false) }
  }

  return (
    <Modal title="Goods received" subtitle={`${po.id} · ${po.supplierName}`} onClose={() => !busy && onClose()} size="lg">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <FlexRow justify="space-between" style={{ flexWrap: 'wrap', gap: 8 }}>
          <div style={{ fontSize: 13, color: T.textMuted }}>Type what arrived in this delivery.</div>
          <Btn variant="secondary" size="sm" onClick={all}>Receive everything outstanding</Btn>
        </FlexRow>
        {open.map(l => (
          <div key={l.lineId} style={{ border: `1px solid ${T.border}`, borderRadius: 10, padding: '12px 14px', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 200px', minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>{l.description}</div>
              <div style={{ fontSize: 12, color: T.textMuted, marginTop: 3 }}>
                Ordered {fmtQty(l.qty)} {l.unit}{l.receivedQty ? `, already received ${fmtQty(l.receivedQty)}` : ''}. Still to come: <strong>{fmtQty(remaining(l))} {l.unit}</strong>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input inputMode="decimal" aria-label={`Received quantity for ${l.description}`} value={qty[l.lineId]} placeholder="0"
                onChange={e => { setQty({ ...qty, [l.lineId]: e.target.value.replace(/[^0-9.]/g, '') }); setErr('') }}
                style={{ width: 120, height: 46, border: `1px solid ${T.border}`, borderRadius: 10, padding: '0 12px', fontSize: 18, fontWeight: 700, textAlign: 'right', fontFamily: 'inherit', fontVariantNumeric: 'tabular-nums', color: T.text }} />
              <span style={{ fontSize: 13, color: T.textMuted, minWidth: 28 }}>{l.unit}</span>
            </div>
          </div>
        ))}
        <Textarea label="Note (optional)" value={note} onChange={e => setNote(e.target.value)} placeholder="Lorry number, challan number, anything worth keeping" rows={2} maxLength={500} />
        {err && <Alert type="danger">{err}</Alert>}
        <FlexRow justify="flex-end" gap={8}>
          <Btn variant="secondary" onClick={onClose} disabled={busy}>Cancel</Btn>
          <Btn variant="success" onClick={submit} disabled={busy || entered.length === 0}>{busy ? 'Saving...' : 'Record delivery'}</Btn>
        </FlexRow>
      </div>
    </Modal>
  )
}
