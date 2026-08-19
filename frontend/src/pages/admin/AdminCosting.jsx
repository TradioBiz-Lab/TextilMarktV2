import { useState } from 'react'
import { T } from '../../constants.js'
import { PageHeader, Card, LoadingScreen, EmptyState } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'
import { CostSheetPanel } from '../shared/CostSheetPanel.jsx'

// Standalone Costing module — a top-level sidebar destination, not a tab
// buried inside order tracking. Speaks to the Materials module via each cost
// sheet's own "Pull from Materials Requirement" action, not by embedding.
export function AdminCosting() {
  const { orders, loading } = useApp()
  const [selectedId, setSelectedId] = useState('')

  if (loading) return <LoadingScreen />

  const selected = orders.find(o => o.id === selectedId)

  return (
    <div>
      <PageHeader title="Costing" subtitle="Manufacturer cost sheets — review, set margin, and approve for buyer visibility" />
      <Card style={{ marginBottom: 16 }}>
        <label style={{ fontSize: 11, fontWeight: 700, color: T.textMuted }}>ORDER</label>
        <select value={selectedId} onChange={e => setSelectedId(e.target.value)}
          style={{ display: 'block', width: '100%', marginTop: 6, padding: '8px 10px', borderRadius: 8, border: `1px solid ${T.border}`, fontSize: 13 }}>
          <option value="">Select an order…</option>
          {orders.map(o => <option key={o.id} value={o.id}>{o.id} — {o.product}</option>)}
        </select>
      </Card>

      {!selected
        ? <Card><EmptyState icon="🧮" title="Pick an order" subtitle="Select an order above to view or author its cost sheets." /></Card>
        : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            {(selected.assignments || []).map(a => (
              <CostSheetPanel key={a.sub} scopeType="tradio_order" orderId={selected.id} mfrId={a.mid} orderQty={selected.totalQty}
                styleLabel={`Cost Sheet — ${a.mfrCompany || a.mid}`} />
            ))}
          </div>
        )}
    </div>
  )
}
