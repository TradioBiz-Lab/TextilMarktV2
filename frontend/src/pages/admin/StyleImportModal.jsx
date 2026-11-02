import { useState, useEffect, useRef } from 'react'
import { AlertTriangle, Check, Download, FileSpreadsheet, UploadCloud } from '../../icons.jsx'
import { T } from '../../constants.js'
import { Btn, FlexRow, Modal } from '../../components/ui.jsx'
import { StyleImportPreview } from '../../components/StyleImportPreview.jsx'
import { useApp } from '../../context.jsx'
import { styleImportsApi } from '../../api.js'
import { SHEET_ACCEPT, downloadTemplate, readSheetFile, sheetFileProblem } from '../../styleImport.js'

// Create many styles from an Excel or CSV sheet. Pick the master order and the file; every row is checked and shown before
// anything is created. Rows already in the master order are skipped, so a second upload never makes duplicates.
// For a customer (`forReview`) the last step does not create: it sends the sheet to Tradio's master admin to approve.
export function StyleImportModal({ masterOrders, presetMasterOrderId, onClose, onNewMasterOrder, onDone, forReview = false }) {
  const { refreshOrders } = useApp()
  const [masterOrderId, setMasterOrderId] = useState(presetMasterOrderId || '')
  useEffect(() => { if (presetMasterOrderId) setMasterOrderId(presetMasterOrderId) }, [presetMasterOrderId])
  const [file, setFile] = useState(null)
  const [uploadId, setUploadId] = useState('')
  const [preview, setPreview] = useState(null)
  const [busy, setBusy] = useState('')      // 'upload' | 'preview' | 'create' | ''
  const [err, setErr] = useState('')
  const [result, setResult] = useState(null)
  const fileInput = useRef(null)

  // Check the sheet against the master order whenever either changes.
  useEffect(() => {
    if (!uploadId || !masterOrderId) { setPreview(null); return }
    let stale = false
    setBusy('preview'); setErr(''); setPreview(null)
    styleImportsApi.preview(uploadId, masterOrderId)
      .then(p => { if (!stale) setPreview(p) })
      .catch(e => { if (!stale) setErr(e?.message || 'Could not read that file.') })
      .finally(() => { if (!stale) setBusy('') })
    return () => { stale = true }
  }, [uploadId, masterOrderId])

  const choose = async f => {
    if (!f) return
    const problem = sheetFileProblem(f)
    if (problem) { setErr(problem); return }
    setBusy('upload'); setErr(''); setPreview(null); setUploadId('')
    try {
      const { filename, data } = await readSheetFile(f)
      const up = await styleImportsApi.upload(filename, data)
      setFile(f); setUploadId(up.id)
    } catch (e) { setErr(e?.message || 'Could not upload that file.') }
    finally { setBusy('') }
  }

  const reset = () => { setFile(null); setUploadId(''); setPreview(null); setErr('') }

  const create = async () => {
    setBusy('create'); setErr('')
    try {
      const r = await styleImportsApi.commit(uploadId, masterOrderId, preview.summary.errors > 0)
      setResult(r)
      if (!r.pending) refreshOrders().catch(() => {})
    } catch (e) { setErr(e?.message || (forReview ? 'Could not send the sheet.' : 'Could not create the styles.')) }
    finally { setBusy('') }
  }

  const s = preview?.summary
  const mo = masterOrders.find(m => m.id === masterOrderId)

  if (result?.pending) {
    return (
      <Modal title="Sent for review" subtitle={`${result.summary.ok} style${result.summary.ok !== 1 ? 's' : ''}${mo ? ` for ${mo.orderName}` : ''}`} onClose={() => onDone(result)} size="md" float>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 13.5, color: T.text, lineHeight: 1.6 }}>
            Tradio's master admin has your sheet and will approve it. The styles are added once they do, and you will get a notification either way. You can follow it under "Your requests" on this page.
          </div>
          <FlexRow justify="flex-end"><Btn onClick={() => onDone(result)}>Done</Btn></FlexRow>
        </div>
      </Modal>
    )
  }

  if (result) {
    return (
      <Modal title="Styles imported" subtitle={`${result.created.length} style${result.created.length !== 1 ? 's' : ''} added${mo ? ` under ${mo.orderName}` : ''}`} onClose={() => onDone(result)} size="lg" float>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 13, color: T.text }}>
            {result.created.map(c => <div key={c.id} style={{ padding: '3px 0' }}><Check size={13} color={T.success} style={{ verticalAlign: -2, marginRight: 6 }} /><b>{c.id}</b> {c.styleNumber && `(${c.styleNumber})`} {c.product}</div>)}
          </div>
          {result.failed.length > 0 && (
            <div style={{ fontSize: 12.5, color: T.danger, background: T.dangerBg, border: `1px solid ${T.dangerBorder}`, borderRadius: 8, padding: '8px 12px' }}>
              <b>{result.failed.length} could not be created:</b>
              {result.failed.map(f => <div key={f.row}>Row {f.row}{f.styleNumber ? `, ${f.styleNumber}` : ''}: {f.error}</div>)}
            </div>
          )}
          {(result.skipped.exists > 0 || result.skipped.invalid > 0) && (
            <div style={{ fontSize: 12.5, color: T.textMuted }}>
              Skipped: {[result.skipped.exists ? `${result.skipped.exists} already in the master order` : '', result.skipped.invalid ? `${result.skipped.invalid} with problems (fix the sheet and upload it again to add them)` : ''].filter(Boolean).join(', ')}.
            </div>
          )}
          <FlexRow justify="flex-end"><Btn onClick={() => onDone(result)}>Done</Btn></FlexRow>
        </div>
      </Modal>
    )
  }

  return (
    <Modal title="Import styles" subtitle={forReview ? 'Add many styles at once from an Excel or CSV sheet. Every row is checked first, then Tradio reviews the sheet before the styles are added.' : 'Create many styles at once from an Excel or CSV sheet. Every row is checked and shown before anything is created.'} onClose={() => { if (!busy) onClose() }} size="xxl" float>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <FlexRow justify="space-between" style={{ marginBottom: 6 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Master Order *</label>
            {onNewMasterOrder && <button onClick={onNewMasterOrder} style={{ fontSize: 11, color: T.primary, background: 'none', border: 'none', cursor: 'pointer', fontWeight: 700, fontFamily: 'inherit' }}>+ New Master Order</button>}
          </FlexRow>
          <select value={masterOrderId} onChange={e => setMasterOrderId(e.target.value)}
            style={{ width: '100%', border: `1px solid ${T.border}`, borderRadius: 8, padding: '9px 12px', fontSize: 13, color: T.text, background: T.surface, fontFamily: 'inherit' }}>
            <option value="">Select master order</option>
            {masterOrders.map(m => <option key={m.id} value={m.id}>{m.id} - {m.orderName} ({m.buyerCompany})</option>)}
          </select>
          {masterOrders.length === 0 && !onNewMasterOrder && <div style={{ fontSize: 12, color: T.textMuted, marginTop: 6 }}>You have no master order yet. Ask your Tradio coordinator to set one up, then come back.</div>}
        </div>

        {!file ? (
          <div>
            <input ref={fileInput} type="file" accept={SHEET_ACCEPT} hidden onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; choose(f) }} />
            <button onClick={() => fileInput.current?.click()} disabled={busy === 'upload'}
              onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); choose(e.dataTransfer.files?.[0]) }}
              style={{ width: '100%', border: `2px dashed ${T.border}`, borderRadius: 10, background: T.bg, padding: '26px 16px', cursor: 'pointer', fontFamily: 'inherit', color: T.textMuted, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
              <UploadCloud size={26} />
              <span style={{ fontSize: 13.5, fontWeight: 700, color: T.text }}>{busy === 'upload' ? 'Uploading…' : 'Choose a sheet, or drop it here'}</span>
              <span style={{ fontSize: 12 }}>Excel (.xlsx) or CSV, up to 100 styles</span>
            </button>
            <div style={{ fontSize: 12, color: T.textMuted, marginTop: 10, lineHeight: 1.6 }}>
              <b>Every row needs:</b> Brand, Style No, Description, a picture, Fabric and Stage (NPD or Replen). A replen also needs its Amazon link.
              <br /><b>Optional:</b> Category (worked out from the description when blank), Tech pack link, Quantity, Colours.
              <br />In Excel, place each picture over its row; in a CSV, give a web address in the Image column.
            </div>
            <button onClick={downloadTemplate} style={{ marginTop: 8, fontSize: 12, fontWeight: 700, color: T.primaryDeep, background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: 'inherit', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <Download size={13} /> Download a CSV template
            </button>
          </div>
        ) : (
          <FlexRow justify="space-between" style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: '8px 12px' }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: T.text, display: 'inline-flex', alignItems: 'center', gap: 8 }}><FileSpreadsheet size={16} />{file.name}</span>
            <button onClick={reset} disabled={!!busy} style={{ fontSize: 12, fontWeight: 700, color: T.primaryDeep, background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>Choose a different file</button>
          </FlexRow>
        )}

        {file && !masterOrderId && <div style={{ fontSize: 12.5, color: T.textMuted }}>Choose the master order to check the sheet against it.</div>}
        {busy === 'preview' && <div style={{ fontSize: 12.5, color: T.textMuted }}>Checking the sheet…</div>}

        {err && <div style={{ fontSize: 12, color: T.danger, fontWeight: 600, background: T.dangerBg, border: `1px solid ${T.dangerBorder}`, borderRadius: 8, padding: '8px 12px' }}><AlertTriangle size={12} style={{ verticalAlign: -2, marginRight: 4 }} /> {err}</div>}

        {preview && (
          <>
            <StyleImportPreview preview={preview} />
            {s.errors > 0 && s.ok > 0 && <div style={{ fontSize: 12, color: T.textMuted }}>The {s.errors} row{s.errors !== 1 ? 's' : ''} with problems will be skipped. Fix the sheet and upload it again to add {s.errors !== 1 ? 'them' : 'it'}; the styles done now are not duplicated.</div>}
          </>
        )}

        <FlexRow justify="flex-end" gap={8}>
          <Btn variant="secondary" onClick={onClose} disabled={!!busy}>Cancel</Btn>
          {preview && s.ok > 0 && (
            <Btn onClick={create} disabled={!!busy}>
              {forReview
                ? (busy === 'create' ? 'Sending…' : s.errors > 0 ? `Send the ${s.ok} valid style${s.ok !== 1 ? 's' : ''} for review` : `Send ${s.ok} style${s.ok !== 1 ? 's' : ''} for review`)
                : (busy === 'create' ? 'Creating…' : s.errors > 0 ? `Create the ${s.ok} valid style${s.ok !== 1 ? 's' : ''}` : `Create ${s.ok} style${s.ok !== 1 ? 's' : ''}`)}
            </Btn>
          )}
        </FlexRow>
      </div>
    </Modal>
  )
}
