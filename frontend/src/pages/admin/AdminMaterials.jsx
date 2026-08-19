import { useState } from 'react'
import { T } from '../../constants.js'
import { PageHeader, Card, Btn, Modal, LoadingScreen, EmptyState } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'
import { MaterialRequirementsPanel } from './MaterialRequirementsPanel.jsx'
import { MaterialRequirementsBulkUploadPanel } from './MaterialRequirementsBulkUploadPanel.jsx'

// Standalone Materials module — a top-level sidebar destination, not a tab
// buried inside order tracking. Order tracking (Production) stays about
// dates/status/evidence; this is the planning layer that pushes lines onto
// an order's Fabric/Trims stages.
export function AdminMaterials() {
  const { orders, loading } = useApp()
  const [selectedId, setSelectedId] = useState('')
  const [showBulk, setShowBulk] = useState(false)

  if (loading) return <LoadingScreen />

  const selected = orders.find(o => o.id === selectedId)

  return (
    <div>
      {showBulk && (
        <Modal title="Bulk Upload Requirement Lines" onClose={() => setShowBulk(false)}>
          <MaterialRequirementsBulkUploadPanel onDone={() => setShowBulk(false)} />
        </Modal>
      )}

      <PageHeader title="Materials" subtitle="Fabric, trims and accessory planning — push lines onto an order's stages"
        action={<Btn variant="secondary" onClick={() => setShowBulk(true)} icon="📦">Bulk Upload</Btn>} />
      <Card style={{ marginBottom: 16 }}>
        <label style={{ fontSize: 11, fontWeight: 700, color: T.textMuted }}>ORDER</label>
        <select value={selectedId} onChange={e => setSelectedId(e.target.value)}
          style={{ display: 'block', width: '100%', marginTop: 6, padding: '8px 10px', borderRadius: 8, border: `1px solid ${T.border}`, fontSize: 13 }}>
          <option value="">Select an order…</option>
          {orders.map(o => <option key={o.id} value={o.id}>{o.id} — {o.product}</option>)}
        </select>
      </Card>

      {!selected
        ? <Card><EmptyState icon="📦" title="Pick an order" subtitle="Select an order above to plan its material requirements." /></Card>
        : <MaterialRequirementsPanel key={selected.id} order={selected} />}
    </div>
  )
}
