import { useState } from 'react'
import { Modal, Input, Select, Btn, Alert, FlexRow, SectionLabel } from '../../components/ui.jsx'
import { suppliersApi } from '../../api.js'
import { ITEM_CATEGORIES } from '../../lib/procurement.js'

const str = v => (v === null || v === undefined ? '' : String(v))

/** Add something a supplier sells, or change it: a structured record, so it can be found and compared. */
export function ItemFormModal({ supplierId, item, onClose, onSaved }) {
  const editing = !!item
  const [f, setF] = useState(() => ({
    category: item?.category || 'fabric', name: item?.name || '', unit: item?.unit || 'm', defaultRate: str(item?.defaultRate || ''), moq: str(item?.moq || ''),
    taxPct: str(item?.taxPct ?? 5), hsnCode: item?.hsnCode || '', leadTimeDays: str(item?.leadTimeDays),
    composition: item?.specs?.composition || '', gsm: str(item?.specs?.gsm), widthInches: str(item?.specs?.widthInches),
    construction: item?.specs?.construction || '', colour: item?.specs?.colour || '',
  }))
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)
  const set = patch => { setF(p => ({ ...p, ...patch })); setErr('') }
  const isFabric = f.category === 'fabric'

  const submit = async () => {
    if (!f.name.trim()) { setErr('Give the item a name'); return }
    setSaving(true)
    const num = v => (String(v).trim() === '' ? null : Number(v))
    const body = {
      category: f.category, name: f.name.trim(), unit: f.unit.trim() || 'm',
      defaultRate: num(f.defaultRate) ?? 0, moq: num(f.moq) ?? 0, taxPct: num(f.taxPct) ?? 0, hsnCode: f.hsnCode.trim(), leadTimeDays: num(f.leadTimeDays),
      specs: { composition: f.composition.trim(), gsm: num(f.gsm), widthInches: num(f.widthInches), construction: f.construction.trim(), colour: f.colour.trim() },
    }
    try {
      const saved = editing ? await suppliersApi.updateItem(supplierId, item.id, body) : await suppliersApi.addItem(supplierId, body)
      onSaved(saved)
    } catch (e) { setErr(e?.message || 'Could not save the item') } finally { setSaving(false) }
  }

  return (
    <Modal title={editing ? 'Edit item' : 'Add item'} subtitle="Something this supplier sells" onClose={() => !saving && onClose()} size="lg">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="form-grid-2">
          <Input label="Item name *" value={f.name} onChange={e => set({ name: e.target.value })} placeholder="Single jersey 180 GSM" autoFocus />
          <Select label="Kind" value={f.category} onChange={e => set({ category: e.target.value, unit: e.target.value === 'trim' && f.unit === 'm' ? 'pcs' : f.unit })}>
            {ITEM_CATEGORIES.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
          </Select>
        </div>
        <div className="form-grid-3">
          <Input label="Unit" value={f.unit} onChange={e => set({ unit: e.target.value })} placeholder="kg, m, pcs" />
          <Input label="Rate (rupees per unit)" inputMode="decimal" value={f.defaultRate} onChange={e => set({ defaultRate: e.target.value })} placeholder="342.50" />
          <Input label="Minimum order" inputMode="decimal" value={f.moq} onChange={e => set({ moq: e.target.value })} placeholder="300" hint="In the same unit" />
        </div>
        <div className="form-grid-3">
          <Input label="GST %" inputMode="decimal" value={f.taxPct} onChange={e => set({ taxPct: e.target.value })} placeholder="5" />
          <Input label="HSN code" inputMode="numeric" value={f.hsnCode} onChange={e => set({ hsnCode: e.target.value.replace(/\D/g, '').slice(0, 8) })} placeholder="600631" />
          <Input label="Lead time (days)" inputMode="numeric" value={f.leadTimeDays} onChange={e => set({ leadTimeDays: e.target.value })} placeholder="10" />
        </div>
        {(isFabric || f.composition || f.gsm || f.widthInches) && (
          <div>
            <SectionLabel>Fabric details</SectionLabel>
            <div className="form-grid-2" style={{ marginTop: 8 }}>
              <Input label="Composition" value={f.composition} onChange={e => set({ composition: e.target.value })} placeholder="100% cotton" />
              <Input label="Construction" value={f.construction} onChange={e => set({ construction: e.target.value })} placeholder="Single jersey, twill, rib 2x2" />
            </div>
            <div className="form-grid-3" style={{ marginTop: 10 }}>
              <Input label="GSM" inputMode="decimal" value={f.gsm} onChange={e => set({ gsm: e.target.value })} placeholder="180" />
              <Input label="Width (inches)" inputMode="decimal" value={f.widthInches} onChange={e => set({ widthInches: e.target.value })} placeholder="72" />
              <Input label="Colour" value={f.colour} onChange={e => set({ colour: e.target.value })} placeholder="Peacot" />
            </div>
          </div>
        )}
        {err && <Alert type="danger">{err}</Alert>}
        <FlexRow justify="flex-end" gap={8}>
          <Btn variant="secondary" onClick={onClose} disabled={saving}>Cancel</Btn>
          <Btn onClick={submit} disabled={saving}>{saving ? 'Saving...' : editing ? 'Save changes' : 'Add item'}</Btn>
        </FlexRow>
      </div>
    </Modal>
  )
}
