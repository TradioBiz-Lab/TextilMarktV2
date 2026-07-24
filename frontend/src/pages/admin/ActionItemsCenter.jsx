import { useState } from 'react'
import { T, getToday, dayNumber } from '../../constants.js'
import { PageHeader, Card, Btn, FlexRow, Modal, Select, Input, Textarea, EmptyState, Mono, LoadingScreen, useToast } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'

function fmtDate(d) {
  if (!d) return '—'
  const dt = new Date(d)
  const dd = String(dt.getDate()).padStart(2, '0')
  const mm = String(dt.getMonth() + 1).padStart(2, '0')
  return `${dd}-${mm}-${dt.getFullYear()}`
}

function fmtDateTime(d) {
  if (!d) return '—'
  const dt = new Date(d)
  return `${fmtDate(d)} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`
}

const PRIORITY_STYLE = {
  high:   { bg: T.dangerBg,  c: T.danger,  border: T.dangerBorder,  label: 'High' },
  medium: { bg: T.warningBg, c: T.warning, border: T.warningBorder, label: 'Medium' },
  low:    { bg: '#f1f5f9',   c: T.textMuted, border: T.border,      label: 'Low' },
}

const isOverdue   = item => item.status !== 'done' && !!item.eta && dayNumber(item.eta) - dayNumber(getToday()) < 0
const isDueToday  = item => item.status !== 'done' && !!item.eta && dayNumber(item.eta) - dayNumber(getToday()) === 0
const toDateInput = d => d ? new Date(d).toISOString().slice(0, 10) : ''

const emptyForm = { title: '', detail: '', assigneeId: '', buyerId: '', priority: 'medium', eta: '' }

export function ActionItemsCenter({ onOpen }) {
  const { actionItems, users, orders, currentUser, loading, createActionItem, updateActionItem, addActionItemUpdate, removeActionItem } = useApp()
  const toast = useToast()

  const [scope, setScope] = useState('mine') // 'mine' | 'all'
  const [statusFilter, setStatusFilter] = useState('open') // 'open' | 'done' | 'all'
  const [q, setQ] = useState('')
  const [collapsedGroups, setCollapsedGroups] = useState({})
  const [expandedId, setExpandedId] = useState(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)
  const [updateDrafts, setUpdateDrafts] = useState({})
  const [busy, setBusy] = useState(false)

  // ── Create / edit modal ──
  const [modalOpen, setModalOpen] = useState(false)
  const [editingId, setEditingId] = useState(null) // null = creating new
  const [form, setForm] = useState(emptyForm)
  const [formErr, setFormErr] = useState('')

  if (loading) return <LoadingScreen />

  const admins = users.filter(u => u.role === 'admin' && u.isActive)
  const buyers = users.filter(u => u.role === 'buyer' && u.isActive)

  const resetModal = () => {
    setModalOpen(false)
    setEditingId(null)
    setForm(emptyForm)
    setFormErr('')
  }

  const openCreate = () => { resetModal(); setModalOpen(true) }
  const openEdit = item => {
    setEditingId(item.id)
    setForm({
      title: item.title, detail: item.detail || '', assigneeId: item.assigneeId,
      buyerId: item.buyerId || '', priority: item.priority, eta: toDateInput(item.eta),
    })
    setFormErr('')
    setModalOpen(true)
  }

  const submitForm = async () => {
    if (!form.title.trim()) { setFormErr('Title is required'); return }
    if (!form.assigneeId) { setFormErr('Assignee is required'); return }
    setBusy(true)
    try {
      const payload = {
        title: form.title.trim(),
        detail: form.detail,
        assigneeId: form.assigneeId,
        buyerId: form.buyerId || null,
        priority: form.priority,
        eta: form.eta || null,
      }
      if (editingId) {
        await updateActionItem(editingId, payload)
        toast('Action item updated', 'success')
      } else {
        await createActionItem(payload)
        toast('Action item created', 'success')
      }
      resetModal()
    } catch (err) {
      setFormErr(typeof err === 'string' ? err : (err?.message || 'Failed to save action item'))
    } finally { setBusy(false) }
  }

  const toggleDone = async item => {
    setBusy(true)
    try {
      await updateActionItem(item.id, { status: item.status === 'done' ? 'open' : 'done' })
    } catch { toast('Failed to update status', 'error') } finally { setBusy(false) }
  }

  const submitUpdate = async itemId => {
    const text = (updateDrafts[itemId] || '').trim()
    if (!text) return
    setBusy(true)
    try {
      await addActionItemUpdate(itemId, text)
      setUpdateDrafts(d => ({ ...d, [itemId]: '' }))
    } catch { toast('Failed to add update', 'error') } finally { setBusy(false) }
  }

  const doDelete = async id => {
    setBusy(true)
    try {
      await removeActionItem(id)
      setConfirmDeleteId(null)
      toast('Action item deleted', 'success')
    } catch { toast('Failed to delete', 'error') } finally { setBusy(false) }
  }

  // ── Filter + group ──
  const filtered = actionItems.filter(item => {
    if (scope === 'mine' && String(item.assigneeId) !== String(currentUser.id)) return false
    if (statusFilter !== 'all' && item.status !== statusFilter) return false
    if (q.trim()) {
      const m = q.trim().toLowerCase()
      if (!item.title.toLowerCase().includes(m) && !(item.detail || '').toLowerCase().includes(m)) return false
    }
    return true
  })

  // TNA-linked pending stages, read-live from orders — one row per assignment, for
  // its currently active stage only (the first not-yet-complete one). Earlier this
  // flattened every future incomplete stage into its own row, which buried the one
  // actually-actionable step per line item under a dozen not-yet-relevant ones.
  // Display-only here (no expand/mark-done/edit/delete): the interactive surface
  // lives in Order Detail; clicking opens the order.
  const tnaRows = statusFilter === 'done' ? [] : orders
    .flatMap(o => (o.assignments || []).map(a => {
      const stages = a.stages || []
      const si = stages.findIndex(s => (s.unitsDone || 0) < (s.totalUnits || 0))
      if (si === -1) return null
      const s = stages[si]
      if (!s.responsibleId) return null
      return { o, s, a, si }
    }))
    .filter(Boolean)
    .filter(({ s }) => scope !== 'mine' || String(s.responsibleId) === String(currentUser.id))
    .filter(({ o, s }) => {
      if (!q.trim()) return true
      const m = q.trim().toLowerCase()
      return s.name.toLowerCase().includes(m) || o.product.toLowerCase().includes(m)
    })
    .map(({ o, s, a, si }) => ({
      id: `tna:${o.id}:${a.mid}:${si}`,
      title: `${s.name} — ${o.product}`,
      buyerCompany: o.buyerCompany,
      assigneeName: s.responsibleName,
      eta: s.eta && s.eta !== 'NA' ? s.eta : null,
      orderId: o.id,
      priority: 'medium',
      status: 'open',
      _kind: 'tna',
    }))

  const priorityRank = { high: 0, medium: 1, low: 2 }
  const sortItems = list => [...list].sort((a, b) => {
    const aOver = isOverdue(a) ? 0 : 1, bOver = isOverdue(b) ? 0 : 1
    if (aOver !== bOver) return aOver - bOver
    const aEta = a.eta ? dayNumber(a.eta) : Infinity, bEta = b.eta ? dayNumber(b.eta) : Infinity
    if (aEta !== bEta) return aEta - bEta
    return priorityRank[a.priority] - priorityRank[b.priority]
  })

  const groupsMap = {}
  ;[...filtered, ...tnaRows].forEach(item => {
    const key = item.buyerCompany || 'Internal'
    ;(groupsMap[key] ??= []).push(item)
  })
  const groups = Object.entries(groupsMap)
    .map(([client, items]) => ({
      client, items: sortItems(items),
      openCount: items.filter(i => i.status === 'open').length,
      overdueCount: items.filter(isOverdue).length,
    }))
    .sort((a, b) => (b.overdueCount - a.overdueCount) || (b.openCount - a.openCount))

  return (
    <div>
      <PageHeader title="Action Items" subtitle="Track follow-ups across clients — assign, prioritize, and close them out" action={
        <Btn onClick={openCreate} icon="➕">New Action Item</Btn>
      } />

      {/* ── Filters ── */}
      <Card style={{ marginBottom: 14 }}>
        <FlexRow gap={10} style={{ flexWrap: 'wrap' }}>
          <div role="tablist" style={{ display: 'flex', gap: 2, background: '#f1f5f9', padding: 3, borderRadius: 9 }}>
            {['mine', 'all'].map(s => (
              <button key={s} onClick={() => setScope(s)}
                style={{ background: scope === s ? '#fff' : 'transparent', border: 'none', cursor: 'pointer', padding: '6px 14px', borderRadius: 7, fontSize: 12, fontWeight: 700, color: scope === s ? T.text : T.textMuted, fontFamily: 'inherit', boxShadow: scope === s ? '0 1px 2px rgba(0,0,0,0.06)' : 'none' }}>
                {s === 'mine' ? 'My Items' : 'All Items'}
              </button>
            ))}
          </div>
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
            style={{ border: `1px solid ${T.border}`, borderRadius: 8, padding: '7px 12px', fontSize: 13, color: T.text, background: T.surface, fontFamily: 'inherit' }}>
            <option value="open">Open</option>
            <option value="done">Done</option>
            <option value="all">All Statuses</option>
          </select>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="🔍 Search title or detail…"
            style={{ flex: 1, minWidth: 200, border: `1px solid ${T.border}`, borderRadius: 8, padding: '7px 12px', fontSize: 13, color: T.text, fontFamily: 'inherit' }} />
        </FlexRow>
      </Card>

      {/* ── Groups ── */}
      {groups.length === 0 ? (
        <Card><EmptyState icon="✅" title="No action items" desc={scope === 'mine' ? "You're all caught up — nothing assigned to you here." : 'Create one to start tracking follow-ups.'} /></Card>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {groups.map(g => {
            const isOpen = !collapsedGroups[g.client]
            return (
              <Card key={g.client} pad={false}>
                <button onClick={() => setCollapsedGroups(p => ({ ...p, [g.client]: !p[g.client] }))}
                  style={{ width: '100%', border: 'none', cursor: 'pointer', padding: '13px 18px', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 10, background: '#f8fafc' }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: T.text, flex: 1, textAlign: 'left' }}>{g.client === 'Internal' ? '🏠' : '📁'} {g.client}</span>
                  {g.overdueCount > 0 && <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: T.dangerBg, color: T.danger, border: `1px solid ${T.dangerBorder}` }}>{g.overdueCount} overdue</span>}
                  <span style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, background: '#fff', border: `1px solid ${T.border}`, borderRadius: 10, padding: '2px 9px' }}>{g.openCount} open</span>
                  <span style={{ fontSize: 14, color: T.textMuted, transition: 'transform 0.2s', transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}>›</span>
                </button>
                {isOpen && (
                  <div style={{ padding: '4px 12px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {g.items.map(item => {
                      if (item._kind === 'tna') {
                        const overdue = isOverdue(item)
                        return (
                          <div key={item.id} onClick={() => onOpen && onOpen(item.orderId)}
                            style={{ border: `1px solid ${overdue ? T.dangerBorder : T.border}`, borderRadius: 10, background: overdue ? '#fffaf9' : T.surface, padding: '10px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                            <span style={{ fontSize: 9, fontWeight: 800, color: T.primaryDark, background: T.primaryLight, padding: '2px 8px', borderRadius: 10, whiteSpace: 'nowrap' }}>📅 TNA</span>
                            <span style={{ fontSize: 13, fontWeight: 600, color: T.text, flex: 1, minWidth: 160 }}>{item.title}</span>
                            <span style={{ fontSize: 11, color: T.textMuted }}>{item.assigneeName || '—'}</span>
                            {item.eta && (
                              <span style={{ fontSize: 10, fontWeight: overdue ? 700 : 400, color: overdue ? T.danger : T.textMuted, whiteSpace: 'nowrap' }}>
                                {overdue ? `${fmtDate(item.eta)} · overdue` : fmtDate(item.eta)}
                              </span>
                            )}
                          </div>
                        )
                      }
                      const pr = PRIORITY_STYLE[item.priority]
                      const overdue = isOverdue(item)
                      const dueToday = isDueToday(item)
                      const rowExpanded = expandedId === item.id
                      return (
                        <div key={item.id} style={{ border: `1px solid ${overdue ? T.dangerBorder : T.border}`, borderRadius: 10, background: overdue ? '#fffaf9' : T.surface }}>
                          <div onClick={() => setExpandedId(rowExpanded ? null : item.id)}
                            style={{ padding: '10px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                            <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: pr.bg, color: pr.c, border: `1px solid ${pr.border}`, whiteSpace: 'nowrap' }}>{pr.label}</span>
                            <span style={{ fontSize: 13, fontWeight: 600, color: item.status === 'done' ? T.textMuted : T.text, textDecoration: item.status === 'done' ? 'line-through' : 'none', flex: 1, minWidth: 160 }}>{item.title}</span>
                            <span style={{ fontSize: 11, color: T.textMuted }}>{item.assigneeName || '—'}</span>
                            {item.eta && (
                              <span style={{ fontSize: 10, fontWeight: overdue || dueToday ? 700 : 400, color: overdue ? T.danger : dueToday ? T.warning : T.textMuted, whiteSpace: 'nowrap' }}>
                                {overdue ? `${fmtDate(item.eta)} · overdue` : dueToday ? 'due today' : fmtDate(item.eta)}
                              </span>
                            )}
                            {item.status === 'done' && <span style={{ fontSize: 10, fontWeight: 700, color: T.success, background: T.successBg, border: `1px solid ${T.successBorder}`, borderRadius: 10, padding: '2px 8px' }}>Done</span>}
                            <span style={{ fontSize: 12, color: T.textMuted, transition: 'transform 0.2s', transform: rowExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>›</span>
                          </div>

                          {rowExpanded && (
                            <div style={{ padding: '0 14px 14px', borderTop: `1px solid ${T.border}`, marginTop: 2, paddingTop: 12 }}>
                              {item.detail && <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 10, whiteSpace: 'pre-wrap' }}>{item.detail}</div>}
                              {item.orderId && (
                                <div onClick={() => onOpen && onOpen(item.orderId)}
                                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: onOpen ? 'pointer' : 'default', background: T.primaryLight, border: '1px solid #c7d2fe', borderRadius: 8, padding: '4px 10px', marginBottom: 12 }}>
                                  <Mono style={{ fontSize: 11 }}>{item.orderId}</Mono>
                                  {item.stageName && <span style={{ fontSize: 11, color: T.primaryDark }}>· {item.stageName}</span>}
                                </div>
                              )}

                              {/* Updates thread */}
                              <div style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Updates</div>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10, maxHeight: 220, overflowY: 'auto' }}>
                                {(item.updates || []).length === 0 && <div style={{ fontSize: 12, color: T.textLight }}>No updates yet.</div>}
                                {(item.updates || []).map((u, i) => (
                                  <div key={i} style={{ background: '#f8fafc', borderRadius: 8, padding: '8px 10px' }}>
                                    <div style={{ fontSize: 12, color: T.text }}>{u.text}</div>
                                    <div style={{ fontSize: 10, color: T.textLight, marginTop: 3 }}>{u.byUserName || 'Someone'} · {fmtDateTime(u.at)}</div>
                                  </div>
                                ))}
                              </div>
                              <FlexRow gap={8} style={{ marginBottom: 12 }}>
                                <input
                                  value={updateDrafts[item.id] || ''}
                                  onChange={e => setUpdateDrafts(d => ({ ...d, [item.id]: e.target.value }))}
                                  onKeyDown={e => { if (e.key === 'Enter') submitUpdate(item.id) }}
                                  placeholder="Add a progress update…"
                                  style={{ flex: 1, border: `1px solid ${T.border}`, borderRadius: 8, padding: '7px 10px', fontSize: 12, fontFamily: 'inherit' }}
                                />
                                <Btn size="sm" disabled={busy || !(updateDrafts[item.id] || '').trim()} onClick={() => submitUpdate(item.id)}>Post</Btn>
                              </FlexRow>

                              <FlexRow gap={8}>
                                <Btn size="sm" variant={item.status === 'done' ? 'secondary' : 'success'} disabled={busy} onClick={() => toggleDone(item)}>
                                  {item.status === 'done' ? 'Reopen' : 'Mark Done'}
                                </Btn>
                                <Btn size="sm" variant="secondary" disabled={busy} onClick={() => openEdit(item)}>Edit</Btn>
                                {currentUser?.adminType === 'master' && (
                                  confirmDeleteId === item.id ? (
                                    <>
                                      <span style={{ fontSize: 12, color: T.danger, alignSelf: 'center' }}>Delete this item?</span>
                                      <Btn size="sm" variant="danger" disabled={busy} onClick={() => doDelete(item.id)}>Confirm</Btn>
                                      <Btn size="sm" variant="secondary" onClick={() => setConfirmDeleteId(null)}>Cancel</Btn>
                                    </>
                                  ) : (
                                    <button onClick={() => setConfirmDeleteId(item.id)}
                                      style={{ padding: '5px 12px', fontSize: 12, fontWeight: 700, borderRadius: 8, border: `1px solid ${T.dangerBorder}`, background: T.dangerBg, color: T.danger, cursor: 'pointer', fontFamily: 'inherit' }}>
                                      Delete
                                    </button>
                                  )
                                )}
                              </FlexRow>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </Card>
            )
          })}
        </div>
      )}

      {/* ── Create / Edit modal ── */}
      {modalOpen && (
        <Modal title={editingId ? 'Edit Action Item' : 'New Action Item'} size="lg" onClose={resetModal}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Input label="Title *" value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} placeholder="e.g. Follow up on fabric approval" />
            <Textarea label="Detail (optional)" value={form.detail} onChange={e => setForm({ ...form, detail: e.target.value })} placeholder="Any extra context…" />
            <div className="form-grid-2">
              <Select label="Assignee *" value={form.assigneeId} onChange={e => setForm({ ...form, assigneeId: e.target.value })}>
                <option value="">— Select admin —</option>
                {admins.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </Select>
              <Select label="Customer (optional)" value={form.buyerId} onChange={e => setForm({ ...form, buyerId: e.target.value })}>
                <option value="">Internal (no customer)</option>
                {buyers.map(b => <option key={b.id} value={b.id}>{b.company}</option>)}
              </Select>
            </div>
            <div className="form-grid-2">
              <Select label="Priority" value={form.priority} onChange={e => setForm({ ...form, priority: e.target.value })}>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </Select>
              <Input label="ETA (optional)" type="date" value={form.eta} onChange={e => setForm({ ...form, eta: e.target.value })} />
            </div>

            {formErr && <div style={{ fontSize: 12, color: T.danger, fontWeight: 600, background: T.dangerBg, border: `1px solid ${T.dangerBorder}`, borderRadius: 8, padding: '8px 12px' }}>⚠ {formErr}</div>}
            <FlexRow justify="flex-end" gap={8}>
              <Btn variant="secondary" onClick={resetModal}>Cancel</Btn>
              <Btn disabled={busy || !form.title.trim() || !form.assigneeId} onClick={submitForm}>{busy ? 'Saving…' : editingId ? 'Save Changes' : 'Create Action Item'}</Btn>
            </FlexRow>
          </div>
        </Modal>
      )}
    </div>
  )
}
