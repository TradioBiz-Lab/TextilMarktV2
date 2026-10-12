import { BRAND_NAVY, BRAND_ORANGE, MARK_SIZE, MARK_GEOMETRY } from '../brandMark.js'
import { T } from '../constants.js'

// Plain constants and markup for anything that is not React (PDF and email headers in the backend
// can copy brandMark.js as it is). They are re-exported here so there is one place to import the
// brand from.
export { BRAND_NAVY, BRAND_ORANGE, MARK_SIZE, MARK_GEOMETRY, MARK_SVG, markSvg } from '../brandMark.js'

const FONT = "'Inter Variable', 'Inter', system-ui, sans-serif"

/**
 * The Tradio T: a navy tile with an orange T made of two bars. Same drawing as the website icon.
 * `onDark` adds a faint ring around the tile so it still reads as a tile on a navy surface.
 * Decorative by default; pass `title` when the mark stands alone and needs a name for screen readers.
 */
export function LogoMark({ size = 32, onDark = false, title, className, style }) {
  const { tile, bars } = MARK_GEOMETRY
  return (
    <svg
      className={className}
      width={size} height={size} viewBox={`0 0 ${MARK_SIZE} ${MARK_SIZE}`}
      role={title ? 'img' : undefined} aria-label={title || undefined} aria-hidden={title ? undefined : true}
      focusable="false"
      style={{ display: 'block', flexShrink: 0, ...style }}
    >
      <rect {...tile} fill={BRAND_NAVY} />
      {onDark && <rect x="1.5" y="1.5" width="97" height="97" rx="18.5" fill="none" stroke="#fff" strokeOpacity="0.18" strokeWidth="3" />}
      {bars.map((b, i) => <rect key={i} {...b} fill={BRAND_ORANGE} />)}
    </svg>
  )
}

/**
 * The TextilMarkt lockup: the T mark, the name, and a small "by Tradio" line.
 *
 *   variant   'full' (mark + name + caption, the default) or 'compact' (the mark alone)
 *   onDark    true on a navy or other dark surface: white name, light caption, ringed tile
 *   size      height of the mark in px; the name and caption scale from it (default 32)
 *
 * The caption borrows the website's eyebrow style (a short orange rule, then widely spaced capitals),
 * so the product and tradiobiz.com read as one brand. Orange appears only in the mark and that rule.
 * Class hooks for CSS: .brand-logo on the root, .brand-text on the name and caption block (index.css
 * hides it on very narrow headers).
 */
export function Logo({ variant = 'full', onDark = false, size = 32, className, style }) {
  const compact = variant === 'compact'
  const nameSize = Math.round(size * 0.54)
  const capSize = Math.max(9, Math.round(size * 0.25))
  const ruleW = Math.round(size * 0.3)
  const ruleH = Math.max(1.5, size / 24)
  return (
    <span
      className={`brand-logo${className ? ` ${className}` : ''}`}
      role={compact ? 'img' : undefined} aria-label={compact ? 'TextilMarkt by Tradio' : undefined}
      style={{ display: 'inline-flex', alignItems: 'center', gap: Math.round(size * 0.3), lineHeight: 1, ...style }}
    >
      <LogoMark size={size} onDark={onDark} />
      {!compact && (
        <span className="brand-text" style={{ display: 'flex', flexDirection: 'column', gap: Math.round(size * 0.12), minWidth: 0 }}>
          <span style={{ fontFamily: FONT, fontWeight: 700, fontSize: nameSize, letterSpacing: '-0.03em', lineHeight: 1, whiteSpace: 'nowrap', color: onDark ? '#FFFFFF' : BRAND_NAVY }}>
            TextilMarkt
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: Math.round(size * 0.14) }}>
            <span aria-hidden="true" style={{ width: ruleW, height: ruleH, borderRadius: 1, background: BRAND_ORANGE, flexShrink: 0 }} />
            <span style={{ fontFamily: FONT, fontWeight: 600, fontSize: capSize, letterSpacing: '0.22em', textTransform: 'uppercase', lineHeight: 1, whiteSpace: 'nowrap', color: onDark ? 'rgba(255,255,255,0.62)' : T.textLight }}>
              by Tradio
            </span>
          </span>
        </span>
      )}
    </span>
  )
}
