import { useState } from 'react'
import { Modal, Input, Btn, FlexRow } from './ui.jsx'
import { T, pastDateNote } from '../constants.js'

// Moving a style to production needs a delivery date once it has a manufacturer: its plan gets the Delivery step it
// did not have while in development. `needsDate` is false when every style being moved already has a date or has no
// manufacturer yet (that date is asked for when the manufacturer is added).
// `needsQty`: a style from New Product Development that has no quantity yet gives one here (production needs it).
export function PromoteModal({ count, needsDate, needsQty = false, busy, onClose, onConfirm }) {
  const [date, setDate] = useState('')
  const [qty, setQty] = useState('')
  const qtyOk = !needsQty || (Number.isInteger(Number(qty)) && Number(qty) > 0)
  return (
    <Modal title={count > 1 ? `Move ${count} styles to production` : 'Move to production'} onClose={() => { if (!busy) onClose() }} size="sm">
      <div>
        <p style={{ fontSize: 13, color: T.textMuted, margin: '0 0 14px' }}>
          {needsDate
            ? 'Each plan gets its Delivery step now. Give the delivery date promised to the customer if you have it; without one the step stays undated until the date is set. Styles that already have a date keep theirs.'
            : 'A style with a manufacturer gets its Delivery step on its delivery date. A style with no manufacturer yet gets its date when the manufacturer is added.'}
        </p>
        {needsQty && <div style={{ marginBottom: 12 }}><Input label="Total Quantity *" type="number" value={qty} onChange={e => setQty(e.target.value)} placeholder="5000" hint="Production needs the bulk quantity." /></div>}
        {needsDate && <Input label="Promised delivery date" type="date" value={date} onChange={e => setDate(e.target.value)} hint={pastDateNote(date) || 'Optional'} />}
        <FlexRow justify="flex-end" gap={8} style={{ marginTop: 16 }}>
          <Btn variant="secondary" disabled={busy} onClick={onClose}>Cancel</Btn>
          <Btn disabled={busy || !qtyOk} onClick={() => onConfirm(date || null, needsQty ? Math.floor(Number(qty)) : undefined)}>{busy ? 'Moving…' : 'Move to production'}</Btn>
        </FlexRow>
      </div>
    </Modal>
  )
}
