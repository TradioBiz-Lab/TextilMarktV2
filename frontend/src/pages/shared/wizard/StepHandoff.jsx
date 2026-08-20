import { useState, useEffect } from 'react'
import { PackageCheck, ArrowLeft, ArrowRight } from 'lucide-react'
import { T } from '../../../constants.js'
import { Card, Btn, FlexRow, EmptyState } from '../../../components/ui.jsx'
import { useApp } from '../../../context.jsx'

// Steps 4-6 (Materials, Costing, TNA) hand off to the existing standalone
// pages for each line item created in Step 3 — those modules already work
// per-order/per-project, so Phase 1 doesn't re-embed them here. A later phase
// can replace this with real embedded tabs per the wizard plan.
export function StepHandoff({ wizardState, onBack, onNavigate, onOpenOrder }) {
  const { orders, listMfrProjects } = useApp()
  const isAdmin = wizardState.role === 'admin'
  const [mfrItems, setMfrItems] = useState(null)

  useEffect(() => {
    if (!isAdmin) listMfrProjects().then(setMfrItems).catch(() => setMfrItems([]))
  }, [isAdmin, listMfrProjects])

  const items = isAdmin
    ? orders.filter(o => wizardState.lineItemIds.includes(o.id))
    : (mfrItems || []).filter(p => wizardState.lineItemIds.includes(p.id))

  return (
    <Card style={{ padding: '30px 32px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 24 }}>
        <div style={{ width: 42, height: 42, borderRadius: T.radius.md, background: T.successBg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <PackageCheck size={21} color={T.success} />
        </div>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: T.text, margin: 0, letterSpacing: '-0.01em' }}>Materials, costing &amp; TNA</h2>
          <p style={{ fontSize: 12.5, color: T.textMuted, marginTop: 5 }}>
            {wizardState.lineItemIds.length} line item{wizardState.lineItemIds.length !== 1 ? 's' : ''} created. Open each one to build its bill of materials, cost sheet, and TNA plan.
          </p>
        </div>
      </div>

      {items.length === 0 ? (
        <EmptyState icon="⏳" title="Loading line items…" desc="This should only take a moment" />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {items.map(item => (
            <div key={isAdmin ? item.id : item.id}
              style={{ border: `1px solid ${T.border}`, borderRadius: T.radius.md, padding: '13px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, background: T.bg }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{isAdmin ? item.product : item.styleName}</div>
                <div style={{ fontSize: 11, color: T.textMuted, fontFamily: "'JetBrains Mono',monospace", marginTop: 2 }}>{isAdmin ? item.id : (item.category || '—')}</div>
              </div>
              <FlexRow gap={8}>
                {isAdmin ? (
                  <Btn size="sm" variant="secondary" onClick={() => onOpenOrder(item.id)}>Open Order <ArrowRight size={13} style={{ marginLeft: -2 }} /></Btn>
                ) : (
                  <Btn size="sm" variant="secondary" onClick={() => onNavigate('projects')}>Open Project <ArrowRight size={13} style={{ marginLeft: -2 }} /></Btn>
                )}
              </FlexRow>
            </div>
          ))}
        </div>
      )}

      <FlexRow justify="space-between" style={{ marginTop: 24 }}>
        <Btn variant="secondary" size="lg" onClick={onBack} icon={<ArrowLeft size={16} />}>Back</Btn>
        <Btn size="lg" onClick={() => onNavigate(isAdmin ? 'orders' : 'projects')}>Finish</Btn>
      </FlexRow>
    </Card>
  )
}
