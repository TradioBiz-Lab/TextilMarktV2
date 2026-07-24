import { useState, useRef } from 'react'
import Papa from 'papaparse'
import { T } from '../../constants.js'
import { Btn, FlexRow, EmptyState } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'

const MFR_SPLIT_MAX = 5
const STAGE_MAX = 20
const MAX_ROWS = 100

// Turn one Papa-parsed CSV row into the panel's editable row shape.
function csvRowToStructured(raw, rowIndex) {
  const assignments = []
  for (let m = 1; m <= MFR_SPLIT_MAX; m++) {
    const code = (raw[`mfr${m}_code`] || '').trim()
    const qty = (raw[`mfr${m}_qty`] || '').trim()
    if (code || qty) assignments.push({ code, qty })
  }
  const stages = []
  for (let s = 1; s <= STAGE_MAX; s++) {
    const name = (raw[`stage${s}_name`] || '').trim()
    if (!name) continue
    const startDate = (raw[`stage${s}_start_date`] || '').trim()
    const endDate = (raw[`stage${s}_end_date`] || '').trim()
    const responsibleEmail = (raw[`stage${s}_responsible_email`] || '').trim()
    const description = (raw[`stage${s}_description`] || '').trim()
    const targetQty = (raw[`stage${s}_target_qty`] || '').trim()
    stages.push({ name, startDate, endDate, responsibleEmail, description, targetQty })
  }
  return {
    rowIndex,
    product: (raw.product || '').trim(),
    category: (raw.category || '').trim(),
    season: (raw.season || '').trim(),
    totalQty: raw.total_qty ? parseInt(raw.total_qty, 10) : '',
    delivery: (raw.delivery || '').trim(),
    assignments,
    stages,
    orderId: (raw.order_id || '').trim(),
  }
}

// Re-derived fresh on every render from the current row state — no separate
// "validated" copy to keep in sync as the admin edits fields inline.
function validateRow(row, mfrUsers, responsibleUsers) {
  const errors = []
  if (!row.product.trim()) errors.push('Product name is required')
  if (!row.totalQty || row.totalQty < 1) errors.push('Total quantity must be a positive number')
  if (!row.delivery || isNaN(new Date(row.delivery).getTime())) errors.push('Delivery date is missing or invalid')

  const filledAssignments = row.assignments.filter(a => a.code.trim() || String(a.qty).trim())
  if (filledAssignments.length === 0) errors.push('At least one manufacturer split is required')
  const resolvedAssignments = []
  filledAssignments.forEach(a => {
    const code = a.code.trim()
    const qty = parseInt(a.qty, 10)
    if (!code) { errors.push('A manufacturer quantity was given without a code'); return }
    if (!qty || qty < 1) { errors.push(`Quantity for "${code}" must be a positive number`); return }
    const mfrUser = mfrUsers.find(u => u.code === code)
    if (!mfrUser) { errors.push(`Unknown manufacturer code "${code}"`); return }
    resolvedAssignments.push({ code, mid: mfrUser.id, qty })
  })
  const assignedTotal = resolvedAssignments.reduce((s, a) => s + a.qty, 0)
  if (resolvedAssignments.length > 0 && row.totalQty && assignedTotal !== row.totalQty) {
    errors.push(`Manufacturer quantities (${assignedTotal}) must sum to total quantity (${row.totalQty})`)
  }

  const filledStages = row.stages.filter(s => s.name.trim())
  filledStages.forEach(s => {
    if (!s.startDate.trim()) errors.push(`Stage "${s.name}" is missing a start date`)
    else if (s.startDate !== 'NA' && isNaN(new Date(s.startDate).getTime())) errors.push(`Stage "${s.name}" has an invalid start date`)
    if (!s.endDate.trim()) errors.push(`Stage "${s.name}" is missing an end date`)
    else if (s.endDate !== 'NA' && isNaN(new Date(s.endDate).getTime())) errors.push(`Stage "${s.name}" has an invalid end date`)
    if (s.startDate.trim() && s.endDate.trim() && s.startDate !== 'NA' && s.endDate !== 'NA'
        && new Date(s.startDate) > new Date(s.endDate)) {
      errors.push(`Stage "${s.name}" — start date must be on or before its end date`)
    }
    s.resolvedResponsibleId = null
    if (s.responsibleEmail?.trim()) {
      const match = responsibleUsers.find(u => u.email?.toLowerCase() === s.responsibleEmail.trim().toLowerCase())
      if (!match) errors.push(`Stage "${s.name}" — unknown responsible person email "${s.responsibleEmail}"`)
      else s.resolvedResponsibleId = match.id
    }
    if (s.description?.length > 1000) errors.push(`Stage "${s.name}" — description is too long (max 1000 characters)`)
    if (s.targetQty?.trim()) {
      const q = parseInt(s.targetQty, 10)
      if (isNaN(q) || q < 1) errors.push(`Stage "${s.name}" — target quantity must be a positive number`)
    }
  })
  if (filledStages.length === 0) errors.push('At least one production stage with start/end dates is required')

  return { errors, status: errors.length ? 'error' : 'valid', resolvedAssignments, filledStages }
}

export function BulkUploadCsvPanel({ masterOrder, onDone }) {
  const { users, bulkCreateOrders } = useApp()
  const mfrUsers = users.filter(u => u.role === 'manufacturer' && u.isActive)
  const responsibleUsers = users.filter(u => (u.role === 'admin' || u.role === 'manufacturer') && u.isActive)
  const fileInputRef = useRef(null)
  const [rows, setRows] = useState([])
  const [fileName, setFileName] = useState('')
  const [parseErr, setParseErr] = useState('')
  const [expandedRow, setExpandedRow] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [results, setResults] = useState(null)

  const updateRow = (rowIndex, patch) => setRows(prev => prev.map(r => r.rowIndex === rowIndex ? { ...r, ...patch } : r))
  const updateAssignment = (rowIndex, ai, patch) => setRows(prev => prev.map(r => r.rowIndex === rowIndex ? { ...r, assignments: r.assignments.map((a, i) => i === ai ? { ...a, ...patch } : a) } : r))
  const updateStage = (rowIndex, si, patch) => setRows(prev => prev.map(r => r.rowIndex === rowIndex ? { ...r, stages: r.stages.map((s, i) => i === si ? { ...s, ...patch } : s) } : r))

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
          setParseErr(`Too many rows (${structured.length}) — max ${MAX_ROWS} per bulk upload. Split into multiple files.`)
          setRows([])
          return
        }
        if (structured.length === 0) {
          setParseErr('No rows found in this CSV')
        }
        setRows(structured)
      },
    })
  }

  const validated = rows.map(row => ({ row, v: validateRow(row, mfrUsers, responsibleUsers) }))
  const validCount = validated.filter(x => x.v.status === 'valid').length

  const handleSubmit = async () => {
    const validRows = validated.filter(x => x.v.status === 'valid')
    if (validRows.length === 0) return
    setSubmitting(true)
    try {
      const payloadRows = validRows.map(({ row, v }) => ({
        product: row.product,
        category: row.category || undefined,
        season: row.season || masterOrder.season || undefined,
        totalQty: row.totalQty,
        delivery: row.delivery,
        assignments: v.resolvedAssignments.map(a => ({ mid: a.mid, qty: a.qty })),
        stageNames: v.filledStages.map(s => s.name),
        stageStartDates: v.filledStages.map(s => s.startDate),
        stageEtas: v.filledStages.map(s => s.endDate),
        stageResponsibleIds: v.filledStages.map(s => s.resolvedResponsibleId || null),
        stageDescriptions: v.filledStages.map(s => s.description || ''),
        stageTotalUnits: v.filledStages.map(s => s.targetQty?.trim() ? parseInt(s.targetQty, 10) : null),
        orderId: row.orderId || undefined,
      }))
      const result = await bulkCreateOrders(masterOrder.id, payloadRows)
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
            {results.created} of {results.total} orders created{results.failed > 0 ? `, ${results.failed} failed` : ''}
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
          <div style={{ fontSize: 26, marginBottom: 6 }}>📄</div>
          <div style={{ fontWeight: 600, color: T.textMuted }}>Click to upload a CSV, or drag & drop</div>
          {fileName && <div style={{ fontSize: 12, color: T.primary, marginTop: 6, fontWeight: 600 }}>{fileName} — {rows.length} row{rows.length !== 1 ? 's' : ''} parsed</div>}
        </div>
        <input ref={fileInputRef} type="file" accept=".csv" style={{ display: 'none' }}
          onChange={e => e.target.files[0] && handleFile(e.target.files[0])} />
        <FlexRow justify="space-between" style={{ marginTop: 8 }}>
          <a href="/templates/tna-bulk-upload-template.csv" download style={{ fontSize: 12, color: T.primary, fontWeight: 600 }}>⬇ Download CSV Template</a>
          {rows.length > 0 && <span style={{ fontSize: 12, color: T.textMuted }}>{validCount} valid · {rows.length - validCount} with errors</span>}
        </FlexRow>
      </div>

      {parseErr && <div style={{ fontSize: 12, color: T.danger, fontWeight: 600, background: T.dangerBg, border: `1px solid ${T.dangerBorder}`, borderRadius: 8, padding: '8px 12px' }}>⚠ {parseErr}</div>}

      {rows.length === 0 && !parseErr && (
        <EmptyState icon="📄" title="No CSV uploaded yet" desc="Download the template, fill in your products, and upload it here" />
      )}

      {rows.length > 0 && (
        <div style={{ border: `1px solid ${T.border}`, borderRadius: 10, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#f8fafc' }}>
                {['#', 'Product', 'Qty', 'Manufacturer split', 'Stages', 'Status'].map(h => (
                  <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontSize: 10, fontWeight: 800, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {validated.flatMap(({ row, v }) => {
                const isOpen = expandedRow === row.rowIndex
                const mainRow = (
                  <tr key={`r${row.rowIndex}`} onClick={() => setExpandedRow(isOpen ? null : row.rowIndex)}
                    style={{ borderTop: `1px solid ${T.border}`, cursor: 'pointer', background: isOpen ? '#f8fafc' : 'transparent' }}>
                    <td style={{ padding: '9px 12px', fontSize: 12, color: T.textMuted }}>{row.rowIndex + 1}</td>
                    <td style={{ padding: '9px 12px', fontSize: 13, fontWeight: 600, color: T.text }}>{row.product || '—'}</td>
                    <td style={{ padding: '9px 12px', fontSize: 12, color: T.textMuted }}>{row.totalQty || '—'}</td>
                    <td style={{ padding: '9px 12px', fontSize: 12, color: T.textMuted }}>{row.assignments.map(a => `${a.code}:${a.qty}`).join(', ') || '—'}</td>
                    <td style={{ padding: '9px 12px', fontSize: 12, color: T.textMuted }}>{row.stages.length}</td>
                    <td style={{ padding: '9px 12px' }}>
                      {v.status === 'valid'
                        ? <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: T.successBg, color: T.success, border: `1px solid ${T.successBorder}` }}>✓ Valid</span>
                        : <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: T.dangerBg, color: T.danger, border: `1px solid ${T.dangerBorder}` }}>⚠ {v.errors.length} issue{v.errors.length !== 1 ? 's' : ''}</span>}
                    </td>
                  </tr>
                )
                if (!isOpen) return [mainRow]
                const detailRow = (
                  <tr key={`d${row.rowIndex}`} style={{ borderTop: `1px solid ${T.border}` }}>
                    <td colSpan={6} style={{ padding: '14px 16px', background: '#fafbfc' }}>
                      {v.errors.length > 0 && (
                        <div style={{ marginBottom: 10, display: 'flex', flexDirection: 'column', gap: 3 }}>
                          {v.errors.map((e, i) => <div key={i} style={{ fontSize: 12, color: T.danger }}>⚠ {e}</div>)}
                        </div>
                      )}
                      <div className="form-grid-3" style={{ marginBottom: 10 }}>
                        <div>
                          <label style={{ fontSize: 10, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase' }}>Product</label>
                          <input value={row.product} onChange={e => updateRow(row.rowIndex, { product: e.target.value })}
                            style={{ width: '100%', border: `1px solid ${T.border}`, borderRadius: 6, padding: '6px 8px', fontSize: 12, fontFamily: 'inherit', boxSizing: 'border-box' }} />
                        </div>
                        <div>
                          <label style={{ fontSize: 10, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase' }}>Total Qty</label>
                          <input type="number" value={row.totalQty} onChange={e => updateRow(row.rowIndex, { totalQty: parseInt(e.target.value, 10) || '' })}
                            style={{ width: '100%', border: `1px solid ${T.border}`, borderRadius: 6, padding: '6px 8px', fontSize: 12, fontFamily: 'inherit', boxSizing: 'border-box' }} />
                        </div>
                        <div>
                          <label style={{ fontSize: 10, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase' }}>Delivery</label>
                          <input type="date" value={row.delivery} onChange={e => updateRow(row.rowIndex, { delivery: e.target.value })}
                            style={{ width: '100%', border: `1px solid ${T.border}`, borderRadius: 6, padding: '6px 8px', fontSize: 12, fontFamily: 'inherit', boxSizing: 'border-box' }} />
                        </div>
                      </div>

                      <label style={{ fontSize: 10, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase' }}>Manufacturer splits</label>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4, marginBottom: 10 }}>
                        {row.assignments.map((a, ai) => (
                          <div key={ai} style={{ display: 'flex', gap: 8 }}>
                            <input value={a.code} placeholder="Mfr code" onChange={e => updateAssignment(row.rowIndex, ai, { code: e.target.value })}
                              style={{ width: 100, border: `1px solid ${T.border}`, borderRadius: 6, padding: '6px 8px', fontSize: 12, fontFamily: 'inherit' }} />
                            <input type="number" value={a.qty} placeholder="Qty" onChange={e => updateAssignment(row.rowIndex, ai, { qty: e.target.value })}
                              style={{ width: 100, border: `1px solid ${T.border}`, borderRadius: 6, padding: '6px 8px', fontSize: 12, fontFamily: 'inherit' }} />
                          </div>
                        ))}
                      </div>

                      <label style={{ fontSize: 10, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase' }}>Stages</label>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
                        {row.stages.map((s, si) => (
                          <div key={si} style={{ border: `1px solid ${T.border}`, borderRadius: 6, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6, background: '#fff' }}>
                            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                              <span style={{ fontSize: 11, color: T.textLight, minWidth: 18 }}>{si + 1}.</span>
                              <input value={s.name} placeholder="Stage name" onChange={e => updateStage(row.rowIndex, si, { name: e.target.value })}
                                style={{ flex: 1, minWidth: 110, border: `1px solid ${T.border}`, borderRadius: 6, padding: '6px 8px', fontSize: 12, fontFamily: 'inherit' }} />
                              <input type={s.startDate === 'NA' ? 'text' : 'date'} value={s.startDate} placeholder="Start date"
                                onChange={e => updateStage(row.rowIndex, si, { startDate: e.target.value })}
                                style={{ width: 130, border: `1px solid ${!s.startDate.trim() ? T.danger : T.border}`, borderRadius: 6, padding: '6px 8px', fontSize: 12, fontFamily: 'inherit' }} />
                              <input type={s.endDate === 'NA' ? 'text' : 'date'} value={s.endDate} placeholder="End date"
                                onChange={e => updateStage(row.rowIndex, si, { endDate: e.target.value })}
                                style={{ width: 130, border: `1px solid ${!s.endDate.trim() ? T.danger : T.border}`, borderRadius: 6, padding: '6px 8px', fontSize: 12, fontFamily: 'inherit' }} />
                            </div>
                            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                              <input value={s.responsibleEmail} placeholder="Responsible email (optional)"
                                onChange={e => updateStage(row.rowIndex, si, { responsibleEmail: e.target.value })}
                                style={{ flex: 1, minWidth: 160, border: `1px solid ${T.border}`, borderRadius: 6, padding: '6px 8px', fontSize: 12, fontFamily: 'inherit' }} />
                              <input type="number" min={1} value={s.targetQty} placeholder="Target qty"
                                title="Defaults to the manufacturer's assigned quantity if left blank"
                                onChange={e => updateStage(row.rowIndex, si, { targetQty: e.target.value })}
                                style={{ width: 110, border: `1px solid ${T.border}`, borderRadius: 6, padding: '6px 8px', fontSize: 12, fontFamily: 'inherit' }} />
                            </div>
                            <input value={s.description} placeholder="Description (optional) — what this stage involves"
                              onChange={e => updateStage(row.rowIndex, si, { description: e.target.value })}
                              style={{ width: '100%', border: `1px solid ${T.border}`, borderRadius: 6, padding: '6px 8px', fontSize: 12, fontFamily: 'inherit', boxSizing: 'border-box' }} />
                          </div>
                        ))}
                      </div>
                    </td>
                  </tr>
                )
                return [mainRow, detailRow]
              })}
            </tbody>
          </table>
        </div>
      )}

      <FlexRow justify="flex-end" gap={8}>
        <Btn disabled={validCount === 0 || submitting} onClick={handleSubmit}>
          {submitting ? 'Creating…' : `Create ${validCount} Valid Order${validCount !== 1 ? 's' : ''}`}
        </Btn>
      </FlexRow>
    </div>
  )
}
