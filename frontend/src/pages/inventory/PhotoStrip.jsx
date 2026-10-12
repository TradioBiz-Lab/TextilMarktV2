import { useEffect, useRef, useState } from 'react'
import { Camera, Image as ImageIcon, X, Trash2 } from '../../icons.jsx'
import { T } from '../../constants.js'
import { Btn, blobToDataUrl } from '../../components/ui.jsx'
import { compressImage } from '../../lib/imageCompress.js'
import { grnsApi } from '../../api.js'

const KINDS = [{ id: 'challan', label: 'Challan' }, { id: 'goods', label: 'Goods' }, { id: 'damage', label: 'Damage' }]
const kindLabel = id => KINDS.find(k => k.id === id)?.label || 'Photo'
const MAX = 12

// A phone photo is shrunk before it is sent: 1600 px on the long side is plenty to read a challan, and a few
// hundred kilobytes is what a factory's mobile data can carry.
const prepare = async file => blobToDataUrl(await compressImage(file, { maxEdge: 1600, quality: 0.8, minBytes: 250 * 1024 }))

/**
 * The evidence photos of a goods received note: the supplier's challan, the goods as they arrived, any damage.
 * A big camera button first (the rear camera opens directly on a phone), a gallery picker beside it, and each
 * photo is sent the moment it is taken, so nothing is lost if the page is closed. Photos of a posted note
 * stay as they are (`canRemove` is false and the server refuses it too); more can still be added.
 *
 * `photos` is [{ id, kind, name, createdAt, dataUrl? }]: one that arrived without its bytes is fetched here. `grnId` is the
 * id of the record (a goods received note by default; pass `api={jobworkApi}` for a job work challan, which has the same calls).
 */
export function PhotoStrip({ grnId, photos, setPhotos, canAdd = true, canRemove = true, onError, api = grnsApi }) {
  const cam = useRef(null)
  const gallery = useRef(null)
  const [kind, setKind] = useState(() => (photos.some(p => p.kind === 'challan') ? 'goods' : 'challan'))
  const [busy, setBusy] = useState(0)
  const [view, setView] = useState(null)

  // Fetch the bytes of photos the list brought without them, one at a time.
  const missing = photos.find(p => !p.dataUrl && !p.failed)
  useEffect(() => {
    if (!missing) return undefined
    let dead = false
    api.photo(grnId, missing.id)
      .then(full => { if (!dead) setPhotos(list => list.map(p => (p.id === missing.id ? { ...p, dataUrl: full.dataUrl } : p))) })
      .catch(() => { if (!dead) setPhotos(list => list.map(p => (p.id === missing.id ? { ...p, failed: true } : p))) })
    return () => { dead = true }
  }, [grnId, missing?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const add = async files => {
    const picked = [...files].filter(f => f.type.startsWith('image/'))
    if (!picked.length) return
    for (const file of picked) {
      if (photos.length + busy >= MAX) { onError?.(`A note can have at most ${MAX} photos`); break }
      setBusy(n => n + 1)
      try {
        const dataUrl = await prepare(file)
        const saved = await api.addPhoto(grnId, { dataUrl, kind, name: file.name || '' })
        setPhotos(list => [...list, { ...saved, dataUrl }])
        if (kind === 'challan') setKind('goods')
      } catch (e) { onError?.(e?.message || 'The photo could not be saved. Try again') } finally { setBusy(n => n - 1) }
    }
  }

  const remove = async photo => {
    try { await api.removePhoto(grnId, photo.id); setPhotos(list => list.filter(p => p.id !== photo.id)); setView(null) }
    catch (e) { onError?.(e?.message || 'The photo could not be removed') }
  }

  return (
    <div>
      {canAdd && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div role="group" aria-label="What the photo shows" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {KINDS.map(k => (
              <button key={k.id} type="button" aria-pressed={kind === k.id} onClick={() => setKind(k.id)}
                style={{ fontSize: 12, fontWeight: 700, padding: '8px 14px', minHeight: 36, borderRadius: 20, cursor: 'pointer', fontFamily: 'inherit', border: `1px solid ${kind === k.id ? T.primary : T.border}`, background: kind === k.id ? T.primaryLight : T.surface, color: kind === k.id ? T.primaryDark : T.textMuted }}>
                {k.label}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" onClick={() => cam.current?.click()} disabled={busy > 0 || photos.length >= MAX}
              style={{ flex: '1 1 180px', minHeight: 56, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 10, border: 'none', borderRadius: 12, background: T.primaryDeep, color: '#fff', fontSize: 16, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', opacity: busy > 0 || photos.length >= MAX ? 0.6 : 1 }}>
              <Camera size={22} /> Take a photo of the {kindLabel(kind).toLowerCase()}
            </button>
            <Btn variant="secondary" size="lg" icon={<ImageIcon size={16} />} onClick={() => gallery.current?.click()} disabled={busy > 0 || photos.length >= MAX}>From gallery</Btn>
          </div>
          <input ref={cam} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} aria-label="Take a photo" onChange={e => { add(e.target.files); e.target.value = '' }} />
          <input ref={gallery} type="file" accept="image/*" multiple style={{ display: 'none' }} aria-label="Choose photos" onChange={e => { add(e.target.files); e.target.value = '' }} />
        </div>
      )}

      {(photos.length > 0 || busy > 0) && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: 8, marginTop: canAdd ? 12 : 0 }}>
          {photos.map(p => (
            <button key={p.id} type="button" onClick={() => setView(p)} aria-label={`${kindLabel(p.kind)} photo, open`}
              style={{ position: 'relative', padding: 0, border: `1px solid ${T.border}`, borderRadius: 10, overflow: 'hidden', aspectRatio: '1 / 1', background: '#f1f5f9', cursor: 'pointer' }}>
              {p.dataUrl ? <img src={p.dataUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} /> : <span style={{ fontSize: 11, color: T.textLight }}>{p.failed ? 'Not loaded' : 'Loading'}</span>}
              <span style={{ position: 'absolute', left: 4, bottom: 4, fontSize: 10, fontWeight: 800, color: '#fff', background: 'rgba(15,23,42,0.7)', borderRadius: 5, padding: '2px 6px' }}>{kindLabel(p.kind)}</span>
            </button>
          ))}
          {Array.from({ length: busy }, (_, i) => (
            <div key={`u${i}`} role="status" aria-label="Saving photo" style={{ aspectRatio: '1 / 1', border: `1px dashed ${T.border}`, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: T.textLight }}>Saving...</div>
          ))}
        </div>
      )}
      {photos.length === 0 && busy === 0 && !canAdd && <div style={{ fontSize: 13, color: T.textLight }}>No photos were taken.</div>}

      {view && (
        <div role="dialog" aria-label="Photo" onClick={() => setView(null)} style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(15,23,42,0.88)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 16, gap: 12 }}>
          {view.dataUrl ? <img src={view.dataUrl} alt={`${kindLabel(view.kind)} photo`} style={{ maxWidth: '100%', maxHeight: '80vh', borderRadius: 8 }} onClick={e => e.stopPropagation()} /> : <div style={{ color: '#fff' }}>Loading...</div>}
          <div style={{ display: 'flex', gap: 8 }} onClick={e => e.stopPropagation()}>
            {canRemove && <Btn variant="danger" icon={<Trash2 size={14} />} onClick={() => remove(view)}>Remove photo</Btn>}
            <Btn variant="secondary" icon={<X size={14} />} onClick={() => setView(null)}>Close</Btn>
          </div>
        </div>
      )}
    </div>
  )
}
