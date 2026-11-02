import { useMemo, useState } from 'react'
import { AlertTriangle, RefreshCw, Search, FileSpreadsheet, ChevronRight } from '../icons.jsx'
import { T, replenEligible, fmtDate } from '../constants.js'
import { Btn, FlexRow, Input, Modal, ProductThumb, useToast } from './ui.jsx'
import { TagInput } from './TagInput.jsx'
import { MasterOrderPicker } from './MasterOrderPicker.jsx'
import { useApp } from '../context.jsx'
import { styleRequestsApi } from '../api.js'
import { autoShortenLink } from '../links.js'
import { StyleImportModal } from '../pages/admin/StyleImportModal.jsx'

/** What a chosen style starts with: its own colours and links, for the customer to change. */
const startFor = o => ({ colours: (o?.colourways || []).map(c => c.name), quantity: '', ecommerceLink: o?.ecommerceLink || '', techPackLink: o?.techPackLink || '', delivery: '' })

/** One line saying what has been filled in for a chosen style, shown while its details are folded away. */
function summaryOf(c) {
  const bits = [c.delivery ? `delivery ${fmtDate(c.delivery)}` : null, String(c.quantity).trim() ? `${Number(c.quantity).toLocaleString('en-IN')} pcs` : null,
    c.colours.length ? c.colours.join(', ') : null].filter(Boolean)
  return bits.join(' · ')
}

// Reordering styles that have been delivered (a replen). Tick any of them and say, for each, the colours, how many (optional),
// the product and tech pack links and the expected delivery date; a ticked style stays folded until it is opened. Or, on the second tab, send a sheet of styles.
//   A customer (Order replen): the request goes to Tradio's master admin for review, who picks the master order.
//   Tradio (`admin`, Add replen): for one customer (`buyerId`), created at once under the master order chosen here.
export function ReplenRequestModal({ preselect = [], onClose, onSent, admin = false, buyerId = null }) {
  const { orders, masterOrders, createMasterOrder, refreshOrders } = useApp()
  const toast = useToast()
  const [tab, setTab] = useState('choose')
  const [q, setQ] = useState('')
  const eligible = useMemo(() => (orders || []).filter(o => replenEligible(o) && (!admin || String(o.buyerId) === String(buyerId))).sort((a, b) => a.product.localeCompare(b.product)), [orders, admin, buyerId])
  const [chosen, setChosen] = useState(() => Object.fromEntries(preselect.map(id => [id, startFor((orders || []).find(o => o.id === id))])))
  const [openId, setOpenId] = useState(null)        // the one chosen style whose details are showing
  const [moId, setMoId] = useState('')
  const [newMo, setNewMo] = useState(null)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const moName = id => (masterOrders || []).find(m => m.id === id)?.orderName || ''
  const needle = q.trim().toLowerCase()
  const shown = eligible.filter(o => !needle || [o.product, o.styleNumber, o.id, moName(o.masterOrderId)].some(v => String(v || '').toLowerCase().includes(needle)))
  const ids = Object.keys(chosen)
  // Ticking a style chooses it and opens its details (folding the others); unticking drops it.
  const toggle = o => {
    if (chosen[o.id]) { setChosen(p => { const n = { ...p }; delete n[o.id]; return n }); if (openId === o.id) setOpenId(null) }
    else { setChosen(p => ({ ...p, [o.id]: startFor(o) })); setOpenId(o.id) }
  }
  const update = (id, patch) => setChosen(p => ({ ...p, [id]: { ...p[id], ...patch } }))
  const missingDate = ids.filter(id => !chosen[id].delivery)
  const badQty = ids.filter(id => chosen[id].quantity !== '' && !(Number.isInteger(Number(chosen[id].quantity)) && Number(chosen[id].quantity) > 0))

  const send = async () => {
    setErr('')
    if (!ids.length) { setErr('Choose at least one style.'); return }
    if (missingDate.length) { setErr('Add the expected delivery date for every style you chose.'); setOpenId(missingDate[0]); return }
    if (badQty.length) { setErr('A quantity has to be a whole number.'); setOpenId(badQty[0]); return }
    if (admin && !moId && !newMo) { setErr('Choose the master order these replens go under.'); return }
    if (admin && newMo && !newMo.orderName.trim()) { setErr('Give the new master order a name.'); return }
    setSaving(true)
    try {
      const items = []
      for (const id of ids) {
        const c = chosen[id]
        items.push({ sourceOrderId: id, colours: c.colours, ...(String(c.quantity).trim() ? { quantity: Math.floor(Number(c.quantity)) } : {}), ecommerceLink: c.ecommerceLink.trim(), techPackLink: c.techPackLink.trim(), delivery: c.delivery })
      }
      if (admin) {
        let target = moId
        if (newMo) { const made = await createMasterOrder({ id: 'auto', buyerId, orderName: newMo.orderName.trim(), season: newMo.season || undefined }); target = made.id; setNewMo(null); setMoId(made.id) }
        const r = await styleRequestsApi.directReplen(target, items)
        refreshOrders().catch(() => {})
        toast(`Replen added: ${r.created.length} style${r.created.length !== 1 ? 's' : ''}${r.failed?.length ? `, ${r.failed.length} could not be` : ''}`, r.failed?.length ? 'warning' : 'success')
        onSent(r)
      } else {
        await styleRequestsApi.create('replen', items)
        toast(`Replen request sent to Tradio: ${items.length} style${items.length !== 1 ? 's' : ''}`, 'success')
        onSent()
      }
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
  const customerMos = admin ? (masterOrders || []).filter(m => String(m.buyerId) === String(buyerId)) : []

  return (
    <Modal title={admin ? 'Add replen' : 'Order replen'} subtitle={admin ? 'Reorder this customer\'s delivered styles. They are created at once, under the master order you choose.' : 'Reorder your delivered styles. Tradio reviews the request, then plans it.'} onClose={() => { if (!saving) onClose() }} size="xxl" float>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <FlexRow gap={8} style={{ flexWrap: 'wrap' }}>
          {tabBtn('choose', 'Choose styles', <RefreshCw size={13} />)}
          {tabBtn('import', 'Import from Excel or CSV', <FileSpreadsheet size={13} />)}
        </FlexRow>

        {tab === 'import' && (admin
          ? <StyleImportModal embedded masterOrders={customerMos} presetMasterOrderId={moId} onClose={onClose} onDone={r => { refreshOrders().catch(() => {}); onSent(r) }} />
          : <StyleImportModal embedded forReview noMasterOrder masterOrders={[]} onClose={onClose} onDone={() => onSent()} />)}

        {tab === 'choose' && (
          <>
            {admin && <MasterOrderPicker buyerId={buyerId} value={moId} onChange={setMoId} newMo={newMo} setNewMo={setNewMo} label="Master order the replens go under *" />}
            <div style={{ position: 'relative' }}>
              <Search size={14} color={T.textLight} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} />
              <input value={q} onChange={e => setQ(e.target.value)} placeholder="Find a style by name or style ID" aria-label="Find a style"
                style={{ width: '100%', boxSizing: 'border-box', border: `1px solid ${T.border}`, borderRadius: 8, padding: '8px 12px 8px 32px', fontSize: 13, fontFamily: 'inherit' }} />
            </div>
            {eligible.length === 0 && <div style={{ fontSize: 13, color: T.textMuted }}>{admin ? 'This customer has no delivered styles to reorder yet.' : 'You have no delivered styles to reorder yet. Use New product development for a new style, or the Import tab.'}</div>}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: '52vh', overflowY: 'auto', paddingRight: 2 }}>
              {shown.map(o => {
                const c = chosen[o.id]
                const open = c && openId === o.id
                const summary = c && summaryOf(c)
                return (
                  <div key={o.id} style={{ border: `1px solid ${c ? T.primaryDeep : T.border}`, borderRadius: 10, background: c ? '#fffaf5' : T.surface }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px' }}>
                      <input type="checkbox" checked={!!c} onChange={() => toggle(o)} aria-label={`Choose ${o.product}`} style={{ width: 17, height: 17, accentColor: T.primaryDeep, flexShrink: 0, cursor: 'pointer' }} />
                      <div role="button" tabIndex={0} onClick={() => (c ? setOpenId(open ? null : o.id) : toggle(o))} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); c ? setOpenId(open ? null : o.id) : toggle(o) } }}
                        aria-expanded={!!open} style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1, minWidth: 0, cursor: 'pointer' }}>
                        <div style={{ transform: 'scale(0.8)', margin: -5, flexShrink: 0 }}><ProductThumb order={o} /></div>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ fontSize: 13.5, fontWeight: 700, color: T.text }}>{o.product}</div>
                          <div style={{ fontSize: 11.5, color: T.textMuted }}>{[o.styleNumber, moName(o.masterOrderId), o.totalQty ? `last order ${o.totalQty.toLocaleString('en-IN')} pcs` : ''].filter(Boolean).join(' · ')}</div>
                          {c && !open && <div style={{ fontSize: 11.5, marginTop: 2, color: c.delivery ? T.textMuted : '#b45309', fontWeight: c.delivery ? 400 : 700 }}>{c.delivery ? summary : `Needs an expected delivery date${summary ? ` · ${summary}` : ''}`}</div>}
                        </div>
                        {c && <ChevronRight size={15} color={T.textLight} style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s', flexShrink: 0 }} />}
                      </div>
                    </div>
                    {open && (
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
                        <FlexRow justify="flex-end"><Btn size="sm" variant="secondary" onClick={() => setOpenId(null)}>Done with this style</Btn></FlexRow>
                      </div>
                    )}
                  </div>
                )
              })}
              {eligible.length > 0 && shown.length === 0 && <div style={{ fontSize: 13, color: T.textMuted }}>Nothing matches "{q.trim()}".</div>}
            </div>

            {err && <div style={{ fontSize: 12, color: T.danger, fontWeight: 600, background: T.dangerBg, border: `1px solid ${T.dangerBorder}`, borderRadius: 8, padding: '8px 12px' }}><AlertTriangle size={12} style={{ verticalAlign: -2, marginRight: 4 }} /> {err}</div>}
            <FlexRow justify="space-between" gap={8} style={{ flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, color: T.textMuted }}>{ids.length ? `${ids.length} chosen${missingDate.length ? `, ${missingDate.length} still need${missingDate.length === 1 ? 's' : ''} a delivery date` : ''}` : 'Tick the styles to reorder.'}</span>
              <FlexRow gap={8}>
                <Btn variant="secondary" onClick={onClose} disabled={saving}>Cancel</Btn>
                <Btn onClick={send} disabled={saving || !ids.length} icon={<RefreshCw size={13} />}>
                  {saving ? (admin ? 'Adding…' : 'Sending…') : admin ? `Add ${ids.length || ''} replen${ids.length === 1 ? '' : 's'}`.replace('  ', ' ') : `Send ${ids.length || ''} for review`.replace('  ', ' ')}
                </Btn>
              </FlexRow>
            </FlexRow>
          </>
        )}
      </div>
    </Modal>
  )
}
