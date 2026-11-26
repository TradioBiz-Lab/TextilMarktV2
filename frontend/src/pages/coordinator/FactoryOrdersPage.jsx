import { ArrowLeft, ChevronRight, Building2 } from '../../icons.jsx'
import { T } from '../../constants.js'
import { useApp } from '../../context.jsx'
import { t, langOf } from '../../coordinatorText.js'
import { clientsAtFactory } from '../../coordinatorStyles.js'
import { LoadingScreen } from '../../components/ui.jsx'

export const countText = (n, lang) => (n === 1 ? t('products_count_one', lang) : t('products_count', lang, { n }))

/** The top of a coordinator page: a big Back and what this page is. */
export function CoordHeader({ title, subtitle, onBack, lang }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
      <button type="button" onClick={onBack} aria-label={t('back', lang)}
        style={{ width: 48, height: 48, borderRadius: 14, border: `1.5px solid ${T.borderHover}`, background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}>
        <ArrowLeft size={22} color={T.text} />
      </button>
      <div style={{ minWidth: 0 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, color: T.text, margin: 0, letterSpacing: '-0.02em', lineHeight: 1.2, overflowWrap: 'anywhere' }}>{title}</h1>
        {subtitle && <div style={{ fontSize: 14, color: T.textMuted, marginTop: 2 }}>{subtitle}</div>}
      </div>
    </div>
  )
}

/** One factory: a large card per client with work there. The coordinator knows the work by whose it is. */
export function FactoryOrdersPage({ factoryId, onOpenClient, onBack }) {
  const { currentUser, orders, visits, loading } = useApp()
  const lang = langOf(currentUser)
  if (loading && !orders.length) return <LoadingScreen />
  const factory = (visits?.factories || []).find(f => String(f.id) === String(factoryId))
  const clients = clientsAtFactory(orders, factoryId)

  return (
    <div style={{ maxWidth: 560, margin: '0 auto', padding: '4px 0 32px' }}>
      <CoordHeader title={factory?.name || t('factories_title', lang)} subtitle={t('clients_title', lang)} onBack={onBack} lang={lang} />
      {clients.length === 0
        ? <div style={{ background: '#fff', border: `1px solid ${T.border}`, borderRadius: 18, padding: '32px 20px', textAlign: 'center', fontSize: 16, color: T.textMuted }}>{t('clients_empty', lang)}</div>
        : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {clients.map(c => (
              <button key={c.id} type="button" onClick={() => onOpenClient(c.id)}
                style={{ display: 'flex', alignItems: 'center', gap: 14, textAlign: 'left', background: '#fff', border: `2px solid ${T.border}`, borderRadius: 18, padding: '18px 16px', minHeight: 88, cursor: 'pointer', fontFamily: 'inherit', boxShadow: T.shadow.sm, opacity: c.live ? 1 : 0.7 }}>
                <span style={{ width: 52, height: 52, borderRadius: 14, background: T.primaryLight, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Building2 size={28} color={T.primaryDeep} weight="duotone" />
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 21, fontWeight: 600, color: T.text, lineHeight: 1.2, overflowWrap: 'anywhere' }}>{c.name}</span>
                  <span style={{ display: 'block', fontSize: 15, color: T.textMuted, marginTop: 4 }}>
                    {countText(c.count, lang)}{c.live === 0 ? ` · ${t('state_delivered', lang)}` : ''}
                  </span>
                </span>
                <ChevronRight size={24} color={T.textLight} />
              </button>
            ))}
          </div>
        )}
    </div>
  )
}
