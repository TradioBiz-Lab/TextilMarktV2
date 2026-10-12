import { useEffect, useState } from 'react'
import { Modal, Btn, Alert, Input, Select, Textarea, FlexRow, SectionLabel, LoadingScreen, useToast } from '../../components/ui.jsx'
import { T } from '../../constants.js'
import { inventoryApi } from '../../api.js'
import { fmtQty, fmtDay } from '../../lib/procurement.js'
import { CATEGORIES, categoryLabel, ledgerLabel, signedQty, decimal, round3 } from '../../lib/inventory.js'
import { Pill } from '../procurement/common.jsx'

const UNITS = ['kg', 'm', 'pcs', 'yds', 'set', 'roll', 'cone', 'box', 'carton']

/** Add an item to the stock list by hand, or change one. (Goods received add their own items.) */
export function ItemFormModal({ item, onClose, onSaved }) {
  const toast = useToast()
  const [f, setF] = useState(() => ({
    name: item?.name || '', unit: item?.unit || 'pcs', category: item?.category || 'fabric', reorderLevel: item?.reorderLevel ? String(item.reorderLevel) : '',
    hsnCode: item?.hsnCode || '', notes: item?.notes || '',
  }))
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const set = patch => { setF(v => ({ ...v, ...patch })); setErr('') }

  const submit = async () => {
    if (!f.name.trim()) { setErr('Name the item'); return }
    setBusy(true)
    try {
      const body = { name: f.name.trim(), unit: f.unit.trim() || 'pcs', category: f.category, reorderLevel: Number(f.reorderLevel) || 0, hsnCode: f.hsnCode.trim(), notes: f.notes.trim() }
      const saved = item ? await inventoryApi.updateItem(item.id, body) : await inventoryApi.createItem(body)
      toast(item ? 'Item saved' : `${saved.name} added to stock`, 'success')
      onSaved(saved)
    } catch (e) {
      setErr(e?.message || 'The item could not be saved')
      setBusy(false)
    }
  }

  return (
    <Modal title={item ? 'Edit item' : 'Add an item'} subtitle="Write it the way it appears on a purchase order and a challan, so received goods find it." onClose={() => !busy && onClose()}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Input label="Name" value={f.name} onChange={e => set({ name: e.target.value })} maxLength={300} placeholder="Polar fleece 300 GSM, 150 cm - BLACK" inputStyle={{ minHeight: 44, fontSize: 15 }} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <Input label="Unit" value={f.unit} list="item-units" maxLength={20} onChange={e => set({ unit: e.target.value })} inputStyle={{ minHeight: 44, fontSize: 15 }} />
            <datalist id="item-units">{UNITS.map(u => <option key={u} value={u} />)}</datalist>
          </div>
          <Select label="Kind" value={f.category} onChange={e => set({ category: e.target.value })} style={{}}>
            {CATEGORIES.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
          </Select>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Input label="Keep at least" inputMode="decimal" value={f.reorderLevel} onChange={e => set({ reorderLevel: decimal(e.target.value) })} placeholder="0 for no level" hint="It is flagged to buy below this" inputStyle={{ minHeight: 44, fontSize: 15 }} />
          <Input label="HSN code" value={f.hsnCode} maxLength={8} onChange={e => set({ hsnCode: e.target.value })} inputStyle={{ minHeight: 44, fontSize: 15 }} />
        </div>
        <Textarea label="Notes" value={f.notes} onChange={e => set({ notes: e.target.value })} rows={2} maxLength={500} />
        {item && <div style={{ fontSize: 12, color: T.textLight }}>The unit cannot change once stock has moved.</div>}
        {err && <Alert type="danger">{err}</Alert>}
        <FlexRow justify="flex-end" gap={8}>
          <Btn variant="secondary" onClick={onClose} disabled={busy}>Cancel</Btn>
          <Btn onClick={submit} disabled={busy}>{busy ? 'Saving...' : item ? 'Save' : 'Add item'}</Btn>
        </FlexRow>
      </div>
    </Modal>
  )
}

const REASONS = ['Stock take', 'Damaged or spoiled', 'Found', 'Used for a sample', 'Other']

/** Put the book right after a count: type what is really there. */
export function AdjustModal({ item, onClose, onDone }) {
  const toast = useToast()
  const [counted, setCounted] = useState('')
  const [reason, setReason] = useState(REASONS[0])
  const [other, setOther] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const has = counted.trim() !== ''
  const diff = has ? round3(Number(counted) - item.onHand) : null

  const submit = async () => {
    const why = reason === 'Other' ? other.trim() : reason
    if (!has) { setErr('Type how much you counted'); return }
    if (!why) { setErr('Say why the stock is being adjusted'); return }
    if (diff === 0) { setErr('The count matches the book. Nothing to adjust'); return }
    setBusy(true)
    try {
      await inventoryApi.adjust({ itemId: item.id, counted: Number(counted), reason: why })
      toast('Stock corrected', 'success')
      onDone()
    } catch (e) { setErr(e?.message || 'The stock could not be corrected'); setBusy(false) }
  }

  return (
    <Modal title="Count stock" subtitle={item.name} onClose={() => !busy && onClose()}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 13, color: T.textMuted }}>The book says <strong style={{ color: T.text }}>{fmtQty(item.onHand)} {item.unit}</strong> in the store. Type what is really there.</div>
        <Input label={`Counted (${item.unit})`} inputMode="decimal" value={counted} onChange={e => { setCounted(decimal(e.target.value)); setErr('') }} placeholder="0" inputStyle={{ minHeight: 52, fontSize: 22, fontWeight: 700, textAlign: 'right' }} />
        {has && diff !== 0 && <div style={{ fontSize: 13, fontWeight: 700, color: diff > 0 ? T.successDeep || T.success : T.danger }}>{diff > 0 ? 'More than the book by' : 'Less than the book by'} {fmtQty(Math.abs(diff))} {item.unit}</div>}
        <Select label="Why" value={reason} onChange={e => { setReason(e.target.value); setErr('') }}>{REASONS.map(r => <option key={r}>{r}</option>)}</Select>
        {reason === 'Other' && <Input label="Say why" value={other} maxLength={300} onChange={e => { setOther(e.target.value); setErr('') }} />}
        {err && <Alert type="danger">{err}</Alert>}
        <FlexRow justify="flex-end" gap={8}>
          <Btn variant="secondary" onClick={onClose} disabled={busy}>Cancel</Btn>
          <Btn onClick={submit} disabled={busy}>{busy ? 'Saving...' : 'Correct the stock'}</Btn>
        </FlexRow>
      </div>
    </Modal>
  )
}

/** One item: how much is where, and every movement that made it so. */
export function ItemModal({ itemId, canWrite, onClose, onEdit, onCount, onIssue, onCombine, onOpenGrn, onChanged }) {
  const toast = useToast()
  const [item, setItem] = useState(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const load = () => inventoryApi.item(itemId).then(i => { setItem(i); setErr('') }).catch(e => setErr(e?.message || 'Could not load this item'))
  useEffect(() => { load() }, [itemId]) // eslint-disable-line react-hooks/exhaustive-deps

  const archive = async () => {
    setBusy(true)
    try { await (item.isActive ? inventoryApi.archiveItem(item.id) : inventoryApi.restoreItem(item.id)); toast(item.isActive ? 'Item archived' : 'Item restored', 'success'); onChanged(); await load() }
    catch (e) { toast(e?.message || 'That did not work', 'error') } finally { setBusy(false) }
  }

  return (
    <Modal title={item?.name || 'Item'} subtitle={item ? `${categoryLabel(item.category)} · counted in ${item.unit}` : ''} onClose={onClose} size="lg">
      {err && <Alert type="danger">{err}</Alert>}
      {!item && !err && <LoadingScreen message="Loading..." />}
      {item && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div>
              <div style={{ fontSize: 10, fontWeight: 800, color: T.textLight, textTransform: 'uppercase', letterSpacing: '0.07em' }}>In the store</div>
              <div style={{ fontSize: 30, fontWeight: 800, color: item.low ? T.danger : T.text, fontVariantNumeric: 'tabular-nums' }}>{fmtQty(item.onHand)} <span style={{ fontSize: 15, fontWeight: 600, color: T.textMuted }}>{item.unit}</span></div>
            </div>
            {item.atJobWork > 0 && <div><div style={{ fontSize: 10, fontWeight: 800, color: T.textLight, textTransform: 'uppercase', letterSpacing: '0.07em' }}>With job workers</div><div style={{ fontSize: 20, fontWeight: 700, color: T.text }}>{fmtQty(item.atJobWork)} {item.unit}</div></div>}
            {item.reorderLevel > 0 && <div><div style={{ fontSize: 10, fontWeight: 800, color: T.textLight, textTransform: 'uppercase', letterSpacing: '0.07em' }}>Keep at least</div><div style={{ fontSize: 20, fontWeight: 700, color: T.text }}>{fmtQty(item.reorderLevel)} {item.unit}</div></div>}
            {item.low && <Pill tone="bad">Below the level to keep: time to buy</Pill>}
            {!item.isActive && <Pill>Archived</Pill>}
          </div>
          {item.locations.filter(l => l.location !== 'store').length > 0 && (
            <div style={{ fontSize: 13, color: T.textMuted }}>{item.locations.filter(l => l.location !== 'store').map(l => `${l.label}: ${fmtQty(l.qty)} ${item.unit}`).join(' · ')}</div>
          )}
          {canWrite && (
            <FlexRow gap={8} style={{ flexWrap: 'wrap' }}>
              <Btn onClick={() => onIssue(item)} disabled={!item.isActive || item.onHand <= 0}>Issue to an order</Btn>
              <Btn variant="secondary" onClick={() => onCount(item)}>Count stock</Btn>
              <Btn variant="secondary" onClick={() => onEdit(item)}>Edit</Btn>
              {item.isActive && <Btn variant="secondary" onClick={() => onCombine(item)}>Combine with another</Btn>}
              <Btn variant="ghost" onClick={archive} disabled={busy}>{item.isActive ? 'Archive' : 'Restore'}</Btn>
            </FlexRow>
          )}
          <div>
            <SectionLabel>Movements</SectionLabel>
            {item.ledger.length === 0 ? <div style={{ fontSize: 13, color: T.textMuted, padding: '10px 0' }}>Nothing has moved yet.</div> : (
              <div style={{ marginTop: 6 }}>
                {item.ledger.map(r => (
                  <div key={r.id} style={{ display: 'flex', gap: 12, alignItems: 'baseline', padding: '9px 0', borderBottom: `1px solid ${T.border}`, flexWrap: 'wrap' }}>
                    <div style={{ width: 86, fontSize: 12, color: T.textLight }}>{fmtDay(r.at)}</div>
                    <div style={{ flex: '1 1 160px', minWidth: 0, fontSize: 13, color: T.text }}>
                      {ledgerLabel(r.type)}
                      <span style={{ color: T.textLight }}>{r.orderId ? ` · ${r.orderId}` : ''}{r.note && r.type === 'adjustment' ? ` · ${r.note}` : ''}</span>
                      {r.refType === 'grn' && <> <button type="button" className="gl-link" onClick={() => onOpenGrn(r.refId)}>open note</button></>}
                    </div>
                    <div style={{ fontSize: 14, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: r.qty > 0 ? T.successDeep || T.success : T.danger }}>{signedQty(r.qty, r.unit, fmtQty)}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}

/** Two items that are really one thing (a cloth written two ways): move the stock into one and archive the other. */
export function CombineModal({ item, items, onClose, onDone }) {
  const toast = useToast()
  const options = items.filter(i => i.isActive && i.id !== item.id && i.unit.trim().toLowerCase() === item.unit.trim().toLowerCase())
  const [intoId, setIntoId] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const into = options.find(i => i.id === intoId)

  const submit = async () => {
    setBusy(true)
    try { await inventoryApi.mergeItem(item.id, intoId); toast('Items combined', 'success'); onDone(into) }
    catch (e) { setErr(e?.message || 'The items could not be combined'); setBusy(false) }
  }

  return (
    <Modal title="Combine with another item" subtitle={item.name} onClose={() => !busy && onClose()}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.5 }}>Use this when the same thing was entered under two names. Choose the one to keep.</div>
        {options.length === 0 ? <Alert type="info">There is no other item counted in {item.unit} to combine it with.</Alert> : (
          <Select label="Keep this item" value={intoId} onChange={e => { setIntoId(e.target.value); setErr('') }}>
            <option value="">Choose an item</option>
            {options.map(i => <option key={i.id} value={i.id}>{i.name} ({fmtQty(i.onHand)} {i.unit})</option>)}
          </Select>
        )}
        {into && <Alert type="warning">{fmtQty(item.onHand)} {item.unit} moves into <strong>{into.name}</strong>, which then holds {fmtQty(item.onHand + into.onHand)} {item.unit}. {item.name} is archived, and goods that arrive under its name go to {into.name} from now on.</Alert>}
        {err && <Alert type="danger">{err}</Alert>}
        <FlexRow justify="flex-end" gap={8}>
          <Btn variant="secondary" onClick={onClose} disabled={busy}>Cancel</Btn>
          <Btn onClick={submit} disabled={!intoId || busy}>{busy ? 'Combining...' : 'Combine'}</Btn>
        </FlexRow>
      </div>
    </Modal>
  )
}
