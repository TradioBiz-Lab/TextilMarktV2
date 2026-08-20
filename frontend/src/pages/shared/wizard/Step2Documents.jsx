import { useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { T, DOC_TYPES, PATTERN_LINK_ONLY_TYPES } from '../../../constants.js'
import { Card, Btn, Select, Input, FlexRow, FileUpload, fileUploadPayload, useToast, Alert } from '../../../components/ui.jsx'
import { useApp } from '../../../context.jsx'

// Document types relevant during setup — POs/tech packs/reference material.
// Certificates, GRN/QC evidence, and Wiki entries belong to their own existing
// flows (manufacturer certs, stage evidence, Wiki), not this step.
const WIZARD_DOC_TYPES = DOC_TYPES.filter(d =>
  ['PO', 'buyer_order', 'tech_pack', 'RFQ', 'terms', 'measurement_sheet', 'pattern', 'fit_comments', 'sop'].includes(d.v)
)

let rowSeq = 0
function blankDocRow() {
  return { key: ++rowSeq, type: 'tech_pack', name: '', file: null, fileErr: '', notes: '' }
}

export function Step2Documents({ wizardState, onNext, onBack }) {
  const { uploadDoc } = useApp()
  const toast = useToast()
  const [rows, setRows] = useState([blankDocRow()])
  const [uploading, setUploading] = useState(false)
  const [err, setErr] = useState('')

  const updateRow = (key, patch) => setRows(prev => prev.map(r => r.key === key ? { ...r, ...patch } : r))
  const removeRow = key => setRows(prev => prev.filter(r => r.key !== key))

  const filledRows = rows.filter(r => r.file && (r.file.dataUrl || r.file.externalUrl) && r.name.trim())

  const submit = async () => {
    setErr('')
    setUploading(true)
    try {
      const scope = wizardState.role === 'admin'
        ? { masterOrderId: wizardState.masterOrderId }
        : { mfrMasterProjectId: wizardState.mfrMasterProjectId }
      for (const row of filledRows) {
        await uploadDoc({
          type: row.type, name: row.name.trim(), notes: row.notes.trim() || undefined,
          ...scope,
          ...fileUploadPayload(row.file),
        })
      }
      if (filledRows.length > 0) toast(`${filledRows.length} document${filledRows.length !== 1 ? 's' : ''} uploaded`, 'success')
      onNext()
    } catch (e) {
      setErr(typeof e === 'string' ? e : (e?.message || 'Failed to upload one or more documents — fix the error and try again'))
    } finally {
      setUploading(false)
    }
  }

  return (
    <Card style={{ padding: '30px 32px' }}>
      <div style={{ marginBottom: 22 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, color: T.text, margin: 0, letterSpacing: '-0.01em' }}>Reference documents</h2>
        <p style={{ fontSize: 12.5, color: T.textMuted, marginTop: 5 }}>
          POs, tech packs, fit comments, measurement sheets, patterns (DXF links), and SOPs. Optional — you can skip this and add documents later.
        </p>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {rows.map(row => {
          const isLinkOnly = PATTERN_LINK_ONLY_TYPES.includes(row.type)
          return (
            <div key={row.key} style={{ border: `1px solid ${T.border}`, borderRadius: T.radius.md, padding: 16, background: T.bg, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <FlexRow gap={10} style={{ flexWrap: 'wrap' }}>
                <div style={{ minWidth: 180 }}>
                  <Select label="Type" value={row.type} onChange={e => updateRow(row.key, { type: e.target.value })}>
                    {WIZARD_DOC_TYPES.map(d => <option key={d.v} value={d.v}>{d.l}</option>)}
                  </Select>
                </div>
                <div style={{ flex: 1, minWidth: 180 }}>
                  <Input label="Name" value={row.name} onChange={e => updateRow(row.key, { name: e.target.value })} placeholder="e.g. Tech Pack v2" />
                </div>
                {rows.length > 1 && (
                  <button type="button" onClick={() => removeRow(row.key)}
                    style={{ alignSelf: 'flex-end', background: 'none', border: 'none', color: T.danger, cursor: 'pointer', fontSize: 12, fontWeight: 700, padding: '10px 4px' }}>
                    Remove
                  </button>
                )}
              </FlexRow>
              {isLinkOnly && (
                <div style={{ fontSize: 11, color: T.textLight }}>Pattern files (DXF etc.) are attached as a share link, not an inline upload — use the "Paste link" tab below.</div>
              )}
              <FileUpload file={row.file} onFile={f => updateRow(row.key, { file: f })} error={row.fileErr} onError={e => updateRow(row.key, { fileErr: e })} />
              <Input label="Notes (optional)" value={row.notes} onChange={e => updateRow(row.key, { notes: e.target.value })} />
            </div>
          )
        })}
      </div>

      <FlexRow justify="flex-start" style={{ marginTop: 14 }}>
        <Btn variant="secondary" onClick={() => setRows(prev => [...prev, blankDocRow()])}>+ Add Another Document</Btn>
      </FlexRow>

      {err && <div style={{ marginTop: 16 }}><Alert type="danger">{err}</Alert></div>}

      <FlexRow justify="space-between" style={{ marginTop: 24 }}>
        <Btn variant="secondary" size="lg" onClick={onBack} icon={<ArrowLeft size={16} />}>Back</Btn>
        <FlexRow gap={8}>
          <Btn variant="secondary" size="lg" onClick={onNext} disabled={uploading}>Skip</Btn>
          <Btn size="lg" onClick={submit} disabled={uploading}>
            {uploading ? 'Uploading…' : filledRows.length > 0 ? `Upload ${filledRows.length} & Continue →` : 'Next: Line Items →'}
          </Btn>
        </FlexRow>
      </FlexRow>
    </Card>
  )
}
