import { useState, useRef } from 'react'
import { UploadCloud, CheckCircle2, AlertTriangle } from '../../icons.jsx'
import { T } from '../../constants.js'
import { Modal, Btn, Alert, Select, SectionLabel, activateOnKey } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'
import { PARTNER_TYPES } from '../../partners.js'

// Import partners from a CSV in four steps: choose the file (the server reads it), match its columns to partner
// fields (the first five rows are shown, with the best guess already filled in), check it (a dry run that writes
// nothing and reports each problem row and each duplicate name), then import what passed.

const th = { textAlign: 'left', padding: '6px 8px', fontSize: 11, fontWeight: 700, color: T.textMuted, background: '#f8fafc', borderBottom: `1px solid ${T.border}`, whiteSpace: 'nowrap', verticalAlign: 'bottom' }
const td = { padding: '5px 8px', fontSize: 12, color: T.text, borderBottom: `1px solid ${T.border}`, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

export function PartnerCsvImportModal({ onClose, onDone }) {
  const { previewPartnerCsv, importPartners } = useApp()
  const [step, setStep] = useState('file') // file | map | check | done
  const [file, setFile] = useState(null)
  const [data, setData] = useState(null)   // the server's reading of the file
  const [mapping, setMapping] = useState({})
  const [defaultType, setDefaultType] = useState('unknown')
  const [report, setReport] = useState(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [drag, setDrag] = useState(false)
  const input = useRef(null)

  const read = async f => {
    if (!f) return
    if (!/\.csv$/i.test(f.name) && !/csv|text\/plain|excel/.test(f.type)) { setErr('Choose a .csv file. In Excel or Sheets use Save as, CSV.'); return }
    if (f.size > 2_000_000) { setErr('That file is over 2 MB. Split it into smaller files.'); return }
    setBusy(true); setErr(''); setFile(f)
    try {
      const d = await previewPartnerCsv(await f.text())
      setData(d); setMapping(d.suggestedMapping); setStep('map')
    } catch (e) { setErr(e?.message || 'Could not read the file') } finally { setBusy(false) }
  }

  const mapped = Object.values(mapping).filter(Boolean)
  const nameMapped = mapped.includes('name')
  const typeMapped = mapped.includes('type')
  // A field can be filled from one column only, except the ones that gather several (notes, keywords, products).
  const MANY = new Set(['notes', 'keywords', 'categories', 'products', 'fabrics', 'fabricTypes', 'trimCategories'])
  const dupes = [...new Set(mapped.filter((k, i) => !MANY.has(k) && mapped.indexOf(k) !== i))]

  const payload = dryRun => ({ rows: data.rows, mapping, defaultType, dryRun })
  const check = async () => {
    setBusy(true); setErr('')
    try { setReport(await importPartners(payload(true))); setStep('check') } catch (e) { setErr(e?.message || 'Could not check the file') } finally { setBusy(false) }
  }
  const run = async () => {
    setBusy(true); setErr('')
    try { const r = await importPartners(payload(false)); setReport(r); setStep('done') } catch (e) { setErr(e?.message || 'The import failed') } finally { setBusy(false) }
  }

  const reasonText = s => (s.reason === 'duplicate_existing' ? 'already in the directory' : `same name as row ${s.firstRow} of this file`)

  return (
    <Modal title="Import partners from CSV" subtitle={step === 'file' ? 'The first row of the file must be the column headings.' : file?.name} size="xxl" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {err && <Alert type="danger">{err}</Alert>}

        {step === 'file' && (
          <>
            <div role="button" tabIndex={0} onClick={() => input.current?.click()} onKeyDown={activateOnKey(() => input.current?.click())}
              onDragOver={e => { e.preventDefault(); setDrag(true) }} onDragLeave={() => setDrag(false)}
              onDrop={e => { e.preventDefault(); setDrag(false); read(e.dataTransfer.files[0]) }}
              style={{ border: `2px dashed ${drag ? T.primary : T.border}`, borderRadius: 12, padding: 36, textAlign: 'center', cursor: 'pointer', background: drag ? T.primaryLight : '#fafbff' }}>
              <UploadCloud size={30} color={drag ? T.primary : T.textLight} />
              <div style={{ fontWeight: 700, color: T.textMuted, marginTop: 8 }}>{busy ? 'Reading the file…' : 'Click to choose a CSV, or drop it here'}</div>
              <div style={{ fontSize: 12, color: T.textLight, marginTop: 4 }}>Up to 1,000 rows and 2 MB. Names already in the directory are skipped, whatever their capitalisation.</div>
            </div>
            <input ref={input} type="file" accept=".csv,text/csv" style={{ display: 'none' }} onChange={e => { const f = e.target.files[0]; e.target.value = ''; read(f) }} />
          </>
        )}

        {step === 'map' && data && (
          <>
            <div style={{ fontSize: 13, color: T.textMuted }}>{data.rowCount} row{data.rowCount === 1 ? '' : 's'} found. Check which partner field each column fills; the best guess is already chosen. Columns set to "Ignore" are skipped.</div>
            <div style={{ overflowX: 'auto', border: `1px solid ${T.border}`, borderRadius: 10 }}>
              <table style={{ borderCollapse: 'collapse', minWidth: '100%' }}>
                <thead>
                  <tr>{data.headers.map(h => <th key={h} style={th}>{h}</th>)}</tr>
                  <tr>{data.headers.map(h => (
                    <th key={h} style={{ ...th, background: '#fff', paddingBottom: 8, minWidth: 170 }}>
                      <Select aria-label={`Field for ${h}`} value={mapping[h] || ''} onChange={e => setMapping(m => ({ ...m, [h]: e.target.value || null }))}>
                        <option value="">Ignore</option>
                        {data.fields.map(fl => <option key={fl.key} value={fl.key}>{fl.label}</option>)}
                      </Select>
                    </th>
                  ))}</tr>
                </thead>
                <tbody>
                  {data.preview.map((r, i) => <tr key={i}>{data.headers.map(h => <td key={h} style={td} title={r[h]}>{r[h]}</td>)}</tr>)}
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: 12, color: T.textLight }}>Showing the first {data.preview.length} of {data.rowCount} rows.</div>
            {!nameMapped && <Alert type="warning">Choose which column holds the partner's name.</Alert>}
            {dupes.length > 0 && <Alert type="warning">More than one column is set to the same field ({dupes.join(', ')}). Only the first is used.</Alert>}
            {!typeMapped && (
              <div style={{ maxWidth: 320 }}>
                <Select label="No type column: use this type for every row" value={defaultType} onChange={e => setDefaultType(e.target.value)}>
                  {PARTNER_TYPES.map(t => <option key={t.v} value={t.v}>{t.label}</option>)}
                </Select>
              </div>
            )}
          </>
        )}

        {(step === 'check' || step === 'done') && report && (
          <>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {[
                [step === 'done' ? 'Imported' : 'Will import', step === 'done' ? report.created : report.wouldCreate, T.successDeep, T.successBg],
                ['Duplicate names', report.skipped.length, '#92400e', '#fef3c7'],
                ['Rows with problems', report.errors.length, T.dangerDeep, T.dangerBg],
              ].map(([l, n, fg, bg]) => (
                <div key={l} style={{ background: bg, color: fg, borderRadius: 10, padding: '10px 16px', minWidth: 130 }}>
                  <div style={{ fontSize: 22, fontWeight: 800 }}>{n}</div>
                  <div style={{ fontSize: 12, fontWeight: 700 }}>{l}</div>
                </div>
              ))}
            </div>
            {step === 'done' && <Alert type="success">The import is finished. It is recorded in the Audit Log.</Alert>}
            {report.errors.length > 0 && (
              <div>
                <SectionLabel>Rows with problems (not imported)</SectionLabel>
                <div style={{ maxHeight: 200, overflowY: 'auto', border: `1px solid ${T.border}`, borderRadius: 10 }}>
                  <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                    <thead><tr><th style={th}>Row</th><th style={th}>Name</th><th style={th}>Problem</th></tr></thead>
                    <tbody>{report.errors.map(e => (
                      <tr key={e.row}><td style={td}>{e.row}</td><td style={td}>{e.name || '(no name)'}</td><td style={{ ...td, whiteSpace: 'normal', color: T.dangerDeep }}>{e.errors.join('. ')}</td></tr>
                    ))}</tbody>
                  </table>
                </div>
              </div>
            )}
            {report.skipped.length > 0 && (
              <div>
                <SectionLabel>Skipped as duplicates</SectionLabel>
                <div style={{ maxHeight: 160, overflowY: 'auto', border: `1px solid ${T.border}`, borderRadius: 10 }}>
                  <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                    <thead><tr><th style={th}>Row</th><th style={th}>Name</th><th style={th}>Why</th></tr></thead>
                    <tbody>{report.skipped.map(s => (
                      <tr key={s.row}><td style={td}>{s.row}</td><td style={td}>{s.name}</td><td style={{ ...td, whiteSpace: 'normal' }}>{reasonText(s)}</td></tr>
                    ))}</tbody>
                  </table>
                </div>
              </div>
            )}
            {step === 'check' && report.wouldCreate === 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: T.textMuted }}><AlertTriangle size={14} />Nothing new would be imported.</div>
            )}
            {step === 'check' && report.wouldCreate > 0 && report.errors.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: T.textMuted }}><CheckCircle2 size={14} />Rows with problems are left out. Fix them in the file and import again; the ones that passed will not be added twice.</div>
            )}
          </>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          {step === 'map' && <><Btn variant="secondary" onClick={() => { setStep('file'); setData(null); setErr('') }}>Choose another file</Btn><Btn onClick={check} disabled={busy || !nameMapped}>{busy ? 'Checking…' : 'Check the file'}</Btn></>}
          {step === 'check' && <><Btn variant="secondary" onClick={() => { setStep('map'); setErr('') }}>Back to columns</Btn><Btn onClick={run} disabled={busy || report.wouldCreate === 0}>{busy ? 'Importing…' : `Import ${report.wouldCreate} partner${report.wouldCreate === 1 ? '' : 's'}`}</Btn></>}
          {step === 'done' && <Btn onClick={() => onDone(report)}>Done</Btn>}
          {step === 'file' && <Btn variant="secondary" onClick={onClose}>Cancel</Btn>}
        </div>
      </div>
    </Modal>
  )
}
