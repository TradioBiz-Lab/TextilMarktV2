import { useEffect, useState } from 'react'
import { Copy, LayoutGrid } from '../icons.jsx'
import { T, getToday, fmtDate } from '../constants.js'
import { Btn, FlexRow, Select, Input, useToast } from './ui.jsx'
import { useApp } from '../context.jsx'
import { planTemplatesApi } from '../api.js'

// An empty plan can start from what already exists instead of being typed in: another style's plan in the same
// master order (same buy, same timeline, so its dates are kept) or the customer's saved template (dated from a start
// day you pick). Owners and quantity targets are mapped onto this split by the server. Shown above the Add step form.
export function PlanStarter({ order, asgn }) {
  const { orders, startPlan } = useApp()
  const toast = useToast()
  const [template, setTemplate] = useState(null)
  const [fromId, setFromId] = useState('')
  const [start, setStart] = useState(getToday())
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    planTemplatesApi.get(order.buyerId).then(t => { if (live) setTemplate(t) }).catch(() => { if (live) setTemplate(null) })
    return () => { live = false }
  }, [order.buyerId])

  const stepsOf = o => (o.assignments || []).reduce((best, a) => Math.max(best, (a.stages || []).filter(s => !s.isDelivery).length), 0)
  const siblings = order.masterOrderId
    ? (orders || []).filter(o => o.masterOrderId === order.masterOrderId && o.id !== order.id && stepsOf(o) > 0)
    : []
  if (!siblings.length && !template?.exists) return null

  const run = async (data, done) => {
    setBusy(true)
    try { await startPlan(order.id, asgn.mid, data); toast(done, 'success') }
    catch (e) { toast(typeof e === 'string' ? e : (e?.message || 'Could not start the plan'), 'error') }
    finally { setBusy(false) }
  }
  const box = { flex: '1 1 260px', background: '#fff', border: `1px solid ${T.border}`, borderRadius: 10, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }
  const head = { fontSize: 12, fontWeight: 800, color: T.text, display: 'flex', alignItems: 'center', gap: 6 }

  return (
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', margin: '12px 0 4px' }}>
      {siblings.length > 0 && (
        <div style={box}>
          <div style={head}><Copy size={14} /> Copy another style's plan</div>
          <div style={{ fontSize: 11, color: T.textMuted }}>From this master order. Its steps and dates are copied; owners and targets fit this factory.</div>
          <FlexRow gap={8} style={{ flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 180px' }}>
              <Select value={fromId} onChange={e => setFromId(e.target.value)} aria-label="Style to copy the plan from">
                <option value="">Choose a style</option>
                {siblings.map(o => <option key={o.id} value={o.id}>{o.product}{o.styleNumber ? ` (${o.styleNumber})` : ''} · {stepsOf(o)} steps</option>)}
              </Select>
            </div>
            <Btn size="sm" disabled={!fromId || busy} onClick={() => run({ from: 'style', fromOrderId: fromId }, 'Plan copied')}>Copy plan</Btn>
          </FlexRow>
        </div>
      )}
      {template?.exists && (
        <div style={box}>
          <div style={head}><LayoutGrid size={14} /> Use {order.buyerCompany || "the customer"}'s template</div>
          <div style={{ fontSize: 11, color: T.textMuted }}>{template.stepCount} steps, saved {fmtDate(template.updatedAt)}{template.savedByName ? ` by ${template.savedByName}` : ''}. Dates count from the start day.</div>
          <FlexRow gap={8} style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ flex: '1 1 160px' }}><Input label="Plan starts" type="date" value={start} onChange={e => setStart(e.target.value)} /></div>
            <Btn size="sm" disabled={!start || busy} onClick={() => run({ from: 'template', startDate: start }, 'Template applied')}>Use template</Btn>
          </FlexRow>
        </div>
      )}
    </div>
  )
}
