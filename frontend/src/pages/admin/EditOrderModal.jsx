import { useState } from 'react'
import { AlertTriangle, X, Plus } from '../../icons.jsx'
import { T, phaseOf, SEASONS, CATEGORIES, resolveNamedColor } from '../../constants.js'
import { swatchHex, normalisePantone, PANTONE_HINT, PANTONE_PLACEHOLDER } from '../../colours.js'
import { Btn, FlexRow, Input, Select } from '../../components/ui.jsx'

let _cwKeySeq = 1
let _fabKeySeq = 1

export function EditOrderModal({ order, onClose, onSave }) {
  const [f, setF] = useState({
    product: order.product || '',
    styleNumber: order.styleNumber || '',
    category: order.category || '',
    season: order.season || '',
    phase: phaseOf(order),
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
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)

  const set = key => e => setF(p => ({ ...p, [key]: e.target.value }))

  const splitSum = (order.assignments || []).reduce((n, a) => n + (Number(a.qty) || 0), 0)

  const save = async () => {
    setErr('')
    if (!f.product.trim()) { setErr('Product name is required'); return }
    const qty = parseInt(f.totalQty, 10)
    if (isNaN(qty) || qty < 1) { setErr('Total quantity must be a positive number'); return }
    // The date is needed once a style in production has a manufacturer (its plan's Delivery step stands on it).
    const hasSplits = (order.assignments || []).length > 0
    if (!f.delivery && f.phase !== 'development' && hasSplits) { setErr('A delivery date is needed for a style in production with a manufacturer'); return }

    const payload = {
      product: f.product.trim(),
      styleNumber: f.styleNumber.trim(),
      category: f.category || undefined,
      season: f.season || undefined,
      // Only a real change travels: an unchanged quantity must not touch the manufacturer splits.
      ...(qty !== order.totalQty ? { totalQty: qty } : {}),
      // A cleared date is sent as null (allowed with no manufacturer or in development); left out, the old one would stay.
      ...(f.delivery ? { delivery: f.delivery } : order.delivery ? { delivery: null } : {}),
      colourways: colourways.filter(c => c.name.trim()).map(c => ({ name: c.name.trim(), code: c.code.trim(), hex: c.hex.trim() })),
      fabricDetails: fabrics.filter(fb => fb.name.trim()).map(fb => ({ name: fb.name.trim(), composition: fb.composition.trim(), gsm: fb.gsm.trim(), supplier: fb.supplier.trim() })),
      ecommerceLink: f.ecommerceLink.trim(),
      callout: f.callout.trim(),
    }

    setSaving(true)
    try {
      await onSave(order.id, payload)
    } catch (e) {
      setErr(e?.message || 'Failed to update order')
      setSaving(false)
    }
  }

  return (
    <div
      className="dialog-backdrop"
      style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, backdropFilter: 'blur(2px)' }}
    >
      <div style={{ background: '#fff', borderRadius: 14, border: `1px solid ${T.border}`, width: '100%', maxWidth: 520, boxShadow: '0 24px 64px rgba(0,0,0,0.18)' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '20px 24px 16px', borderBottom: `1px solid ${T.border}` }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: T.text }}>Edit Style</div>
            <div style={{ fontSize: 12, color: T.textMuted, marginTop: 3, fontFamily: "'JetBrains Mono',monospace" }}>{order.id}</div>
          </div>
          <button onClick={onClose} style={{ background: '#f1f5f9', border: 'none', cursor: 'pointer', width: 28, height: 28, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, color: T.textMuted }} aria-label="Close"><X size={14} /></button>
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

          <div className="form-grid-2" style={{ gap: 12 }}>
            <div>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Category</label>
              <select
                value={f.category}
                onChange={set('category')}
                style={{ width: '100%', border: `1px solid ${T.border}`, borderRadius: 8, padding: '9px 12px', fontSize: 13, color: T.text, background: T.surface, fontFamily: 'inherit' }}
              >
                <option value="">Select</option>
                {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <Select label="Season" value={f.season} onChange={set('season')}>
              <option value="">Select</option>
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
              // With several splits the total is their sum. It stays editable when it no longer matches them (a split's
              // quantity changed on Change Mfr), so it can be set to the sum.
              disabled={(order.assignments || []).length > 1 && order.totalQty === splitSum}
              hint={(order.assignments || []).length === 1 ? 'Also updates the manufacturer quantity and every step target. Finished steps stay finished.'
                : (order.assignments || []).length > 1 ? (order.totalQty === splitSum ? `Split across ${(order.assignments || []).length} manufacturers, so the total is the sum of their quantities.` : `The splits add up to ${splitSum}. Set the total to ${splitSum} to match them.`) : undefined}
            />
            <Input
              label={f.phase !== 'development' && (order.assignments || []).length > 0 ? 'Expected Delivery *' : 'Expected Delivery'}
              type="date"
              value={f.delivery}
              onChange={set('delivery')}
            />
          </div>

          <div>
            <FlexRow justify="space-between" style={{ marginBottom: 6 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Colourways</label>
              <button onClick={addCw} style={{ fontSize: 11, color: T.primary, background: 'none', border: 'none', cursor: 'pointer', fontWeight: 700, fontFamily: 'inherit' }}><Plus size={11} style={{ verticalAlign: -1, marginRight: 3 }} />Add colourway</button>
            </FlexRow>
            {colourways.map(c => (
              <div key={c._key} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
                <input type="color" value={swatchHex(c, resolveNamedColor)} onChange={e => updateCw(c._key, { hex: e.target.value })}
                  title="Swatch colour: matched from the name, click to change"
                  style={{ width: 32, height: 32, padding: 0, border: `1px solid ${T.border}`, borderRadius: 6, cursor: 'pointer', flexShrink: 0 }} />
                <input value={c.name} onChange={e => updateCw(c._key, { name: e.target.value })}
                  placeholder="Colour (e.g. Peacot)"
                  style={{ flex: 2, border: `1px solid ${T.border}`, borderRadius: 6, padding: '6px 10px', fontSize: 12, fontFamily: 'inherit' }} />
                <input value={c.code} maxLength={40} onChange={e => updateCw(c._key, { code: e.target.value })}
                  onBlur={() => updateCw(c._key, { code: normalisePantone(c.code).value })}
                  placeholder={PANTONE_PLACEHOLDER} title={PANTONE_HINT} aria-label="Pantone reference"
                  style={{ flex: 1, border: `1px solid ${normalisePantone(c.code).valid ? T.border : T.warning}`, borderRadius: 6, padding: '6px 10px', fontSize: 12, fontFamily: 'inherit' }} />
                {colourways.length > 1 && (
                  <button onClick={() => removeCw(c._key)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: T.textLight }} aria-label="Close"><X size={14} /></button>
                )}
              </div>
            ))}
            <div style={{ fontSize: 11, color: T.textLight, marginTop: 4 }}>{PANTONE_HINT}</div>
            {colourways.some(c => !normalisePantone(c.code).valid) && (
              <div style={{ fontSize: 11, color: T.warning, marginTop: 3 }}>A Pantone reference looks like 19-4052 TCX. Anything else is kept as typed.</div>
            )}
          </div>
          <div>
            <FlexRow justify="space-between" style={{ marginBottom: 6 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Fabric Details</label>
              <button onClick={addFab} style={{ fontSize: 11, color: T.primary, background: 'none', border: 'none', cursor: 'pointer', fontWeight: 700, fontFamily: 'inherit' }}><Plus size={11} style={{ verticalAlign: -1, marginRight: 3 }} />Add fabric</button>
            </FlexRow>
            {fabrics.map(fb => (
              <div key={fb._key} style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
                <input value={fb.name} onChange={e => updateFab(fb._key, { name: e.target.value })}
                  placeholder="Fabric (e.g. Shell, Single Jersey)"
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
                  <button onClick={() => removeFab(fb._key)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: T.textLight }} aria-label="Close"><X size={14} /></button>
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
            placeholder="e.g. delayed a week, lab dip submission slipped"
            hint="Order-level risk note. Shows on the Order Status report."
          />


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
