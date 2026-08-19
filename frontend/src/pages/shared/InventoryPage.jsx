import { useState, useEffect } from 'react'
import { T } from '../../constants.js'
import { PageHeader, Card, EmptyState, LoadingScreen, useToast } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'

function fmtDate(d) {
  if (!d) return '—'
  const dt = new Date(d)
  return `${String(dt.getDate()).padStart(2, '0')}-${String(dt.getMonth() + 1).padStart(2, '0')}-${dt.getFullYear()}`
}

// Read side of the InventoryMovement ledger — on-hand stock, computed
// server-side as sum(in) - sum(out) per material. Admin sees tradio_order
// stock across every manufacturer; a manufacturer sees their own stock
// across BOTH their Tradio work and their private mfr_project work (their
// own ledger has to span everything to be useful to them) — the server
// enforces exactly this split, this page just renders whatever it returns.
export function InventoryPage() {
  const { currentUser, listInventory } = useApp()
  const toast = useToast()
  const [rows, setRows] = useState(null)

  useEffect(() => {
    let cancelled = false
    listInventory()
      .then(r => { if (!cancelled) setRows(r) })
      .catch(err => toast(err.message || 'Failed to load inventory', 'error'))
    return () => { cancelled = true }
  }, [])

  if (rows === null) return <LoadingScreen />

  const isAdmin = currentUser?.role === 'admin'

  return (
    <div>
      <PageHeader title="Inventory" subtitle={isAdmin
        ? 'On-hand material stock across every manufacturer — Tradio orders only'
        : 'Your own on-hand material stock, across Tradio orders and your own projects'} />
      <Card pad={false}>
        <div style={{ padding: '16px 18px' }}>
          {rows.length === 0
            ? <EmptyState icon="🗄" title="No stock movements yet" subtitle="Receiving materials or capturing production actuals will populate this view." />
            : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ textAlign: 'left', borderBottom: `2px solid ${T.border}`, color: T.textMuted, fontSize: 11, textTransform: 'uppercase' }}>
                      {isAdmin && <th style={{ padding: '6px 8px' }}>Manufacturer</th>}
                      <th style={{ padding: '6px 8px' }}>Material</th>
                      <th style={{ padding: '6px 8px', textAlign: 'right' }}>On Hand</th>
                      <th style={{ padding: '6px 8px' }}>Unit</th>
                      <th style={{ padding: '6px 8px' }}>Last Movement</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={i} style={{ borderBottom: `1px solid ${T.border}` }}>
                        {isAdmin && <td style={{ padding: '6px 8px' }}>{r.mfrCompany || r.mfrId}</td>}
                        <td style={{ padding: '6px 8px', fontWeight: 600 }}>{r.materialName}</td>
                        <td style={{ padding: '6px 8px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 600, color: r.onHand < 0 ? T.danger : T.text }}>{r.onHand}</td>
                        <td style={{ padding: '6px 8px' }}>{r.unit || '—'}</td>
                        <td style={{ padding: '6px 8px' }}>{fmtDate(r.lastMovementAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </div>
      </Card>
    </div>
  )
}
