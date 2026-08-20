import { useState, useMemo, useRef } from 'react'
import Papa from 'papaparse'
import { FileText, BarChart3 } from 'lucide-react'
import { T } from '../../constants.js'
import { Btn, FlexRow, EmptyState } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'

// Imports the team's own "Summary TNA" sheet shape — steps down the rows, one
// Start/End column pair per style — and pushes the revised dates back onto the
// matching orders. This is the re-sync path: the plan gets reworked in Excel,
// this brings it back in rather than making someone retype 16 steps × 6 styles.
//
// Expected CSV (save the Summary TNA sheet as CSV):
//
//   Step,A-Line Smocked Pocket Dress,,Smocked Waist Top,,       <- product names, blank over the End column
//   ,Start,End,Start,End,                                       <- the Start/End markers
//   Style No,4702,,4706,,                                       <- ignored
//   Trims Order,14-Jul-2026,14-Jul-2026,14-Jul-2026,14-Jul-2026 <- a step row
//
// Rows whose first cell doesn't match a stage name on that order are reported,
// never silently dropped.

const MAX_CELLS = 2000

// Accepts 14-Jul-2026, 14/07/2026, 2026-07-14, and the literal NA.
function parseDate(raw) {
  const v = String(raw ?? '').trim()
  if (!v) return { empty: true }
  if (/^na$/i.test(v)) return { value: 'NA' }
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return { value: v }
  const m = /^(\d{1,2})[-/ ]([A-Za-z]{3,})[-/ ](\d{4})$/.exec(v)
  if (m) {
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
    const mi = months.indexOf(m[2].slice(0, 3).toLowerCase())
    if (mi >= 0) return { value: `${m[3]}-${String(mi + 1).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}` }
  }
  const n = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(v)  // dd-mm-yyyy
  if (n) return { value: `${n[3]}-${String(n[2]).padStart(2, '0')}-${String(n[1]).padStart(2, '0')}` }
  const d = new Date(v)
  if (!isNaN(d.getTime())) return { value: d.toISOString().slice(0, 10) }
  return { error: `"${v}" isn't a date` }
}

const fmt = d => (!d || d === 'NA') ? (d || '—') : d.split('-').reverse().join('-')

export function TnaImportPanel({ onClose }) {
  const { orders, bulkUpdateStages } = useApp()
  const [parseErr, setParseErr] = useState('')
  const [columns, setColumns] = useState([])   // one per style column found
  const [fileName, setFileName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [results, setResults] = useState(null)
  const fileRef = useRef(null)

  const handleFile = e => {
    const file = e.target.files?.[0]
    if (!file) return
    setFileName(file.name)
    setParseErr('')
    setResults(null)
    Papa.parse(file, {
      skipEmptyLines: 'greedy',
      complete: res => {
        try {
          setColumns(buildColumns(res.data))
        } catch (err) {
          setParseErr(err.message)
          setColumns([])
        }
      },
      error: err => setParseErr(`Could not read the file: ${err.message}`),
    })
  }

  // Turn the wide sheet into one entry per style column, each carrying its
  // matched order and the step changes found for it.
  function buildColumns(grid) {
    if (!grid || grid.length < 3) throw new Error('That file has too few rows to be a Summary TNA sheet')
    const nameRow = grid[0]
    const markerRow = grid[1]

    // Pair up columns by the Start/End markers, attributing each pair to the
    // nearest product name at or before the Start column.
    const pairs = []
    let currentName = ''
    for (let c = 1; c < markerRow.length; c++) {
      if (String(nameRow[c] ?? '').trim()) currentName = String(nameRow[c]).trim()
      if (/^start$/i.test(String(markerRow[c] ?? '').trim())) {
        const endCol = /^end$/i.test(String(markerRow[c + 1] ?? '').trim()) ? c + 1 : null
        if (currentName) pairs.push({ product: currentName, startCol: c, endCol })
      }
    }
    if (pairs.length === 0) {
      throw new Error('No "Start"/"End" column pair found on row 2 — is this the Summary TNA sheet?')
    }

    const dataRows = grid.slice(2).filter(r => String(r[0] ?? '').trim())
    if (dataRows.length * pairs.length > MAX_CELLS) throw new Error('That sheet is too large to import in one go')

    return pairs.map(p => {
      // Match on product name; the order must already exist (this updates a plan,
      // it doesn't create orders — use Bulk Upload for that).
      const norm = s => String(s || '').toLowerCase().replace(/\s*\(style[^)]*\)\s*/gi, '').replace(/[^a-z0-9]/g, '')
      const match = (orders || []).find(o => norm(o.product) === norm(p.product))
        || (orders || []).find(o => norm(o.product).startsWith(norm(p.product)) || norm(p.product).startsWith(norm(o.product)))

      const col = { product: p.product, order: match || null, asgn: null, changes: [], skipped: [] }
      if (!match) {
        col.error = `No order found with a product name matching "${p.product}"`
        return col
      }
      col.asgn = (match.assignments || [])[0] || null
      if (!col.asgn) { col.error = 'That order has no manufacturer assignment'; return col }

      for (const row of dataRows) {
        const stepName = String(row[0]).trim()
        const si = (col.asgn.stages || []).findIndex(s => s.name.trim().toLowerCase() === stepName.toLowerCase())
        if (si === -1) { col.skipped.push(stepName); continue }
        const stage = col.asgn.stages[si]

        const sd = parseDate(row[p.startCol])
        const ed = p.endCol != null ? parseDate(row[p.endCol]) : { empty: true }
        if (sd.error || ed.error) { col.skipped.push(`${stepName} — ${sd.error || ed.error}`); continue }
        if (sd.empty && ed.empty) continue

        const patch = { index: si }
        let changed = false
        if (!sd.empty && sd.value !== stage.startDate) { patch.startDate = sd.value; changed = true }
        if (!ed.empty && ed.value !== stage.eta) { patch.eta = ed.value; changed = true }
        if (!changed) continue

        // Mirror the server's intra-stage rule so bad pairs are caught in preview.
        const effStart = patch.startDate ?? stage.startDate
        const effEnd = patch.eta ?? stage.eta
        if (effStart && effEnd && effStart !== 'NA' && effEnd !== 'NA' && new Date(effStart) > new Date(effEnd)) {
          col.skipped.push(`${stepName} — start would be after end`)
          continue
        }
        col.changes.push({ stepName, patch, was: { startDate: stage.startDate, eta: stage.eta } })
      }
      return col
    })
  }

  const totals = useMemo(() => ({
    matched: columns.filter(c => c.order).length,
    unmatched: columns.filter(c => !c.order).length,
    changes: columns.reduce((n, c) => n + c.changes.length, 0),
    skipped: columns.reduce((n, c) => n + c.skipped.length, 0),
  }), [columns])

  const submit = async () => {
    setSubmitting(true)
    const out = { updated: 0, failed: 0, errors: [] }
    try {
      for (const c of columns) {
        if (!c.order || c.changes.length === 0) continue
        try {
          await bulkUpdateStages(c.order.id, c.asgn.mid, c.changes.map(ch => ch.patch))
          out.updated += c.changes.length
        } catch (err) {
          out.failed += c.changes.length
          out.errors.push(`${c.product}: ${err?.message || 'failed'}`)
        }
      }
      setResults(out)
    } finally {
      setSubmitting(false)
    }
  }

  if (results) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ background: results.failed === 0 ? T.successBg : T.warningBg, border: `1px solid ${results.failed === 0 ? T.successBorder : T.warningBorder}`, borderRadius: 10, padding: '14px 16px' }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: results.failed === 0 ? T.success : T.warning }}>
            {results.updated} step date{results.updated !== 1 ? 's' : ''} updated{results.failed ? `, ${results.failed} failed` : ''}
          </div>
        </div>
        {results.errors.map((e, i) => (
          <div key={i} style={{ fontSize: 12, color: T.danger, background: T.dangerBg, borderRadius: 8, padding: '8px 12px' }}>{e}</div>
        ))}
        <FlexRow justify="flex-end"><Btn onClick={onClose}>Done</Btn></FlexRow>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ fontSize: 12, color: T.textMuted, lineHeight: 1.6 }}>
        Save the <b>Summary TNA</b> sheet as CSV and drop it here. Steps down the rows, a
        <b> Start</b>/<b>End</b> column pair per style. Styles are matched to existing orders by
        product name, steps by step name — this updates dates on orders that already exist, it
        doesn't create them.
      </div>

      <FlexRow gap={10}>
        <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={handleFile} style={{ display: 'none' }} />
        <Btn variant="secondary" icon={<FileText size={14} />} onClick={() => fileRef.current?.click()}>Choose CSV</Btn>
        {fileName && <span style={{ fontSize: 12, color: T.textMuted }}>{fileName}</span>}
      </FlexRow>

      {parseErr && (
        <div style={{ background: T.dangerBg, border: `1px solid ${T.dangerBorder}`, borderRadius: 8, padding: '10px 14px', fontSize: 12, color: T.danger }}>{parseErr}</div>
      )}

      {columns.length === 0 && !parseErr && (
        <EmptyState icon={<BarChart3 size={26} color={T.textLight} />} title="No file loaded" desc="Choose a Summary TNA CSV to preview the changes." />
      )}

      {columns.length > 0 && (
        <>
          <FlexRow gap={14} style={{ flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, color: T.success, fontWeight: 700 }}>{totals.matched} style{totals.matched !== 1 ? 's' : ''} matched</span>
            {totals.unmatched > 0 && <span style={{ fontSize: 12, color: T.danger, fontWeight: 700 }}>{totals.unmatched} unmatched</span>}
            <span style={{ fontSize: 12, color: T.primary, fontWeight: 700 }}>{totals.changes} date change{totals.changes !== 1 ? 's' : ''}</span>
            {totals.skipped > 0 && <span style={{ fontSize: 12, color: T.warning, fontWeight: 700 }}>{totals.skipped} row{totals.skipped !== 1 ? 's' : ''} skipped</span>}
          </FlexRow>

          <div style={{ maxHeight: 420, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {columns.map((c, i) => (
              <div key={i} style={{ border: `1px solid ${c.error ? T.dangerBorder : T.border}`, borderRadius: 10, padding: '10px 14px', background: c.error ? T.dangerBg : T.surface }}>
                <FlexRow gap={8} style={{ marginBottom: c.changes.length || c.skipped.length ? 8 : 0 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{c.product}</span>
                  {c.order
                    ? <span style={{ fontSize: 10, color: T.textMuted, fontFamily: "'JetBrains Mono',monospace" }}>→ {c.order.id}</span>
                    : <span style={{ fontSize: 11, color: T.danger }}>{c.error}</span>}
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: T.textMuted }}>
                    {c.changes.length} change{c.changes.length !== 1 ? 's' : ''}
                  </span>
                </FlexRow>

                {c.changes.map((ch, j) => (
                  <div key={j} style={{ fontSize: 11, color: T.text, padding: '3px 0', borderTop: `1px solid ${T.border}` }}>
                    <b>{ch.stepName}</b>{' '}
                    {ch.patch.startDate && <span style={{ color: T.textMuted }}>start {fmt(ch.was.startDate)} → <b style={{ color: T.primary }}>{fmt(ch.patch.startDate)}</b>{' '}</span>}
                    {ch.patch.eta && <span style={{ color: T.textMuted }}>end {fmt(ch.was.eta)} → <b style={{ color: T.primary }}>{fmt(ch.patch.eta)}</b></span>}
                  </div>
                ))}

                {c.skipped.length > 0 && (
                  <div style={{ fontSize: 10, color: T.warning, marginTop: 6 }}>
                    Skipped: {c.skipped.slice(0, 6).join(', ')}{c.skipped.length > 6 ? ` +${c.skipped.length - 6} more` : ''}
                  </div>
                )}
              </div>
            ))}
          </div>

          <FlexRow justify="flex-end" gap={8}>
            <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
            <Btn disabled={submitting || totals.changes === 0} onClick={submit}>
              {submitting ? 'Applying…' : `Apply ${totals.changes} change${totals.changes !== 1 ? 's' : ''}`}
            </Btn>
          </FlexRow>
        </>
      )}
    </div>
  )
}
