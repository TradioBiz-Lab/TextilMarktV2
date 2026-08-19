import { useState, useEffect } from 'react'
import { T } from '../../../constants.js'
import { Card, Btn, FlexRow, SectionLabel, EmptyState } from '../../../components/ui.jsx'
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
    <Card>
      <SectionLabel>Step 4 — Materials, Costing & TNA</SectionLabel>
      <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 14 }}>
        {wizardState.lineItemIds.length} line item{wizardState.lineItemIds.length !== 1 ? 's' : ''} created. Open each one to build its Bill of Materials, cost sheet, and (for admin) TNA plan.
      </div>

      {items.length === 0 ? (
        <EmptyState icon="⏳" title="Loading line items…" desc="This should only take a moment" />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {items.map(item => (
            <div key={isAdmin ? item.id : item.id}
              style={{ border: `1px solid ${T.border}`, borderRadius: 10, padding: '12px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{isAdmin ? item.product : item.styleName}</div>
                <div style={{ fontSize: 11, color: T.textMuted, fontFamily: "'JetBrains Mono',monospace" }}>{isAdmin ? item.id : (item.category || '—')}</div>
              </div>
              <FlexRow gap={8}>
                {isAdmin ? (
                  <Btn size="sm" variant="secondary" onClick={() => onOpenOrder(item.id)}>Open Order (Materials/Costing/TNA) →</Btn>
                ) : (
                  <Btn size="sm" variant="secondary" onClick={() => onNavigate('projects')}>Open Project (Materials/Costing) →</Btn>
                )}
              </FlexRow>
            </div>
          ))}
        </div>
      )}

      <FlexRow justify="space-between" style={{ marginTop: 20 }}>
        <Btn variant="secondary" onClick={onBack}>← Back</Btn>
        <Btn onClick={() => onNavigate(isAdmin ? 'orders' : 'projects')}>Finish</Btn>
      </FlexRow>
    </Card>
  )
}
