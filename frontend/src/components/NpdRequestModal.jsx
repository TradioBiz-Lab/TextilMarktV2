import { useState } from 'react'
import { AlertTriangle, FlaskConical, FileSpreadsheet, Plus, Trash2 } from '../icons.jsx'
import { T } from '../constants.js'
import { Btn, FlexRow, Input, Modal } from './ui.jsx'
import { TagInput } from './TagInput.jsx'
import { styleRequestsApi } from '../api.js'
import { npdMissing } from '../styleRequests.js'
import { StyleImportModal } from '../pages/admin/StyleImportModal.jsx'

let _key = 1
const blank = () => ({ key: _key++, colours: [], quantity: '', delivery: '', techPackLink: '' })

// The customer's New product development: for each new style, its colours, quantity (optional), expected delivery date and
// tech pack link, and nothing else; Tradio names it and picks the master order when it reviews the request. Or, on the second
// tab, a sheet of styles.
export function NpdRequestModal({ onClose, onSent }) {
  const [tab, setTab] = useState('enter')
  const [styles, setStyles] = useState(() => [blank()])
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const update = (key, patch) => setStyles(p => p.map(s => (s.key === key ? { ...s, ...patch } : s)))

  const send = async () => {
    setErr('')
    const i = styles.findIndex(npdMissing)
    if (i !== -1) { setErr(`Style ${i + 1} ${npdMissing(styles[i])}.`); return }
    setSaving(true)
    try {
      const items = styles.map(s => ({ colours: s.colours, ...(String(s.quantity).trim() ? { quantity: Math.floor(Number(s.quantity)) } : {}), delivery: s.delivery, techPackLink: s.techPackLink.trim() }))
      const r = await styleRequestsApi.create('npd', items)
      onSent(r)
    } catch (e) {
      setErr(e?.message || 'Could not send the styles. Nothing was sent; try again.')
      setSaving(false)
    }
  }

  const tabBtn = (id, text, icon) => (
    <button onClick={() => setTab(id)} aria-pressed={tab === id}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 800, padding: '8px 14px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit', border: `1px solid ${tab === id ? T.primaryDeep : T.border}`, background: tab === id ? T.primaryDeep : T.surface, color: tab === id ? '#fff' : T.text }}>
      {icon}{text}
    </button>
  )

  return (
    <Modal title="New product development" subtitle="Tell Tradio about each new style. Tradio reviews the request, then plans it." onClose={() => { if (!saving) onClose() }} size="xl" float>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <FlexRow gap={8} style={{ flexWrap: 'wrap' }}>
          {tabBtn('enter', 'Enter styles', <FlaskConical size={13} />)}
          {tabBtn('import', 'Import from Excel or CSV', <FileSpreadsheet size={13} />)}
        </FlexRow>

        {tab === 'import' && <StyleImportModal embedded forReview noMasterOrder masterOrders={[]} onClose={onClose} onDone={r => onSent({ count: r?.summary?.ok })} />}

        {tab === 'enter' && (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: '56vh', overflowY: 'auto', paddingRight: 2 }}>
              {styles.map((s, i) => (
                <div key={s.key} style={{ border: `1px solid ${T.border}`, borderRadius: 10, padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <FlexRow justify="space-between">
                    <span style={{ fontSize: 13, fontWeight: 800, color: T.text }}>Style {i + 1}</span>
                    {styles.length > 1 && (
                      <button onClick={() => setStyles(p => p.filter(x => x.key !== s.key))} aria-label={`Remove style ${i + 1}`} style={{ background: 'none', border: 'none', cursor: 'pointer', color: T.textLight, display: 'flex' }}><Trash2 size={14} /></button>
                    )}
                  </FlexRow>
                  <TagInput label="Colours *" value={s.colours} onChange={v => update(s.key, { colours: v })} keepCase placeholder="Type a colour, then Enter" />
                  <div className="form-grid-2" style={{ gap: 10 }}>
                    <Input label="Quantity (optional)" type="number" min="1" step="1" value={s.quantity} onChange={e => update(s.key, { quantity: e.target.value })} placeholder="e.g. 1200" />
                    <Input label="Expected delivery date *" type="date" value={s.delivery} onChange={e => update(s.key, { delivery: e.target.value })} />
                  </div>
                  <Input label="Tech pack link *" value={s.techPackLink} onChange={e => update(s.key, { techPackLink: e.target.value })} placeholder="https://…" />
                </div>
              ))}
            </div>
            <div><Btn size="sm" variant="secondary" icon={<Plus size={13} />} onClick={() => setStyles(p => [...p, blank()])}>Add another style</Btn></div>

            {err && <div style={{ fontSize: 12, color: T.danger, fontWeight: 600, background: T.dangerBg, border: `1px solid ${T.dangerBorder}`, borderRadius: 8, padding: '8px 12px' }}><AlertTriangle size={12} style={{ verticalAlign: -2, marginRight: 4 }} /> {err}</div>}
            <FlexRow justify="flex-end" gap={8}>
              <Btn variant="secondary" onClick={onClose} disabled={saving}>Cancel</Btn>
              <Btn onClick={send} disabled={saving} icon={<FlaskConical size={13} />}>{saving ? 'Sending…' : `Send ${styles.length} for review`}</Btn>
            </FlexRow>
          </>
        )}
      </div>
    </Modal>
  )
}
