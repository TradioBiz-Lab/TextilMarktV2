import { useState, useRef } from 'react'
import { FileText } from 'lucide-react'
import { T, WIKI_PAGE_CATEGORIES } from '../../constants.js'
import { Modal, Select, Input, Btn, FlexRow, useToast } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'
import { renderMarkdownSafe } from '../../lib/markdown.js'
import { importDocument } from '../../lib/docImport.js'

const titleFromFilename = name =>
  name.replace(/\.(docx|pdf)$/i, '').replace(/[_-]+/g, ' ').trim()

// Admin-only editor for a Wiki Page (Tech Pack/SOP) — a Markdown textarea with a
// live sanitized preview beside it, no rich-text editor dependency. `page` is
// null for a new page, or the full record (including bodyMarkdown) to edit.
export function WikiPageEditor({ page, onClose, onSaved }) {
  const { users, createWikiPage, updateWikiPage } = useApp()
  const toast = useToast()
  const buyerUsers = users.filter(u => u.role === 'buyer')
  const isEdit = !!page

  const [title, setTitle] = useState(page?.title || '')
  const [category, setCategory] = useState(page?.category || 'sop')
  const [wikiScope, setWikiScope] = useState(page?.wikiScope || 'company')
  const [buyerId, setBuyerId] = useState(page?.buyerId || '')
  const [bodyMarkdown, setBodyMarkdown] = useState(page?.bodyMarkdown || '')
  const [saving, setSaving] = useState(false)
  const [importing, setImporting] = useState(false)
  const fileInputRef = useRef(null)

  const canSubmit = title.trim() && bodyMarkdown.trim() && (wikiScope === 'company' || !!buyerId) && !saving

  const handleImportFile = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-selecting the same file later
    if (!file) return
    if (bodyMarkdown.trim() && !window.confirm('This will replace the current content below with the imported document. Continue?')) return

    setImporting(true)
    try {
      const { markdown, warnings } = await importDocument(file)
      setBodyMarkdown(markdown)
      if (!title.trim()) setTitle(titleFromFilename(file.name))
      toast(warnings.length ? `Imported with ${warnings.length} note(s) — review the content below` : 'Imported — review before saving', warnings.length ? 'warning' : 'success')
      if (warnings.length) console.warn('[wiki import]', warnings)
    } catch (err) {
      toast(err?.message || 'Failed to import document', 'error')
    } finally {
      setImporting(false)
    }
  }

  const submit = async () => {
    setSaving(true)
    try {
      const data = { title: title.trim(), category, bodyMarkdown, wikiScope, buyerId: wikiScope === 'buyer' ? buyerId : null }
      if (isEdit) await updateWikiPage(page.id, data)
      else await createWikiPage(data)
      toast(isEdit ? 'Page updated' : 'Page created', 'success')
      onSaved?.()
    } catch (e) {
      toast(e?.message || 'Failed to save page', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={isEdit ? 'Edit Wiki Page' : 'New Wiki Page'} subtitle="Tech Pack/SOP content, authored as a page — not a file upload" onClose={onClose} size="xxl">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="form-grid-2">
          <Input label="Title" value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Neobrands Manufacturer SOP" />
          <Select label="Category" value={category} onChange={e => setCategory(e.target.value)}>
            {WIKI_PAGE_CATEGORIES.map(c => <option key={c.v} value={c.v}>{c.l}</option>)}
          </Select>
        </div>
        <div className="form-grid-2">
          <Select label="Scope" value={wikiScope} onChange={e => setWikiScope(e.target.value)}>
            <option value="company">Company-wide</option>
            <option value="buyer">Specific Buyer</option>
          </Select>
          {wikiScope === 'buyer' && (
            <Select label="Buyer *" value={buyerId} onChange={e => setBuyerId(e.target.value)}>
              <option value="">— Select Buyer —</option>
              {buyerUsers.map(b => <option key={b.id} value={b.id}>{b.company} ({b.name})</option>)}
            </Select>
          )}
        </div>

        <div>
          <FlexRow justify="space-between" style={{ marginBottom: 5 }}>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Content (Markdown)</label>
            <FlexRow gap={8}>
              <span style={{ fontSize: 11, color: T.textLight }}>or start from a file:</span>
              <input ref={fileInputRef} type="file" accept=".docx,.pdf" onChange={handleImportFile} style={{ display: 'none' }} />
              <button type="button" onClick={() => fileInputRef.current?.click()} disabled={importing}
                style={{ background: '#f1f5f9', border: 'none', borderRadius: 6, padding: '4px 10px', fontSize: 11, fontWeight: 600, cursor: importing ? 'default' : 'pointer', color: T.textMuted, fontFamily: 'inherit', opacity: importing ? 0.6 : 1, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                {importing ? 'Importing…' : <><FileText size={12} /> Import from Word/PDF</>}
              </button>
            </FlexRow>
          </FlexRow>
          <div className="form-grid-2" style={{ gap: 12 }}>
            <textarea
              value={bodyMarkdown}
              onChange={e => setBodyMarkdown(e.target.value)}
              placeholder={'# Heading\n\nWrite the SOP/tech pack content here using Markdown — headings, lists, bold text all render in the preview.'}
              style={{ width: '100%', minHeight: 380, border: `1px solid ${T.border}`, borderRadius: 8, padding: '10px 12px', fontSize: 13, color: T.text, background: T.surface, fontFamily: "'JetBrains Mono',monospace", resize: 'vertical' }}
            />
            <div className="markdown-body" style={{ border: `1px solid ${T.border}`, borderRadius: 8, padding: '10px 14px', minHeight: 380, maxHeight: 380, overflowY: 'auto', background: '#fafafa', fontSize: 13, color: T.text }}
              dangerouslySetInnerHTML={{ __html: renderMarkdownSafe(bodyMarkdown) || '<span style="color:#94a3b8">Preview will appear here…</span>' }} />
          </div>
        </div>

        <FlexRow justify="flex-end" gap={8}>
          <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
          <Btn disabled={!canSubmit} onClick={submit}>{saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Page'}</Btn>
        </FlexRow>
      </div>
    </Modal>
  )
}
