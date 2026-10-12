import { useEffect, useMemo, useState } from 'react'
import { T } from '../../constants.js'
import { Btn, Modal, Alert, Input, Select, FlexRow } from '../../components/ui.jsx'
import { costSheetsApi, bomsApi } from '../../api.js'
import { useApp } from '../../context.jsx'
import { usePartners } from '../../lib/usePartners.js'

/**
 * Start a cost sheet for one of the factory's customers: the customer, a style name, and (to save typing) one
 * of the factory's orders for that customer. When that order has a frozen bill of materials the lines can be
 * filled from it. `defaults` pre-fills from where it was opened (the BOM tab already knows the order).
 */
export function NewCostSheetModal({ onClose, onCreated, defaults = {} }) {
  const { orders } = useApp()
  const { partners, loading } = usePartners(true)
  const [brandId, setBrandId] = useState(defaults.brandId || '')
  const [orderId, setOrderId] = useState(defaults.orderId || '')
  const [styleName, setStyleName] = useState(defaults.styleName || '')
  const [bom, setBom] = useState(null)            // the order's frozen BOM, when it has one
  const [useBom, setUseBom] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const choices = useMemo(() => (orders || []).filter(o => String(o.buyerId) === String(brandId)), [orders, brandId])

  useEffect(() => {
    setBom(null)
    if (!orderId) return undefined
    let live = true
    bomsApi.forOrder(orderId).then(r => { if (live && r.current?.status === 'frozen') setBom(r.current) }).catch(() => {})
    return () => { live = false }
  }, [orderId])

  const pickOrder = id => {
    setOrderId(id)
    const o = (orders || []).find(x => x.id === id)
    if (o && !styleName.trim()) setStyleName(o.product || '')
  }

  const create = async () => {
    if (!brandId) { setError('Choose the customer this is for'); return }
    if (!styleName.trim()) { setError('Name the style'); return }
    setBusy(true); setError('')
    try {
      onCreated(await costSheetsApi.create({ brandId, styleName: styleName.trim(), ...(orderId ? { orderId } : {}), ...(bom && useBom ? { bomId: bom.id } : {}) }))
    } catch (e) { setError(e?.message || 'Could not start the cost sheet'); setBusy(false) }
  }

  return (
    <Modal title="New cost sheet" subtitle="Build the price of a style line by line, then share it with the customer" onClose={busy ? () => {} : onClose} size="md">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Select label="Customer *" value={brandId} onChange={e => { setBrandId(e.target.value); setOrderId('') }} disabled={loading}>
          <option value="">{loading ? 'Loading...' : partners.length ? 'Choose a customer' : 'No customers connected yet'}</option>
          {partners.map(p => <option key={p.id} value={p.id}>{p.company}</option>)}
        </Select>
        <Select label="For one of your orders (optional)" value={orderId} onChange={e => pickOrder(e.target.value)} disabled={!brandId}>
          <option value="">{brandId ? (choices.length ? 'Not for an order yet' : 'No orders for this customer yet') : 'Choose a customer first'}</option>
          {choices.map(o => <option key={o.id} value={o.id}>{o.product}{o.styleNumber ? ` (${o.styleNumber})` : ''} · {o.id}</option>)}
        </Select>
        <Input label="Style name *" value={styleName} onChange={e => { setStyleName(e.target.value); setError('') }} maxLength={120} placeholder="For example: Baggy active jacket" />
        {bom && (
          <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 12px', background: T.primaryLight, borderRadius: 10, cursor: 'pointer', minHeight: 44 }}>
            <input type="checkbox" checked={useBom} onChange={e => setUseBom(e.target.checked)} style={{ width: 18, height: 18, marginTop: 1 }} />
            <span style={{ fontSize: 13, color: T.text, lineHeight: 1.5 }}><strong>Fill the lines from the bill of materials</strong> (version {bom.version}, {bom.lines.length} lines): consumption, wastage and rates come across; add labour and check the prices.</span>
          </label>
        )}
        {error && <Alert type="danger">{error}</Alert>}
        <FlexRow justify="flex-end" gap={8}>
          <Btn variant="secondary" onClick={onClose} disabled={busy}>Cancel</Btn>
          <Btn onClick={create} disabled={busy}>{busy ? 'Starting...' : 'Start cost sheet'}</Btn>
        </FlexRow>
      </div>
    </Modal>
  )
}
