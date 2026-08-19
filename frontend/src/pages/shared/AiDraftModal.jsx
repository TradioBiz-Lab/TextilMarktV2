import { useState } from 'react'
import { T, REQUIREMENT_CATEGORY_LABEL } from '../../constants.js'
import { Card, Btn, FlexRow, useToast, LoadingScreen, EmptyState, Modal } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'

// AI drafts a BOM from an uploaded document — the response is an editable
// draft the user reviews line-by-line before anything is saved. There is no
// path from here straight into MaterialRequirement: accepting a line calls
// the ordinary addRequirementLine, same as typing it in by hand. See
// materialsAi.js's own header comment for why that's structural, not a UI
// convention — TRADIO.md documents a real financial loss at Tradio from an
// over-optimistic AI/estimated consumption figure that wasn't reviewed.
// Shared by both the admin (MaterialRequirementsPanel) and manufacturer
// (MfrProjects' ProjectDetail) Materials UIs.
export function AiDraftModal({ scopeType, orderId, mfrProjectId, candidateDocs, onClose, onAccept }) {
  const { draftBomFromDocuments } = useApp()
  const toast = useToast()
  const [selectedDocIds, setSelectedDocIds] = useState([])
  const [drafting, setDrafting] = useState(false)
  const [draftLines, setDraftLines] = useState(null)
  const [accepted, setAccepted] = useState(new Set())
  const [saving, setSaving] = useState(false)

  async function runDraft() {
    if (selectedDocIds.length === 0) { toast('Pick at least one document', 'error'); return }
    setDrafting(true)
    try {
      const res = await draftBomFromDocuments({ scopeType, orderId, mfrProjectId, documentIds: selectedDocIds })
      setDraftLines(res.draftLines)
      setAccepted(new Set(res.draftLines.map((_, i) => i)))
      if (res.draftLines.length === 0) toast('No extractable BOM lines found in the selected document(s)', 'warning')
    } catch (err) {
      toast(err.message || 'AI drafting failed', 'error')
    } finally {
      setDrafting(false)
    }
  }

  async function saveAccepted() {
    const toSave = draftLines.filter((_, i) => accepted.has(i))
    if (toSave.length === 0) return
    setSaving(true)
    try {
      for (const line of toSave) {
        await onAccept(line)
      }
      toast(`${toSave.length} line${toSave.length > 1 ? 's' : ''} added from AI draft`, 'success')
      onClose()
    } catch (err) {
      toast(err.message || 'Failed to save accepted lines', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title="AI Draft BOM from Documents" subtitle="Review every line before saving — nothing is written until you accept it" onClose={onClose} size="xl">
      {!draftLines ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {candidateDocs.length === 0
            ? <EmptyState icon="📄" title="No eligible documents" subtitle="Upload a PDF or image tech pack first (link-only documents can't be used for AI drafting)." />
            : candidateDocs.map(d => (
              <label key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                <input type="checkbox" checked={selectedDocIds.includes(d.id)}
                  onChange={e => setSelectedDocIds(prev => e.target.checked ? [...prev, d.id] : prev.filter(id => id !== d.id))} />
                {d.name} <span style={{ color: T.textMuted, fontSize: 11 }}>({d.type})</span>
              </label>
            ))}
          <FlexRow justify="flex-end">
            <Btn onClick={runDraft} disabled={drafting || selectedDocIds.length === 0}>{drafting ? 'Analysing…' : 'Draft BOM'}</Btn>
          </FlexRow>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {draftLines.length === 0
            ? <EmptyState icon="🤷" title="Nothing extracted" subtitle="Try a different document, or add lines manually." />
            : draftLines.map((l, i) => (
              <div key={i} style={{ border: `1px solid ${T.border}`, borderRadius: 8, padding: 10, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <input type="checkbox" checked={accepted.has(i)} style={{ marginTop: 3 }}
                  onChange={e => setAccepted(prev => { const next = new Set(prev); e.target.checked ? next.add(i) : next.delete(i); return next })} />
                <div style={{ flex: 1 }}>
                  <div><span style={{ fontSize: 10, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', marginRight: 8 }}>{REQUIREMENT_CATEGORY_LABEL[l.category] || l.category}</span>
                    <span style={{ fontWeight: 600 }}>{l.name}</span>
                    {l.requiredQty != null && <span style={{ color: T.textMuted, fontSize: 12, marginLeft: 8 }}>{l.requiredQty} {l.unit}</span>}
                    {l.colourway && <span style={{ color: T.textMuted, fontSize: 12, marginLeft: 8 }}>· {l.colourway}</span>}
                  </div>
                  {l.note && <div style={{ fontSize: 11, color: T.warning, marginTop: 3 }}>⚠ {l.note}</div>}
                  {l.requiredQty == null && <div style={{ fontSize: 11, color: T.warning, marginTop: 3 }}>⚠ Quantity not stated in the document — fill it in before saving, or edit after.</div>}
                </div>
              </div>
            ))}
          <FlexRow justify="space-between">
            <Btn variant="secondary" onClick={() => setDraftLines(null)}>← Try Different Documents</Btn>
            <Btn onClick={saveAccepted} disabled={saving || accepted.size === 0}>{saving ? 'Saving…' : `Add ${accepted.size} Selected Line${accepted.size !== 1 ? 's' : ''}`}</Btn>
          </FlexRow>
        </div>
      )}
    </Modal>
  )
}
