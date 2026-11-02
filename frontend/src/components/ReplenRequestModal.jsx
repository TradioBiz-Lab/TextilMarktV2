import { useMemo, useState } from 'react'
import { AlertTriangle, Check, RefreshCw, Search, Trash2, FileSpreadsheet } from '../icons.jsx'
import { T, phaseOf, MEASUREMENTS_FILE_PROPS, MEASUREMENT_LABEL_NAME, getToday } from '../constants.js'
import { Btn, FileUpload, FlexRow, Input, MeasurementLabelSelect, Modal, ProductThumb, fileUploadPayload, useToast } from './ui.jsx'
import { TagInput } from './TagInput.jsx'
import { useApp } from '../context.jsx'
import { styleRequestsApi } from '../api.js'
import { autoShortenLink } from '../links.js'
import { StyleImportModal } from '../pages/admin/StyleImportModal.jsx'

let _sheetKey = 1
/** What a chosen style starts with: its own colours and links, for the customer to change. */
const startFor = o => ({ colours: (o?.colourways || []).map(c => c.name), quantity: '', ecommerceLink: o?.ecommerceLink || '', techPackLink: o?.techPackLink || '', delivery: '', sheets: [], pending: null, pendingLabel: 'customer_submission' })

const label = { display: 'block', fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 5 }

// The customer's Order replen: tick any of its styles in production and say, for each, the colours, how many (optional), the
// product and tech pack links, the expected delivery date and any measurement sheets. Or, on the second tab, send a sheet of
// styles. Either way it goes to Tradio's master admin for review, who chooses the master order and creates the styles.
export function ReplenRequestModal({ preselect = [], onClose, onSent }) {
  const { orders, masterOrders, uploadDoc } = useApp()
  const toast = useToast()
  const [tab, setTab] = useState('choose')
  const [q, setQ] = useState('')
  const production = useMemo(() => (orders || []).filter(o => phaseOf(o) === 'production').sort((a, b) => a.product.localeCompare(b.product)), [orders])
  const [chosen, setChosen] = useState(() => Object.fromEntries(preselect.map(id => [id, startFor((orders || []).find(o => o.id === id))])))
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const moName = id => (masterOrders || []).find(m => m.id === id)?.orderName || ''
  const needle = q.trim().toLowerCase()
  const shown = production.filter(o => !needle || [o.product, o.styleNumber, o.id, moName(o.masterOrderId)].some(v => String(v || '').toLowerCase().includes(needle)))
  const ids = Object.keys(chosen)
  const toggle = o => setChosen(p => { const n = { ...p }; if (n[o.id]) delete n[o.id]; else n[o.id] = startFor(o); return n })
  const update = (id, patch) => setChosen(p => ({ ...p, [id]: { ...p[id], ...patch } }))
  const missingDate = ids.filter(id => !chosen[id].delivery)
  const badQty = ids.filter(id => chosen[id].quantity !== '' && !(Number.isInteger(Number(chosen[id].quantity)) && Number(chosen[id].quantity) > 0))

  const send = async () => {
    setErr('')
    if (!ids.length) { setErr('Choose at least one style.'); return }
    if (missingDate.length) { setErr('Add the expected delivery date for every style you chose.'); return }
    if (badQty.length) { setErr('A quantity has to be a whole number.'); return }
    setSaving(true)
    try {
      const items = []
      for (const id of ids) {
        const c = chosen[id]
        // The sheets go up first, on no style yet; approval moves them onto the new style.
        const docIds = []
        for (const sh of c.sheets) {
          const d = await uploadDoc({ type: 'measurements', name: `Measurements, ${(orders || []).find(o => o.id === id)?.product || id}`, issuer: '', issueDate: getToday(), expiryDate: null, orderId: null, mfrId: null, measurementLabel: sh.label, ...fileUploadPayload(sh.file) })
          docIds.push(d.id)
        }
        items.push({ sourceOrderId: id, colours: c.colours, ...(String(c.quantity).trim() ? { quantity: Math.floor(Number(c.quantity)) } : {}), ecommerceLink: c.ecommerceLink.trim(), techPackLink: c.techPackLink.trim(), delivery: c.delivery, docIds })
      }
      await styleRequestsApi.create('replen', items)
      toast(`Replen request sent to Tradio: ${items.length} style${items.length !== 1 ? 's' : ''}`, 'success')
      onSent()
    } catch (e) {
      setErr(e?.message || 'Could not send the request.')
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
    <Modal title="Order replen" subtitle="Reorder your styles in production. Tradio reviews the request, then plans it." onClose={() => { if (!saving) onClose() }} size="xxl" float>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <FlexRow gap={8} style={{ flexWrap: 'wrap' }}>
          {tabBtn('choose', 'Choose styles', <RefreshCw size={13} />)}
          {tabBtn('import', 'Import from Excel or CSV', <FileSpreadsheet size={13} />)}
        </FlexRow>

        {tab === 'import' && <StyleImportModal embedded forReview noMasterOrder masterOrders={[]} onClose={onClose} onDone={() => onSent()} />}

        {tab === 'choose' && (
          <>
            <div style={{ position: 'relative' }}>
              <Search size={14} color={T.textLight} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} />
              <input value={q} onChange={e => setQ(e.target.value)} placeholder="Find a style by name or style ID" aria-label="Find a style"
                style={{ width: '100%', boxSizing: 'border-box', border: `1px solid ${T.border}`, borderRadius: 8, padding: '8px 12px 8px 32px', fontSize: 13, fontFamily: 'inherit' }} />
            </div>
            {production.length === 0 && <div style={{ fontSize: 13, color: T.textMuted }}>You have no styles in production yet. Use New product development for a new style, or the Import tab.</div>}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: '52vh', overflowY: 'auto', paddingRight: 2 }}>
              {shown.map(o => {
                const c = chosen[o.id]
                return (
                  <div key={o.id} style={{ border: `1px solid ${c ? T.primaryDeep : T.border}`, borderRadius: 10, background: c ? '#fffaf5' : T.surface }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', cursor: 'pointer' }}>
                      <input type="checkbox" checked={!!c} onChange={() => toggle(o)} style={{ width: 17, height: 17, accentColor: T.primaryDeep, flexShrink: 0 }} />
                      <div style={{ transform: 'scale(0.8)', margin: -5, flexShrink: 0 }}><ProductThumb order={o} /></div>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 13.5, fontWeight: 700, color: T.text }}>{o.product}</div>
                        <div style={{ fontSize: 11.5, color: T.textMuted }}>{[o.styleNumber, moName(o.masterOrderId), o.totalQty ? `last order ${o.totalQty.toLocaleString('en-IN')} pcs` : ''].filter(Boolean).join(' · ')}</div>
                      </div>
                    </label>
                    {c && (
                      <div style={{ padding: '0 12px 12px 41px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <TagInput label="Colours" value={c.colours} onChange={v => update(o.id, { colours: v })} keepCase placeholder="Type a colour, then Enter" />
                        <div className="form-grid-2" style={{ gap: 10 }}>
                          <Input label="Quantity (optional)" type="number" min="1" step="1" value={c.quantity} onChange={e => update(o.id, { quantity: e.target.value })} placeholder="e.g. 1200" />
                          <Input label="Expected delivery date *" type="date" value={c.delivery} onChange={e => update(o.id, { delivery: e.target.value })} />
                        </div>
                        <div className="form-grid-2" style={{ gap: 10 }}>
                          <Input label="Product link" value={c.ecommerceLink} onChange={e => update(o.id, { ecommerceLink: autoShortenLink(e.target.value) })} placeholder="https://www.amazon.in/dp/…" />
                          <Input label="Tech pack link" value={c.techPackLink} onChange={e => update(o.id, { techPackLink: e.target.value })} placeholder="https://…" />
                        </div>
                        <div>
                          <span style={label}>Measurement sheets</span>
                          {c.sheets.map(sh => (
                            <FlexRow key={sh.key} gap={8} style={{ fontSize: 12.5, color: T.text, marginBottom: 6 }}>
                              <Check size={13} color={T.success} /><span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sh.file?.name || 'Sheet'}</span>
                              <span style={{ fontSize: 10.5, fontWeight: 800, color: '#075985', background: '#e0f2fe', border: '1px solid #7dd3fc', borderRadius: 10, padding: '1px 8px' }}>{MEASUREMENT_LABEL_NAME[sh.label]}</span>
                              <button onClick={() => update(o.id, { sheets: c.sheets.filter(x => x.key !== sh.key) })} aria-label="Remove the sheet" style={{ background: 'none', border: 'none', cursor: 'pointer', color: T.textLight, display: 'flex' }}><Trash2 size={13} /></button>
                            </FlexRow>
                          ))}
                          <FileUpload {...MEASUREMENTS_FILE_PROPS} file={c.pending} onFile={f => update(o.id, { pending: f })} />
                          {c.pending && (
                            <FlexRow gap={8} style={{ marginTop: 6, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                              <div style={{ minWidth: 200 }}><MeasurementLabelSelect value={c.pendingLabel} onChange={v => update(o.id, { pendingLabel: v })} /></div>
                              <Btn size="sm" disabled={!c.pendingLabel} onClick={() => update(o.id, { sheets: [...c.sheets, { key: _sheetKey++, file: c.pending, label: c.pendingLabel }], pending: null })}>Add sheet</Btn>
                            </FlexRow>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
              {production.length > 0 && shown.length === 0 && <div style={{ fontSize: 13, color: T.textMuted }}>Nothing matches "{q.trim()}".</div>}
            </div>

            {err && <div style={{ fontSize: 12, color: T.danger, fontWeight: 600, background: T.dangerBg, border: `1px solid ${T.dangerBorder}`, borderRadius: 8, padding: '8px 12px' }}><AlertTriangle size={12} style={{ verticalAlign: -2, marginRight: 4 }} /> {err}</div>}
            <FlexRow justify="space-between" gap={8} style={{ flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, color: T.textMuted }}>{ids.length ? `${ids.length} chosen${missingDate.length ? `, ${missingDate.length} still need${missingDate.length === 1 ? 's' : ''} a delivery date` : ''}` : 'Tick the styles to reorder.'}</span>
              <FlexRow gap={8}>
                <Btn variant="secondary" onClick={onClose} disabled={saving}>Cancel</Btn>
                <Btn onClick={send} disabled={saving || !ids.length} icon={<RefreshCw size={13} />}>{saving ? 'Sending…' : `Send ${ids.length || ''} for review`.replace('  ', ' ')}</Btn>
              </FlexRow>
            </FlexRow>
          </>
        )}
      </div>
    </Modal>
  )
}
