import { useState } from 'react'
import { FileText, Sparkles } from '../../icons.jsx'
import { T } from '../../constants.js'
import { Btn, Modal, Alert, FlexRow } from '../../components/ui.jsx'
import { bomsApi } from '../../api.js'
import { fmtDay } from '../../lib/procurement.js'

/**
 * Pick one of the order's tech packs and have it read into the bill of materials. Reading is the slowest thing
 * in the app (a whole PDF goes to the model), so the dialog says so and stays open until it is done.
 */
export function TechPackModal({ orderId, packs, onClose, onRead }) {
  const [reading, setReading] = useState(null)
  const [error, setError] = useState('')

  const read = async doc => {
    setReading(doc.id); setError('')
    try { onRead(await bomsApi.extract(orderId, doc.id)) } catch (e) { setError(e?.message || 'The tech pack could not be read'); setReading(null) }
  }

  return (
    <Modal title="Read a tech pack" subtitle="The lines it finds are suggestions: you check them before the bill of materials can be frozen" onClose={reading ? () => {} : onClose} size="md">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {packs.length === 0 && <Alert type="info">There is no tech pack on this order yet. Upload one under "Documents and assets" at the top of the order (a PDF or an image), then come back here.</Alert>}
        {packs.map(d => (
          <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', border: `1px solid ${T.border}`, borderRadius: 10 }}>
            <FileText size={20} color={T.textMuted} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: T.text, overflowWrap: 'anywhere' }}>{d.name}</div>
              <div style={{ fontSize: 11, color: T.textLight }}>{d.fileName || ''}{d.issueDate ? ` · ${fmtDay(d.issueDate)}` : ''}</div>
            </div>
            <Btn size="sm" icon={<Sparkles size={13} />} onClick={() => read(d)} disabled={!!reading || (!d.fileName && !d.hasFile && d.externalUrl)}>{reading === d.id ? 'Reading...' : 'Read it'}</Btn>
          </div>
        ))}
        {reading && <Alert type="info">Reading the tech pack. This can take up to a minute: please keep this open.</Alert>}
        {error && <Alert type="danger">{error}</Alert>}
        <FlexRow justify="flex-end"><Btn variant="secondary" onClick={onClose} disabled={!!reading}>Close</Btn></FlexRow>
      </div>
    </Modal>
  )
}
