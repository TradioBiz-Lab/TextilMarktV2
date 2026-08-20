import { useState } from 'react'
import { Check } from 'lucide-react'
import { T } from '../../../constants.js'
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
//
// Deliberately styled as a single-column online form rather than a boxed
// internal-tool panel: centered content, a slim progress bar in place of a
// circle-and-connector stepper, generous whitespace. Each step still owns its
// own layout — this shell only sets the frame around it.
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
  const progressPct = ((step - 1) / (STEPS.length - 1)) * 100

  return (
    <div style={{ maxWidth: 680, margin: '0 auto', padding: '8px 0 48px' }}>
      <div style={{ textAlign: 'center', marginBottom: 34 }}>
        <h1 style={{ fontSize: 27, fontWeight: 750, color: T.text, margin: 0, letterSpacing: '-0.025em' }}>
          {role === 'admin' ? 'New Order Setup' : 'New Project Setup'}
        </h1>
        <p style={{ fontSize: 13.5, color: T.textMuted, marginTop: 7 }}>
          A guided flow from master order to production plan — step {step} of {STEPS.length}.
        </p>
      </div>

      {/* Slim progress bar + step labels — the "online form" stepper */}
      <div style={{ marginBottom: 38 }}>
        <div style={{ height: 5, borderRadius: T.radius.pill, background: T.border, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${progressPct}%`, borderRadius: T.radius.pill, background: T.primary, transition: 'width 0.35s ease' }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10 }}>
          {STEPS.map(s => {
            const reached = step >= s.n || (s.n === 1 && (wizardState.masterOrderId || wizardState.mfrMasterProjectId))
            const done = step > s.n
            const active = step === s.n
            return (
              <div key={s.n} onClick={() => { if (reached) goTo(s.n) }}
                style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: reached ? 'pointer' : 'default' }}>
                {done ? (
                  <span style={{ width: 14, height: 14, borderRadius: '50%', background: T.primary, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <Check size={9} color="#fff" strokeWidth={3.5} />
                  </span>
                ) : (
                  <span style={{ width: 14, height: 14, borderRadius: '50%', border: `2px solid ${active ? T.primary : T.border}`, flexShrink: 0 }} />
                )}
                <span style={{ fontSize: 11.5, fontWeight: active ? 700 : 550, color: active ? T.text : (done ? T.textMuted : T.textLight), whiteSpace: 'nowrap' }}>{s.label}</span>
              </div>
            )
          })}
        </div>
      </div>

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
