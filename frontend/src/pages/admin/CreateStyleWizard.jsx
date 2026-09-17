import { useState } from 'react'
import { X, Plus, Trash2, ChevronLeft, ChevronRight } from 'lucide-react'
import { T, CATEGORIES, PATTERN_FILE_PROPS, MEASUREMENTS_FILE_PROPS, resolveNamedColor } from '../../constants.js'
import { Btn, FlexRow, Input, Select, FileUpload, fileUploadPayload } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'

let _styleKeySeq = 1
const newStyle = () => ({
  _key: _styleKeySeq++,
  product: '', styleNumber: '', category: '', customCategory: '',
  colourways: [{ _key: _styleKeySeq++, name: '', code: '', hex: '' }],
  fabrics: [{ _key: _styleKeySeq++, name: '', composition: '', gsm: '', supplier: '' }],
  totalQty: '', delivery: '',
  // Step 3 — all optional
  photoFile: null, photoErr: '',
  measurementsFile: null, measurementsErr: '',
  techPackFile: null, techPackErr: '',
  patternFile: null, patternErr: '',
  ecommerceLink: '',
})

// Next sequence number for this buyer+category+season, derived from the
// highest existing suffix (not array length) — same fix as genMoId, so a
// deleted style can't cause the next one to collide with a survivor.
function genStyleId(orders, buyerCode, cat, season) {
  const prefix = `${buyerCode}-${cat}-${season}-`
  const maxN = orders
    .filter(o => o.id.startsWith(prefix))
    .reduce((max, o) => {
      const n = parseInt(o.id.slice(prefix.length), 10)
      return Number.isFinite(n) && n > max ? n : max
    }, 0)
  return `${prefix}${String(maxN + 1).padStart(3, '0')}`
}

const STEPS = ['Master order & basic details', 'Colourways & fabric (optional)', 'Reference documents (optional)']

// Decision-tree modal: Node 1 picks the Master Order and defines one or more
// styles' basic details; Node 2 collects colourways/fabric per style; Node 3
// collects optional reference documents per style. No manufacturer, no
// production stages (TNA) here at all — both are added later from the Style
// Detail page once the style exists.
export function CreateStyleWizard({ masterOrders, onClose, onCreated, onNewMasterOrder }) {
  const { orders, createOrder, uploadDoc } = useApp()
  const [step, setStep] = useState(1)
  const [masterOrderId, setMasterOrderId] = useState('')
  const [styles, setStyles] = useState([newStyle()])
  const [err, setErr] = useState('')
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
    s.product.trim() && s.styleNumber.trim() &&
    (s.category && s.category !== '__custom__' ? true : s.customCategory.trim()) &&
    s.totalQty && Number(s.totalQty) > 0 && s.delivery
  )

  const submit = async () => {
    setErr('')
    setSaving(true)
    try {
      const createdIds = []
      for (const s of styles) {
        const category = s.category === '__custom__' ? s.customCategory.trim() : s.category
        const id = genStyleId(orders, mo.buyerCode, (category || 'XX').toUpperCase().slice(0, 6), mo.season || 'XX')
        const photoPayload = fileUploadPayload(s.photoFile)
        const colourways = s.colourways.filter(c => c.name.trim()).map(c => ({ name: c.name.trim(), code: c.code.trim(), hex: c.hex.trim() }))
        const fabricDetails = s.fabrics.filter(f => f.name.trim()).map(f => ({
          name: f.name.trim(), composition: f.composition.trim(), gsm: f.gsm.trim(), supplier: f.supplier.trim(),
        }))
        const created = await createOrder({
          id, buyerId: mo.buyerId, product: s.product.trim(), styleNumber: s.styleNumber.trim(),
          category, season: mo.season || undefined, masterOrderId,
          totalQty: Math.floor(Number(s.totalQty)), delivery: s.delivery,
          createdAt: new Date().toISOString().slice(0, 10),
          colourways, fabricDetails, ecommerceLink: s.ecommerceLink.trim(),
          imageDataUrl: photoPayload.dataUrl || null, imageUrl: photoPayload.externalUrl || null,
        })
        createdIds.push(created.id)

        const docUploads = [
          [s.measurementsFile, 'measurements', 'Measurements'],
          [s.techPackFile, 'tech_pack', 'Tech Pack'],
          [s.patternFile, 'pattern', 'Pattern / DXF'],
        ]
        for (const [file, type, label] of docUploads) {
          if (!file) continue
          try {
            await uploadDoc({
              type, name: `${label} — ${created.id}`, issuer: '', issueDate: new Date().toISOString().slice(0, 10),
              expiryDate: null, orderId: created.id, mfrId: null,
              ...fileUploadPayload(file),
            })
          } catch { /* style is created either way — document can be re-uploaded from Style Detail */ }
        }
      }
      onCreated(createdIds[0])
    } catch (e) {
      setErr(typeof e === 'string' ? e : (e?.message || 'Failed to create style(s)'))
      setSaving(false)
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, backdropFilter: 'blur(2px)' }} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: '#fff', borderRadius: 14, border: `1px solid ${T.border}`, width: '100%', maxWidth: 860, maxHeight: '92vh', display: 'flex', flexDirection: 'column', boxShadow: '0 24px 64px rgba(0,0,0,0.18)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '20px 24px 16px', borderBottom: `1px solid ${T.border}` }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: T.text }}>Create Style{styles.length > 1 ? 's' : ''}</div>
            <div style={{ fontSize: 12, color: T.textMuted, marginTop: 3 }}>
              Step {step} of {STEPS.length} — {STEPS[step - 1]}
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
                  <option value="">— Select Master Order —</option>
                  {masterOrders.map(m => <option key={m.id} value={m.id}>{m.id} — {m.orderName} ({m.buyerCompany})</option>)}
                </select>
              </div>

              {styles.map((s, si) => {
                const catForId = s.category === '__custom__' ? (s.customCategory || 'CUST').toUpperCase().slice(0, 6) : (s.category || 'XX')
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
                      <Input label="Style Number *" value={s.styleNumber} onChange={e => updateStyle(s._key, { styleNumber: e.target.value })} placeholder="e.g. STY-2026-014" />
                    </div>
                    <div className="form-grid-2" style={{ gap: 10 }}>
                      <div>
                        <Select label="Category *" value={s.category} onChange={e => updateStyle(s._key, { category: e.target.value })}>
                          <option value="">— Select —</option>
                          {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                          <option value="__custom__">✏️ Custom…</option>
                        </Select>
                        {s.category === '__custom__' && (
                          <input value={s.customCategory} onChange={e => updateStyle(s._key, { customCategory: e.target.value.toUpperCase() })}
                            placeholder="Type category code…" maxLength={20}
                            style={{ width: '100%', border: `1px solid ${T.border}`, borderRadius: 8, padding: '7px 12px', fontSize: 13, marginTop: 6, fontFamily: 'inherit', boxSizing: 'border-box' }} />
                        )}
                      </div>
                      <Input label="Quantity *" type="number" value={s.totalQty} onChange={e => updateStyle(s._key, { totalQty: e.target.value })} placeholder="5000" />
                    </div>
                    <Input label="Expected Delivery *" type="date" value={s.delivery} onChange={e => updateStyle(s._key, { delivery: e.target.value })} />

                    {mo && (s.product || s.styleNumber) && (
                      <div style={{ fontSize: 11, color: T.textLight, fontFamily: "'JetBrains Mono',monospace" }}>
                        ID preview: {genStyleId(orders, mo.buyerCode, catForId, mo.season || 'XX')}
                      </div>
                    )}
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
                Everything below is optional — anything left blank can be added later from each style's detail page.
              </div>
              {styles.map((s, si) => (
                <div key={s._key} style={{ background: '#f8fafc', border: `1px solid ${T.border}`, borderRadius: 10, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <span style={{ fontSize: 12, fontWeight: 800, color: T.text }}>{s.product || `Style ${si + 1}`}{s.styleNumber ? ` — ${s.styleNumber}` : ''}</span>

                  <div>
                    <FlexRow justify="space-between" style={{ marginBottom: 6 }}>
                      <label style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Colourways</label>
                      <button onClick={() => addColourway(s._key)} style={{ fontSize: 11, color: T.primary, background: 'none', border: 'none', cursor: 'pointer', fontWeight: 700, fontFamily: 'inherit' }}>+ Add colourway</button>
                    </FlexRow>
                    {s.colourways.map(c => (
                      <div key={c._key} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
                        <input type="color" value={c.hex || resolveNamedColor(c.name) || '#cbd5e1'} onChange={e => updateColourway(s._key, c._key, { hex: e.target.value })}
                          title="Swatch colour (approximate)"
                          style={{ width: 32, height: 32, padding: 0, border: `1px solid ${T.border}`, borderRadius: 6, cursor: 'pointer', flexShrink: 0 }} />
                        <input value={c.name} onChange={e => updateColourway(s._key, c._key, { name: e.target.value })}
                          placeholder="Colour (e.g. Peacot)"
                          style={{ flex: 2, border: `1px solid ${T.border}`, borderRadius: 6, padding: '6px 10px', fontSize: 12, fontFamily: 'inherit' }} />
                        <input value={c.code} onChange={e => updateColourway(s._key, c._key, { code: e.target.value })}
                          placeholder="Pantone TPX/TCX (optional)"
                          style={{ flex: 1, border: `1px solid ${T.border}`, borderRadius: 6, padding: '6px 10px', fontSize: 12, fontFamily: 'inherit' }} />
                        {s.colourways.length > 1 && (
                          <button onClick={() => removeColourway(s._key, c._key)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: T.textLight, display: 'flex', alignItems: 'center' }}><X size={13} /></button>
                        )}
                      </div>
                    ))}
                  </div>

                  <div>
                    <FlexRow justify="space-between" style={{ marginBottom: 6 }}>
                      <label style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Fabric Details</label>
                      <button onClick={() => addFabric(s._key)} style={{ fontSize: 11, color: T.primary, background: 'none', border: 'none', cursor: 'pointer', fontWeight: 700, fontFamily: 'inherit' }}>+ Add fabric</button>
                    </FlexRow>
                    {s.fabrics.map(f => (
                      <div key={f._key} style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
                        <input value={f.name} onChange={e => updateFabric(s._key, f._key, { name: e.target.value })}
                          placeholder="Fabric (e.g. Shell — Single Jersey)"
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
                Everything below is optional — anything left blank can be uploaded later from each style's detail page.
              </div>
              {styles.map((s, si) => (
                <div key={s._key} style={{ background: '#f8fafc', border: `1px solid ${T.border}`, borderRadius: 10, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <span style={{ fontSize: 12, fontWeight: 800, color: T.text }}>{s.product || `Style ${si + 1}`}{s.styleNumber ? ` — ${s.styleNumber}` : ''}</span>
                  <div className="form-grid-2" style={{ gap: 12 }}>
                    <div>
                      <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Image</label>
                      <FileUpload file={s.photoFile} onFile={f => updateStyle(s._key, { photoFile: f, photoErr: '' })} error={s.photoErr} onError={e => updateStyle(s._key, { photoErr: e })} />
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

          {err && <div style={{ fontSize: 12, color: T.danger, fontWeight: 600, background: T.dangerBg, border: `1px solid ${T.dangerBorder}`, borderRadius: 8, padding: '8px 12px' }}>⚠ {err}</div>}

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
