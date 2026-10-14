import { useState } from 'react'
import { ChevronLeft, ChevronRight } from '../icons.jsx'
import { T } from '../constants.js'
import { Modal } from './ui.jsx'

// A style's photos the way a shop shows them: one large photo that slides, arrows either side, a row of thumbnails
// under it. `photos` is [{ src, label, accent }]; the shown photo is controlled (index / onIndex) so the colourway
// chips elsewhere on the page can pick it too. A click on the large photo opens it full size.
export function StyleGallery({ photos, index, onIndex, width = 260 }) {
  const [zoom, setZoom] = useState(false)
  const n = photos.length
  if (!n) return null
  const i = Math.min(Math.max(index || 0, 0), n - 1)
  const go = d => onIndex((i + d + n) % n)
  const height = Math.round(width * 4 / 3)
  const arrow = (side, d) => n > 1 && (
    <button onClick={e => { e.stopPropagation(); go(d) }} aria-label={d < 0 ? 'Previous photo' : 'Next photo'} className="sg-arrow"
      style={{ position: 'absolute', top: '50%', [side]: 8, transform: 'translateY(-50%)', width: 32, height: 32, borderRadius: '50%', border: `1px solid ${T.border}`, background: 'rgba(255,255,255,0.92)', boxShadow: '0 2px 8px rgba(15,23,42,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', padding: 0 }}>
      {d < 0 ? <ChevronLeft size={16} color={T.text} /> : <ChevronRight size={16} color={T.text} />}
    </button>
  )
  return (
    <div style={{ width, display: 'flex', flexDirection: 'column', gap: 10 }}
      tabIndex={0} aria-roledescription="carousel" aria-label="Style photos"
      onKeyDown={e => { if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1) } if (e.key === 'ArrowRight') { e.preventDefault(); go(1) } }}>
      <style>{`.sg-arrow { opacity: .85; transition: opacity .15s } .sg-frame:hover .sg-arrow { opacity: 1 }`}</style>
      <div className="sg-frame" style={{ position: 'relative', width, height, borderRadius: 10, overflow: 'hidden', background: '#f8fafc', border: `1px solid ${T.border}` }}>
        {/* The track slides one frame per photo. */}
        <div style={{ display: 'flex', height: '100%', width: `${n * 100}%`, transform: `translateX(-${(i * 100) / n}%)`, transition: 'transform .35s ease' }}>
          {photos.map((p, k) => (
            <button key={k} onClick={() => setZoom(true)} aria-label={`Open ${p.label} full size`} tabIndex={k === i ? 0 : -1}
              style={{ width: `${100 / n}%`, height: '100%', padding: 0, border: 'none', background: '#fff', cursor: 'zoom-in' }}>
              <img src={p.src} alt={p.label} style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} />
            </button>
          ))}
        </div>
        {arrow('left', -1)}
        {arrow('right', 1)}
        <span style={{ position: 'absolute', left: 10, bottom: 10, display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, color: T.text, background: 'rgba(255,255,255,0.94)', border: `1px solid ${T.border}`, borderRadius: 999, padding: '3px 10px' }}>
          {photos[i].accent && <span style={{ width: 9, height: 9, borderRadius: '50%', background: photos[i].accent, border: '1px solid rgba(0,0,0,0.12)' }} />}
          {photos[i].label}
        </span>
        {n > 1 && <span style={{ position: 'absolute', right: 10, bottom: 10, fontSize: 10, fontWeight: 700, color: '#fff', background: 'rgba(15,23,42,0.55)', borderRadius: 999, padding: '2px 8px' }}>{i + 1} / {n}</span>}
      </div>
      {n > 1 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {photos.map((p, k) => (
            <button key={k} onClick={() => onIndex(k)} onMouseEnter={() => onIndex(k)} aria-label={`Show ${p.label}`} aria-current={k === i}
              style={{ width: 48, height: 60, padding: 0, borderRadius: 6, overflow: 'hidden', cursor: 'pointer', background: '#fff', border: `2px solid ${k === i ? T.primaryDeep : T.border}`, boxShadow: k === i ? '0 0 0 2px rgba(194,65,12,0.15)' : 'none' }}>
              <img src={p.src} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
            </button>
          ))}
        </div>
      )}
      {zoom && (
        <Modal title={photos[i].label} onClose={() => setZoom(false)} size="lg">
          <div style={{ position: 'relative' }}>
            <img src={photos[i].src} alt={photos[i].label} style={{ display: 'block', width: '100%', maxHeight: '72vh', objectFit: 'contain', borderRadius: 8, background: '#fff' }} />
            {arrow('left', -1)}
            {arrow('right', 1)}
          </div>
        </Modal>
      )}
    </div>
  )
}
