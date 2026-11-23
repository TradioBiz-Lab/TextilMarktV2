import { useState } from 'react'
import { Ruler, Image as ImageIcon, ChevronDown, ChevronRight, Camera, MapPin, LayoutGrid } from '../icons.jsx'
import { T } from '../constants.js'
import { useApp } from '../context.jsx'
import { t, langOf } from '../coordinatorText.js'
import { techPackOf, measurementOf, productState } from '../coordinatorStyles.js'
import { DocCard } from './ui.jsx'
import { SizeBreakupTable } from './SizeBreakup.jsx'
import { nextSteps, stepState } from '../nextSteps.js'
import { AddUpdateSheet } from '../pages/coordinator/AddUpdateSheet.jsx'

// One of the two papers he needs on the floor, under a label he can read at a glance. The file opens with the same
// viewer as everywhere else (the card's View button).
function Paper({ label, doc, lang, users, getDocData }) {
  return (
    <div style={{ background: '#fff', border: `1.5px solid ${doc ? T.infoBorder : T.border}`, borderRadius: 14, padding: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 16, fontWeight: 800, color: doc ? T.info : T.textMuted, marginBottom: doc ? 8 : 0 }}>
        <Ruler size={20} /> {label}
        {!doc && <span style={{ marginLeft: 'auto', fontSize: 13, fontWeight: 600, color: T.textLight }}>{t('not_uploaded', lang)}</span>}
      </div>
      {doc && <DocCard doc={doc} users={users} onGetData={getDocData} compact />}
    </div>
  )
}

const STEP_TONE = { done: { bg: '#f1f5f9', fg: '#475569' }, running: { bg: '#dcfce7', fg: '#166534' }, not_started: { bg: '#fff7ed', fg: '#9a3412' } }

// One step to report on: a large row with its name and where it stands.
function StepButton({ step, lang, onClick }) {
  const state = stepState(step.stage)
  const tone = STEP_TONE[state]
  const s = step.stage
  return (
    <button type="button" onClick={onClick}
      style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', minHeight: 60, textAlign: 'left', background: '#fff', border: `2px solid ${state === 'running' ? '#22c55e' : T.borderHover}`, borderRadius: 14, padding: '10px 12px', cursor: 'pointer', fontFamily: 'inherit' }}>
      <Camera size={24} color={T.primaryDeep} style={{ flexShrink: 0 }} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 17, fontWeight: 800, color: T.text, lineHeight: 1.25, overflowWrap: 'anywhere' }}>{s.name}</span>
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, fontWeight: 800, padding: '1px 8px', borderRadius: 10, background: tone.bg, color: tone.fg }}>{t(`step_${state}`, lang)}</span>
          {s.kind === 'quantity' && s.totalUnits > 0 && <span style={{ fontSize: 13, fontWeight: 700, color: T.textMuted }}>{s.unitsDone || 0} / {s.totalUnits}</span>}
        </span>
      </span>
      <ChevronRight size={20} color={T.textLight} />
    </button>
  )
}

// "Add update": the two or three steps he is most likely here for, the rest behind one tap. Only while he is checked
// in at this factory (the server refuses an update otherwise).
function AddUpdate({ order, split, lang, visits, onNextProduct }) {
  const [showOthers, setShowOthers] = useState(false)
  const [open, setOpen] = useState(null)   // the step index being reported on
  const here = visits?.open && String(visits.open.factoryId) === String(split.mid)
  const { suggested, others } = nextSteps(split.stages || [])
  if (!(split.stages || []).length) return null
  return (
    <div style={{ background: '#fff', border: `1.5px solid ${T.border}`, borderRadius: 14, padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 18, fontWeight: 800, color: T.text }}>{t('add_update', lang)}</div>
      {!here ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 15, fontWeight: 600, color: T.warning, background: T.warningBg, border: `1px solid ${T.warningBorder}`, borderRadius: 12, padding: '10px 12px' }}>
          <MapPin size={18} style={{ flexShrink: 0 }} /> {t('check_in_to_update', lang, { name: split.mfrCompany || '' })}
        </div>
      ) : (
        <>
          <div style={{ fontSize: 14, color: T.textMuted }}>{t('choose_step', lang)}</div>
          {suggested.map(s => <StepButton key={s.index} step={s} lang={lang} onClick={() => setOpen(s.index)} />)}
          {others.length > 0 && (
            <button type="button" onClick={() => setShowOthers(v => !v)} aria-expanded={showOthers}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: 44, background: 'none', border: 'none', fontSize: 15, fontWeight: 700, color: T.info, cursor: 'pointer', fontFamily: 'inherit' }}>
              {t('other_steps', lang)} ({others.length}) <ChevronDown size={16} style={{ transform: showOthers ? 'rotate(180deg)' : 'none' }} />
            </button>
          )}
          {showOthers && others.map(s => <StepButton key={s.index} step={s} lang={lang} onClick={() => setOpen(s.index)} />)}
        </>
      )}
      {open != null && split.stages[open] && (
        <AddUpdateSheet order={order} factoryId={split.mid} stageIndex={open} stage={split.stages[open]} onClose={() => setOpen(null)} onNextProduct={onNextProduct} />
      )}
    </div>
  )
}

/**
 * The top of the order page as an Ops & QC coordinator sees it on his phone: the picture, what it is, how many, and the
 * two papers he checks against (tech pack, measurements), the size breakup, then the steps he can send an update on. The full page follows
 * underneath, read only. `onNextProduct` takes him back to the client's products after an update.
 */
export function CoordinatorOrderTop({ order, factoryId, onNextProduct }) {
  const { currentUser, docs, users, getDocData, visits } = useApp()
  const lang = langOf(currentUser)
  const url = order.imageDataUrl || order.imageUrl
  const split = (order.assignments || []).find(a => String(a.mid) === String(factoryId)) || order.assignments?.[0]
  const state = productState(order, split?.mid)
  const measurement = measurementOf(docs, order.id)
  return (
    <div style={{ background: T.infoBg, border: `1px solid ${T.infoBorder}`, borderRadius: 18, padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
        <span style={{ width: 104, height: 104, borderRadius: 14, overflow: 'hidden', background: '#fff', border: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          {url ? <img src={url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <ImageIcon size={36} color={T.textLight} />}
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 20, fontWeight: 800, color: T.text, lineHeight: 1.2, overflowWrap: 'anywhere' }}>{order.product}</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: T.textMuted, marginTop: 4 }}>{order.buyerCompany}</div>
          {order.styleNumber && <div style={{ fontSize: 14, color: T.textMuted, marginTop: 2, overflowWrap: 'anywhere' }}>{order.styleNumber}</div>}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 800, padding: '3px 10px', borderRadius: 10, background: '#fff', color: T.info, border: `1px solid ${T.infoBorder}` }}>{t(`state_${state}`, lang)}</span>
            {split?.qty != null && <span style={{ fontSize: 13, fontWeight: 800, padding: '3px 10px', borderRadius: 10, background: '#fff', color: T.text, border: `1px solid ${T.border}` }}>{t('pieces', lang, { n: split.qty })}</span>}
          </div>
        </div>
      </div>
      {(order.colourways || []).length > 0 && (
        <div style={{ fontSize: 14, color: T.text }}>
          <span style={{ fontWeight: 800 }}>{t('colours', lang)}: </span>{order.colourways.map(c => c.name).filter(Boolean).join(', ')}
        </div>
      )}
      <Paper label={t('tech_pack', lang)} doc={techPackOf(docs, order.id)} lang={lang} users={users} getDocData={getDocData} />
      <Paper label={measurement?.locked ? t('locked_measurement', lang) : t('measurements', lang)} doc={measurement} lang={lang} users={users} getDocData={getDocData} />
      {/* How many of each colour in each size: what he counts and checks cartons against. Below the two papers, as Ankit asked. */}
      <div style={{ background: '#fff', border: `1.5px solid ${order.sizeBreakup ? T.infoBorder : T.border}`, borderRadius: 14, padding: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 16, fontWeight: 800, color: order.sizeBreakup ? T.info : T.textMuted, marginBottom: order.sizeBreakup ? 8 : 0 }}>
          <LayoutGrid size={20} /> {t('size_breakup', lang)}
          {order.sizeBreakup
            ? <span style={{ marginLeft: 'auto', fontSize: 14, fontWeight: 800, color: T.text }}>{t('pieces', lang, { n: order.sizeBreakup.total })}</span>
            : <span style={{ marginLeft: 'auto', fontSize: 13, fontWeight: 600, color: T.textLight }}>{t('size_breakup_none', lang)}</span>}
        </div>
        {order.sizeBreakup && <SizeBreakupTable breakup={order.sizeBreakup} large labels={{ colour: t('colour', lang), total: t('total', lang), pieces: t('pieces_word', lang) }} />}
      </div>
      {split && <AddUpdate order={order} split={split} lang={lang} visits={visits} onNextProduct={onNextProduct} />}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 13, fontWeight: 700, color: T.textMuted }}>
        {t('full_details', lang)} <ChevronDown size={14} />
      </div>
    </div>
  )
}
