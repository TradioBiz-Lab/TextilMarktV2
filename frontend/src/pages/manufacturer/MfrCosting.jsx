import { useState, useMemo } from 'react'
import { Calculator } from 'lucide-react'
import { T } from '../../constants.js'
import { PageHeader, Card, EmptyState, LoadingScreen } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'
import { CostSheetPanel } from '../shared/CostSheetPanel.jsx'

// Standalone Costing module — a top-level sidebar destination, not a tab
// buried inside order tracking. Own cost sheets across all Tradio-brokered
// assignments; own non-Tradio work is costed inside My Projects instead.
export function MfrCosting() {
  const { currentUser, orders, loading } = useApp()
  const [selectedId, setSelectedId] = useState('')

  const myOrders = useMemo(() => orders.filter(o => o.assignments?.some(a => String(a.mid) === String(currentUser?.id))), [orders, currentUser])

  if (loading) return <LoadingScreen />

  const selected = myOrders.find(o => o.id === selectedId)

  return (
    <div>
      <PageHeader title="Costing" subtitle="Your own cost sheets — draft, submit, and track approval" />
      <Card style={{ marginBottom: 16 }}>
        <label style={{ fontSize: 11, fontWeight: 700, color: T.textMuted }}>ORDER</label>
        <select value={selectedId} onChange={e => setSelectedId(e.target.value)}
          style={{ display: 'block', width: '100%', marginTop: 6, padding: '8px 10px', borderRadius: 8, border: `1px solid ${T.border}`, fontSize: 13 }}>
          <option value="">Select an order…</option>
          {myOrders.map(o => <option key={o.id} value={o.id}>{o.id} — {o.product}</option>)}
        </select>
      </Card>

      {!selected
        ? <Card><EmptyState icon={<Calculator size={26} color={T.textLight} />} title="Pick an order" subtitle="Select one of your assignments above to open its cost sheet." /></Card>
        : <CostSheetPanel scopeType="tradio_order" orderId={selected.id} mfrId={currentUser.id} orderQty={selected.totalQty} styleLabel="My Cost Sheet" />}
    </div>
  )
}
