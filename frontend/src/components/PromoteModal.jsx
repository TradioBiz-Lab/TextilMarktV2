import { useState } from 'react'
import { Modal, Input, Btn, FlexRow } from './ui.jsx'
import { T } from '../constants.js'

// Moving a style to production needs a delivery date: it gets the Delivery step it did not have while in development.
// `needsDate` is false when every style being moved already has one.
export function PromoteModal({ count, needsDate, busy, onClose, onConfirm }) {
  const [date, setDate] = useState('')
  const blocked = needsDate && !date
  return (
    <Modal title={count > 1 ? `Move ${count} styles to production` : 'Move to production'} onClose={() => { if (!busy) onClose() }} size="sm">
      <div>
        <p style={{ fontSize: 13, color: T.textMuted, margin: '0 0 14px' }}>
          {needsDate
            ? 'A style in production needs a delivery date. It gets its Delivery step now. Styles that already have a date keep theirs.'
            : 'These styles already have a delivery date. Each gets its Delivery step.'}
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
