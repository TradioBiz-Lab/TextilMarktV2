import { useState } from 'react'
import { Modal, Input, Btn, FlexRow } from './ui.jsx'
import { T, pastDateNote } from '../constants.js'

// Moving a style to production needs a delivery date once it has a manufacturer: its plan gets the Delivery step it
// did not have while in development. `needsDate` is false when every style being moved already has a date or has no
// manufacturer yet (that date is asked for when the manufacturer is added).
export function PromoteModal({ count, needsDate, busy, onClose, onConfirm }) {
  const [date, setDate] = useState('')
  return (
    <Modal title={count > 1 ? `Move ${count} styles to production` : 'Move to production'} onClose={() => { if (!busy) onClose() }} size="sm">
      <div>
        <p style={{ fontSize: 13, color: T.textMuted, margin: '0 0 14px' }}>
          {needsDate
            ? 'Each plan gets its Delivery step now. Give the delivery date promised to the customer if you have it; without one the step stays undated until the date is set. Styles that already have a date keep theirs.'
            : 'A style with a manufacturer gets its Delivery step on its delivery date. A style with no manufacturer yet gets its date when the manufacturer is added.'}
        </p>
        {needsDate && <Input label="Promised delivery date" type="date" value={date} onChange={e => setDate(e.target.value)} hint={pastDateNote(date) || 'Optional'} />}
        <FlexRow justify="flex-end" gap={8} style={{ marginTop: 16 }}>
          <Btn variant="secondary" disabled={busy} onClick={onClose}>Cancel</Btn>
          <Btn disabled={busy} onClick={() => onConfirm(date || null)}>{busy ? 'Moving…' : 'Move to production'}</Btn>
        </FlexRow>
      </div>
    </Modal>
  )
}
