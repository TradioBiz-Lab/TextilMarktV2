import { useEffect, useRef } from 'react'
import { Image as ImageIcon, ChevronDown } from '../../icons.jsx'
import { T } from '../../constants.js'
import { useApp } from '../../context.jsx'
import { useNavState } from '../../navState.js'
import { t, langOf } from '../../coordinatorText.js'
import { productsOfClient } from '../../coordinatorStyles.js'
import { LoadingScreen } from '../../components/ui.jsx'
import { CoordHeader, countText } from './FactoryOrdersPage.jsx'

const STATE_TONE = {
  development: { bg: '#ede9fe', fg: '#5b21b6' },
  production: { bg: '#dbeafe', fg: '#1e3a8a' },
  replen: { bg: '#ccfbf1', fg: '#0f766e' },
  delivered: { bg: '#f1f5f9', fg: '#475569' },
}

// A small card: the picture is what he recognises, then the name and the customer's own style number.
function ProductCard({ card, lang, onOpen }) {
  const url = card.order.imageDataUrl || card.order.imageUrl
  const tone = STATE_TONE[card.state] || STATE_TONE.production
  return (
    <button type="button" onClick={() => onOpen(card.id)}
      style={{ display: 'flex', flexDirection: 'column', textAlign: 'left', background: '#fff', border: `1.5px solid ${T.border}`, borderRadius: 16, overflow: 'hidden', padding: 0, cursor: 'pointer', fontFamily: 'inherit', boxShadow: T.shadow.xs, minWidth: 0 }}>
      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', aspectRatio: '1 / 1', background: '#f1f5f9' }}>
        {url ? <img src={url} alt="" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <ImageIcon size={36} color={T.textLight} />}
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '10px 10px 12px', minWidth: 0 }}>
        <span style={{ fontSize: 15, fontWeight: 800, color: T.text, lineHeight: 1.25, overflowWrap: 'anywhere' }}>{card.product}</span>
        {card.styleNumber && <span style={{ fontSize: 13, color: T.textMuted, overflowWrap: 'anywhere' }}>{card.styleNumber}</span>}
        <span style={{ alignSelf: 'flex-start', fontSize: 12, fontWeight: 800, padding: '2px 9px', borderRadius: 10, background: tone.bg, color: tone.fg, marginTop: 2 }}>{t(`state_${card.state}`, lang)}</span>
      </span>
    </button>
  )
}

const grid = { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }
const heading = { fontSize: 14, fontWeight: 800, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 10px 2px' }

/**
 * One client's products at one factory, as small cards under the master order each belongs to (a label, not a tap).
 * `focusMo` scrolls to that master order's heading (a master order found by the search opens here).
 */
export function FactoryProductsPage({ factoryId, clientId, focusMo, onOpen, onBack }) {
  const { currentUser, orders, masterOrders, visits, loading } = useApp()
  const lang = langOf(currentUser)
  const [showDelivered, setShowDelivered] = useNavState('coord.products.delivered', false)
  const focusRef = useRef(null)
  useEffect(() => { if (focusMo && focusRef.current) focusRef.current.scrollIntoView({ block: 'start' }) }, [focusMo])
  if (loading && !orders.length) return <LoadingScreen />

  const factory = (visits?.factories || []).find(f => String(f.id) === String(factoryId))
  const { groups, delivered } = productsOfClient(orders, masterOrders, factoryId, clientId)
  const clientName = [...groups.flatMap(g => g.products), ...delivered][0]?.order.buyerCompany || ''
  const total = groups.reduce((n, g) => n + g.products.length, 0) + delivered.length

  return (
    <div style={{ maxWidth: 560, margin: '0 auto', padding: '4px 0 32px' }}>
      <CoordHeader title={clientName || t('clients_title', lang)} subtitle={[factory?.name, countText(total, lang)].filter(Boolean).join(' · ')} onBack={onBack} lang={lang} />
      {total === 0 && <div style={{ background: '#fff', border: `1px solid ${T.border}`, borderRadius: 18, padding: '32px 20px', textAlign: 'center', fontSize: 16, color: T.textMuted }}>{t('clients_empty', lang)}</div>}
      {groups.map(g => (
        <section key={g.key} ref={focusMo && String(focusMo) === g.key ? focusRef : undefined} style={{ marginBottom: 22, scrollMarginTop: 12 }}>
          <h2 style={heading}>{g.title || t('other_styles', lang)}</h2>
          <div style={grid}>{g.products.map(c => <ProductCard key={c.id} card={c} lang={lang} onOpen={onOpen} />)}</div>
        </section>
      ))}
      {delivered.length > 0 && (
        <section>
          <button type="button" onClick={() => setShowDelivered(!showDelivered)} aria-expanded={showDelivered}
            style={{ ...heading, display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', padding: '10px 2px', minHeight: 44, cursor: 'pointer', fontFamily: 'inherit', width: '100%' }}>
            {t('delivered_heading', lang, { n: delivered.length })}
            <ChevronDown size={16} style={{ transform: showDelivered ? 'rotate(180deg)' : 'none' }} />
          </button>
          {showDelivered && <div style={grid}>{delivered.map(c => <ProductCard key={c.id} card={c} lang={lang} onOpen={onOpen} />)}</div>}
        </section>
      )}
    </div>
  )
}
