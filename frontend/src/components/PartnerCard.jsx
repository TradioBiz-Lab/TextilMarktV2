import { T } from '../constants.js'
import { Card } from './ui.jsx'
import { PartnerImage, Chip, CategoryChips, TagChips, StatusPill, ScoreBadge, ClaimTag, LiveBadge } from './PartnerBits.jsx'
import { CLUSTER_LABEL, TYPE_LABEL, moqVerified, cityName, machineTotal } from '../partners.js'

// One partner in the list page's grid: tile, name, place, what they make, MOQ (a claim until verified), score,
// and status (Live shows as its own badge).
export function PartnerCard({ partner: p, onOpen }) {
  // The place is the cluster, at the right of the name, and nothing else. A partner in "Other" (or in no cluster) shows its
  // city there instead, since "Other" says nothing; with neither, no place is shown.
  const place = p.cluster && p.cluster !== 'other' ? CLUSTER_LABEL[p.cluster] : cityName(p.city)
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
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
            <div style={{ fontSize: T.fontSize.md, fontWeight: 800, color: T.text, lineHeight: 1.3, overflowWrap: 'anywhere', minWidth: 0 }}>{p.name}</div>
            {place && <span style={{ flexShrink: 0 }}><Chip tone="place">{place}</Chip></span>}
          </div>
          <div style={{ fontSize: T.fontSize.xs, color: T.textLight, marginTop: 2 }}>{TYPE_LABEL[p.type]}{!p.isActive ? ' · archived' : ''}</div>
        </div>
        {p.categories.length > 0 && <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}><CategoryChips categories={p.categories} /></div>}
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
          {offers ? <TagChips tags={offers.tags} tone={offers.tone} /> : <><TagChips tags={p.keywords} max={3} plain /><TagChips tags={p.fabrics} tone="fabric" max={2} /></>}
        </div>
        <div style={{ flex: 1 }} />
        {(p.moqPerStyleColour !== null || machineTotal(p) !== null) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: T.fontSize.sm, color: T.text }}>
            {p.moqPerStyleColour !== null && <><span style={{ fontWeight: 700 }}>MOQ {p.moqPerStyleColour} pcs</span>{!moqVerified(p) && <ClaimTag />}</>}
            {machineTotal(p) !== null && <span style={{ fontWeight: 700, marginLeft: p.moqPerStyleColour !== null ? 'auto' : 0 }}>{machineTotal(p)} machines</span>}
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          {p.status !== 'live' && <StatusPill status={p.status} />}
        </div>
      </div>
    </Card>
  )
}
