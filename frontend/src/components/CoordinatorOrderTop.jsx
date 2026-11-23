import { Ruler, Image as ImageIcon, ChevronDown } from '../icons.jsx'
import { T } from '../constants.js'
import { useApp } from '../context.jsx'
import { t, langOf } from '../coordinatorText.js'
import { techPackOf, measurementOf, productState } from '../coordinatorStyles.js'
import { DocCard } from './ui.jsx'

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

/**
 * The top of the order page as an Ops & QC coordinator sees it on his phone: the picture, what it is, how many, and the
 * two papers he checks against (tech pack, measurements). The full page follows underneath, read only. `children` is
 * where a later phase puts his "Add update" buttons.
 */
export function CoordinatorOrderTop({ order, factoryId, children }) {
  const { currentUser, docs, users, getDocData } = useApp()
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
      {children}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 13, fontWeight: 700, color: T.textMuted }}>
        {t('full_details', lang)} <ChevronDown size={14} />
      </div>
    </div>
  )
}
