import { useState } from 'react'
import { Modal, Input, Btn, FlexRow } from './ui.jsx'
import { T } from '../constants.js'

// Moving a style to production needs a delivery date once it has a manufacturer: its plan gets the Delivery step it
// did not have while in development. `needsDate` is false when every style being moved already has a date or has no
// manufacturer yet (that date is asked for when the manufacturer is added).
export function PromoteModal({ count, needsDate, busy, onClose, onConfirm }) {
  const [date, setDate] = useState('')
  const blocked = needsDate && !date
  return (
    <Modal title={count > 1 ? `Move ${count} styles to production` : 'Move to production'} onClose={() => { if (!busy) onClose() }} size="sm">
      <div>
        <p style={{ fontSize: 13, color: T.textMuted, margin: '0 0 14px' }}>
          {needsDate
            ? 'A style in production with a manufacturer needs a delivery date: its plan gets a Delivery step on it now. Styles that already have a date keep theirs.'
            : 'A style with a manufacturer gets its Delivery step on its delivery date. A style with no manufacturer yet gets its date when the manufacturer is added.'}
        </p>
        {needsDate && <Input label="Expected Delivery *" type="date" value={date} onChange={e => setDate(e.target.value)} />}
        <FlexRow justify="flex-end" gap={8} style={{ marginTop: 16 }}>
          <Btn variant="secondary" disabled={busy} onClick={onClose}>Cancel</Btn>
          <Btn disabled={busy || blocked} onClick={() => onConfirm(date || null)}>{busy ? 'Moving…' : 'Move to production'}</Btn>
        </FlexRow>
      </div>
    </Modal>
  )
}
