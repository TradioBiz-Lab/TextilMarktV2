import { useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { T, SEASONS, CATEGORIES } from '../../constants.js'
import { Btn, FlexRow, Input, Select, FileUpload, fileUploadPayload, ProductThumb } from '../../components/ui.jsx'

let _cwKeySeq = 1
let _fabKeySeq = 1

export function EditOrderModal({ order, onClose, onSave }) {
  const [f, setF] = useState({
    product: order.product || '',
    styleNumber: order.styleNumber || '',
    category: order.category || '',
    season: order.season || '',
    totalQty: order.totalQty != null ? String(order.totalQty) : '',
    delivery: order.delivery ? new Date(order.delivery).toISOString().slice(0, 10) : '',
    ecommerceLink: order.ecommerceLink || '',
    callout: order.callout || '',
  })
  const [colourways, setColourways] = useState(
    (order.colourways || []).length > 0
      ? order.colourways.map(c => ({ _key: _cwKeySeq++, name: c.name, code: c.code || '', hex: c.hex || '' }))
      : [{ _key: _cwKeySeq++, name: '', code: '', hex: '' }]
  )
  const updateCw = (key, patch) => setColourways(p => p.map(c => c._key === key ? { ...c, ...patch } : c))
  const addCw = () => setColourways(p => [...p, { _key: _cwKeySeq++, name: '', code: '', hex: '' }])
  const removeCw = key => setColourways(p => p.length > 1 ? p.filter(c => c._key !== key) : p)

  const [fabrics, setFabrics] = useState(
    (order.fabricDetails || []).length > 0
      ? order.fabricDetails.map(f => ({ _key: _fabKeySeq++, name: f.name, composition: f.composition || '', gsm: f.gsm || '', supplier: f.supplier || '' }))
      : [{ _key: _fabKeySeq++, name: '', composition: '', gsm: '', supplier: '' }]
  )
  const updateFab = (key, patch) => setFabrics(p => p.map(f => f._key === key ? { ...f, ...patch } : f))
  const addFab = () => setFabrics(p => [...p, { _key: _fabKeySeq++, name: '', composition: '', gsm: '', supplier: '' }])
  const removeFab = key => setFabrics(p => p.length > 1 ? p.filter(f => f._key !== key) : p)
  const hasExistingPhoto = !!(order.imageDataUrl || order.imageUrl)
  const [photoFile, setPhotoFile] = useState(null)
  const [photoErr, setPhotoErr] = useState('')
  const [clearPhoto, setClearPhoto] = useState(false)
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)

  const set = key => e => setF(p => ({ ...p, [key]: e.target.value }))

  const save = async () => {
    setErr('')
    if (!f.product.trim()) { setErr('Product name is required'); return }
    const qty = parseInt(f.totalQty, 10)
    if (isNaN(qty) || qty < 1) { setErr('Total quantity must be a positive number'); return }
    if (!f.delivery) { setErr('Delivery date is required'); return }

    const payload = {
      product: f.product.trim(),
      styleNumber: f.styleNumber.trim(),
      category: f.category || undefined,
      season: f.season || undefined,
      totalQty: qty,
      delivery: f.delivery,
      colourways: colourways.filter(c => c.name.trim()).map(c => ({ name: c.name.trim(), code: c.code.trim(), hex: c.hex.trim() })),
      fabricDetails: fabrics.filter(fb => fb.name.trim()).map(fb => ({ name: fb.name.trim(), composition: fb.composition.trim(), gsm: fb.gsm.trim(), supplier: fb.supplier.trim() })),
      ecommerceLink: f.ecommerceLink.trim(),
      callout: f.callout.trim(),
    }
    if (clearPhoto) {
      payload.imageDataUrl = null
      payload.imageUrl = null
    } else if (photoFile) {
      const p = fileUploadPayload(photoFile)
      payload.imageDataUrl = p.dataUrl || null
      payload.imageUrl = p.externalUrl || null
    }

    setSaving(true)
    try {
      await onSave(order.id, payload)
    } catch (e) {
      setErr(typeof e === 'string' ? e : 'Failed to update order')
      setSaving(false)
    }
  }

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, backdropFilter: 'blur(2px)' }}
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div style={{ background: '#fff', borderRadius: 14, border: `1px solid ${T.border}`, width: '100%', maxWidth: 520, boxShadow: '0 24px 64px rgba(0,0,0,0.18)' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '20px 24px 16px', borderBottom: `1px solid ${T.border}` }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: T.text }}>Edit Order</div>
            <div style={{ fontSize: 12, color: T.textMuted, marginTop: 3, fontFamily: "'JetBrains Mono',monospace" }}>{order.id}</div>
          </div>
          <button onClick={onClose} style={{ background: '#f1f5f9', border: 'none', cursor: 'pointer', width: 28, height: 28, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, color: T.textMuted }}>×</button>
        </div>

        {/* Body */}
        <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="form-grid-2" style={{ gap: 12 }}>
            <Input
              label="Product Name *"
              value={f.product}
              onChange={set('product')}
              placeholder="e.g. Classic T-Shirt"
            />
            <Input
              label="Style Number"
              value={f.styleNumber}
              onChange={set('styleNumber')}
              placeholder="e.g. STY-2026-014"
            />
          </div>

          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Product Photo (optional)</label>
            {hasExistingPhoto && !photoFile && !clearPhoto ? (
              <FlexRow gap={10}>
                <ProductThumb order={order} size="sm" />
                <Btn variant="secondary" size="sm" onClick={() => setClearPhoto(true)}>Remove photo</Btn>
              </FlexRow>
            ) : (
              <FileUpload file={photoFile} onFile={f => { setPhotoFile(f); setPhotoErr(''); setClearPhoto(false) }} error={photoErr} onError={setPhotoErr} />
            )}
          </div>

          <div className="form-grid-2" style={{ gap: 12 }}>
            <div>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Category</label>
              <select
                value={f.category}
                onChange={set('category')}
                style={{ width: '100%', border: `1px solid ${T.border}`, borderRadius: 8, padding: '9px 12px', fontSize: 13, color: T.text, background: T.surface, fontFamily: 'inherit' }}
              >
                <option value="">— Select —</option>
                {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <Select label="Season" value={f.season} onChange={set('season')}>
              <option value="">— Select —</option>
              {SEASONS.map(s => <option key={s}>{s}</option>)}
            </Select>
          </div>

          <div className="form-grid-2" style={{ gap: 12 }}>
            <Input
              label="Total Quantity *"
              type="number"
              value={f.totalQty}
              onChange={set('totalQty')}
              placeholder="5000"
            />
            <Input
              label="Expected Delivery *"
              type="date"
              value={f.delivery}
              onChange={set('delivery')}
            />
          </div>

          <div>
            <FlexRow justify="space-between" style={{ marginBottom: 6 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Colourways</label>
              <button onClick={addCw} style={{ fontSize: 11, color: T.primary, background: 'none', border: 'none', cursor: 'pointer', fontWeight: 700, fontFamily: 'inherit' }}>+ Add colourway</button>
            </FlexRow>
            {colourways.map(c => (
              <div key={c._key} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
                <input type="color" value={c.hex || '#cbd5e1'} onChange={e => updateCw(c._key, { hex: e.target.value })}
                  title="Swatch colour (approximate)"
                  style={{ width: 32, height: 32, padding: 0, border: `1px solid ${T.border}`, borderRadius: 6, cursor: 'pointer', flexShrink: 0 }} />
                <input value={c.name} onChange={e => updateCw(c._key, { name: e.target.value })}
                  placeholder="Colour (e.g. Peacot)"
                  style={{ flex: 2, border: `1px solid ${T.border}`, borderRadius: 6, padding: '6px 10px', fontSize: 12, fontFamily: 'inherit' }} />
                <input value={c.code} onChange={e => updateCw(c._key, { code: e.target.value })}
                  placeholder="Pantone TPX/TCX (optional)"
                  style={{ flex: 1, border: `1px solid ${T.border}`, borderRadius: 6, padding: '6px 10px', fontSize: 12, fontFamily: 'inherit' }} />
                {colourways.length > 1 && (
                  <button onClick={() => removeCw(c._key)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: T.textLight }}>×</button>
                )}
              </div>
            ))}
          </div>
          <div>
            <FlexRow justify="space-between" style={{ marginBottom: 6 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Fabric Details</label>
              <button onClick={addFab} style={{ fontSize: 11, color: T.primary, background: 'none', border: 'none', cursor: 'pointer', fontWeight: 700, fontFamily: 'inherit' }}>+ Add fabric</button>
            </FlexRow>
            {fabrics.map(fb => (
              <div key={fb._key} style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
                <input value={fb.name} onChange={e => updateFab(fb._key, { name: e.target.value })}
                  placeholder="Fabric (e.g. Shell — Single Jersey)"
                  style={{ flex: '2 1 150px', border: `1px solid ${T.border}`, borderRadius: 6, padding: '6px 10px', fontSize: 12, fontFamily: 'inherit' }} />
                <input value={fb.composition} onChange={e => updateFab(fb._key, { composition: e.target.value })}
                  placeholder="Composition"
                  style={{ flex: '2 1 130px', border: `1px solid ${T.border}`, borderRadius: 6, padding: '6px 10px', fontSize: 12, fontFamily: 'inherit' }} />
                <input value={fb.gsm} onChange={e => updateFab(fb._key, { gsm: e.target.value })}
                  placeholder="GSM"
                  style={{ flex: '0 1 60px', border: `1px solid ${T.border}`, borderRadius: 6, padding: '6px 10px', fontSize: 12, fontFamily: 'inherit' }} />
                <input value={fb.supplier} onChange={e => updateFab(fb._key, { supplier: e.target.value })}
                  placeholder="Supplier"
                  style={{ flex: '1 1 100px', border: `1px solid ${T.border}`, borderRadius: 6, padding: '6px 10px', fontSize: 12, fontFamily: 'inherit' }} />
                {fabrics.length > 1 && (
                  <button onClick={() => removeFab(fb._key)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: T.textLight }}>×</button>
                )}
              </div>
            ))}
          </div>
          <Input
            label="E-commerce Link"
            value={f.ecommerceLink}
            onChange={set('ecommerceLink')}
            placeholder="https://…"
          />
          <Input
            label="Callout"
            value={f.callout}
            onChange={set('callout')}
            placeholder="e.g. delayed a week — lab dip submission slipped"
            hint="Order-level risk note. Shows on the Order Status report."
          />

          <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#92400e' }}>
            Note: editing the total quantity does not automatically update manufacturer assignment quantities. Update those from the order detail view if needed.
          </div>

          {err && (
            <div style={{ fontSize: 12, color: T.danger, fontWeight: 600, background: T.dangerBg, border: `1px solid ${T.dangerBorder}`, borderRadius: 8, padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 6 }}>
              <AlertTriangle size={13} /> {err}
            </div>
          )}

          <FlexRow justify="flex-end" gap={8} style={{ marginTop: 4 }}>
            <Btn variant="secondary" onClick={onClose} disabled={saving}>Cancel</Btn>
            <Btn onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save Changes'}</Btn>
          </FlexRow>
        </div>
      </div>
    </div>
  )
}
