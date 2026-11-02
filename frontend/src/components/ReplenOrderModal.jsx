import { useState } from 'react'
import { RefreshCw, AlertTriangle } from '../icons.jsx'
import { T } from '../constants.js'
import { Btn, FlexRow, Input, Modal, Textarea, useToast } from './ui.jsx'
import { useApp } from '../context.jsx'

// "Order replen": reorder a style that is in production. The new style is a copy of this one in the Replen stage with the
// quantity asked for; the customer says how many and, if it helps, adds a note. Tradio plans it from there.
export function ReplenOrderModal({ order, onClose, onOrdered }) {
  const { orderReplen, currentUser } = useApp()
  // A customer's replen is a request for Tradio's master admin to approve; Tradio's own is created at once.
  const forReview = currentUser?.role === 'buyer'
  const toast = useToast()
  const [quantity, setQuantity] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const qty = Number(quantity)
  const valid = Number.isInteger(qty) && qty >= 1

  const submit = async () => {
    setSaving(true); setErr('')
    try {
      const created = await orderReplen(order.id, { quantity: qty, ...(note.trim() ? { note: note.trim() } : {}) })
      toast(created.pending ? `Replen request sent to Tradio: ${created.product}, ${qty.toLocaleString('en-IN')} pcs` : `Replen ordered: ${created.product}, ${qty.toLocaleString('en-IN')} pcs`, 'success')
      onOrdered(created)
    } catch (e) {
      setErr(e?.message || (forReview ? 'Could not send the request.' : 'Could not order the replen.'))
      setSaving(false)
    }
  }

  return (
    <Modal title="Order replen" subtitle={`${order.product}${order.styleNumber ? ` · ${order.styleNumber}` : ''}`} onClose={() => { if (!saving) onClose() }} size="sm" float>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.55 }}>
          {forReview
            ? <>This asks Tradio to reorder the same style. Their master admin approves it, and it is then added as a new style in <b style={{ color: T.text }}>Replen</b> with the same product, photo, fabric and links.</>
            : <>This reorders the same style. It is added as a new style in <b style={{ color: T.text }}>Replen</b> with the same product, photo, fabric and links; Tradio plans it from there.</>}
        </div>
        <Input label="How many pieces? *" type="number" min="1" step="1" value={quantity} onChange={e => setQuantity(e.target.value)} placeholder="e.g. 1200"
          hint={order.totalQty ? `The first order was ${order.totalQty.toLocaleString('en-IN')} pcs.` : undefined} />
        <Textarea label="Note for Tradio" value={note} onChange={e => setNote(e.target.value)} rows={3} maxLength={500} placeholder="Optional, e.g. the date you need it by, or a change from last time" />
        {err && <div style={{ fontSize: 12, color: T.danger, fontWeight: 600, background: T.dangerBg, border: `1px solid ${T.dangerBorder}`, borderRadius: 8, padding: '8px 12px' }}><AlertTriangle size={12} style={{ verticalAlign: -2, marginRight: 4 }} /> {err}</div>}
        <FlexRow justify="flex-end" gap={8}>
          <Btn variant="secondary" onClick={onClose} disabled={saving}>Cancel</Btn>
          <Btn onClick={submit} disabled={!valid || saving} icon={<RefreshCw size={13} />}>{saving ? (forReview ? 'Sending…' : 'Ordering…') : (forReview ? 'Send replen request' : 'Order replen')}</Btn>
        </FlexRow>
      </div>
    </Modal>
  )
}
