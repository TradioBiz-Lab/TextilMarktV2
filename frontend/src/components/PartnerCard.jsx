import { MapPin } from '../icons.jsx'
import { T } from '../constants.js'
import { Card } from './ui.jsx'
import { PartnerImage, Chip, CategoryChips, TagChips, StatusPill, ScoreBadge, ClaimTag, OnPlatformBadge, LiveBadge } from './PartnerBits.jsx'
import { CLUSTER_LABEL, TYPE_LABEL, moqVerified } from '../partners.js'

// One partner in the list page's grid: tile, name, place, what they make, MOQ (a claim until verified), score,
// status and the "On platform" badge.
export function PartnerCard({ partner: p, onOpen }) {
  const clusterLabel = p.cluster ? CLUSTER_LABEL[p.cluster] : ''
  const showCluster = clusterLabel && !p.city.toLowerCase().includes(clusterLabel.toLowerCase().split(' ')[0])
  const offers = p.type === 'fabric_supplier' ? { tags: p.fabricTypes, tone: 'fabric' }
    : p.type === 'trims_supplier' ? { tags: p.trimCategories, tone: 'trim' }
    : null
  return (
    <Card pad={false} onClick={onOpen} style={{ display: 'flex', flexDirection: 'column', opacity: p.isActive ? 1 : 0.65, ...(p.isLive ? { borderColor: T.successBorder, boxShadow: `0 0 0 1px ${T.successBorder}` } : {}) }}>
      <div style={{ position: 'relative' }}>
        <PartnerImage partner={p} height={124} thumb />
        <div style={{ position: 'absolute', top: 8, left: 8, display: 'flex', gap: 5, alignItems: 'center' }}>{p.isLive && <LiveBadge />}</div>
        <div style={{ position: 'absolute', top: 8, right: 8 }}><ScoreBadge score={p.verification.score} /></div>
      </div>
      <div style={{ padding: '12px 14px 14px', display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
        <div>
          <div style={{ fontSize: T.fontSize.md, fontWeight: 800, color: T.text, lineHeight: 1.3, overflowWrap: 'anywhere' }}>{p.name}</div>
          <div style={{ fontSize: T.fontSize.xs, color: T.textLight, marginTop: 2 }}>{TYPE_LABEL[p.type]}{!p.isActive ? ' · archived' : ''}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: T.fontSize.sm, color: T.textMuted }}>
          {(p.city || clusterLabel) && <MapPin size={13} color={T.textLight} />}
          {p.city && <span>{p.city}</span>}
          {showCluster && <Chip tone="place">{clusterLabel}</Chip>}
        </div>
        {p.categories.length > 0 && <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}><CategoryChips categories={p.categories} /></div>}
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
          {offers ? <TagChips tags={offers.tags} tone={offers.tone} /> : <><TagChips tags={p.keywords} max={3} plain /><TagChips tags={p.fabrics} tone="fabric" max={2} /></>}
        </div>
        <div style={{ flex: 1 }} />
        {p.moqPerStyleColour !== null && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: T.fontSize.sm, color: T.text }}>
            <span style={{ fontWeight: 700 }}>MOQ {p.moqPerStyleColour} pcs</span>
            {!moqVerified(p) && <ClaimTag />}
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <StatusPill status={p.status} />
          {p.onPlatform && <OnPlatformBadge />}
        </div>
      </div>
    </Card>
  )
}
