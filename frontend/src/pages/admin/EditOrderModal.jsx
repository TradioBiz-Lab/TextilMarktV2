import { useState } from 'react'
import { T, SEASONS, CATEGORIES } from '../../constants.js'
import { Btn, FlexRow, Input, Select } from '../../components/ui.jsx'

export function EditOrderModal({ order, onClose, onSave }) {
  const [f, setF] = useState({
    product: order.product || '',
    category: order.category || '',
    season: order.season || '',
    totalQty: order.totalQty != null ? String(order.totalQty) : '',
    delivery: order.delivery ? new Date(order.delivery).toISOString().slice(0, 10) : '',
  })
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)

  const set = key => e => setF(p => ({ ...p, [key]: e.target.value }))

  const save = async () => {
    setErr('')
    if (!f.product.trim()) { setErr('Product name is required'); return }
    const qty = parseInt(f.totalQty, 10)
    if (isNaN(qty) || qty < 1) { setErr('Total quantity must be a positive number'); return }
    if (!f.delivery) { setErr('Delivery date is required'); return }

    const payload = {
      product: f.product.trim(),
      category: f.category || undefined,
      season: f.season || undefined,
      totalQty: qty,
      delivery: f.delivery,
    }

    setSaving(true)
    try {
      await onSave(order.id, payload)
    } catch (e) {
      setErr(typeof e === 'string' ? e : 'Failed to update order')
      setSaving(false)
    }
  }

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, backdropFilter: 'blur(2px)' }}
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div style={{ background: '#fff', borderRadius: 14, border: `1px solid ${T.border}`, width: '100%', maxWidth: 520, boxShadow: '0 24px 64px rgba(0,0,0,0.18)' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '20px 24px 16px', borderBottom: `1px solid ${T.border}` }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: T.text }}>Edit Order</div>
            <div style={{ fontSize: 12, color: T.textMuted, marginTop: 3, fontFamily: "'JetBrains Mono',monospace" }}>{order.id}</div>
          </div>
          <button onClick={onClose} style={{ background: '#f1f5f9', border: 'none', cursor: 'pointer', width: 28, height: 28, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, color: T.textMuted }}>×</button>
        </div>

        {/* Body */}
        <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Input
            label="Product Name *"
            value={f.product}
            onChange={set('product')}
            placeholder="e.g. Classic T-Shirt"
          />

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Category</label>
              <select
                value={f.category}
                onChange={set('category')}
                style={{ width: '100%', border: `1px solid ${T.border}`, borderRadius: 8, padding: '9px 12px', fontSize: 13, color: T.text, background: T.surface, fontFamily: 'inherit' }}
              >
                <option value="">— Select —</option>
                {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <Select label="Season" value={f.season} onChange={set('season')}>
              <option value="">— Select —</option>
              {SEASONS.map(s => <option key={s}>{s}</option>)}
            </Select>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Input
              label="Total Quantity *"
              type="number"
              value={f.totalQty}
              onChange={set('totalQty')}
              placeholder="5000"
            />
            <Input
              label="Expected Delivery *"
              type="date"
              value={f.delivery}
              onChange={set('delivery')}
            />
          </div>

          <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#92400e' }}>
            Note: editing the total quantity does not automatically update manufacturer assignment quantities. Update those from the order detail view if needed.
          </div>

          {err && (
            <div style={{ fontSize: 12, color: T.danger, fontWeight: 600, background: T.dangerBg, border: `1px solid ${T.dangerBorder}`, borderRadius: 8, padding: '8px 12px' }}>
              ⚠ {err}
            </div>
          )}

          <FlexRow justify="flex-end" gap={8} style={{ marginTop: 4 }}>
            <Btn variant="secondary" onClick={onClose} disabled={saving}>Cancel</Btn>
            <Btn onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save Changes'}</Btn>
          </FlexRow>
        </div>
      </div>
    </div>
  )
}
