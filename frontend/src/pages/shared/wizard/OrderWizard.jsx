import { useState } from 'react'
import { T } from '../../../constants.js'
import { PageHeader, Card, FlexRow } from '../../../components/ui.jsx'
import { useApp } from '../../../context.jsx'
import { Step1MasterOrder } from './Step1MasterOrder.jsx'
import { Step2Documents } from './Step2Documents.jsx'
import { Step3LineItems } from './Step3LineItems.jsx'
import { StepHandoff } from './StepHandoff.jsx'

// Order/Project Setup Wizard — replaces the old quick-create modals
// (AdminOrders.jsx's New Master Order/Create Order, MfrProjects.jsx's New
// Master Project/Add Style) with one guided flow: Master Order + Customer →
// Documents → Line Items → Materials → Costing → TNA. Same overall UX for
// both roles; only the backend target differs (admin → real Order/MasterOrder,
// manufacturer → their own private MfrProject/MfrMasterProject).
//
// No separate "draft" model — each step's Next is a real create/save against
// the real target model (see the wizard plan's Context section). That also
// makes this resumable for free: wizardState just accumulates the ids each
// step created, and Steps 4-6 (Materials/Costing/TNA) hand off to the
// existing standalone pages for each created line item rather than
// re-embedding them here — those modules already work per-order/per-project.
const STEPS = [
  { n: 1, label: 'Master Order' },
  { n: 2, label: 'Documents' },
  { n: 3, label: 'Line Items' },
  { n: 4, label: 'Materials & Costing' },
]

export function OrderWizard({ onNavigate, onOpenOrder }) {
  const { currentUser } = useApp()
  const role = currentUser?.role === 'manufacturer' ? 'manufacturer' : 'admin'
  const [step, setStep] = useState(1)
  const [wizardState, setWizardState] = useState({
    role,
    masterOrderId: null,
    mfrMasterProjectId: null,
    buyerId: null,
    buyerName: '',
    lineItemIds: [], // Order ids (admin) or MfrProject ids (manufacturer)
  })

  const goTo = n => setStep(n)
  const patchState = patch => setWizardState(prev => ({ ...prev, ...patch }))

  return (
    <div>
      <PageHeader
        title={role === 'admin' ? 'New Order Setup' : 'New Project Setup'}
        subtitle="Master order → Documents → Line items → Materials & Costing → TNA"
      />

      <Card style={{ marginBottom: 16 }}>
        <FlexRow gap={0} style={{ overflowX: 'auto' }}>
          {STEPS.map((s, i) => {
            const reached = step >= s.n || (s.n === 1 && wizardState.masterOrderId) || (s.n === 1 && wizardState.mfrMasterProjectId)
            const active = step === s.n
            return (
              <div key={s.n} style={{ display: 'flex', alignItems: 'center', flex: 1, minWidth: 130 }}>
                <div
                  onClick={() => { if (reached) goTo(s.n) }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, cursor: reached ? 'pointer' : 'default',
                    opacity: reached ? 1 : 0.4,
                  }}>
                  <div style={{
                    width: 26, height: 26, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 12, fontWeight: 800, flexShrink: 0,
                    background: active ? T.primary : (reached ? T.primaryLight : '#f1f5f9'),
                    color: active ? '#fff' : (reached ? T.primaryDark : T.textLight),
                  }}>{s.n}</div>
                  <span style={{ fontSize: 12, fontWeight: 700, color: active ? T.text : T.textMuted, whiteSpace: 'nowrap' }}>{s.label}</span>
                </div>
                {i < STEPS.length - 1 && <div style={{ flex: 1, height: 1, background: T.border, margin: '0 10px' }} />}
              </div>
            )
          })}
        </FlexRow>
      </Card>

      {step === 1 && (
        <Step1MasterOrder wizardState={wizardState} patchState={patchState} onNext={() => goTo(2)} />
      )}
      {step === 2 && (
        <Step2Documents wizardState={wizardState} onNext={() => goTo(3)} onBack={() => goTo(1)} />
      )}
      {step === 3 && (
        <Step3LineItems wizardState={wizardState} patchState={patchState} onNext={() => goTo(4)} onBack={() => goTo(2)} />
      )}
      {step === 4 && (
        <StepHandoff wizardState={wizardState} onBack={() => goTo(3)} onNavigate={onNavigate} onOpenOrder={onOpenOrder} />
      )}
    </div>
  )
}
