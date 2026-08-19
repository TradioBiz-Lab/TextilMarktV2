import { useState, useRef } from 'react'
import Papa from 'papaparse'
import { T } from '../../constants.js'
import { Btn, FlexRow, EmptyState } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'

const MAX_ROWS = 200
const CATEGORIES = ['fabric', 'trim', 'accessory', 'other']

const cellStyle = w => ({ width: w, border: `1px solid ${T.border}`, borderRadius: 6, padding: '5px 7px', fontSize: 12, fontFamily: 'inherit', boxSizing: 'border-box' })

function csvRowToStructured(raw, rowIndex) {
  return {
    rowIndex,
    orderId: (raw.order_id || '').trim(),
    category: (raw.category || '').trim().toLowerCase(),
    name: (raw.material_name || '').trim(),
    requiredQty: raw.required_qty ? parseFloat(raw.required_qty) : '',
    unit: (raw.unit || '').trim(),
    supplier: (raw.supplier || '').trim(),
    colourway: (raw.colourway || '').trim(),
  }
}

// Re-derived fresh on every render, same convention as the other bulk panels.
function validateRow(row, orders) {
  const errors = []
  if (!row.orderId) errors.push('order_id is required')
  else if (!orders.some(o => o.id === row.orderId)) errors.push(`Order "${row.orderId}" not found`)
  if (!row.name) errors.push('material_name is required')
  if (row.requiredQty === '' || isNaN(row.requiredQty) || row.requiredQty < 0) errors.push('required_qty must be a non-negative number')
  if (row.category && !CATEGORIES.includes(row.category)) errors.push(`category must be one of: ${CATEGORIES.join(', ')}`)

  return { errors, status: errors.length ? 'error' : 'valid' }
}

export function MaterialRequirementsBulkUploadPanel({ onDone }) {
  const { orders, bulkUploadMaterialRequirements } = useApp()
  const fileInputRef = useRef(null)
  const [rows, setRows] = useState([])
  const [fileName, setFileName] = useState('')
  const [parseErr, setParseErr] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [results, setResults] = useState(null)

  const updateRow = (rowIndex, patch) => setRows(prev => prev.map(r => r.rowIndex === rowIndex ? { ...r, ...patch } : r))

  const handleFile = (file) => {
    setFileName(file.name)
    setParseErr('')
    setResults(null)
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        if (res.errors?.length) {
          setParseErr(`CSV parse error: ${res.errors[0].message}`)
          setRows([])
          return
        }
        const structured = res.data.map((raw, i) => csvRowToStructured(raw, i))
        if (structured.length > MAX_ROWS) {
          setParseErr(`Too many rows (${structured.length}) — max ${MAX_ROWS} per bulk upload.`)
          setRows([])
          return
        }
        if (structured.length === 0) setParseErr('No rows found in this CSV')
        setRows(structured)
      },
    })
  }

  const validated = rows.map(row => ({ row, v: validateRow(row, orders) }))
  const validCount = validated.filter(x => x.v.status === 'valid').length

  const handleSubmit = async () => {
    const validRows = validated.filter(x => x.v.status === 'valid').map(x => x.row)
    if (validRows.length === 0) return
    setSubmitting(true)
    try {
      const payloadRows = validRows.map(r => ({
        orderId: r.orderId, category: r.category || undefined, name: r.name, requiredQty: r.requiredQty,
        unit: r.unit || undefined, supplier: r.supplier || undefined, colourway: r.colourway || undefined,
      }))
      const result = await bulkUploadMaterialRequirements(payloadRows)
      setResults(result)
    } finally {
      setSubmitting(false)
    }
  }

  if (results) {
    const failedRows = results.results.filter(r => !r.success)
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ background: results.failed === 0 ? T.successBg : T.warningBg, border: `1px solid ${results.failed === 0 ? T.successBorder : T.warningBorder}`, borderRadius: 10, padding: '14px 16px' }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: results.failed === 0 ? T.success : T.warning }}>
            {results.created} of {results.total} requirement lines added{results.failed > 0 ? `, ${results.failed} failed` : ''}
          </div>
        </div>
        {failedRows.length > 0 && (
          <div style={{ background: T.dangerBg, border: `1px solid ${T.dangerBorder}`, borderRadius: 10, padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {failedRows.map(r => (
              <div key={r.row} style={{ fontSize: 12, color: T.danger }}>Row {r.row + 1}: {r.error}</div>
            ))}
          </div>
        )}
        <FlexRow justify="flex-end">
          <Btn onClick={onDone}>Done</Btn>
        </FlexRow>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <div onClick={() => fileInputRef.current?.click()}
          style={{ border: `2px dashed ${T.border}`, borderRadius: 10, padding: '24px', textAlign: 'center', cursor: 'pointer', background: '#fafbff' }}>
          <div style={{ fontSize: 26, marginBottom: 6 }}>📦</div>
          <div style={{ fontWeight: 600, color: T.textMuted }}>Click to upload a CSV, or drag & drop</div>
          {fileName && <div style={{ fontSize: 12, color: T.primary, marginTop: 6, fontWeight: 600 }}>{fileName} — {rows.length} row{rows.length !== 1 ? 's' : ''} parsed</div>}
        </div>
        <input ref={fileInputRef} type="file" accept=".csv" style={{ display: 'none' }}
          onChange={e => e.target.files[0] && handleFile(e.target.files[0])} />
        <FlexRow justify="space-between" style={{ marginTop: 8 }}>
          <a href="/templates/material-requirements-bulk-upload-template.csv" download style={{ fontSize: 12, color: T.primary, fontWeight: 600 }}>⬇ Download CSV Template</a>
          {rows.length > 0 && <span style={{ fontSize: 12, color: T.textMuted }}>{validCount} valid · {rows.length - validCount} with errors</span>}
        </FlexRow>
      </div>

      {parseErr && <div style={{ fontSize: 12, color: T.danger, fontWeight: 600, background: T.dangerBg, border: `1px solid ${T.dangerBorder}`, borderRadius: 8, padding: '8px 12px' }}>⚠ {parseErr}</div>}

      {rows.length === 0 && !parseErr && (
        <EmptyState icon="📦" title="No CSV uploaded yet" desc="Download the template, fill in requirement lines for existing orders, and upload it here" />
      )}

      {rows.length > 0 && (
        <div style={{ border: `1px solid ${T.border}`, borderRadius: 10, overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#f8fafc' }}>
                {['#', 'Order ID', 'Category', 'Material', 'Qty', 'Unit', 'Supplier', 'Colourway', 'Status'].map(h => (
                  <th key={h} style={{ padding: '8px 10px', textAlign: 'left', fontSize: 10, fontWeight: 800, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {validated.map(({ row, v }) => (
                <tr key={row.rowIndex} style={{ borderTop: `1px solid ${T.border}` }}>
                  <td style={{ padding: '6px 10px', fontSize: 12, color: T.textMuted }}>{row.rowIndex + 1}</td>
                  <td style={{ padding: '4px 6px' }}><input value={row.orderId} onChange={e => updateRow(row.rowIndex, { orderId: e.target.value })} style={cellStyle(140)} /></td>
                  <td style={{ padding: '4px 6px' }}>
                    <select value={row.category} onChange={e => updateRow(row.rowIndex, { category: e.target.value })} style={cellStyle(90)}>
                      <option value="">other</option>
                      {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </td>
                  <td style={{ padding: '4px 6px' }}><input value={row.name} onChange={e => updateRow(row.rowIndex, { name: e.target.value })} style={cellStyle(170)} /></td>
                  <td style={{ padding: '4px 6px' }}><input type="number" value={row.requiredQty} onChange={e => updateRow(row.rowIndex, { requiredQty: parseFloat(e.target.value) || '' })} style={cellStyle(70)} /></td>
                  <td style={{ padding: '4px 6px' }}><input value={row.unit} onChange={e => updateRow(row.rowIndex, { unit: e.target.value })} style={cellStyle(60)} /></td>
                  <td style={{ padding: '4px 6px' }}><input value={row.supplier} onChange={e => updateRow(row.rowIndex, { supplier: e.target.value })} style={cellStyle(120)} /></td>
                  <td style={{ padding: '4px 6px' }}><input value={row.colourway} onChange={e => updateRow(row.rowIndex, { colourway: e.target.value })} style={cellStyle(100)} /></td>
                  <td style={{ padding: '6px 10px' }}>
                    {v.status === 'valid'
                      ? <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: T.successBg, color: T.success, border: `1px solid ${T.successBorder}` }}>✓</span>
                      : <span title={v.errors.join('; ')} style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: T.dangerBg, color: T.danger, border: `1px solid ${T.dangerBorder}`, cursor: 'help' }}>⚠ {v.errors.length}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <FlexRow justify="flex-end" gap={8}>
        <Btn disabled={validCount === 0 || submitting} onClick={handleSubmit}>
          {submitting ? 'Uploading…' : `Add ${validCount} Valid Line${validCount !== 1 ? 's' : ''}`}
        </Btn>
      </FlexRow>
    </div>
  )
}
