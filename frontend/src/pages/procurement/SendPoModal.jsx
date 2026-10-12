import { useEffect, useState } from 'react'
import { Send } from '../../icons.jsx'
import { T } from '../../constants.js'
import { Modal, Btn, Alert, Textarea, FlexRow, Input, SectionLabel } from '../../components/ui.jsx'
import { suppliersApi, purchaseOrdersApi } from '../../api.js'
import { rupees, fmtDay } from '../../lib/procurement.js'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Send a draft PO to its supplier by email, PDF attached. Says plainly what will go out and that it cannot
 * be unsent. `onSent(po, notice)` gets the server's answer: the PO as sent, and what actually happened
 * (who was emailed, or that no email service is set up here, or lines that could not be linked).
 */
export function SendPoModal({ po, onClose, onSent }) {
  const [choices, setChoices] = useState(() => (po.supplier.email ? [{ email: po.supplier.email, label: po.supplierName, on: true }] : []))
  const [extra, setExtra] = useState('')
  const [message, setMessage] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  // The supplier's other contacts are offered too, unchecked.
  useEffect(() => {
    let live = true
    suppliersApi.get(po.supplierId).then(s => {
      if (!live) return
      setChoices(prev => {
        const have = new Set(prev.map(c => c.email.toLowerCase()))
        const more = (s.contacts || []).filter(c => c.email && !have.has(c.email.toLowerCase())).map(c => ({ email: c.email, label: c.name || 'Contact', on: false }))
        return [...prev, ...more]
      })
    }).catch(() => { /* the main address is enough */ })
    return () => { live = false }
  }, [po.supplierId])

  const addExtra = () => {
    const e = extra.trim().toLowerCase()
    if (!EMAIL_RE.test(e)) { setErr('Enter a valid email address'); return }
    setErr('')
    setChoices(prev => (prev.some(c => c.email.toLowerCase() === e) ? prev.map(c => (c.email.toLowerCase() === e ? { ...c, on: true } : c)) : [...prev, { email: e, label: 'Added by you', on: true }]))
    setExtra('')
  }

  const chosen = choices.filter(c => c.on).map(c => c.email)
  const send = async () => {
    if (chosen.length === 0) { setErr('Choose who to send it to'); return }
    if (chosen.length > 5) { setErr('Send to at most 5 addresses'); return }
    setBusy(true); setErr('')
    try {
      const r = await purchaseOrdersApi.send(po.id, { to: chosen, message: message.trim() || undefined })
      onSent(r, r.notice || {})
    } catch (e) { setErr(e?.message || 'The purchase order could not be sent'); setBusy(false) }
  }

  return (
    <Modal title={`Send ${po.id}`} subtitle={`To ${po.supplierName}`} onClose={() => !busy && onClose()} size="md">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 12, padding: '12px 14px', background: T.bg, border: `1px solid ${T.border}`, borderRadius: 10 }}>
          <Summary label="Items">{po.lines.length}</Summary>
          <Summary label="Total">{rupees(po.totals.grandTotal)}</Summary>
          <Summary label="Delivery by">{fmtDay(po.expectedDate)}</Summary>
        </div>

        <div>
          <SectionLabel>Email it to</SectionLabel>
          {choices.length === 0 && <div style={{ fontSize: 13, color: T.warning, padding: '6px 0' }}>This supplier has no email address. Add one below.</div>}
          {choices.map(c => (
            <label key={c.email} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderBottom: `1px solid ${T.border}`, cursor: 'pointer', minHeight: 40 }}>
              <input type="checkbox" checked={c.on} onChange={e => setChoices(prev => prev.map(x => (x.email === c.email ? { ...x, on: e.target.checked } : x)))} style={{ width: 18, height: 18 }} />
              <span style={{ fontSize: 14, color: T.text, fontWeight: 600 }}>{c.email}</span>
              <span style={{ fontSize: 12, color: T.textLight }}>{c.label}</span>
            </label>
          ))}
          <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'flex-start' }}>
            <div style={{ flex: 1 }}><Input type="email" inputMode="email" value={extra} onChange={e => { setExtra(e.target.value); setErr('') }} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addExtra() } }} placeholder="Another email address" aria-label="Another email address" /></div>
            <Btn variant="secondary" onClick={addExtra} disabled={!extra.trim()}>Add</Btn>
          </div>
        </div>

        <Textarea label="Message (optional)" value={message} onChange={e => setMessage(e.target.value)} placeholder="For example: please confirm the delivery date by Friday." rows={3} maxLength={1000} />

        <Alert type="warning">The PDF goes to the supplier by email and cannot be unsent. Replies come to your own email address.</Alert>
        {err && <Alert type="danger">{err}</Alert>}
        <FlexRow justify="flex-end" gap={8}>
          <Btn variant="secondary" onClick={onClose} disabled={busy}>Cancel</Btn>
          <Btn icon={<Send size={14} />} onClick={send} disabled={busy || chosen.length === 0}>{busy ? 'Sending...' : 'Send purchase order'}</Btn>
        </FlexRow>
      </div>
    </Modal>
  )
}

function Summary({ label, children }) {
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 800, color: T.textLight, textTransform: 'uppercase', letterSpacing: '0.07em' }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 800, color: T.text, marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>{children}</div>
    </div>
  )
}
