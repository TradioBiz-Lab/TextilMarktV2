import { useState } from 'react'
import { T, SEASONS, CATEGORIES } from '../../../constants.js'
import { Card, Btn, Input, Select, FlexRow, useToast, SectionLabel, FileUpload, fileUploadPayload } from '../../../components/ui.jsx'
import { useApp } from '../../../context.jsx'
import { BulkUploadCsvPanel } from '../../admin/BulkUploadCsvPanel.jsx'

let rowSeq = 0
function blankStyleRow() {
  return {
    key: ++rowSeq, styleName: '', category: '', season: '', totalQty: '', delivery: '',
    colourways: '', photo: null, photoErr: '',
  }
}

// Manufacturer path — no Tradio order machinery (no assignments/stages), so a
// much lighter repeatable-row editor than the admin path's BulkUploadCsvPanel.
function MfrLineItemsForm({ wizardState, patchState, onNext, onBack }) {
  const { bulkCreateMfrProjects } = useApp()
  const toast = useToast()
  const [rows, setRows] = useState([blankStyleRow()])
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const updateRow = (key, patch) => setRows(prev => prev.map(r => r.key === key ? { ...r, ...patch } : r))
  const removeRow = key => setRows(prev => prev.filter(r => r.key !== key))

  const submit = async () => {
    setErr('')
    const valid = rows.filter(r => r.styleName.trim())
    if (valid.length === 0) { setErr('At least one style is required'); return }
    setSaving(true)
    try {
      const payloadRows = valid.map(r => {
        const photoPayload = fileUploadPayload(r.photo)
        return {
          styleName: r.styleName.trim(), buyerName: wizardState.buyerName,
          category: r.category, season: r.season, totalQty: Number(r.totalQty) || 0,
          delivery: r.delivery || null,
          colourways: r.colourways.split(',').map(c => c.trim()).filter(Boolean).map(name => ({ name })),
          imageDataUrl: photoPayload.dataUrl || null, imageUrl: photoPayload.externalUrl || null,
        }
      })
      const result = await bulkCreateMfrProjects(wizardState.mfrMasterProjectId, payloadRows)
      const ids = result.results.filter(r => r.success).map(r => r.id)
      if (ids.length === 0) { setErr('No styles could be created — check the fields above'); setSaving(false); return }
      patchState({ lineItemIds: ids })
      toast(`${ids.length} style${ids.length !== 1 ? 's' : ''} created`, 'success')
      onNext()
    } catch (e) {
      setErr(typeof e === 'string' ? e : (e?.message || 'Failed to create styles'))
      setSaving(false)
    }
  }

  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {rows.map(row => (
          <div key={row.key} style={{ border: `1px solid ${T.border}`, borderRadius: 10, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <FlexRow justify="space-between">
              <div style={{ flex: 1 }} className="form-grid-2">
                <Input label="Style Name *" value={row.styleName} onChange={e => updateRow(row.key, { styleName: e.target.value })} />
                <Input label="Total Qty" type="number" value={row.totalQty} onChange={e => updateRow(row.key, { totalQty: e.target.value })} />
              </div>
              {rows.length > 1 && (
                <button type="button" onClick={() => removeRow(row.key)}
                  style={{ background: 'none', border: 'none', color: T.danger, cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>Remove</button>
              )}
            </FlexRow>
            <div className="form-grid-3">
              <Select label="Category" value={row.category} onChange={e => updateRow(row.key, { category: e.target.value })}>
                <option value="">—</option>
                {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </Select>
              <Select label="Season" value={row.season} onChange={e => updateRow(row.key, { season: e.target.value })}>
                <option value="">—</option>
                {SEASONS.map(s => <option key={s} value={s}>{s}</option>)}
              </Select>
              <Input label="Delivery" type="date" value={row.delivery} onChange={e => updateRow(row.key, { delivery: e.target.value })} />
            </div>
            <Input label="Colourways (comma-separated)" value={row.colourways} onChange={e => updateRow(row.key, { colourways: e.target.value })} placeholder="Black, Navy" />
            <div>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 5 }}>Product Photo (optional)</label>
              <FileUpload file={row.photo} onFile={f => updateRow(row.key, { photo: f })} error={row.photoErr} onError={e => updateRow(row.key, { photoErr: e })} />
            </div>
          </div>
        ))}
      </div>

      <FlexRow justify="flex-start" style={{ marginTop: 12 }}>
        <Btn variant="secondary" onClick={() => setRows(prev => [...prev, blankStyleRow()])}>+ Add Style</Btn>
      </FlexRow>

      {err && <div style={{ fontSize: 12, color: T.danger, fontWeight: 600, marginTop: 12 }}>⚠ {err}</div>}

      <FlexRow justify="space-between" style={{ marginTop: 20 }}>
        <Btn variant="secondary" onClick={onBack}>← Back</Btn>
        <Btn onClick={submit} disabled={saving}>{saving ? 'Creating…' : 'Next: Materials & Costing →'}</Btn>
      </FlexRow>
    </>
  )
}

export function Step3LineItems({ wizardState, patchState, onNext, onBack }) {
  const { masterOrders } = useApp()
  const isAdmin = wizardState.role === 'admin'
  const masterOrder = isAdmin ? masterOrders.find(m => m.id === wizardState.masterOrderId) : null

  return (
    <Card>
      <SectionLabel>Step 3 — Product Line Items</SectionLabel>
      <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 14 }}>
        {isAdmin
          ? 'Add each style — image, quantity, colourways — manually or via CSV. Production stages default to "NA" dates; you\'ll set the real TNA plan in the next step.'
          : 'Add each style your own project covers.'}
      </div>

      {isAdmin ? (
        masterOrder ? (
          <BulkUploadCsvPanel
            masterOrder={masterOrder}
            onDone={(results) => {
              const ids = (results?.results || []).filter(r => r.success).map(r => r.orderId)
              patchState({ lineItemIds: ids })
              onNext()
            }}
          />
        ) : (
          <div style={{ fontSize: 13, color: T.danger }}>Master order not found — go back and try again.</div>
        )
      ) : (
        <MfrLineItemsForm wizardState={wizardState} patchState={patchState} onNext={onNext} onBack={onBack} />
      )}
    </Card>
  )
}
