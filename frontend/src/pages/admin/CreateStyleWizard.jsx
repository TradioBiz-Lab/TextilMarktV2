import { useState, useEffect } from 'react'
import { X, Plus, Trash2, ChevronLeft, ChevronRight, AlertTriangle, Camera } from '../../icons.jsx'
import { T, PHASES, CATEGORIES, PATTERN_FILE_PROPS, MEASUREMENTS_FILE_PROPS, resolveNamedColor, getToday } from '../../constants.js'
import { swatchHex, normalisePantone, PANTONE_HINT, PANTONE_PLACEHOLDER, photoFromFile } from '../../colours.js'
import { Btn, FlexRow, Input, Select, FileUpload, fileUploadPayload, useToast } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'

let _styleKeySeq = 1
const newStyle = () => ({
  _key: _styleKeySeq++,
  product: '', styleNumber: '', category: '', customCategory: '',
  colourways: [{ _key: _styleKeySeq++, name: '', code: '', hex: '' }],
  fabrics: [{ _key: _styleKeySeq++, name: '', composition: '', gsm: '', supplier: '' }],
  // Optional: the date the customer expects it. A plan's Delivery step is dated with it (or stays undated until given).
  totalQty: '', delivery: '', phase: 'production',
  // Step 3, all optional. Product photos, each tied to one of the style's colourways or to none; the first is the main photo.
  photos: [], photoColour: '',
  measurementsFile: null, measurementsErr: '',
  techPackFile: null, techPackErr: '',
  patternFile: null, patternErr: '',
  ecommerceLink: '',
})

const STEPS = ['Master order & basic details', 'Colourways & fabric (optional)', 'Reference documents (optional)']

// Decision-tree modal: Node 1 picks the Master Order and defines one or more
// styles' basic details; Node 2 collects colourways/fabric per style; Node 3
// collects optional reference documents per style. No manufacturer, no
// production stages (TNA) here at all — both are added later from the Style
// Detail page once the style exists.
export function CreateStyleWizard({ masterOrders, presetMasterOrderId, onClose, onCreated, onNewMasterOrder }) {
  const { createOrder, uploadDoc } = useApp()
  const toast = useToast()
  const [step, setStep] = useState(1)
  const [masterOrderId, setMasterOrderId] = useState(presetMasterOrderId || '')
  // A master order created from inside the wizard (or asked for by the page) becomes the chosen one.
  useEffect(() => { if (presetMasterOrderId) setMasterOrderId(presetMasterOrderId) }, [presetMasterOrderId])
  const [styles, setStyles] = useState([newStyle()])
  const [err, setErr] = useState('')
  const [photoMsg, setPhotoMsg] = useState({}) // style key -> what the photo picker could not add
  const [saving, setSaving] = useState(false)

  const mo = masterOrders.find(m => m.id === masterOrderId)

  const updateStyle = (key, patch) => setStyles(p => p.map(s => s._key === key ? { ...s, ...patch } : s))
  const addStyle = () => setStyles(p => [...p, newStyle()])
  const removeStyle = key => setStyles(p => p.length > 1 ? p.filter(s => s._key !== key) : p)

  const addColourway = key => updateStyle(key, {
    colourways: [...styles.find(s => s._key === key).colourways, { _key: _styleKeySeq++, name: '', code: '', hex: '' }],
  })
  const updateColourway = (styleKey, cwKey, patch) => setStyles(p => p.map(s => s._key !== styleKey ? s : {
    ...s, colourways: s.colourways.map(c => c._key === cwKey ? { ...c, ...patch } : c),
  }))
  const removeColourway = (styleKey, cwKey) => setStyles(p => p.map(s => s._key !== styleKey ? s : {
    ...s, colourways: s.colourways.filter(c => c._key !== cwKey),
  }))

  const addFabric = key => updateStyle(key, {
    fabrics: [...styles.find(s => s._key === key).fabrics, { _key: _styleKeySeq++, name: '', composition: '', gsm: '', supplier: '' }],
  })
  const updateFabric = (styleKey, fKey, patch) => setStyles(p => p.map(s => s._key !== styleKey ? s : {
    ...s, fabrics: s.fabrics.map(f => f._key === fKey ? { ...f, ...patch } : f),
  }))
  const removeFabric = (styleKey, fKey) => setStyles(p => p.map(s => s._key !== styleKey ? s : {
    ...s, fabrics: s.fabrics.filter(f => f._key !== fKey),
  }))

  const step1Valid = masterOrderId && styles.every(s =>
    s.product.trim() &&
    (s.category && s.category !== '__custom__' ? true : s.customCategory.trim()) &&
    s.totalQty && Number.isInteger(Number(s.totalQty)) && Number(s.totalQty) > 0
  )

  const submit = async () => {
    setErr('')
    setSaving(true)
    const createdIds = []
    const createdKeys = []
    const failedUploads = []
    try {
      for (const s of styles) {
        const category = s.category === '__custom__' ? s.customCategory.trim() : s.category
        const colourways = s.colourways.filter(c => c.name.trim()).map(c => ({ name: c.name.trim(), code: c.code.trim(), hex: c.hex.trim() }))
        const fabricDetails = s.fabrics.filter(f => f.name.trim()).map(f => ({
          name: f.name.trim(), composition: f.composition.trim(), gsm: f.gsm.trim(), supplier: f.supplier.trim(),
        }))
        // The server numbers the style ('auto'): no clash with someone creating at the same time, no dropped number reused.
        const created = await createOrder({
          id: 'auto', buyerId: mo.buyerId, product: s.product.trim(), styleNumber: s.styleNumber.trim(),
          category, season: mo.season || undefined, masterOrderId,
          totalQty: Math.floor(Number(s.totalQty)), ...(s.phase === 'production' && s.delivery ? { delivery: s.delivery } : {}), phase: s.phase,
          createdAt: getToday(),
          colourways, fabricDetails, ecommerceLink: s.ecommerceLink.trim(),
          photos: s.photos.map(ph => ({ image: ph.image, colourway: colourways.some(c => c.name === ph.colourway) ? ph.colourway : '' })),
        })
        createdIds.push(created.id)
        createdKeys.push(s._key)

        const docUploads = [
          [s.measurementsFile, 'measurements', 'Measurements'],
          [s.techPackFile, 'tech_pack', 'Tech Pack'],
          [s.patternFile, 'pattern', 'Pattern / DXF'],
        ]
        for (const [file, type, label] of docUploads) {
          if (!file) continue
          try {
            await uploadDoc({
              type, name: `${label}, ${created.id}`, issuer: '', issueDate: getToday(),
              expiryDate: null, orderId: created.id, mfrId: null,
              ...fileUploadPayload(file),
            })
          } catch (e) { failedUploads.push(`${label} for ${created.id} (${e?.message || 'upload failed'})`) }
        }
      }
      // The styles exist either way; say which files did not make it, so they can be added on the style page.
      if (failedUploads.length) toast(`Created, but these files did not upload: ${failedUploads.join('; ')}. Add them in Documents & Assets.`, 'warning')
      onCreated(createdIds[0])
    } catch (e) {
      // A failure part-way through must not leave the styles that did get created in the form,
      // or pressing Create again would make them a second time.
      if (createdKeys.length) setStyles(p => p.filter(x => !createdKeys.includes(x._key)))
      const done = createdKeys.length ? ` ${createdIds.length} style${createdIds.length !== 1 ? 's were' : ' was'} already created (${createdIds.join(', ')}) and removed from this form, so retrying only creates the rest.` : ''
      setErr(`${e?.message || 'Failed to create style(s)'}.${done}`)
      setSaving(false)
    }
  }

  return (
    <div className="dialog-backdrop" style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, backdropFilter: 'blur(2px)' }}>
      <div style={{ background: '#fff', borderRadius: 14, border: `1px solid ${T.border}`, width: '100%', maxWidth: 860, maxHeight: '92vh', display: 'flex', flexDirection: 'column', boxShadow: '0 24px 64px rgba(0,0,0,0.18)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '20px 24px 16px', borderBottom: `1px solid ${T.border}` }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: T.text }}>Create Style{styles.length > 1 ? 's' : ''}</div>
            <div style={{ fontSize: 12, color: T.textMuted, marginTop: 3 }}>
              Step {step} of {STEPS.length} - {STEPS[step - 1]}
            </div>
          </div>
          <button onClick={onClose} style={{ background: '#f1f5f9', border: 'none', cursor: 'pointer', width: 28, height: 28, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.textMuted }}><X size={15} /></button>
        </div>

        <div style={{ padding: '20px 24px', overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 18 }}>
          {step === 1 && (
            <>
              <div>
                <FlexRow justify="space-between" style={{ marginBottom: 6 }}>
                  <label style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Master Order *</label>
                  <button onClick={onNewMasterOrder} style={{ fontSize: 11, color: T.primary, background: 'none', border: 'none', cursor: 'pointer', fontWeight: 700, fontFamily: 'inherit' }}>+ New Master Order</button>
                </FlexRow>
                <select value={masterOrderId} onChange={e => setMasterOrderId(e.target.value)}
                  style={{ width: '100%', border: `1px solid ${T.border}`, borderRadius: 8, padding: '9px 12px', fontSize: 13, color: T.text, background: T.surface, fontFamily: 'inherit' }}>
                  <option value="">Select master order</option>
                  {masterOrders.map(m => <option key={m.id} value={m.id}>{m.id} - {m.orderName} ({m.buyerCompany})</option>)}
                </select>
              </div>

              {styles.map((s, si) => {
                return (
                  <div key={s._key} style={{ background: '#f8fafc', border: `1px solid ${T.border}`, borderRadius: 10, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <FlexRow justify="space-between">
                      <span style={{ fontSize: 11, fontWeight: 800, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Style {si + 1}</span>
                      {styles.length > 1 && (
                        <button onClick={() => removeStyle(s._key)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: T.danger, display: 'flex' }}><Trash2 size={13} /></button>
                      )}
                    </FlexRow>
                    <div className="form-grid-2" style={{ gap: 10 }}>
                      <Input label="Product Name *" value={s.product} onChange={e => updateStyle(s._key, { product: e.target.value })} placeholder="e.g. Classic T-Shirt" />
                      <Input label="Customer Style ID" value={s.styleNumber} onChange={e => updateStyle(s._key, { styleNumber: e.target.value })} placeholder="The customer's own code, e.g. FLGCM16" maxLength={60} />
                    </div>
                    <div className="form-grid-2" style={{ gap: 10 }}>
                      <div>
                        <Select label="Category *" value={s.category} onChange={e => updateStyle(s._key, { category: e.target.value })}>
                          <option value="">Select</option>
                          {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                          <option value="__custom__">Custom…</option>
                        </Select>
                        {s.category === '__custom__' && (
                          <input value={s.customCategory} onChange={e => updateStyle(s._key, { customCategory: e.target.value.toUpperCase() })}
                            placeholder="Type category code…" maxLength={20}
                            style={{ width: '100%', border: `1px solid ${T.border}`, borderRadius: 8, padding: '7px 12px', fontSize: 13, marginTop: 6, fontFamily: 'inherit', boxSizing: 'border-box' }} />
                        )}
                      </div>
                      <Input label="Quantity *" type="number" value={s.totalQty} onChange={e => updateStyle(s._key, { totalQty: e.target.value })} placeholder="5000" />
                    </div>

                    <div className="form-grid-2" style={{ gap: 10 }}>
                      <Select label="Stage" value={s.phase} onChange={e => updateStyle(s._key, { phase: e.target.value })}>
                        {PHASES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                      </Select>
                      {s.phase === 'production' && <Input label="Expected delivery date" type="date" value={s.delivery} onChange={e => updateStyle(s._key, { delivery: e.target.value })} hint="Optional. It can be added later." />}
                    </div>
                  </div>
                )
              })}
              <button onClick={addStyle} style={{ alignSelf: 'flex-start', fontSize: 12, color: T.primary, background: 'none', border: 'none', cursor: 'pointer', fontWeight: 700, fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 4 }}>
                <Plus size={13} /> Add another style
              </button>
            </>
          )}

          {step === 2 && (
            <>
              <div style={{ fontSize: 12, color: T.textMuted }}>
                Everything below is optional - anything left blank can be added later from each style's detail page.
              </div>
              {styles.map((s, si) => (
                <div key={s._key} style={{ background: '#f8fafc', border: `1px solid ${T.border}`, borderRadius: 10, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <span style={{ fontSize: 12, fontWeight: 800, color: T.text }}>{s.product || `Style ${si + 1}`}{s.styleNumber ? ` - ${s.styleNumber}` : ''}</span>

                  <div>
                    <FlexRow justify="space-between" style={{ marginBottom: 6 }}>
                      <label style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Colourways</label>
                      <button onClick={() => addColourway(s._key)} style={{ fontSize: 11, color: T.primary, background: 'none', border: 'none', cursor: 'pointer', fontWeight: 700, fontFamily: 'inherit' }}><Plus size={11} style={{ verticalAlign: -1, marginRight: 3 }} />Add colourway</button>
                    </FlexRow>
                    {s.colourways.map(c => (
                      <div key={c._key} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
                        <input type="color" value={swatchHex(c, resolveNamedColor)} onChange={e => updateColourway(s._key, c._key, { hex: e.target.value })}
                          title="Swatch colour: matched from the name, click to change"
                          style={{ width: 32, height: 32, padding: 0, border: `1px solid ${T.border}`, borderRadius: 6, cursor: 'pointer', flexShrink: 0 }} />
                        <input value={c.name} onChange={e => updateColourway(s._key, c._key, { name: e.target.value })}
                          placeholder="Colour (e.g. Peacot)"
                          style={{ flex: 2, border: `1px solid ${T.border}`, borderRadius: 6, padding: '6px 10px', fontSize: 12, fontFamily: 'inherit' }} />
                        <input value={c.code} maxLength={40} onChange={e => updateColourway(s._key, c._key, { code: e.target.value })}
                          onBlur={() => updateColourway(s._key, c._key, { code: normalisePantone(c.code).value })}
                          placeholder={PANTONE_PLACEHOLDER} title={PANTONE_HINT} aria-label="Pantone reference"
                          style={{ flex: 1, border: `1px solid ${normalisePantone(c.code).valid ? T.border : T.warning}`, borderRadius: 6, padding: '6px 10px', fontSize: 12, fontFamily: 'inherit' }} />
                        {s.colourways.length > 1 && (
                          <button onClick={() => removeColourway(s._key, c._key)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: T.textLight, display: 'flex', alignItems: 'center' }}><X size={13} /></button>
                        )}
                      </div>
                    ))}
                    <div style={{ fontSize: 11, color: T.textLight, marginTop: 4 }}>{PANTONE_HINT}</div>
                    {s.colourways.some(c => !normalisePantone(c.code).valid) && (
                      <div style={{ fontSize: 11, color: T.warning, marginTop: 3 }}>A Pantone reference looks like 19-4052 TCX. Anything else is kept as typed.</div>
                    )}
                  </div>

                  <div>
                    <FlexRow justify="space-between" style={{ marginBottom: 6 }}>
                      <label style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Fabric Details</label>
                      <button onClick={() => addFabric(s._key)} style={{ fontSize: 11, color: T.primary, background: 'none', border: 'none', cursor: 'pointer', fontWeight: 700, fontFamily: 'inherit' }}><Plus size={11} style={{ verticalAlign: -1, marginRight: 3 }} />Add fabric</button>
                    </FlexRow>
                    {s.fabrics.map(f => (
                      <div key={f._key} style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
                        <input value={f.name} onChange={e => updateFabric(s._key, f._key, { name: e.target.value })}
                          placeholder="Fabric (e.g. Shell - Single Jersey)"
                          style={{ flex: '2 1 160px', border: `1px solid ${T.border}`, borderRadius: 6, padding: '6px 10px', fontSize: 12, fontFamily: 'inherit' }} />
                        <input value={f.composition} onChange={e => updateFabric(s._key, f._key, { composition: e.target.value })}
                          placeholder="Composition (e.g. 100% Cotton)"
                          style={{ flex: '2 1 140px', border: `1px solid ${T.border}`, borderRadius: 6, padding: '6px 10px', fontSize: 12, fontFamily: 'inherit' }} />
                        <input value={f.gsm} onChange={e => updateFabric(s._key, f._key, { gsm: e.target.value })}
                          placeholder="GSM"
                          style={{ flex: '0 1 70px', border: `1px solid ${T.border}`, borderRadius: 6, padding: '6px 10px', fontSize: 12, fontFamily: 'inherit' }} />
                        <input value={f.supplier} onChange={e => updateFabric(s._key, f._key, { supplier: e.target.value })}
                          placeholder="Supplier (optional)"
                          style={{ flex: '1 1 120px', border: `1px solid ${T.border}`, borderRadius: 6, padding: '6px 10px', fontSize: 12, fontFamily: 'inherit' }} />
                        {s.fabrics.length > 1 && (
                          <button onClick={() => removeFabric(s._key, f._key)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: T.textLight, display: 'flex', alignItems: 'center' }}><X size={13} /></button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </>
          )}

          {step === 3 && (
            <>
              <div style={{ fontSize: 12, color: T.textMuted }}>
                Everything here is optional. Anything left out can be added later in the style's Documents & Assets.
              </div>
              {styles.map((s, si) => (
                <div key={s._key} style={{ background: '#f8fafc', border: `1px solid ${T.border}`, borderRadius: 10, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <span style={{ fontSize: 12, fontWeight: 800, color: T.text }}>{s.product || `Style ${si + 1}`}{s.styleNumber ? ` - ${s.styleNumber}` : ''}</span>
                  <div className="form-grid-2" style={{ gap: 12 }}>
                    <div style={{ gridColumn: '1 / -1' }}>
                      <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Product photos</label>
                      {(() => {
                        const names = s.colourways.map(c => c.name.trim()).filter(Boolean)
                        const sel = { border: `1px solid ${T.border}`, borderRadius: 6, padding: '5px 8px', fontSize: 12, fontFamily: 'inherit', background: '#fff', color: T.text }
                        const add = async files => {
                          const added = [], skipped = []
                          const colourway = s.photoColour
                          // A style holds 12 photos (the server's limit): files past that are named, not converted.
                          const room = Math.max(0, 12 - s.photos.length)
                          for (const [i, f] of files.entries()) {
                            if (i >= room) { skipped.push(`${f.name}: a style holds 12 photos`); continue }
                            try { added.push({ _key: _styleKeySeq++, image: await photoFromFile(f), colourway }) }
                            catch (e) { skipped.push(`${f.name}: ${e.message}`) }
                          }
                          // Written against the latest state, so a second pick or a removal made meanwhile is kept.
                          if (added.length) setStyles(p => p.map(x => (x._key === s._key ? { ...x, photos: [...x.photos, ...added].slice(0, 12) } : x)))
                          setPhotoMsg(m => ({ ...m, [s._key]: skipped.length ? `Not added: ${skipped.join('; ')}` : '' }))
                        }
                        return (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                            <FlexRow gap={8} style={{ flexWrap: 'wrap' }}>
                              <select value={s.photoColour} onChange={e => updateStyle(s._key, { photoColour: e.target.value })} aria-label="Colourway the photos show" style={sel}>
                                <option value="">No particular colourway</option>
                                {names.map(n => <option key={n} value={n}>{n}</option>)}
                              </select>
                              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', fontSize: 12, fontWeight: 700, borderRadius: 8, background: T.primaryDeep, color: '#fff', cursor: 'pointer' }}>
                                <Camera size={13} color="#fff" /> Choose photos
                                <input type="file" multiple accept="image/jpeg,image/png,image/webp" style={{ display: 'none' }}
                                  onChange={e => { const fs = [...(e.target.files || [])]; e.target.value = ''; if (fs.length) add(fs) }} />
                              </label>
                              <span style={{ fontSize: 11, color: T.textLight }}>JPEG, PNG or WebP, up to 12. The first is the main photo.</span>
                            </FlexRow>
                            {photoMsg[s._key] && <div style={{ fontSize: 11, color: T.danger }}>{photoMsg[s._key]}</div>}
                            {s.photos.length > 0 && (
                              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                {s.photos.map((ph, i) => (
                                  <div key={ph._key} style={{ width: 110, border: `1px solid ${i === 0 ? T.primaryDeep : T.border}`, borderRadius: 8, padding: 4, background: '#fff', display: 'flex', flexDirection: 'column', gap: 4 }}>
                                    <div style={{ position: 'relative', height: 110, borderRadius: 6, overflow: 'hidden', background: '#f8fafc' }}>
                                      <img src={ph.image} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                                      <button onClick={() => updateStyle(s._key, { photos: s.photos.filter(x => x._key !== ph._key) })} aria-label="Remove photo"
                                        style={{ position: 'absolute', right: 3, top: 3, width: 20, height: 20, borderRadius: '50%', border: 'none', background: 'rgba(15,23,42,0.6)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}><X size={11} color="#fff" /></button>
                                    </div>
                                    <select value={names.includes(ph.colourway) ? ph.colourway : ''} aria-label="Colourway shown in this photo" style={{ ...sel, fontSize: 11, padding: '3px 4px' }}
                                      onChange={e => updateStyle(s._key, { photos: s.photos.map(x => (x._key === ph._key ? { ...x, colourway: e.target.value } : x)) })}>
                                      <option value="">No colourway</option>
                                      {names.map(n => <option key={n} value={n}>{n}</option>)}
                                    </select>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )
                      })()}
                    </div>
                    <div>
                      <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Measurements</label>
                      <FileUpload {...MEASUREMENTS_FILE_PROPS} file={s.measurementsFile} onFile={f => updateStyle(s._key, { measurementsFile: f, measurementsErr: '' })} error={s.measurementsErr} onError={e => updateStyle(s._key, { measurementsErr: e })} />
                    </div>
                    <div>
                      <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Tech Pack</label>
                      <FileUpload file={s.techPackFile} onFile={f => updateStyle(s._key, { techPackFile: f, techPackErr: '' })} error={s.techPackErr} onError={e => updateStyle(s._key, { techPackErr: e })} />
                    </div>
                    <div>
                      <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Patterns / DXF</label>
                      <FileUpload {...PATTERN_FILE_PROPS} file={s.patternFile} onFile={f => updateStyle(s._key, { patternFile: f, patternErr: '' })} error={s.patternErr} onError={e => updateStyle(s._key, { patternErr: e })} />
                    </div>
                  </div>
                  <Input label="E-commerce Link" value={s.ecommerceLink} onChange={e => updateStyle(s._key, { ecommerceLink: e.target.value })} placeholder="https://…" />
                </div>
              ))}
            </>
          )}

          {err && <div style={{ fontSize: 12, color: T.danger, fontWeight: 600, background: T.dangerBg, border: `1px solid ${T.dangerBorder}`, borderRadius: 8, padding: '8px 12px' }}><AlertTriangle size={12} style={{ verticalAlign: -2, marginRight: 4 }} /> {err}</div>}

          <FlexRow justify="space-between" style={{ marginTop: 4 }}>
            <Btn variant="secondary" onClick={step === 1 ? onClose : () => setStep(step - 1)}>
              {step === 1 ? 'Cancel' : <><ChevronLeft size={13} style={{ marginRight: -2 }} /> Back</>}
            </Btn>
            {step < STEPS.length ? (
              <Btn disabled={step === 1 && !step1Valid} onClick={() => setStep(step + 1)}>
                Next: {STEPS[step]} <ChevronRight size={13} style={{ marginLeft: -2 }} />
              </Btn>
            ) : (
              <Btn disabled={saving} onClick={submit}>{saving ? 'Creating…' : `Create Style${styles.length > 1 ? 's' : ''}`}</Btn>
            )}
          </FlexRow>
        </div>
      </div>
    </div>
  )
}
