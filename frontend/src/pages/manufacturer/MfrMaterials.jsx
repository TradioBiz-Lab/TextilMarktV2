import { useState, useMemo } from 'react'
import { T } from '../../constants.js'
import { PageHeader, Card, Btn, Badge, EmptyState, LoadingScreen, FlexRow, useToast } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'

// Standalone Materials module — a top-level sidebar destination, not a tab
// buried inside order tracking. Aggregates what's already fetched (own
// orders/assignments) into one flat table, same "flatten already-server-
// filtered data" pattern as MfrCerts.jsx. "Raise PO" reuses the exact same
// two writes AdminMaterials's version does (stamp poNumber+ordered on the
// real stage material line, file a matching material_po Document) — the
// server enforces who may write a given stage's materials (admin, or that
// stage's own responsibleId), this UI does not attempt to duplicate that
// check, a manufacturer who isn't the responsible party just gets a clear
// 403 toast back.
export function MfrMaterials() {
  const { currentUser, orders, loading, updateStageMaterial, uploadDoc } = useApp()
  const toast = useToast()
  const [selected, setSelected] = useState(new Set())
  const [poNumberDraft, setPoNumberDraft] = useState('')
  const [busy, setBusy] = useState(false)

  const myOrders = useMemo(() => orders.filter(o => o.assignments?.some(a => String(a.mid) === String(currentUser?.id))), [orders, currentUser])

  if (loading) return <LoadingScreen />

  const materialRows = myOrders.flatMap(o => {
    const mine = o.assignments.find(a => String(a.mid) === String(currentUser?.id))
    return (mine?.stages || []).flatMap((s, si) => (s.materials || []).map((m, mi) => ({
      key: `${o.id}:${si}:${mi}`, orderId: o.id, product: o.product, stageName: s.name, stageIndex: si, lineIndex: mi, ...m,
    })))
  })

  function toggle(key) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  async function handleRaisePO() {
    if (selected.size === 0) return
    setBusy(true)
    const poNumber = poNumberDraft.trim() || `PO-${currentUser.id.slice(-6).toUpperCase()}-${Date.now().toString(36).toUpperCase()}`
    let created = 0, denied = 0
    try {
      for (const row of materialRows) {
        if (!selected.has(row.key)) continue
        const notes = `PURCHASE ORDER ${poNumber}\nSupplier: ${row.supplier || '—'}\nMaterial: ${row.name}\nQty: ${row.requiredQty} ${row.unit}\nStage: ${row.stageName}`
        try {
          await updateStageMaterial(row.orderId, currentUser.id, row.stageIndex, row.lineIndex, { poNumber, status: 'ordered' })
          await uploadDoc({ type: 'material_po', name: `PO ${poNumber} — ${row.name}`, orderId: row.orderId, mfrId: currentUser.id, stageIndex: row.stageIndex, materialLineIndex: row.lineIndex, notes })
          created++
        } catch (err) {
          denied++
        }
      }
      if (created > 0) toast(`PO ${poNumber} raised on ${created} line${created > 1 ? 's' : ''}${denied ? ` (${denied} skipped — not your responsibility)` : ''}`, 'success')
      else toast('Could not raise a PO on any selected line — you may not be the responsible party for that stage', 'error')
      setSelected(new Set())
      setPoNumberDraft('')
    } finally { setBusy(false) }
  }

  return (
    <div>
      <PageHeader title="Materials" subtitle="Fabric, trims and accessories across all your assignments" />

      {selected.size > 0 && (
        <Card style={{ marginBottom: 16, border: `1px solid ${T.primary}`, background: T.primaryLight }}>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>Raise PO — {selected.size} line{selected.size > 1 ? 's' : ''} selected</div>
          <FlexRow style={{ gap: 8 }}>
            <input placeholder="PO number (auto-generated if blank)" value={poNumberDraft} onChange={e => setPoNumberDraft(e.target.value)}
              style={{ flex: 1, padding: '6px 8px', borderRadius: 6, border: `1px solid ${T.border}`, fontSize: 13 }} />
            <Btn size="sm" disabled={busy} onClick={handleRaisePO}>Raise PO</Btn>
            <Btn size="sm" variant="secondary" disabled={busy} onClick={() => setSelected(new Set())}>Clear</Btn>
          </FlexRow>
        </Card>
      )}

      <Card pad={false}>
        <div style={{ padding: '16px 18px' }}>
          {materialRows.length === 0
            ? <EmptyState icon="📦" title="No materials yet" subtitle="Materials pushed to your stages by Tradio admin will appear here." />
            : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ textAlign: 'left', borderBottom: `1px solid ${T.border}`, color: T.textMuted, fontSize: 11, textTransform: 'uppercase' }}>
                      <th style={{ padding: '6px 8px', width: 24 }}></th>
                      <th style={{ padding: '6px 8px' }}>Order</th>
                      <th style={{ padding: '6px 8px' }}>Stage</th>
                      <th style={{ padding: '6px 8px' }}>Category</th>
                      <th style={{ padding: '6px 8px' }}>Material</th>
                      <th style={{ padding: '6px 8px' }}>Colourway</th>
                      <th style={{ padding: '6px 8px' }}>Required</th>
                      <th style={{ padding: '6px 8px' }}>Received</th>
                      <th style={{ padding: '6px 8px' }}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {materialRows.map(r => (
                      <tr key={r.key} style={{ borderBottom: `1px solid ${T.border}` }}>
                        <td style={{ padding: '6px 8px' }}>
                          <input type="checkbox" checked={selected.has(r.key)} onChange={() => toggle(r.key)} disabled={r.status === 'received'} />
                        </td>
                        <td style={{ padding: '6px 8px' }}>{r.orderId}</td>
                        <td style={{ padding: '6px 8px' }}>{r.stageName}</td>
                        <td style={{ padding: '6px 8px', textTransform: 'capitalize' }}>{r.category}</td>
                        <td style={{ padding: '6px 8px' }}>{r.name}</td>
                        <td style={{ padding: '6px 8px' }}>{r.colourway || '—'}</td>
                        <td style={{ padding: '6px 8px' }}>{r.requiredQty} {r.unit}</td>
                        <td style={{ padding: '6px 8px' }}>{r.receivedQty || 0} {r.unit}</td>
                        <td style={{ padding: '6px 8px' }}><Badge status={r.status} /></td>
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
