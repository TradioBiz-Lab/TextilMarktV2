import { useState } from 'react'
import { RefreshCw, FlaskConical, ChevronRight } from '../icons.jsx'
import { T } from '../constants.js'
import { useToast } from './ui.jsx'
import { ReplenRequestModal } from './ReplenRequestModal.jsx'
import { StyleRequestsPanel } from './StyleRequestsPanel.jsx'
import { CreateStyleWizard } from '../pages/admin/CreateStyleWizard.jsx'

// The customer's two ways in, on its home page, under its numbers: reorder delivered styles (Order replen, with a tab to send a
// sheet), and start new styles (New product development, the guided Create Style steps). Both go to Tradio for review, which
// also chooses the master order; "Your requests" below shows where each stands.
export function CustomerActions() {
  const toast = useToast()
  const [open, setOpen] = useState(null)          // 'replen' | 'npd' | null
  const [requestsKey, setRequestsKey] = useState(0)
  const sent = () => { setOpen(null); setRequestsKey(k => k + 1) }

  const card = (id, icon, bg, title, desc) => (
    <button onClick={() => setOpen(id)}
      style={{ flex: '1 1 260px', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 14, padding: '16px 18px', borderRadius: 12, border: `1px solid ${T.border}`, background: T.surface, cursor: 'pointer', fontFamily: 'inherit', boxShadow: '0 1px 2px rgba(15,23,42,0.04)' }}>
      <span style={{ width: 44, height: 44, borderRadius: 11, background: bg, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{icon}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 15, fontWeight: 800, color: T.text }}>{title}</span>
        <span style={{ display: 'block', fontSize: 12.5, color: T.textMuted, marginTop: 2 }}>{desc}</span>
      </span>
      <ChevronRight size={16} color={T.textLight} />
    </button>
  )

  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        {card('replen', <RefreshCw size={20} color="#0f766e" />, '#ccfbf1', 'Order replen', 'Reorder delivered styles, or send a sheet of styles')}
        {card('npd', <FlaskConical size={20} color="#5b21b6" />, '#ede9fe', 'New product development', 'Start a new style, step by step')}
      </div>
      <StyleRequestsPanel reloadKey={requestsKey} />
      {open === 'replen' && <ReplenRequestModal onClose={() => setOpen(null)} onSent={sent} />}
      {open === 'npd' && (
        <CreateStyleWizard forCustomer masterOrders={[]} onClose={() => setOpen(null)}
          onCreated={(_, r) => { toast(`Sent to Tradio for review: ${r?.count || 1} style${r?.count === 1 ? '' : 's'}`, 'success'); sent() }} />
      )}
    </div>
  )
}
