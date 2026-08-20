import { useState } from 'react'
import { Ruler, ClipboardList, FileText, Link2, Building2 } from 'lucide-react'
import { T, WIKI_PAGE_CATEGORIES, WIKI_DOC_TYPES, DOC_ICONS } from '../../constants.js'
import { PageHeader, Tabs, Card, EmptyState, Btn, Input, Select, FlexRow, LoadingScreen, useToast, Modal } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'
import { WikiPageEditor } from '../admin/WikiPageEditor.jsx'
import { renderMarkdownSafe } from '../../lib/markdown.js'

const fmtDate = d => {
  if (!d) return '—'
  const dt = new Date(d)
  return `${String(dt.getDate()).padStart(2, '0')}-${String(dt.getMonth() + 1).padStart(2, '0')}-${dt.getFullYear()}`
}

function ScopeBadge({ wikiScope, buyerId, users }) {
  if (wikiScope === 'company')
    return <span style={{ fontSize: 10, fontWeight: 700, color: '#0369a1', background: '#dbeafe', padding: '2px 9px', borderRadius: 20, whiteSpace: 'nowrap' }}>Company-wide</span>
  const buyer = users.find(u => String(u.id) === String(buyerId))
  return <span style={{ fontSize: 10, fontWeight: 700, color: '#7c3aed', background: '#ede9fe', padding: '2px 9px', borderRadius: 20, whiteSpace: 'nowrap' }}>{buyer?.company || 'Buyer-scoped'}</span>
}

function FilterPills({ options, active, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {options.map(f => (
        <button key={f.v} onClick={() => onChange(f.v)}
          style={{ padding: '5px 14px', borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: 'pointer', background: active === f.v ? T.primary : T.surface, color: active === f.v ? '#fff' : T.textMuted, border: active === f.v ? 'none' : `1px solid ${T.border}`, fontFamily: 'inherit' }}>
          {f.l}
        </button>
      ))}
    </div>
  )
}

function RowIcon({ children }) {
  return (
    <div style={{ width: 40, height: 40, borderRadius: 11, background: T.primaryLight, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 19, flexShrink: 0 }}>{children}</div>
  )
}

function PageRow({ p, isAdmin, users, onOpen, onEdit, onDelete }) {
  return (
    <Card pad={false} onClick={() => onOpen(p.id)} style={{ padding: '14px 16px' }}>
      <FlexRow justify="space-between" gap={14}>
        <FlexRow gap={14} style={{ minWidth: 0, flex: 1 }}>
          <RowIcon>{p.category === 'tech_pack' ? <Ruler size={18} color={T.primary} /> : <ClipboardList size={18} color={T.primary} />}</RowIcon>
          <div style={{ minWidth: 0 }}>
            <FlexRow gap={8}>
              <span style={{ fontSize: 13.5, fontWeight: 700, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.title}</span>
              <ScopeBadge wikiScope={p.wikiScope} buyerId={p.buyerId} users={users} />
            </FlexRow>
            <div style={{ fontSize: 11, color: T.textLight, marginTop: 5 }}>
              {WIKI_PAGE_CATEGORIES.find(c => c.v === p.category)?.l} · Updated {fmtDate(p.updatedAt)}
            </div>
          </div>
        </FlexRow>
        {isAdmin && (
          <FlexRow gap={6} onClick={e => e.stopPropagation()} style={{ flexShrink: 0 }}>
            <button onClick={() => onEdit(p)} style={{ background: '#f1f5f9', border: 'none', borderRadius: 8, padding: '6px 12px', fontSize: 11, fontWeight: 600, cursor: 'pointer', color: T.textMuted, fontFamily: 'inherit' }}>Edit</button>
            <button onClick={() => onDelete(p)} style={{ background: T.dangerBg, border: 'none', borderRadius: 8, padding: '6px 12px', fontSize: 11, fontWeight: 600, cursor: 'pointer', color: T.danger, fontFamily: 'inherit' }}>Delete</button>
          </FlexRow>
        )}
      </FlexRow>
    </Card>
  )
}

function FileRow({ d, users }) {
  const DocIcon = DOC_ICONS[d.type] || FileText
  return (
    <Card pad={false} onClick={() => window.open(d.externalUrl, '_blank', 'noopener,noreferrer')} style={{ padding: '14px 16px' }}>
      <FlexRow justify="space-between" gap={14}>
        <FlexRow gap={14} style={{ minWidth: 0, flex: 1 }}>
          <RowIcon><DocIcon size={18} color={T.primary} /></RowIcon>
          <div style={{ minWidth: 0 }}>
            <FlexRow gap={8}>
              <span style={{ fontSize: 13.5, fontWeight: 700, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</span>
              <ScopeBadge wikiScope={d.wikiScope} buyerId={d.buyerId} users={users} />
            </FlexRow>
            <div style={{ fontSize: 11, color: T.textLight, marginTop: 5 }}>{WIKI_DOC_TYPES.find(c => c.v === d.type)?.l}</div>
          </div>
        </FlexRow>
        <span style={{ fontSize: 12, fontWeight: 700, color: T.primary, whiteSpace: 'nowrap', padding: '6px 12px', border: `1px solid ${T.primary}33`, borderRadius: 8, flexShrink: 0 }}>
          Open ↗
        </span>
      </FlexRow>
    </Card>
  )
}

// Company-wide first, then one group per buyer (alphabetical) — admin/master-admin
// only. Buyers/manufacturers see at most "company-wide + their own scope" anyway,
// so a client breakdown adds nothing for them; the flat list stays as-is there.
function groupByClient(items, users) {
  const company = items.filter(i => i.wikiScope === 'company')
  const byBuyer = {}
  for (const i of items) {
    if (i.wikiScope !== 'buyer') continue
    const key = i.buyerId || '__unknown__'
    ;(byBuyer[key] ||= []).push(i)
  }
  const buyerGroups = Object.entries(byBuyer)
    .map(([buyerId, list]) => ({
      buyerId,
      label: users.find(u => String(u.id) === String(buyerId))?.company || 'Unknown Buyer',
      items: list,
    }))
    .sort((a, b) => a.label.localeCompare(b.label))
  return { company, buyerGroups }
}

function ClientGroup({ groupKey, label, count, open, onToggle, children }) {
  return (
    <div style={{ border: `1px solid ${open ? T.primary + '44' : T.border}`, borderRadius: 12, overflow: 'hidden', transition: 'border-color 0.15s' }}>
      <button onClick={() => onToggle(groupKey)}
        style={{ width: '100%', padding: '11px 16px', background: open ? T.primaryLight : '#f8fafc', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, fontFamily: 'inherit', transition: 'background 0.15s' }}>
        <span style={{ fontSize: 13, color: open ? T.primary : T.textMuted, transition: 'transform 0.15s', display: 'inline-block', transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}>›</span>
        <span style={{ fontSize: 12, fontWeight: 700, color: T.text }}>{label}</span>
        <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 700, color: T.textMuted, background: '#e2e8f0', padding: '1px 8px', borderRadius: 10 }}>{count}</span>
      </button>
      {open && (
        <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 6, borderTop: `1px solid ${T.border}` }}>
          {children}
        </div>
      )}
    </div>
  )
}

// Flat (no order-accordion) library — Pages tab is admin-authored Markdown
// (WikiPage model), Files tab is link-only Zoho references (Document's wiki_*
// subset). Buyers/manufacturers get both tabs read-only; admin gets create/
// edit/delete on Pages and add-link on Files.
export function WikiPage() {
  const { currentUser: user, wikiPages, docs, users, loading, getWikiPage, removeWikiPage, uploadDoc } = useApp()
  const toast = useToast()
  const isAdmin = user?.role === 'admin'

  const [tab, setTab] = useState('pages')
  const [search, setSearch] = useState('')
  const [pageCat, setPageCat] = useState('all')
  const [docCat, setDocCat] = useState('all')

  const [showNewPage, setShowNewPage] = useState(false)
  const [editingPage, setEditingPage] = useState(null)
  const [viewPage, setViewPage] = useState(null)
  const [viewLoading, setViewLoading] = useState(false)

  const [showAddLink, setShowAddLink] = useState(false)
  const [linkForm, setLinkForm] = useState({ type: 'wiki_inspection_form', name: '', wikiScope: 'company', buyerId: '', externalUrl: '' })
  const [linkSaving, setLinkSaving] = useState(false)

  const [openGroups, setOpenGroups] = useState(new Set())
  const toggleGroup = id => setOpenGroups(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })

  if (loading) return <LoadingScreen />

  const wikiDocs = docs.filter(d => d.wikiScope && d.isActive !== false)
  const buyerUsers = users.filter(u => u.role === 'buyer')

  const q = search.trim().toLowerCase()
  const filteredPages = wikiPages
    .filter(p => pageCat === 'all' || p.category === pageCat)
    .filter(p => !q || p.title.toLowerCase().includes(q))
  const filteredDocs = wikiDocs
    .filter(d => docCat === 'all' || d.type === docCat)
    .filter(d => !q || d.name.toLowerCase().includes(q))

  const openPage = async (id) => {
    setViewLoading(true)
    try {
      setViewPage(await getWikiPage(id))
    } catch {
      toast('Failed to load page', 'error')
    } finally {
      setViewLoading(false)
    }
  }

  const deletePage = async (p) => {
    if (!window.confirm(`Retire "${p.title}"? It will no longer be visible in the Wiki.`)) return
    try {
      await removeWikiPage(p.id)
      toast('Page retired', 'success')
    } catch {
      toast('Failed to delete page', 'error')
    }
  }

  const resetLinkForm = () => setLinkForm({ type: 'wiki_inspection_form', name: '', wikiScope: 'company', buyerId: '', externalUrl: '' })

  const submitLink = async () => {
    setLinkSaving(true)
    try {
      await uploadDoc({
        type: linkForm.type, name: linkForm.name.trim(),
        wikiScope: linkForm.wikiScope, buyerId: linkForm.wikiScope === 'buyer' ? linkForm.buyerId : null,
        externalUrl: linkForm.externalUrl.trim(),
      })
      toast('Link added', 'success')
      setShowAddLink(false); resetLinkForm()
    } catch (e) {
      toast(e?.message || 'Failed to add link', 'error')
    } finally {
      setLinkSaving(false)
    }
  }

  const canSubmitLink = linkForm.name.trim() && linkForm.externalUrl.trim() && (linkForm.wikiScope === 'company' || linkForm.buyerId) && !linkSaving

  return (
    <div>
      <PageHeader
        title="Wiki"
        subtitle="Tech packs, SOPs, inspection forms, fit comments and photos — one reference library"
        action={isAdmin
          ? (tab === 'pages' ? <Btn onClick={() => setShowNewPage(true)} icon={<FileText size={16} />}>New Page</Btn> : <Btn onClick={() => setShowAddLink(true)} icon={<Link2 size={16} />}>Add Link</Btn>)
          : null}
      />

      <div style={{ marginBottom: 16 }}>
        <Tabs tabs={[{ id: 'pages', label: `Pages (${wikiPages.length})` }, { id: 'files', label: `Files (${wikiDocs.length})` }]} active={tab} onChange={setTab} />
      </div>

      <FlexRow gap={10} style={{ marginBottom: 16, flexWrap: 'wrap' }}>
        <Input placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)} style={{ minWidth: 220 }} />
        {tab === 'pages'
          ? <FilterPills options={[{ v: 'all', l: `All (${wikiPages.length})` }, ...WIKI_PAGE_CATEGORIES]} active={pageCat} onChange={setPageCat} />
          : <FilterPills options={[{ v: 'all', l: `All (${wikiDocs.length})` }, ...WIKI_DOC_TYPES]} active={docCat} onChange={setDocCat} />}
      </FlexRow>

      {tab === 'pages' && (
        filteredPages.length === 0 ? (
          <Card><EmptyState icon={<FileText size={26} color={T.textLight} />} title="No pages" desc={isAdmin ? 'Create the first Tech Pack or SOP page above' : 'No Tech Pack or SOP pages have been added yet'} /></Card>
        ) : isAdmin ? (() => {
          const { company, buyerGroups } = groupByClient(filteredPages, users)
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {company.length > 0 && (
                <ClientGroup groupKey="pages:__company__" label={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Building2 size={13} /> Company-wide</span>} count={company.length} open={openGroups.has('pages:__company__')} onToggle={toggleGroup}>
                  {company.map(p => <PageRow key={p.id} p={p} isAdmin={isAdmin} users={users} onOpen={openPage} onEdit={setEditingPage} onDelete={deletePage} />)}
                </ClientGroup>
              )}
              {buyerGroups.map(g => (
                <ClientGroup key={g.buyerId} groupKey={`pages:${g.buyerId}`} label={g.label} count={g.items.length} open={openGroups.has(`pages:${g.buyerId}`)} onToggle={toggleGroup}>
                  {g.items.map(p => <PageRow key={p.id} p={p} isAdmin={isAdmin} users={users} onOpen={openPage} onEdit={setEditingPage} onDelete={deletePage} />)}
                </ClientGroup>
              ))}
            </div>
          )
        })() : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {filteredPages.map(p => <PageRow key={p.id} p={p} isAdmin={isAdmin} users={users} onOpen={openPage} onEdit={setEditingPage} onDelete={deletePage} />)}
          </div>
        )
      )}

      {tab === 'files' && (
        filteredDocs.length === 0 ? (
          <Card><EmptyState icon={<Link2 size={26} color={T.textLight} />} title="No linked files" desc={isAdmin ? 'Add a link to an Inspection Form, Fit Comments sheet, or Photo above' : 'No reference files have been linked yet'} /></Card>
        ) : isAdmin ? (() => {
          const { company, buyerGroups } = groupByClient(filteredDocs, users)
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {company.length > 0 && (
                <ClientGroup groupKey="files:__company__" label={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Building2 size={13} /> Company-wide</span>} count={company.length} open={openGroups.has('files:__company__')} onToggle={toggleGroup}>
                  {company.map(d => <FileRow key={d.id} d={d} users={users} />)}
                </ClientGroup>
              )}
              {buyerGroups.map(g => (
                <ClientGroup key={g.buyerId} groupKey={`files:${g.buyerId}`} label={g.label} count={g.items.length} open={openGroups.has(`files:${g.buyerId}`)} onToggle={toggleGroup}>
                  {g.items.map(d => <FileRow key={d.id} d={d} users={users} />)}
                </ClientGroup>
              ))}
            </div>
          )
        })() : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {filteredDocs.map(d => <FileRow key={d.id} d={d} users={users} />)}
          </div>
        )
      )}

      {(showNewPage || editingPage) && (
        <WikiPageEditor
          page={editingPage}
          onClose={() => { setShowNewPage(false); setEditingPage(null) }}
          onSaved={() => { setShowNewPage(false); setEditingPage(null) }}
        />
      )}

      {viewLoading && (
        <Modal title="Loading…" onClose={() => setViewLoading(false)} size="sm">
          <div style={{ padding: 20, textAlign: 'center', color: T.textMuted }}>Loading page…</div>
        </Modal>
      )}

      {viewPage && !viewLoading && (
        <Modal title={viewPage.title} subtitle={`${WIKI_PAGE_CATEGORIES.find(c => c.v === viewPage.category)?.l} · Updated ${fmtDate(viewPage.updatedAt)}`} onClose={() => setViewPage(null)} size="xl">
          <div className="markdown-body" style={{ fontSize: 14, color: T.text, lineHeight: 1.6 }} dangerouslySetInnerHTML={{ __html: renderMarkdownSafe(viewPage.bodyMarkdown) }} />
        </Modal>
      )}

      {showAddLink && (
        <Modal title="Add Wiki Link" subtitle="The file must already be uploaded to Zoho WorkDrive (or wherever it's shared from) — this stores the link, not the file" onClose={() => { setShowAddLink(false); resetLinkForm() }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div className="form-grid-2">
              <Select label="Category" value={linkForm.type} onChange={e => setLinkForm({ ...linkForm, type: e.target.value })}>
                {WIKI_DOC_TYPES.map(c => <option key={c.v} value={c.v}>{c.l}</option>)}
              </Select>
              <Input label="Name" value={linkForm.name} onChange={e => setLinkForm({ ...linkForm, name: e.target.value })} placeholder="e.g. Fabric Test Report — Style 001" />
            </div>
            <div className="form-grid-2">
              <Select label="Scope" value={linkForm.wikiScope} onChange={e => setLinkForm({ ...linkForm, wikiScope: e.target.value })}>
                <option value="company">Company-wide</option>
                <option value="buyer">Specific Buyer</option>
              </Select>
              {linkForm.wikiScope === 'buyer' && (
                <Select label="Buyer *" value={linkForm.buyerId} onChange={e => setLinkForm({ ...linkForm, buyerId: e.target.value })}>
                  <option value="">— Select Buyer —</option>
                  {buyerUsers.map(b => <option key={b.id} value={b.id}>{b.company} ({b.name})</option>)}
                </Select>
              )}
            </div>
            <Input label="External Link (Zoho WorkDrive share URL)" value={linkForm.externalUrl} onChange={e => setLinkForm({ ...linkForm, externalUrl: e.target.value })} placeholder="https://workdrive.zoho.com/..." />
            <FlexRow justify="flex-end" gap={8}>
              <Btn variant="secondary" onClick={() => { setShowAddLink(false); resetLinkForm() }}>Cancel</Btn>
              <Btn disabled={!canSubmitLink} onClick={submitLink}>{linkSaving ? 'Saving…' : 'Add Link'}</Btn>
            </FlexRow>
          </div>
        </Modal>
      )}
    </div>
  )
}
