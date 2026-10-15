import { useState } from 'react'
import { X, ArrowLeft, Camera } from '../icons.jsx'
import { T } from '../constants.js'
import { Btn, FlexRow, useToast } from './ui.jsx'
import { useApp } from '../context.jsx'
import { photoFromFile } from '../colours.js'

// A style's product photos, managed where its other files are (Documents & Assets): upload one or more, saying which
// colourway they show; change a photo's colourway, make one the main photo, remove one. Every photo here is a slide in
// the style's gallery, and the main one is its thumbnail everywhere. Each change saves at once.
export function ProductPhotos({ order, canEdit }) {
  const { editOrder, setStylePhotos, currentUser } = useApp()
  const toast = useToast()
  const [colour, setColour] = useState('')   // the colourway the next upload shows
  const [busy, setBusy] = useState(false)
  const names = (order.colourways || []).map(c => c.name)
  const main = order.imageDataUrl || order.imageUrl
  // A style from before photos has its one product photo.
  const photos = (order.photos || []).length > 0 ? order.photos : main ? [{ image: main, colourway: '' }] : []

  const save = async (next, done) => {
    setBusy(true)
    const list = next.map(p => ({ image: p.image, colourway: p.colourway || '' }))
    // The customer saves through its own route; Tradio edits photos with the rest of the style.
    try { await (currentUser?.role === 'buyer' ? setStylePhotos(order.id, list) : editOrder(order.id, { photos: list })); toast(done, 'success') }
    catch (e) { toast(typeof e === 'string' ? e : (e?.message || 'Could not save the photos'), 'error') }
    finally { setBusy(false) }
  }
  const upload = async files => {
    if (photos.length + files.length > 12) { toast('A style holds up to 12 photos', 'error'); return }
    setBusy(true)
    let added
    try { added = []; for (const f of files) added.push({ image: await photoFromFile(f), colourway: colour }) }
    catch (e) { setBusy(false); toast(e.message, 'error'); return }
    await save([...photos, ...added], `${added.length} photo${added.length > 1 ? 's' : ''} uploaded${colour ? ` for ${colour}` : ''}`)
  }

  const select = { border: `1px solid ${T.border}`, borderRadius: 6, padding: '5px 8px', fontSize: 12, fontFamily: 'inherit', color: T.text, background: '#fff' }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {canEdit && (
        <FlexRow gap={8} style={{ flexWrap: 'wrap', padding: 10, background: '#f8fafc', border: `1px dashed ${T.border}`, borderRadius: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: T.text }}>Upload photos of</span>
          <select value={colour} onChange={e => setColour(e.target.value)} aria-label="Colourway the uploaded photos show" style={select}>
            <option value="">No particular colourway</option>
            {names.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', fontSize: 12, fontWeight: 700, borderRadius: 8, background: busy ? '#e2e8f0' : T.primaryDeep, color: '#fff', cursor: busy ? 'wait' : 'pointer' }}>
            <Camera size={13} color="#fff" /> {busy ? 'Saving...' : 'Choose photos'}
            <input type="file" multiple accept="image/jpeg,image/png,image/webp" disabled={busy} style={{ display: 'none' }}
              onChange={e => { const fs = [...(e.target.files || [])]; e.target.value = ''; if (fs.length) upload(fs) }} />
          </label>
          {names.length === 0 && <span style={{ fontSize: 11, color: T.textLight }}>Add colourways in Edit Style to tag photos by colour.</span>}
        </FlexRow>
      )}
      {photos.length === 0 ? (
        <div style={{ fontSize: 12, color: T.textMuted, padding: '4px 2px' }}>No product photos yet.{canEdit ? '' : ' The customer or Tradio uploads these.'}</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
          {photos.map((p, i) => (
            <div key={i} style={{ border: `1px solid ${i === 0 ? T.primaryDeep : T.border}`, borderRadius: 8, padding: 6, display: 'flex', flexDirection: 'column', gap: 6, background: '#fff' }}>
              <div style={{ position: 'relative', height: 170, borderRadius: 6, overflow: 'hidden', background: '#f8fafc' }}>
                <img src={p.image} alt={p.colourway || order.product} style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} />
                {i === 0 && <span style={{ position: 'absolute', left: 4, top: 4, fontSize: 9, fontWeight: 800, color: '#fff', background: T.primaryDeep, borderRadius: 4, padding: '1px 6px', letterSpacing: '0.04em' }}>MAIN</span>}
                {canEdit && (
                  <button onClick={() => save(photos.filter((_, k) => k !== i), 'Photo removed')} disabled={busy} aria-label="Remove photo" title="Remove photo"
                    style={{ position: 'absolute', right: 4, top: 4, width: 22, height: 22, borderRadius: '50%', border: 'none', background: 'rgba(15,23,42,0.6)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}><X size={12} color="#fff" /></button>
                )}
              </div>
              {canEdit ? (
                <select value={names.includes(p.colourway) ? p.colourway : ''} disabled={busy} aria-label="Colourway shown in this photo"
                  onChange={e => save(photos.map((x, k) => (k === i ? { ...x, colourway: e.target.value } : x)), 'Colourway updated')} style={select}>
                  <option value="">No colourway</option>
                  {names.map(n => <option key={n} value={n}>{n}</option>)}
                </select>
              ) : (
                <div style={{ fontSize: 12, fontWeight: 600, color: T.textMuted, padding: '0 2px' }}>{p.colourway || 'No colourway'}</div>
              )}
              {canEdit && i > 0 && (
                <Btn size="sm" variant="ghost" disabled={busy} onClick={() => save([p, ...photos.filter((_, k) => k !== i)], 'Main photo changed')} icon={<ArrowLeft size={11} />}>Make main photo</Btn>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
