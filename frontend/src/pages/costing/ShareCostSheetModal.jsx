import { useState } from 'react'
import { Send } from '../../icons.jsx'
import { T } from '../../constants.js'
import { Btn, Modal, Alert, Textarea, FlexRow } from '../../components/ui.jsx'
import { costSheetsApi } from '../../api.js'
import { rupees } from '../../lib/procurement.js'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const parseEmails = text => [...new Set(String(text || '').split(/[\s,;]+/).map(e => e.trim().toLowerCase()).filter(Boolean))]

/**
 * Share this version with the customer: their team is told in the app and emailed the PDF with a link. They
 * are people the platform already knows, so the factory never needs their addresses; extra addresses are for
 * anyone else who should get the PDF. A shared version cannot be edited afterwards.
 */
export function ShareCostSheetModal({ sheet, onClose, onShared }) {
  const [message, setMessage] = useState('')
  const [extra, setExtra] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const emails = parseEmails(extra)
  const bad = emails.filter(e => !EMAIL_RE.test(e))
  const price = sheet.discountPct > 0 ? sheet.computed?.negotiated : sheet.computed?.price

  const send = async () => {
    if (bad.length) { setError(`Check these addresses: ${bad.join(', ')}`); return }
    if (emails.length > 5) { setError('Give up to 5 extra addresses'); return }
    setBusy(true); setError('')
    try { onShared(await costSheetsApi.share(sheet.id, { message: message.trim(), extraEmails: emails })) } catch (e) { setError(e?.message || 'Could not share the cost sheet'); setBusy(false) }
  }

  return (
    <Modal title={`Share with ${sheet.brandName}`} subtitle={`${sheet.styleName} · version ${sheet.version}`} onClose={busy ? () => {} : onClose} size="md">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ background: '#f8fafc', borderRadius: 10, padding: '12px 14px', fontSize: 13, color: T.text, lineHeight: 1.6 }}>
          <FlexRow justify="space-between"><span style={{ color: T.textMuted }}>{sheet.discountPct > 0 ? 'Negotiated price per piece' : 'Price per piece'}</span><strong style={{ fontVariantNumeric: 'tabular-nums' }}>{rupees(price)}</strong></FlexRow>
          <div style={{ marginTop: 6, color: T.textMuted }}>{sheet.brandName}'s team is told in TextilMarkt and emailed the PDF. They can comment and approve it there.</div>
        </div>
        <Textarea label="A note with it (optional)" value={message} onChange={e => setMessage(e.target.value)} rows={3} maxLength={1000} placeholder="For example: prices valid until the 30th" />
        <Textarea label="Also email the PDF to (optional)" value={extra} onChange={e => { setExtra(e.target.value); setError('') }} rows={2} placeholder="Other addresses, separated by commas" hint="Up to 5. Only people who should see the whole build-up." />
        <Alert type="warning">Once shared, this version cannot be edited. If a price changes, you make a new version.</Alert>
        {error && <Alert type="danger">{error}</Alert>}
        <FlexRow justify="flex-end" gap={8}>
          <Btn variant="secondary" onClick={onClose} disabled={busy}>Cancel</Btn>
          <Btn icon={<Send size={14} />} onClick={send} disabled={busy}>{busy ? 'Sharing...' : 'Share cost sheet'}</Btn>
        </FlexRow>
      </div>
    </Modal>
  )
}
