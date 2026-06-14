import { useState } from 'react'
import { T } from '../../constants.js'
import { Btn, FlexRow, Mono } from '../../components/ui.jsx'

export function DeleteOrderModal({ order, onClose, onConfirm }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const confirm = async () => {
    setErr('')
    setBusy(true)
    try {
      await onConfirm(order.id)
    } catch (e) {
      setErr(typeof e === 'string' ? e : 'Failed to delete order')
      setBusy(false)
    }
  }

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, backdropFilter: 'blur(2px)' }}
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div style={{ background: '#fff', borderRadius: 14, border: `1px solid ${T.border}`, width: '100%', maxWidth: 440, boxShadow: '0 24px 64px rgba(0,0,0,0.18)' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '20px 24px 16px', borderBottom: `1px solid ${T.border}` }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: T.danger }}>Delete Order</div>
          <button onClick={onClose} style={{ background: '#f1f5f9', border: 'none', cursor: 'pointer', width: 28, height: 28, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, color: T.textMuted }}>×</button>
        </div>

        {/* Body */}
        <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ background: '#fff1f2', border: '1px solid #fecdd3', borderRadius: 10, padding: '14px 16px' }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#9f1239', marginBottom: 6 }}>This action cannot be undone.</div>
            <div style={{ fontSize: 13, color: '#be123c', lineHeight: 1.6 }}>
              All production stage data and assignment records for this order will be permanently deleted. Associated documents will remain in the Documents tab.
            </div>
          </div>

          <div style={{ background: '#f8fafc', border: `1px solid ${T.border}`, borderRadius: 10, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', gap: 10 }}>
              <span style={{ fontSize: 12, color: T.textMuted, width: 100, flexShrink: 0 }}>Order ID</span>
              <Mono style={{ fontSize: 12 }}>{order.id}</Mono>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <span style={{ fontSize: 12, color: T.textMuted, width: 100, flexShrink: 0 }}>Product</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: T.text }}>{order.product}</span>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <span style={{ fontSize: 12, color: T.textMuted, width: 100, flexShrink: 0 }}>Buyer</span>
              <span style={{ fontSize: 12, color: T.text }}>{order.buyerCompany || '—'}</span>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <span style={{ fontSize: 12, color: T.textMuted, width: 100, flexShrink: 0 }}>Quantity</span>
              <span style={{ fontSize: 12, color: T.text }}>{order.totalQty?.toLocaleString()} pcs</span>
            </div>
          </div>

          {err && (
            <div style={{ fontSize: 12, color: T.danger, fontWeight: 600, background: T.dangerBg, border: `1px solid ${T.dangerBorder}`, borderRadius: 8, padding: '8px 12px' }}>
              ⚠ {err}
            </div>
          )}

          <FlexRow justify="flex-end" gap={8} style={{ marginTop: 4 }}>
            <Btn variant="secondary" onClick={onClose} disabled={busy}>Cancel</Btn>
            <button
              onClick={confirm}
              disabled={busy}
              style={{ padding: '8px 18px', fontSize: 13, fontWeight: 700, borderRadius: 8, border: 'none', background: busy ? '#fca5a5' : T.danger, color: '#fff', cursor: busy ? 'wait' : 'pointer', fontFamily: 'inherit' }}
            >
              {busy ? 'Deleting…' : 'Yes, Delete Order'}
            </button>
          </FlexRow>
        </div>
      </div>
    </div>
  )
}
