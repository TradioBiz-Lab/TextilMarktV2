import { useRef, useState } from 'react'
import { Download, FileSpreadsheet, Upload } from '../icons.jsx'
import { T } from '../constants.js'
import { Modal, Btn, Alert, FlexRow } from './ui.jsx'
import { readSheetFile, mapRows, downloadTemplate } from '../lib/excelIO.js'

/**
 * Bring many rows in from a spreadsheet, the way a factory already keeps them: download the template,
 * fill it in Excel, upload it, check what will be imported, import.
 *
 *   columns      the sheet's columns (see lib/excelIO.js)
 *   example      one example row (an object keyed by column key) for the template
 *   noun         "suppliers", "items": what is being imported
 *   toPayload    (row) => the object the API takes (the row's keys are the columns' keys)
 *   onImport     async (payloads) => { created, skipped: [{ row, name, error }] }, the API's own answer
 *   onDone       called after an import that created something
 */
export function SpreadsheetImport({ title, noun, columns, example, templateName, toPayload = r => r, onImport, onDone, onClose }) {
  const [file, setFile] = useState(null)
  const [fileErr, setFileErr] = useState('')
  const [parsed, setParsed] = useState(null)      // { rows, errors, missingColumns }
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)      // the API's answer
  const [failure, setFailure] = useState('')
  const [drag, setDrag] = useState(false)
  const input = useRef(null)

  const choose = async picked => {
    setFile(picked || null); setFileErr(''); setParsed(null); setResult(null); setFailure('')
    if (!picked) return
    try { setParsed(mapRows(await readSheetFile(picked), columns)) }
    catch (e) { setFileErr(e?.message || 'That file could not be read'); setParsed(null) }
  }

  const rowOk = r => !parsed.errors.some(e => e.row === r._row)
  const good = parsed ? parsed.rows.filter(rowOk) : []
  const bad = parsed ? parsed.rows.length - good.length : 0

  const run = async () => {
    setBusy(true); setFailure('')
    try {
      const answer = await onImport(good.map(r => toPayload(r)))
      setResult(answer)
      if (answer.created) onDone?.(answer)
    } catch (e) { setFailure(e?.message || 'The import failed') } finally { setBusy(false) }
  }

  return (
    <Modal title={title} subtitle={`Add many ${noun} at once from an Excel or CSV file`} onClose={() => !busy && onClose()} size="lg">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '12px 14px', background: T.bg, border: `1px solid ${T.border}`, borderRadius: 10 }}>
          <FileSpreadsheet size={20} color={T.textMuted} />
          <div style={{ flex: 1, minWidth: 180, fontSize: 13, color: T.textMuted, lineHeight: 1.5 }}>Start from the template, so the columns are right. Fill one {noun.replace(/s$/, '')} per row.</div>
          <Btn variant="secondary" size="sm" icon={<Download size={13} />} onClick={() => downloadTemplate({ filename: templateName, sheetName: noun, columns, example })}>Download template</Btn>
        </div>

        {!result && (
          <div>
            <div role="button" tabIndex={0} onClick={() => input.current?.click()} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.current?.click() } }}
              onDragOver={e => { e.preventDefault(); setDrag(true) }} onDragLeave={() => setDrag(false)}
              onDrop={e => { e.preventDefault(); setDrag(false); choose(e.dataTransfer.files[0]) }}
              style={{ border: `2px dashed ${drag ? T.primary : fileErr ? T.danger : T.border}`, borderRadius: 10, padding: '22px 16px', textAlign: 'center', cursor: 'pointer', background: drag ? T.primaryLight : '#fafbff' }}>
              <Upload size={24} color={T.textLight} style={{ marginBottom: 6 }} />
              <div style={{ fontWeight: 600, color: T.textMuted }}>{file ? file.name : 'Choose your filled-in file, or drop it here'}</div>
              <div style={{ fontSize: 12, color: T.textLight, marginTop: 3 }}>Excel (.xlsx) or CSV</div>
            </div>
            <input ref={input} type="file" accept=".xlsx,.csv" style={{ display: 'none' }} onChange={e => { const f = e.target.files[0]; e.target.value = ''; choose(f) }} />
            {fileErr && <div style={{ fontSize: 12, color: T.danger, marginTop: 6 }}>{fileErr}</div>}
          </div>
        )}

        {parsed && !result && (
          <div>
            {parsed.errors.some(e => !e.key && e.row === 1) || parsed.missingColumns.length > 0 ? (
              <Alert type="danger">{parsed.errors[0]?.message || `The file is missing: ${parsed.missingColumns.join(', ')}`}</Alert>
            ) : (
              <>
                <div style={{ fontSize: 13, color: T.text, fontWeight: 600, marginBottom: 8 }}>
                  {good.length} {good.length === 1 ? noun.replace(/s$/, '') : noun} ready to import{bad ? `, ${bad} with problems (they will be left out)` : ''}.
                </div>
                {parsed.errors.length > 0 && (
                  <div style={{ maxHeight: 160, overflowY: 'auto', border: `1px solid ${T.border}`, borderRadius: 8 }}>
                    {parsed.errors.slice(0, 50).map((e, i) => (
                      <div key={i} style={{ padding: '7px 12px', fontSize: 12, color: T.danger, borderBottom: `1px solid ${T.border}` }}>Row {e.row}{e.column ? `, ${e.column}` : ''}: {e.message}</div>
                    ))}
                  </div>
                )}
                {parsed.unknownHeaders.length > 0 && <div style={{ fontSize: 12, color: T.textLight, marginTop: 8 }}>Columns that were not used: {parsed.unknownHeaders.join(', ')}</div>}
              </>
            )}
          </div>
        )}

        {result && (
          <div>
            <Alert type={result.created ? 'success' : 'warning'}>
              {result.created ? `${result.created} ${result.created === 1 ? noun.replace(/s$/, '') : noun} imported.` : 'Nothing was imported.'}
              {result.skipped?.length ? ` ${result.skipped.length} left out:` : ''}
            </Alert>
            {result.skipped?.length > 0 && (
              <div style={{ maxHeight: 160, overflowY: 'auto', border: `1px solid ${T.border}`, borderRadius: 8, marginTop: 8 }}>
                {result.skipped.map((s, i) => <div key={i} style={{ padding: '7px 12px', fontSize: 12, color: T.textMuted, borderBottom: `1px solid ${T.border}` }}>Row {s.row}{s.name ? ` (${s.name})` : ''}: {s.error}</div>)}
              </div>
            )}
          </div>
        )}

        {failure && <Alert type="danger">{failure}</Alert>}

        <FlexRow justify="flex-end" gap={8}>
          <Btn variant="secondary" onClick={onClose} disabled={busy}>{result ? 'Done' : 'Cancel'}</Btn>
          {!result && <Btn onClick={run} disabled={busy || !parsed || good.length === 0 || parsed.missingColumns.length > 0}>{busy ? 'Importing...' : `Import ${good.length || ''}`.trim()}</Btn>}
        </FlexRow>
      </div>
    </Modal>
  )
}
