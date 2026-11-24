import { useEffect, useState } from 'react'
import { Pencil, Plus, Trash2, Check, AlertTriangle, ListChecks, Image as ImageIcon, MapPin, Upload } from '../icons.jsx'
import { T, fmtDate } from '../constants.js'
import { Modal, Btn, FlexRow, useToast } from './ui.jsx'
import { useApp } from '../context.jsx'
import { capsFor } from '../caps.js'
import { t } from '../coordinatorText.js'
import { shrinkImage } from '../capture.js'
import { bomSections, checkAt, bomProgress, editorRows, blankRow, editorPayload } from '../bom.js'

// The pictures of a style's items, by item id. Read once per saved version of the list; a list with no picture asks nothing.
function useBomImages(order) {
  const { getBomImages } = useApp()
  const [images, setImages] = useState({})
  const wanted = (order.bom?.items || []).some(i => i.hasImage)
  useEffect(() => {
    if (!wanted) { setImages({}); return undefined }
    let dead = false
    getBomImages(order.id).then(r => { if (!dead) setImages(r || {}) }).catch(() => {})
    return () => { dead = true }
  }, [order.id, order.bom?.updatedAt, wanted, getBomImages])
  return images
}

function Zoom({ src, onClose }) {
  return (
    <div role="dialog" aria-modal="true" onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.88)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, cursor: 'zoom-out' }}>
      <img src={src} alt="" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: 8, background: '#fff' }} />
    </div>
  )
}

function Thumb({ src, size, onOpen }) {
  const box = { width: size, height: size, borderRadius: 10, overflow: 'hidden', border: `1px solid ${T.border}`, background: '#f1f5f9', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, padding: 0 }
  if (!src) return <span style={box}><ImageIcon size={size / 3} color={T.textLight} /></span>
  return <button type="button" onClick={onOpen} aria-label="See the picture larger" style={{ ...box, cursor: 'zoom-in' }}><img src={src} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /></button>
}

/**
 * The checklist as an Ops & QC coordinator uses it on the floor: each item with its picture, how much of it the order
 * needs, and one large tick. He ticks an item when he has seen it at this factory; the tick can be taken back. Ticking
 * needs him to be checked in there (`canTick`); otherwise the list is read only and says why.
 */
export function BomChecklist({ order, factoryId, factoryName = '', lang, canTick }) {
  const { checkBomItem } = useApp()
  const toast = useToast()
  const images = useBomImages(order)
  const [busy, setBusy] = useState('')
  const [zoom, setZoom] = useState(null)
  const { done, total } = bomProgress(order.bom, factoryId)
  const all = total > 0 && done === total
  const toggle = async item => {
    setBusy(item.id)
    try { await checkBomItem(order.id, item.id, factoryId, !checkAt(item, factoryId)) }
    catch (e) { toast(e?.message || t('failed', lang), 'error') }
    finally { setBusy('') }
  }
  return (
    <div style={{ background: '#fff', border: `1.5px solid ${all ? '#22c55e' : T.infoBorder}`, borderRadius: 14, padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 17, fontWeight: 800, color: T.info }}>
        <ListChecks size={22} /> {t('bom', lang)}
        <span style={{ marginLeft: 'auto', fontSize: 13, fontWeight: 800, color: all ? '#166534' : T.text, background: all ? '#dcfce7' : '#f1f5f9', borderRadius: 10, padding: '3px 10px', whiteSpace: 'nowrap', flexShrink: 0 }}>
          {all ? t('bom_all_checked', lang, { total }) : t('bom_checked', lang, { done, total })}
        </span>
      </div>
      <div style={{ height: 8, borderRadius: 6, background: '#e2e8f0', overflow: 'hidden' }}><div style={{ width: `${total ? (done / total) * 100 : 0}%`, height: '100%', background: '#22c55e', transition: 'width .2s' }} /></div>
      {!canTick && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 600, color: T.warning, background: T.warningBg, border: `1px solid ${T.warningBorder}`, borderRadius: 12, padding: '8px 12px' }}>
          <MapPin size={17} style={{ flexShrink: 0 }} /> {t('bom_check_in', lang, { name: factoryName })}
        </div>
      )}
      {bomSections(order.bom).map((sec, si) => (
        <div key={si} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {sec.section && <div style={{ fontSize: 13, fontWeight: 800, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: si ? 4 : 0 }}>{sec.section}</div>}
          {sec.items.map(item => {
            const ticked = !!checkAt(item, factoryId)
            return (
              <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 10, border: `1.5px solid ${ticked ? '#86efac' : T.border}`, background: ticked ? '#f0fdf4' : '#fff', borderRadius: 12, padding: 8 }}>
                <Thumb src={images[item.id]} size={64} onOpen={() => setZoom(images[item.id])} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 16, fontWeight: 800, color: T.text, lineHeight: 1.25, overflowWrap: 'anywhere' }}>{item.name}</div>
                  {item.description && <div style={{ fontSize: 13, color: T.textMuted, marginTop: 1, overflowWrap: 'anywhere' }}>{item.description}</div>}
                  {(item.perPiece || item.forOrder) && (
                    <div style={{ fontSize: 13, color: T.text, marginTop: 3 }}>
                      {item.forOrder && <span style={{ fontWeight: 800 }}>{item.forOrder}</span>}
                      {item.perPiece && <span style={{ color: T.textMuted }}>{item.forOrder ? ' · ' : ''}{t('bom_per_piece', lang)}: {item.perPiece}</span>}
                    </div>
                  )}
                </div>
                <button type="button" disabled={!canTick || busy === item.id} onClick={() => toggle(item)} aria-pressed={ticked} aria-label={`${item.name}: ${ticked ? t('bom_ticked', lang) : t('bom_tick', lang)}`}
                  style={{ width: 56, height: 56, borderRadius: 14, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: canTick ? 'pointer' : 'default', fontFamily: 'inherit',
                    border: `2.5px solid ${ticked ? '#16a34a' : canTick ? T.borderHover : T.border}`, background: ticked ? '#16a34a' : '#fff', opacity: busy === item.id ? 0.5 : 1 }}>
                  {ticked && <Check size={32} color="#fff" strokeWidth={3.5} />}
                </button>
              </div>
            )
          })}
        </div>
      ))}
      {zoom && <Zoom src={zoom} onClose={() => setZoom(null)} />}
    </div>
  )
}

const field = { border: `1px solid ${T.border}`, borderRadius: 7, padding: '6px 8px', fontSize: 12.5, fontFamily: 'inherit', color: T.text, background: '#fff', minWidth: 0, width: '100%', boxSizing: 'border-box' }

// Tradio writes the list: a section, a name, what it is, how much per piece and for the order, and a picture.
function BomEditor({ order, images, onClose }) {
  const { setBom } = useApp()
  const toast = useToast()
  const [rows, setRows] = useState(() => { const r = editorRows(order.bom); return r.length ? r : [blankRow('Fabric')] })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const set = (i, patch) => setRows(rs => rs.map((r, ri) => (ri === i ? { ...r, ...patch } : r)))
  const pick = async (i, file) => {
    if (!file) return
    try { set(i, { image: await shrinkImage(file, { max: 480, quality: 0.72 }) }) } catch { setErr('That file is not a picture the browser can read') }
  }
  const save = async items => {
    setBusy(true); setErr('')
    try { await setBom(order.id, items); toast(items.length ? 'Bill of materials saved' : 'Bill of materials removed', 'success'); onClose() }
    catch (e) { setErr(e?.message || 'Could not save it'); setBusy(false) }
  }
  return (
    <Modal title="Bill of materials" subtitle={`${order.product} · the checklist the coordinator ticks at the factory. No prices.`} onClose={() => !busy && onClose()} size="lg">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {rows.map((r, i) => {
          const src = r.image === undefined ? (r.hasImage ? images[r.id] : null) : r.image
          return (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', border: `1px solid ${T.border}`, borderRadius: 10, padding: 8, background: '#f8fafc' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'center' }}>
                <Thumb src={src} size={56} onOpen={() => {}} />
                <label style={{ fontSize: 10.5, fontWeight: 700, color: T.info, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                  <Upload size={10} /> {src ? 'Change' : 'Picture'}
                  <input type="file" accept="image/*" style={{ display: 'none' }} onChange={e => { pick(i, e.target.files?.[0]); e.target.value = '' }} />
                </label>
                {src && <button type="button" onClick={() => set(i, { image: null })} style={{ background: 'none', border: 'none', fontSize: 10.5, color: T.textMuted, cursor: 'pointer', padding: 0, fontFamily: 'inherit' }}>Remove</button>}
              </div>
              <div style={{ flex: 1, minWidth: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 6 }}>
                <input value={r.name} onChange={e => set(i, { name: e.target.value })} placeholder="Item, e.g. Front zip" maxLength={120} aria-label={`Item ${i + 1} name`} style={{ ...field, fontWeight: 700 }} />
                <input value={r.section} onChange={e => set(i, { section: e.target.value })} placeholder="Section, e.g. Trims" maxLength={60} aria-label={`Item ${i + 1} section`} list="bom-sections" style={field} />
                <input value={r.description} onChange={e => set(i, { description: e.target.value })} placeholder="What it is" maxLength={200} aria-label={`Item ${i + 1} description`} style={{ ...field, gridColumn: '1 / -1' }} />
                <input value={r.perPiece} onChange={e => set(i, { perPiece: e.target.value })} placeholder="Per piece, e.g. 1.65 m" maxLength={40} aria-label={`Item ${i + 1} per piece`} style={field} />
                <input value={r.forOrder} onChange={e => set(i, { forOrder: e.target.value })} placeholder="For the order, e.g. 1,360 m" maxLength={40} aria-label={`Item ${i + 1} for the order`} style={field} />
              </div>
              <button type="button" onClick={() => setRows(rs => rs.filter((_, ri) => ri !== i))} aria-label={`Remove ${r.name || 'this item'}`} style={{ background: 'none', border: 'none', cursor: 'pointer', color: T.textMuted, padding: 4 }}><Trash2 size={15} /></button>
            </div>
          )
        })}
        <datalist id="bom-sections">{['Fabric', 'Trims', 'Labels', 'Packing'].map(s => <option key={s} value={s} />)}</datalist>
        <div><Btn size="sm" variant="secondary" onClick={() => setRows(rs => [...rs, blankRow(rs[rs.length - 1]?.section || '')])} icon={<Plus size={12} />}>Add an item</Btn></div>
        {err && <div role="alert" style={{ fontSize: 12, color: T.dangerDeep, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}><AlertTriangle size={13} /> {err}</div>}
        <FlexRow justify="space-between" gap={8} style={{ flexWrap: 'wrap' }}>
          <div>{order.bom && <Btn variant="danger" disabled={busy} onClick={() => save([])} icon={<Trash2 size={13} />}>Remove the list</Btn>}</div>
          <FlexRow gap={8}>
            <Btn variant="secondary" disabled={busy} onClick={onClose}>Cancel</Btn>
            <Btn disabled={busy} onClick={() => save(editorPayload(rows))} icon={<Check size={13} strokeWidth={3} />}>{busy ? 'Saving…' : 'Save'}</Btn>
          </FlexRow>
        </FlexRow>
      </div>
    </Modal>
  )
}

/**
 * The bill of materials on a style's page: each item with its picture and, per factory, who ticked it and when. Tradio
 * edits the list; everyone else reads it. (A coordinator has his own large version at the top of the page.)
 */
export function BomSection({ order }) {
  const { currentUser } = useApp()
  const caps = capsFor(currentUser)
  const images = useBomImages(order)
  const [editing, setEditing] = useState(false)
  const [zoom, setZoom] = useState(null)
  const bom = order.bom
  if (caps.isCoord || (!bom && !caps.editBom)) return null
  const factoryName = id => (order.assignments || []).find(a => String(a.mid) === String(id))?.mfrCompany || 'the factory'
  return (
    <div style={{ marginTop: 16 }}>
      <FlexRow gap={8} style={{ marginBottom: 7 }}>
        <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 9, fontWeight: 700, color: T.textLight, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Bill of materials{bom ? ` · ${bom.items.length} items` : ''}</div>
        {caps.editBom && <Btn size="sm" variant="ghost" onClick={() => setEditing(true)} icon={bom ? <Pencil size={11} /> : <Plus size={11} />}>{bom ? 'Edit' : 'Add'}</Btn>}
      </FlexRow>
      {!bom && <div style={{ fontSize: 12, color: T.textMuted }}>Not added yet. Add the fabric, trims, labels and packing the style needs; the coordinator ticks each one off at the factory.</div>}
      {bom && (
        <div style={{ border: `1px solid ${T.border}`, borderRadius: 10, background: '#fff', overflow: 'hidden' }}>
          {bomSections(bom).map((sec, si) => (
            <div key={si}>
              {sec.section && <div style={{ fontSize: 11, fontWeight: 800, color: T.textMuted, background: '#f8fafc', padding: '6px 10px', borderTop: si ? `1px solid ${T.border}` : 'none' }}>{sec.section}</div>}
              {sec.items.map(item => (
                <div key={item.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '7px 10px', borderTop: `1px solid ${T.border}` }}>
                  <Thumb src={images[item.id]} size={40} onOpen={() => setZoom(images[item.id])} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{item.name}{item.description && <span style={{ fontWeight: 400, color: T.textMuted }}> · {item.description}</span>}</div>
                    <div style={{ fontSize: 11.5, color: T.textMuted, marginTop: 1 }}>{[item.perPiece && `${item.perPiece} per piece`, item.forOrder && `${item.forOrder} for the order`].filter(Boolean).join(' · ')}</div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'flex-end', flexShrink: 0 }}>
                    {item.checks.length === 0 && !caps.isBuyer && <span style={{ fontSize: 11, color: T.textLight }}>not checked yet</span>}
                    {item.checks.map(c => (
                      <span key={c.mfrId} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, color: T.successDeep, background: T.successBg, border: `1px solid ${T.successBorder}`, borderRadius: 8, padding: '1px 7px' }}>
                        <Check size={11} strokeWidth={3} /> {factoryName(c.mfrId)}{c.byName ? `, ${c.byName}` : ''}, {fmtDate(c.at)}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      {editing && <BomEditor order={order} images={images} onClose={() => setEditing(false)} />}
      {zoom && <Zoom src={zoom} onClose={() => setZoom(null)} />}
    </div>
  )
}
