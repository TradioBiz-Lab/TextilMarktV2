import { useCallback, useEffect, useState } from 'react'
import { Plus, Pencil, Receipt, Upload } from '../../icons.jsx'
import { T } from '../../constants.js'
import { Modal, Btn, Alert, FlexRow, SectionLabel, LoadingScreen, useToast } from '../../components/ui.jsx'
import { DataTable } from '../../components/DataTable.jsx'
import { SpreadsheetImport } from '../../components/SpreadsheetImport.jsx'
import { suppliersApi } from '../../api.js'
import { suppliersStore, posStore } from '../../stores/procurement.jsx'
import { supplierTypeLabel, rupees, rupeesWhole, fmtQty, ITEM_CATEGORIES } from '../../lib/procurement.js'
import { Pill, StatusPill, Fact } from './common.jsx'
import { SupplierFormModal } from './SupplierFormModal.jsx'
import { ItemFormModal } from './ItemFormModal.jsx'

const ITEM_COLUMNS = [
  { key: 'name', header: 'Item', required: true, aliases: ['name', 'item name'] },
  { key: 'category', header: 'Kind', type: 'enum', options: ['fabric', 'trim', 'other'], aliases: ['category', 'type'] },
  { key: 'unit', header: 'Unit' },
  { key: 'defaultRate', header: 'Rate', type: 'number', aliases: ['rate per unit', 'price'] },
  { key: 'moq', header: 'Minimum order', type: 'number', aliases: ['moq'] },
  { key: 'taxPct', header: 'GST %', type: 'number', aliases: ['gst', 'tax'] },
  { key: 'hsnCode', header: 'HSN code', aliases: ['hsn'] },
  { key: 'composition', header: 'Composition' },
  { key: 'gsm', header: 'GSM', type: 'number' },
  { key: 'widthInches', header: 'Width (inches)', type: 'number', aliases: ['width'] },
  { key: 'construction', header: 'Construction' },
]
const ITEM_EXAMPLE = { name: 'Single jersey 180 GSM', category: 'fabric', unit: 'kg', defaultRate: 342.5, moq: 300, taxPct: 5, hsnCode: '600631', composition: '100% cotton', gsm: 180, widthInches: 72, construction: 'Single jersey' }

const itemPayload = r => ({
  name: r.name, category: r.category || 'fabric', unit: r.unit || undefined, defaultRate: r.defaultRate ?? undefined, moq: r.moq ?? undefined, taxPct: r.taxPct ?? undefined, hsnCode: r.hsnCode || undefined,
  specs: { composition: r.composition || '', gsm: r.gsm ?? null, widthInches: r.widthInches ?? null, construction: r.construction || '' },
})

const specLine = i => [i.specs?.composition, i.specs?.gsm ? `${i.specs.gsm} GSM` : '', i.specs?.widthInches ? `${i.specs.widthInches} in` : '', i.specs?.construction].filter(Boolean).join(' · ')

/**
 * One supplier: who they are, what they sell, and the POs raised with them. `canWrite` is false for a
 * master admin who is only looking at this factory.
 */
export function SupplierDetail({ supplierId, canWrite, onClose, onNewPo, onOpenPo }) {
  const toast = useToast()
  const { refresh } = suppliersStore.useStore()
  const { items: pos } = posStore.useStore()
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(false)
  const [itemForm, setItemForm] = useState(null)     // null | {} (new) | an item (edit)
  const [importing, setImporting] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try { setData(await suppliersApi.get(supplierId)); setError('') } catch (e) { setError(e?.message || 'Could not load this supplier') }
  }, [supplierId])
  useEffect(() => { load() }, [load])

  const changed = async () => { await load(); refresh() }

  const toggleArchive = async () => {
    setBusy(true)
    try {
      if (data.isActive) await suppliersApi.archive(data.id); else await suppliersApi.restore(data.id)
      toast(data.isActive ? `${data.name} archived` : `${data.name} restored`, 'success')
      await changed()
    } catch (e) { toast(e?.message || 'That did not work', 'error') } finally { setBusy(false) }
  }

  const toggleItem = async item => {
    try {
      if (item.isActive) await suppliersApi.archiveItem(data.id, item.id); else await suppliersApi.restoreItem(data.id, item.id)
      await changed()
    } catch (e) { toast(e?.message || 'That did not work', 'error') }
  }

  if (error) return <Modal title="Supplier" onClose={onClose}><Alert type="danger">{error}</Alert></Modal>
  if (!data) return <Modal title="Supplier" onClose={onClose}><LoadingScreen message="Loading supplier..." /></Modal>

  const myPos = pos.filter(p => p.supplierId === data.id).slice(0, 5)
  const itemColumns = [
    { key: 'name', header: 'Item', primary: true, render: i => (
      <div style={{ opacity: i.isActive ? 1 : 0.5 }}>
        <div style={{ fontWeight: 700, color: T.text }}>{i.name}{!i.isActive && <span style={{ marginLeft: 8 }}><Pill>Archived</Pill></span>}</div>
        {specLine(i) && <div style={{ fontSize: 11, color: T.textLight, marginTop: 2 }}>{specLine(i)}</div>}
      </div>
    ) },
    { key: 'category', header: 'Kind', render: i => ITEM_CATEGORIES.find(c => c.id === i.category)?.label || i.category },
    { key: 'rate', header: 'Rate', numeric: true, render: i => (i.defaultRate ? `${rupees(i.defaultRate)} / ${i.unit}` : '-') },
    { key: 'moq', header: 'Minimum', numeric: true, render: i => (i.moq ? `${fmtQty(i.moq)} ${i.unit}` : '-') },
    { key: 'gst', header: 'GST', numeric: true, hideOnMobile: true, render: i => `${i.taxPct}%` },
    { key: 'act', header: '', hideOnMobile: false, render: i => canWrite && (
      <span data-row-ignore style={{ display: 'inline-flex', gap: 6 }}>
        <Btn size="sm" variant="secondary" onClick={() => setItemForm(i)}>Edit</Btn>
        <Btn size="sm" variant="secondary" onClick={() => toggleItem(i)}>{i.isActive ? 'Archive' : 'Restore'}</Btn>
      </span>
    ) },
  ]

  return (
    <>
      <Modal title={data.name} subtitle={`${supplierTypeLabel(data.type)}${data.city ? ` · ${data.city}` : ''}${data.isActive ? '' : ' · archived'}`} onClose={onClose} size="xl">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {canWrite && (
            <FlexRow gap={8} style={{ flexWrap: 'wrap' }}>
              {data.isActive && <Btn icon={<Receipt size={14} />} onClick={() => onNewPo(data)}>New purchase order</Btn>}
              <Btn variant="secondary" icon={<Pencil size={13} />} onClick={() => setEditing(true)}>Edit</Btn>
              <Btn variant="secondary" disabled={busy} onClick={toggleArchive}>{data.isActive ? 'Archive' : 'Restore'}</Btn>
            </FlexRow>
          )}
          {!data.isActive && <Alert type="warning">This supplier is archived. It stays on the purchase orders already sent to it, but cannot be used on new ones until you restore it.</Alert>}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 16 }}>
            <Fact label="Email">{data.email}</Fact>
            <Fact label="Phone">{data.phone}</Fact>
            <Fact label="GSTIN">{data.gstin && <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>{data.gstin}</span>}</Fact>
            <Fact label="State">{data.stateName && `${data.stateName} (${data.stateCode})`}</Fact>
            <Fact label="Address">{[data.address, [data.city, data.pincode].filter(Boolean).join(' ')].filter(Boolean).join(', ')}</Fact>
            <Fact label="Payment terms">{data.paymentTerms}</Fact>
            <Fact label="Delivery terms">{data.deliveryTerms}</Fact>
          </div>
          {data.contacts.length > 0 && (
            <div>
              <SectionLabel>People to call</SectionLabel>
              {data.contacts.map((c, i) => (
                <div key={i} style={{ padding: '7px 0', borderBottom: `1px solid ${T.border}`, fontSize: 13 }}>
                  <strong>{c.name || 'Contact'}</strong>{c.role ? <span style={{ color: T.textMuted }}> ({c.role})</span> : null}
                  <span style={{ color: T.textMuted }}>{[c.phone, c.email].filter(Boolean).map(v => ` · ${v}`).join('')}</span>
                </div>
              ))}
            </div>
          )}
          {data.notes && <div style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{data.notes}</div>}

          <div>
            <FlexRow justify="space-between" style={{ marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
              <SectionLabel>What they sell ({data.itemCount})</SectionLabel>
              {canWrite && data.isActive && (
                <FlexRow gap={8}>
                  <Btn size="sm" variant="secondary" icon={<Upload size={12} />} onClick={() => setImporting(true)}>Import</Btn>
                  <Btn size="sm" icon={<Plus size={12} />} onClick={() => setItemForm({})}>Add item</Btn>
                </FlexRow>
              )}
            </FlexRow>
            <DataTable columns={itemColumns} rows={data.items} rowKey="id" dense maxHeight="min(40vh, 360px)"
              empty={canWrite ? 'Nothing listed yet. Add what they sell, so a purchase order can start from its rate and minimum.' : 'Nothing listed yet.'} />
          </div>

          <div>
            <SectionLabel>Recent purchase orders</SectionLabel>
            {myPos.length === 0 ? <div style={{ fontSize: 13, color: T.textLight, padding: '8px 0' }}>None yet.</div> : myPos.map(p => (
              <div key={p.id} role="button" tabIndex={0} onClick={() => onOpenPo(p.id)} onKeyDown={e => { if (e.key === 'Enter') onOpenPo(p.id) }}
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 0', borderBottom: `1px solid ${T.border}`, cursor: 'pointer', flexWrap: 'wrap' }}>
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, fontWeight: 700, color: T.primaryDeep }}>{p.id}</span>
                <StatusPill status={p.status} />
                <span style={{ marginLeft: 'auto', fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>{rupeesWhole(p.grandTotal)}</span>
              </div>
            ))}
          </div>
        </div>
      </Modal>

      {editing && <SupplierFormModal supplier={data} onClose={() => setEditing(false)} onSaved={async () => { setEditing(false); toast('Supplier saved', 'success'); await changed() }} />}
      {itemForm && <ItemFormModal supplierId={data.id} item={itemForm.id ? itemForm : null} onClose={() => setItemForm(null)} onSaved={async () => { setItemForm(null); toast('Item saved', 'success'); await changed() }} />}
      {importing && (
        <SpreadsheetImport title={`Import items for ${data.name}`} noun="items" columns={ITEM_COLUMNS} example={ITEM_EXAMPLE} templateName={`items-${data.name.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}`}
          toPayload={itemPayload} onImport={items => suppliersApi.bulkItems(data.id, items)} onDone={changed} onClose={() => setImporting(false)} />
      )}
    </>
  )
}
