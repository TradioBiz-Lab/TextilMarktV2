import { useCallback, useEffect, useMemo, useState } from 'react'
import { Receipt, ShoppingCart, AlertTriangle } from '../../icons.jsx'
import { T } from '../../constants.js'
import { Btn, Modal, PageHeader, EmptyState, Alert, Select, FlexRow, LoadingScreen, useToast } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'
import { bomsApi } from '../../api.js'
import { posStore } from '../../stores/procurement.jsx'
import { rupeesWhole, fmtQty } from '../../lib/procurement.js'
import { sectionLabel } from '../../lib/bomUi.js'
import { Pill } from './common.jsx'

/**
 * Everything the factory's frozen bills of materials need, added up across orders (cloth per colour), less what
 * already sits on a purchase order, grouped by supplier. Tick what to buy now and it becomes one draft PO per
 * supplier; nothing is sent to a supplier until the PO itself is sent.
 */
export function ShoppingListPage({ onNavigate, onOpenOrder }) {
  const toast = useToast()
  const { masterOrders } = useApp()
  const { refresh: refreshPos } = posStore.useStore()
  const [scope, setScope] = useState('')               // a master order id, or '' for all orders
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [chosen, setChosen] = useState(() => new Set())
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [useStock, setUseStock] = useState(false)      // take what the store already holds off what is bought

  const load = useCallback(async (mo = scope) => {
    setError('')
    try {
      const d = await bomsApi.aggregate({ masterOrderId: mo || undefined })
      setData(d)
      setChosen(new Set(d.rows.filter(r => r.supplierId && r.remaining > 0).map(r => r.key)))
    } catch (e) { setError(e?.message || 'Could not load the shopping list') }
  }, [scope])
  useEffect(() => { load(scope) }, [scope]) // eslint-disable-line react-hooks/exhaustive-deps

  const groups = useMemo(() => {
    const m = new Map()
    for (const r of data?.rows || []) {
      const k = r.supplierId || ''
      if (!m.has(k)) m.set(k, { id: k, name: r.supplierName || '', rows: [] })
      m.get(k).rows.push(r)
    }
    return [...m.values()].sort((a, b) => (a.id ? 0 : 1) - (b.id ? 0 : 1) || a.name.localeCompare(b.name))
  }, [data])

  // What would be bought: all that is left to order, or less what the store already holds when the person chooses so.
  const qtyOf = r => (useStock ? r.toBuy : r.remaining)
  const buyable = r => !!r.supplierId && qtyOf(r) > 0
  const estimate = r => qtyOf(r) * (r.rate || 0)
  const anyStock = (data?.rows || []).some(r => r.inStock > 0)
  const picked = (data?.rows || []).filter(r => chosen.has(r.key) && buyable(r))
  const suppliersPicked = new Set(picked.map(r => r.supplierId)).size
  const toggle = key => setChosen(s => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n })
  const toggleGroup = g => {
    const rows = g.rows.filter(buyable)
    const all = rows.every(r => chosen.has(r.key))
    setChosen(s => { const n = new Set(s); rows.forEach(r => (all ? n.delete(r.key) : n.add(r.key))); return n })
  }

  const generate = async () => {
    setBusy(true)
    try {
      const r = await bomsApi.generatePos({ masterOrderId: scope || undefined, keys: picked.map(p => p.key), ...(useStock ? { netOfStock: true } : {}) })
      setResult(r)
      await Promise.all([refreshPos(), load(scope)])
    } catch (e) { toast(e?.message || 'Could not create the purchase orders', 'error') } finally { setBusy(false) }
  }

  if (error) return <div><PageHeader title="Shopping list" /><Alert type="danger">{error}</Alert></div>
  if (!data) return <LoadingScreen message="Working out what to buy..." />

  const total = picked.reduce((s, r) => s + estimate(r), 0)
  const mos = masterOrders || []

  return (
    <div style={{ maxWidth: 1100 }}>
      <PageHeader title="Shopping list" subtitle={data.orders ? `What ${data.orders === 1 ? 'your frozen bill of materials needs' : `your ${data.orders} frozen bills of materials need`}, less what is already on a purchase order.` : 'What your bills of materials need, less what is already on a purchase order.'} />

      {mos.length > 0 && (
        <div style={{ maxWidth: 360, marginBottom: 14 }}>
          <Select label="Which orders" value={scope} onChange={e => setScope(e.target.value)}>
            <option value="">All my orders</option>
            {mos.map(m => <option key={m.id} value={m.id}>{m.orderName} ({m.id})</option>)}
          </Select>
        </div>
      )}

      {anyStock && (
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 14, padding: '10px 14px', border: `1px solid ${T.border}`, borderRadius: 10, background: T.surface, cursor: 'pointer', fontSize: 13, color: T.text }}>
          <input type="checkbox" checked={useStock} onChange={e => setUseStock(e.target.checked)} style={{ width: 20, height: 20, marginTop: 1, flexShrink: 0 }} />
          <span><strong>Take what is already in my store off what I buy.</strong> <span style={{ color: T.textMuted }}>Stock is not set aside for an order, so if you plan other orders from it, leave this off or buy a little more.</span></span>
        </label>
      )}

      {data.rows.length === 0 ? (
        <EmptyState icon={<ShoppingCart size={28} color={T.textLight} />} title="Nothing to buy yet"
          desc="Freeze a bill of materials on an order (open the order and choose its Bill of materials tab) and what it needs shows up here, added up with your other orders." />
      ) : (
        <>
          {data.unsupplied > 0 && <div style={{ marginBottom: 14 }}><Alert type="warning">{data.unsupplied === 1 ? '1 item has' : `${data.unsupplied} items have`} no supplier on the bill of materials, so {data.unsupplied === 1 ? 'it cannot' : 'they cannot'} go on a purchase order yet.</Alert></div>}

          {groups.map(g => {
            const rows = g.rows
            const buyableRows = rows.filter(buyable)
            const allOn = buyableRows.length > 0 && buyableRows.every(r => chosen.has(r.key))
            return (
              <div key={g.id || 'none'} style={{ marginBottom: 18 }}>
                <FlexRow justify="space-between" style={{ marginBottom: 6, flexWrap: 'wrap', gap: 8 }}>
                  <FlexRow gap={10}>
                    {buyableRows.length > 0 && <input type="checkbox" checked={allOn} onChange={() => toggleGroup(g)} aria-label={`Choose everything from ${g.name}`} style={{ width: 20, height: 20 }} />}
                    <div style={{ fontSize: 15, fontWeight: 800, color: g.id ? T.text : T.warning }}>{g.id ? g.name : 'No supplier chosen yet'}</div>
                    <span style={{ fontSize: 12, color: T.textMuted }}>{rows.length} item{rows.length === 1 ? '' : 's'}</span>
                  </FlexRow>
                  {g.id && <span style={{ fontSize: 12, color: T.textMuted }}>about {rupeesWhole(buyableRows.reduce((s, r) => s + estimate(r), 0))} before tax</span>}
                </FlexRow>
                <div style={{ border: `1px solid ${T.border}`, borderRadius: 12, background: T.surface, overflow: 'hidden' }}>
                  {rows.map((r, i) => (
                    <div key={r.key} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '12px 14px', borderTop: i ? `1px solid ${T.border}` : 'none', opacity: qtyOf(r) > 0 ? 1 : 0.6, minHeight: 44 }}>
                      <input type="checkbox" checked={chosen.has(r.key) && buyable(r)} disabled={!buyable(r)} onChange={() => toggle(r.key)} aria-label={`Buy ${r.item}${r.colour ? ` in ${r.colour}` : ''}`} style={{ width: 20, height: 20, marginTop: 2, flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>{r.item}{r.colour ? <span style={{ fontWeight: 600, color: T.textMuted }}> · {r.colour}</span> : null}</div>
                        <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>
                          {[sectionLabel(r.section), r.spec].filter(Boolean).join(' · ')}
                          {r.sources.length > 1 ? ` · ${r.sources.length} styles` : r.sources[0]?.product ? ` · ${r.sources[0].product}` : ''}
                        </div>
                        <FlexRow gap={6} style={{ marginTop: 6, flexWrap: 'wrap' }}>
                          {r.belowMoq && <Pill tone="warn" title={`The supplier's minimum is ${fmtQty(r.moq)} ${r.unit}`}>Below the minimum of {fmtQty(r.moq)} {r.unit}</Pill>}
                          {!r.supplierId && <button type="button" className="gl-link" onClick={() => onOpenOrder(r.sources[0].orderId)}>Choose a supplier on the bill of materials</button>}
                          {r.onPo > 0 && <Pill tone="info">{fmtQty(r.onPo)} {r.unit} already on purchase orders</Pill>}
                          {r.inStock > 0 && r.remaining > 0 && <Pill tone="good" title="What is in your store now">{fmtQty(r.inStock)} {r.unit} in your store</Pill>}
                        </FlexRow>
                      </div>
                      <div style={{ textAlign: 'right', flexShrink: 0 }}>
                        <div style={{ fontSize: 15, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: qtyOf(r) > 0 ? T.text : T.success }}>{qtyOf(r) > 0 ? `${fmtQty(qtyOf(r))} ${r.unit}` : r.remaining > 0 ? 'In stock' : 'Ordered'}</div>
                        <div style={{ fontSize: 11, color: T.textLight, fontVariantNumeric: 'tabular-nums' }}>of {fmtQty(r.required)}{useStock && r.fromStock > 0 ? ` · ${fmtQty(r.fromStock)} from store` : ''}{r.rate ? ` · ${rupeesWhole(estimate(r))}` : ''}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}

          <div className="po-totals-bar">
            <div className="po-totals-sum" aria-live="polite">
              <div><span>Items</span><strong>{picked.length}</strong></div>
              <div><span>Suppliers</span><strong>{suppliersPicked}</strong></div>
              <div className="po-grand"><span>About</span><strong>{rupeesWhole(total)}</strong></div>
            </div>
            <div className="po-totals-actions">
              <Btn icon={<Receipt size={14} />} onClick={generate} disabled={busy || picked.length === 0}>{busy ? 'Creating...' : <><span className="po-long">Create draft purchase orders</span><span className="po-short">Create POs</span></>}</Btn>
            </div>
          </div>
        </>
      )}

      {result && (
        <Modal title={result.created.length ? 'Draft purchase orders created' : 'Nothing to create'} onClose={() => setResult(null)} size="md">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {result.created.map(c => (
              <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '10px 12px', background: '#f8fafc', borderRadius: 10 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{c.supplierName}</div>
                  <div style={{ fontSize: 12, color: T.textMuted }}>{c.id} · {c.lineCount} line{c.lineCount === 1 ? '' : 's'} · {rupeesWhole(c.grandTotal)}</div>
                  {c.warnings?.map((w, i) => <div key={i} style={{ fontSize: 11, color: T.warning, marginTop: 2 }}><AlertTriangle size={11} /> {w.message}</div>)}
                </div>
                <Btn size="sm" variant="secondary" onClick={() => { setResult(null); onNavigate('po_detail', { po: c.id }) }}>Open</Btn>
              </div>
            ))}
            {result.skipped.length > 0 && <Alert type="info">{result.skipped.length} item{result.skipped.length === 1 ? ' was' : 's were'} left out: {[...new Set(result.skipped.map(s => s.reason))].join('; ')}.</Alert>}
            {result.failed.length > 0 && <Alert type="danger">{result.failed.map(f => `${f.supplierName}: ${f.error}`).join('. ')}</Alert>}
            <FlexRow justify="flex-end" gap={8}>
              <Btn variant="secondary" onClick={() => setResult(null)}>Stay here</Btn>
              {result.created.length > 0 && <Btn onClick={() => { setResult(null); onNavigate('purchase_orders') }}>See purchase orders</Btn>}
            </FlexRow>
          </div>
        </Modal>
      )}
    </div>
  )
}
