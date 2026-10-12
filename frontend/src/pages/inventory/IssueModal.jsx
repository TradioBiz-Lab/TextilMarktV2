import { useMemo, useState } from 'react'
import { Plus, Trash2 } from '../../icons.jsx'
import { Modal, Btn, Alert, Input, Select, FlexRow, useToast } from '../../components/ui.jsx'
import { T } from '../../constants.js'
import { useApp } from '../../context.jsx'
import { inventoryApi } from '../../api.js'
import { fmtQty } from '../../lib/procurement.js'
import { decimal, issueProblems } from '../../lib/inventory.js'
import { newKey } from '../../lib/bomUi.js'

/**
 * Hand stock out to one of the factory's orders (or bring unused stock back from one). The store's balance is
 * checked as the quantity is typed, so "only 60 kg in the store" is seen before it is sent; the server checks
 * again and is the one that decides.
 */
export function IssueModal({ items, initialItem, onClose, onDone }) {
  const toast = useToast()
  const { orders } = useApp()
  const live = useMemo(() => items.filter(i => i.isActive !== false), [items])
  const myOrders = useMemo(() => (orders || []).filter(o => o.assignments?.[0]?.status !== 'Delivered').sort((a, b) => String(a.product).localeCompare(String(b.product))), [orders])
  const [type, setType] = useState('issue')
  const [orderId, setOrderId] = useState('')
  const [stageIndex, setStageIndex] = useState('')
  const [lines, setLines] = useState(() => [{ key: newKey(), itemId: initialItem?.id || '', qty: '' }])
  const [note, setNote] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const order = myOrders.find(o => o.id === orderId)
  const stages = order?.assignments?.[0]?.stages || []
  const problems = issueProblems(lines, live, type)
  const filled = lines.filter(l => l.itemId && Number(l.qty) > 0)
  const canSend = !!orderId && filled.length > 0 && problems.every(p => !p)

  const setLine = (key, patch) => { setLines(ls => ls.map(l => (l.key === key ? { ...l, ...patch } : l))); setErr('') }

  const submit = async () => {
    setBusy(true)
    try {
      const slip = await inventoryApi.createIssue({
        orderId, type, ...(stageIndex !== '' ? { stageIndex: Number(stageIndex) } : {}), note: note.trim(),
        lines: filled.map(l => ({ itemId: l.itemId, qty: Number(l.qty) })),
      })
      toast(`${type === 'issue' ? 'Issued' : 'Returned'}: ${slip.number}`, 'success')
      onDone(slip)
    } catch (e) { setErr(e?.message || 'That could not be recorded'); setBusy(false) }
  }

  return (
    <Modal title={type === 'issue' ? 'Issue stock to an order' : 'Return unused stock'} subtitle="What each order really used is worked out from these slips." onClose={() => !busy && onClose()} size="lg">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div role="group" aria-label="Issue or return" style={{ display: 'flex', gap: 6 }}>
          {[['issue', 'Issue to an order'], ['return', 'Return from an order']].map(([id, label]) => (
            <button key={id} type="button" aria-pressed={type === id} onClick={() => setType(id)}
              style={{ flex: 1, minHeight: 44, fontSize: 13, fontWeight: 700, borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit', border: `1px solid ${type === id ? T.primary : T.border}`, background: type === id ? T.primaryLight : T.surface, color: type === id ? T.primaryDark : T.textMuted }}>{label}</button>
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
          <Select label="Order" value={orderId} onChange={e => { setOrderId(e.target.value); setStageIndex(''); setErr('') }}>
            <option value="">Choose an order</option>
            {myOrders.map(o => <option key={o.id} value={o.id}>{o.product}{o.styleNumber ? ` (${o.styleNumber})` : ''} - {o.id}</option>)}
          </Select>
          <Select label="For which step (optional)" value={stageIndex} onChange={e => setStageIndex(e.target.value)} disabled={!order}>
            <option value="">Not specified</option>
            {stages.map((s, i) => <option key={i} value={i}>{s.name}</option>)}
          </Select>
        </div>

        <div>
          {lines.map((l, i) => {
            const item = live.find(x => x.id === l.itemId)
            return (
              <div key={l.key} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap', padding: '10px 0', borderBottom: `1px solid ${T.border}` }}>
                <div style={{ flex: '2 1 240px', minWidth: 0 }}>
                  <Select value={l.itemId} onChange={e => setLine(l.key, { itemId: e.target.value })} aria-label={`Item ${i + 1}`}>
                    <option value="">Choose an item</option>
                    {live.map(it => <option key={it.id} value={it.id}>{it.name} ({fmtQty(it.onHand)} {it.unit} in store)</option>)}
                  </Select>
                  {problems[i] && <div role="alert" style={{ fontSize: 12, color: T.danger, marginTop: 4 }}>{problems[i]}</div>}
                </div>
                <div style={{ flex: '1 1 130px', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Input inputMode="decimal" value={l.qty} placeholder="0" aria-label={`Quantity for item ${i + 1}`} onChange={e => setLine(l.key, { qty: decimal(e.target.value) })}
                    style={{ flex: 1 }} inputStyle={{ minHeight: 44, fontSize: 18, fontWeight: 700, textAlign: 'right' }} />
                  <span style={{ fontSize: 13, color: T.textMuted, minWidth: 28 }}>{item?.unit || ''}</span>
                </div>
                {lines.length > 1 && <button type="button" className="gl-remove" onClick={() => setLines(ls => ls.filter(x => x.key !== l.key))} aria-label={`Remove item ${i + 1}`}><Trash2 size={14} /></button>}
              </div>
            )
          })}
          <div style={{ marginTop: 10 }}><Btn variant="secondary" size="sm" icon={<Plus size={12} />} onClick={() => setLines(ls => [...ls, { key: newKey(), itemId: '', qty: '' }])}>Add another item</Btn></div>
        </div>

        <Input label="Note (optional)" value={note} maxLength={500} onChange={e => setNote(e.target.value)} placeholder="For the first cutting lot" />
        {err && <Alert type="danger">{err}</Alert>}
        <FlexRow justify="flex-end" gap={8}>
          <Btn variant="secondary" onClick={onClose} disabled={busy}>Cancel</Btn>
          <Btn onClick={submit} disabled={!canSend || busy}>{busy ? 'Saving...' : type === 'issue' ? 'Issue stock' : 'Return stock'}</Btn>
        </FlexRow>
      </div>
    </Modal>
  )
}
