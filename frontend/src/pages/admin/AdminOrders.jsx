import { useState } from 'react'
import { T, CATEGORIES, SEASONS, DEFAULT_STAGE_NAMES, ORDER_STATUSES } from '../../constants.js'
import { Badge, Btn, Card, EmptyState, Mono, FlexRow, PageHeader, Select, Input, FileUpload, LoadingScreen, useToast, fileUploadPayload } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'
import { EditOrderModal } from './EditOrderModal.jsx'
import { DeleteOrderModal } from './DeleteOrderModal.jsx'
import { BulkUploadCsvPanel } from './BulkUploadCsvPanel.jsx'

function fmtDate(d) {
  if (!d) return '—'
  const dt = new Date(d)
  const dd = String(dt.getDate()).padStart(2, '0')
  const mm = String(dt.getMonth() + 1).padStart(2, '0')
  return `${dd}-${mm}-${dt.getFullYear()}`
}

export function AdminOrders({ onOpen, initialStatus }) {
  const { orders, users, loading, createOrder, uploadDoc, masterOrders, createMasterOrder, editOrder, deleteOrder } = useApp()
  const toast = useToast()
  const [q, setQ] = useState('')
  const [showSugg, setShowSugg] = useState(false)
  const [sfilt, setSfilt] = useState(initialStatus || 'All')
  const [sortCol, setSortCol] = useState(null)
  const [sortDir, setSortDir] = useState('asc')

  // ── Edit / Delete modal state ──
  const [editTarget, setEditTarget] = useState(null)
  const [deleteTarget, setDeleteTarget] = useState(null)

  // ── Create Order state ──
  const [showC, setShowC] = useState(false)
  const [mode, setMode] = useState('single') // 'single' | 'bulk' — bulk only available once a master order is selected
  const [f, setF] = useState({ masterOrderId: '', buyerId: '', product: '', category: '', customCategory: '', season: 'SS26', totalQty: '', delivery: '' })
  const [mfrs, setMfrs] = useState([{ _key: 1, mid: '', qty: '' }])
  const [stages, setStages] = useState(DEFAULT_STAGE_NAMES.map((name, i) => ({ _key: i + 1, name, startDate: '', eta: '' })))
  const [poFile, setPoFile] = useState(null)
  const [poErr, setPoErr] = useState('')
  const [tpFile, setTpFile] = useState(null)
  const [tpErr, setTpErr] = useState('')
  const [createErr, setCreateErr] = useState('')
  const [saving, setSaving] = useState(false)

  // ── Create Master Order state ──
  const [showMO, setShowMO] = useState(false)
  const [mo, setMo] = useState({ buyerId: '', orderName: '', season: 'SS26' })
  const [moFile, setMoFile] = useState(null)
  const [moFileErr, setMoFileErr] = useState('')
  const [moErr, setMoErr] = useState('')
  const [moSaving, setMoSaving] = useState(false)

  if (loading) return <LoadingScreen />

  const buyerUsers = users.filter(u => u.role === 'buyer' && u.isActive)  // used in Master Order modal
  const mfrUsers = users.filter(u => u.role === 'manufacturer' && u.isActive)

  // Derive unique categories from existing orders + default list
  const allCategories = [...new Set([...CATEGORIES, ...orders.map(o => o.category).filter(Boolean)])]

  const toggleSort = col => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
  }

  const filtered = orders.filter(o => {
    const qm = !q || (o.id.toLowerCase().includes(q.toLowerCase()) || o.product.toLowerCase().includes(q.toLowerCase()))
    const sm = sfilt === 'All' || (o.assignments || []).some(a => a.status === sfilt)
    return qm && sm
  }).sort((a, b) => {
    if (!sortCol) return 0
    const dir = sortDir === 'asc' ? 1 : -1
    if (sortCol === 'buyer') return dir * (a.buyerCompany || '').localeCompare(b.buyerCompany || '')
    if (sortCol === 'manufacturer') {
      const am = (a.assignments || []).map(x => x.mfrCompany).filter(Boolean).join(', ')
      const bm = (b.assignments || []).map(x => x.mfrCompany).filter(Boolean).join(', ')
      return dir * am.localeCompare(bm)
    }
    if (sortCol === 'status') return dir * orderStatus(a).localeCompare(orderStatus(b))
    if (sortCol === 'delivery') return dir * (new Date(a.delivery) - new Date(b.delivery))
    return 0
  })

  const genMoId = () => {
    const b = users.find(u => u.id === mo.buyerId)
    if (!b) return null
    const cnt = masterOrders.filter(m => m.buyerId === mo.buyerId).length + 1
    return `MO-${b.code}-${mo.season || 'XX'}-${String(cnt).padStart(3, '0')}`
  }

  const genId = () => {
    const b = users.find(u => u.id === f.buyerId)
    const m = users.find(u => u.id === mfrs[0]?.mid)
    if (!b || !m) return null
    const cat = f.category === '__custom__' ? (f.customCategory || 'CUST').toUpperCase().slice(0, 6) : (f.category || 'XX')
    const cnt = orders.filter(o => o.id.startsWith(b.code + '-')).length + 1
    return `${b.code}-${m.code}-${cat}-${f.season}-${String(cnt).padStart(3, '0')}`
  }

  const resetForm = () => {
    setF({ masterOrderId: '', buyerId: '', product: '', category: '', customCategory: '', season: 'SS26', totalQty: '', delivery: '' })
    setMfrs([{ mid: '', qty: '' }])
    setStages(DEFAULT_STAGE_NAMES.map(name => ({ name, startDate: '', eta: '' })))
    setPoFile(null)
    setPoErr('')
    setTpFile(null)
    setTpErr('')
    setCreateErr('')
    setMode('single')
  }

  const resetMoForm = () => {
    setMo({ buyerId: '', orderName: '', season: 'SS26' })
    setMoFile(null); setMoFileErr(''); setMoErr('')
  }

  const create = async () => {
    const id = genId()
    if (!id) return
    setCreateErr('')

    // Validate assignment quantities sum to totalQty
    const totalQtyNum = Math.floor(Number(f.totalQty))
    if (!totalQtyNum || totalQtyNum < 1) {
      setCreateErr('Total quantity must be a positive number')
      return
    }
    const validMfrs = mfrs.filter(a => a.mid && a.qty !== '')
    if (validMfrs.length === 0) {
      setCreateErr('At least one manufacturer with a quantity is required')
      return
    }
    const assignedTotal = validMfrs.reduce((sum, a) => sum + Math.floor(Number(a.qty) || 0), 0)
    if (assignedTotal !== totalQtyNum) {
      setCreateErr(`Assigned quantities (${assignedTotal.toLocaleString()}) must equal total quantity (${totalQtyNum.toLocaleString()}). Difference: ${Math.abs(totalQtyNum - assignedTotal).toLocaleString()}`)
      return
    }

    const validStages = stages.filter(s => s.name.trim())
    if (validStages.length === 0) {
      setCreateErr('At least one production stage is required')
      return
    }
    const missingStartDate = validStages.find(s => !s.startDate || !s.startDate.trim())
    if (missingStartDate) {
      setCreateErr(`Stage "${missingStartDate.name}" is missing a start date — enter a date or type "NA"`)
      return
    }
    const missingEta = validStages.find(s => !s.eta || !s.eta.trim())
    if (missingEta) {
      setCreateErr(`Stage "${missingEta.name}" is missing an end date — enter a date or type "NA"`)
      return
    }
    const badOrder = validStages.find(s =>
      s.startDate !== 'NA' && s.eta !== 'NA' && new Date(s.startDate) > new Date(s.eta)
    )
    if (badOrder) {
      setCreateErr(`Stage "${badOrder.name}" — start date must be on or before its end date`)
      return
    }

    setSaving(true)
    try {
      const resolvedCategory = f.category === '__custom__' ? f.customCategory.trim() : f.category
      const orderData = {
        id, buyerId: f.buyerId, product: f.product, category: resolvedCategory, season: f.season,
        masterOrderId: f.masterOrderId || null,
        totalQty: totalQtyNum, delivery: f.delivery,
        createdAt: new Date().toISOString().slice(0, 10),
        assignments: validMfrs.map((a, i) => ({ mid: a.mid, qty: Math.floor(Number(a.qty)), sub: `M${i + 1}` })),
        stageNames: validStages.map(s => s.name.trim()),
        stageStartDates: validStages.map(s => s.startDate === 'NA' ? 'NA' : s.startDate || null),
        stageEtas: validStages.map(s => s.eta === 'NA' ? 'NA' : s.eta || null),
      }
      await createOrder(orderData)

      // Upload PO attachment if provided
      if (poFile) {
        try {
          await uploadDoc({
            type: 'PO', name: `PO — ${id}`, issuer: '', issueDate: new Date().toISOString().slice(0, 10),
            expiryDate: null, orderId: id, mfrId: null,
            ...fileUploadPayload(poFile),
          })
        } catch (poErr) {
          console.error('[create order] PO upload failed:', poErr)
          toast('Order created but PO upload failed — re-upload from the Documents tab', 'warning')
          setShowC(false)
          resetForm()
          return
        }
      }

      // Upload Tech Pack if provided
      if (tpFile) {
        try {
          await uploadDoc({
            type: 'tech_pack', name: `Tech Pack — ${id}`, issuer: '', issueDate: new Date().toISOString().slice(0, 10),
            expiryDate: null, orderId: id, mfrId: null,
            ...fileUploadPayload(tpFile),
          })
        } catch (tpErr) {
          console.error('[create order] Tech pack upload failed:', tpErr)
          toast('Order created but Tech Pack upload failed — re-upload from the Documents tab', 'warning')
          setShowC(false)
          resetForm()
          return
        }
      }

      toast(`Order ${id} created`, 'success')
      setShowC(false)
      resetForm()
    } catch (err) {
      setCreateErr(typeof err === 'string' ? err : (err?.message || 'Failed to create order. Please try again.'))
    } finally { setSaving(false) }
  }

  const previewId = genId()

  const orderStatus = (o) => {
    if (o.assignments.some(a => a.status === 'Delayed')) return 'Delayed'
    if (o.assignments.some(a => a.status === 'On Hold')) return 'On Hold'
    if (o.assignments.every(a => a.status === 'Delivered')) return 'Delivered'
    return 'Processing'
  }

  return (
    <div>
      {editTarget && (
        <EditOrderModal
          order={editTarget}
          onClose={() => setEditTarget(null)}
          onSave={async (id, data) => {
            await editOrder(id, data)
            toast(`Order ${id} updated`, 'success')
            setEditTarget(null)
          }}
        />
      )}
      {deleteTarget && (
        <DeleteOrderModal
          order={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onConfirm={async (id) => {
            await deleteOrder(id)
            toast(`Order ${id} deleted`, 'success')
            setDeleteTarget(null)
          }}
        />
      )}
      {showC && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, backdropFilter: 'blur(2px)' }} onClick={e => e.target === e.currentTarget && (setShowC(false), resetForm())}>
          <div style={{ background: '#fff', borderRadius: 14, border: `1px solid ${T.border}`, width: '100%', maxWidth: 720, maxHeight: '94vh', display: 'flex', flexDirection: 'column', boxShadow: '0 24px 64px rgba(0,0,0,0.18)' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '20px 24px 16px', borderBottom: `1px solid ${T.border}` }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 700, color: T.text }}>Create New Order</div>
                <div style={{ fontSize: 12, color: T.textMuted, marginTop: 3 }}>Order ID will be auto-generated · All stages start at 0%</div>
              </div>
              <button onClick={() => { setShowC(false); resetForm() }} style={{ background: '#f1f5f9', border: 'none', cursor: 'pointer', width: 28, height: 28, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, color: T.textMuted }}>×</button>
            </div>
            <div style={{ padding: '20px 24px', overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 16 }}>

              {/* Link to Master Order */}
              <Select label="Master Order *" value={f.masterOrderId} onChange={e => {
                const moId = e.target.value
                const sel = masterOrders.find(m => m.id === moId)
                setF(prev => ({
                  ...prev,
                  masterOrderId: moId,
                  buyerId: sel?.buyerId || prev.buyerId,
                  season: sel?.season || prev.season,
                }))
              }}>
                <option value="">— Select Master Order —</option>
                {masterOrders.map(m => <option key={m.id} value={m.id}>{m.id} — {m.orderName} ({m.buyerCompany})</option>)}
              </Select>

              {f.masterOrderId && (() => {
                const sel = masterOrders.find(m => m.id === f.masterOrderId)
                return sel ? (
                  <div style={{ background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 8, padding: '8px 14px', fontSize: 12, color: '#0369a1', display: 'flex', gap: 16 }}>
                    <span><b>Buyer:</b> {sel.buyerCompany}</span>
                    <span><b>Season:</b> {sel.season || '—'}</span>
                    <span><b>Order:</b> {sel.orderName}</span>
                  </div>
                ) : null
              })()}

              {/* Single Order / Bulk Upload CSV mode toggle — only once a master order is selected */}
              {f.masterOrderId && (
                <div role="tablist" style={{ display: 'flex', gap: 2, background: '#f1f5f9', padding: 3, borderRadius: 9, width: 'fit-content' }}>
                  <button type="button" role="tab" aria-selected={mode === 'single'} onClick={() => setMode('single')}
                    style={{ background: mode === 'single' ? '#fff' : 'transparent', border: 'none', cursor: 'pointer', padding: '6px 14px', borderRadius: 7, fontSize: 12, fontWeight: 700, color: mode === 'single' ? T.text : T.textMuted, fontFamily: 'inherit', boxShadow: mode === 'single' ? '0 1px 2px rgba(0,0,0,0.06)' : 'none' }}>
                    Single Order
                  </button>
                  <button type="button" role="tab" aria-selected={mode === 'bulk'} onClick={() => setMode('bulk')}
                    style={{ background: mode === 'bulk' ? '#fff' : 'transparent', border: 'none', cursor: 'pointer', padding: '6px 14px', borderRadius: 7, fontSize: 12, fontWeight: 700, color: mode === 'bulk' ? T.text : T.textMuted, fontFamily: 'inherit', boxShadow: mode === 'bulk' ? '0 1px 2px rgba(0,0,0,0.06)' : 'none' }}>
                    📄 Bulk Upload CSV
                  </button>
                </div>
              )}

              {mode === 'bulk' && f.masterOrderId ? (
                <BulkUploadCsvPanel
                  masterOrder={masterOrders.find(m => m.id === f.masterOrderId)}
                  onDone={() => { setShowC(false); resetForm() }}
                />
              ) : (
              <>

              {/* Product fields */}
              <div className="form-grid-2">
                <Input label="Product Name *" value={f.product} onChange={e => setF({ ...f, product: e.target.value })} placeholder="e.g. Classic T-Shirt" />
                <Input label="Total Quantity *" type="number" value={f.totalQty} onChange={e => setF({ ...f, totalQty: e.target.value })} placeholder="5000" />
              </div>
              <div className="form-grid-3">
                <div>
                  <Select label="Category" value={f.category} onChange={e => setF({ ...f, category: e.target.value })}>
                    <option value="">— Select —</option>
                    {allCategories.map(c => <option key={c} value={c}>{c}</option>)}
                    <option value="__custom__">✏️ Custom…</option>
                  </Select>
                  {f.category === '__custom__' && (
                    <input
                      value={f.customCategory}
                      onChange={e => setF({ ...f, customCategory: e.target.value.toUpperCase() })}
                      placeholder="Type category code…"
                      maxLength={20}
                      style={{ width: '100%', border: `1px solid ${T.border}`, borderRadius: 8, padding: '7px 12px', fontSize: 13, marginTop: 6, fontFamily: 'inherit', boxSizing: 'border-box' }}
                    />
                  )}
                </div>
                <Select label="Season" value={f.season} onChange={e => setF({ ...f, season: e.target.value })}>
                  {SEASONS.map(s => <option key={s}>{s}</option>)}
                </Select>
                <Input label="Expected Delivery *" type="date" value={f.delivery} onChange={e => setF({ ...f, delivery: e.target.value })} />
              </div>

              {/* Manufacturer assignments */}
              <div>
                <FlexRow justify="space-between" style={{ marginBottom: 8 }}>
                  <label style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Manufacturer Assignments *</label>
                  <button onClick={() => setMfrs([...mfrs, { _key: Date.now(), mid: '', qty: '' }])} style={{ fontSize: 12, color: T.primary, background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600, fontFamily: 'inherit' }}>+ Add Manufacturer</button>
                </FlexRow>
                {mfrs.map((a, i) => (
                  <div key={a._key} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                    <select value={a.mid} onChange={e => setMfrs(mfrs.map((x, j) => j === i ? { ...x, mid: e.target.value } : x))}
                      style={{ flex: 1, border: `1px solid ${T.border}`, borderRadius: 8, padding: '8px 12px', fontSize: 13, color: T.text, background: T.surface, fontFamily: 'inherit' }}>
                      <option value="">Select manufacturer…</option>
                      {mfrUsers.map(m => <option key={m.id} value={m.id}>{m.company} ({m.code})</option>)}
                    </select>
                    <input type="number" value={a.qty} onChange={e => setMfrs(mfrs.map((x, j) => j === i ? { ...x, qty: e.target.value } : x))}
                      placeholder="Qty" style={{ width: 100, border: `1px solid ${T.border}`, borderRadius: 8, padding: '8px 12px', fontSize: 13, fontFamily: 'inherit' }} />
                    {mfrs.length > 1 && (
                      <button onClick={() => setMfrs(mfrs.filter((_, j) => j !== i))}
                        style={{ background: T.dangerBg, border: `1px solid ${T.dangerBorder}`, borderRadius: 8, cursor: 'pointer', padding: '0 12px', color: T.danger, fontSize: 18, fontFamily: 'inherit' }}>×</button>
                    )}
                  </div>
                ))}
                {/* Live qty balance indicator */}
                {(() => {
                  const total = Math.floor(Number(f.totalQty)) || 0
                  const assigned = mfrs.reduce((sum, a) => sum + (Math.floor(Number(a.qty)) || 0), 0)
                  if (total === 0) return null
                  const ok = assigned === total
                  const remaining = total - assigned
                  return (
                    <div style={{ fontSize: 11, fontWeight: 600, color: ok ? T.success : T.danger, marginTop: 2 }}>
                      {ok
                        ? `✓ Quantities balance (${assigned.toLocaleString()} / ${total.toLocaleString()})`
                        : remaining > 0
                          ? `${remaining.toLocaleString()} units still unallocated (${assigned.toLocaleString()} / ${total.toLocaleString()})`
                          : `Over-allocated by ${(-remaining).toLocaleString()} units (${assigned.toLocaleString()} / ${total.toLocaleString()})`
                      }
                    </div>
                  )
                })()}
              </div>

              {/* Dynamic Production Stages */}
              <div>
                <FlexRow justify="space-between" style={{ marginBottom: 8 }}>
                  <label style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Production Stages *</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={() => setStages(DEFAULT_STAGE_NAMES.map(name => ({ name, startDate: '', eta: '' })))} style={{ fontSize: 11, color: T.textMuted, background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600, fontFamily: 'inherit', textDecoration: 'underline' }}>Load Defaults</button>
                    <button onClick={() => setStages([...stages, { name: '', startDate: '', eta: '' }])} style={{ fontSize: 12, color: T.primary, background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600, fontFamily: 'inherit' }}>+ Add Stage</button>
                  </div>
                </FlexRow>
                <div style={{ background: '#f8fafc', borderRadius: 10, border: `1px solid ${T.border}`, padding: '12px 14px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                    <span style={{ fontSize: 11, color: T.textLight }}>Define the production stages for this order. Every stage needs a start and end date — type "NA" only if it genuinely doesn't apply.</span>
                    <span style={{ fontSize: 11, fontWeight: 700, color: stages.filter(s => s.name.trim()).length > 0 ? T.success : T.danger }}>{stages.filter(s => s.name.trim()).length} stage{stages.filter(s => s.name.trim()).length !== 1 ? 's' : ''}</span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {stages.map((s, i) => (
                      <div key={s._key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, minWidth: 22, textAlign: 'right' }}>{i + 1}.</span>
                        <input
                          value={s.name}
                          onChange={e => setStages(stages.map((x, j) => j === i ? { ...x, name: e.target.value } : x))}
                          placeholder="Stage name"
                          style={{ flex: 1, border: `1px solid ${T.border}`, borderRadius: 6, padding: '6px 10px', fontSize: 12, fontFamily: 'inherit', color: T.text, fontWeight: 600 }}
                        />
                        <input
                          type={s.startDate === 'NA' ? 'text' : 'date'}
                          value={s.startDate}
                          onChange={e => setStages(stages.map((x, j) => j === i ? { ...x, startDate: e.target.value } : x))}
                          placeholder="Start date"
                          style={{ width: 130, border: `1px solid ${s.name.trim() && !s.startDate.trim() ? T.danger : T.border}`, borderRadius: 6, padding: '6px 8px', fontSize: 12, fontFamily: 'inherit', color: s.startDate === 'NA' ? T.textLight : T.text }}
                        />
                        <input
                          type={s.eta === 'NA' ? 'text' : 'date'}
                          value={s.eta}
                          onChange={e => setStages(stages.map((x, j) => j === i ? { ...x, eta: e.target.value } : x))}
                          placeholder="End date"
                          style={{ width: 130, border: `1px solid ${s.name.trim() && !s.eta.trim() ? T.danger : T.border}`, borderRadius: 6, padding: '6px 8px', fontSize: 12, fontFamily: 'inherit', color: s.eta === 'NA' ? T.textLight : T.text }}
                        />
                        {i > 0 && (
                          <button onClick={() => { const n = [...stages]; [n[i-1], n[i]] = [n[i], n[i-1]]; setStages(n) }}
                            style={{ background: '#f1f5f9', border: `1px solid ${T.border}`, borderRadius: 6, cursor: 'pointer', width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: T.textMuted }}>↑</button>
                        )}
                        {i < stages.length - 1 && (
                          <button onClick={() => { const n = [...stages]; [n[i], n[i+1]] = [n[i+1], n[i]]; setStages(n) }}
                            style={{ background: '#f1f5f9', border: `1px solid ${T.border}`, borderRadius: 6, cursor: 'pointer', width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: T.textMuted }}>↓</button>
                        )}
                        {stages.length > 1 && (
                          <button onClick={() => setStages(stages.filter((_, j) => j !== i))}
                            style={{ background: T.dangerBg, border: `1px solid ${T.dangerBorder}`, borderRadius: 6, cursor: 'pointer', width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, color: T.danger }}>×</button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* PO Attachment */}
              <div>
                <label style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 8 }}>PO Attachment (optional)</label>
                <FileUpload file={poFile} onFile={f => { setPoFile(f); setPoErr('') }} error={poErr} onError={setPoErr} />
              </div>

              {/* Tech Pack */}
              <div>
                <label style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 8 }}>Tech Pack (optional)</label>
                <FileUpload file={tpFile} onFile={f => { setTpFile(f); setTpErr('') }} error={tpErr} onError={setTpErr} />
              </div>

              {/* Preview ID */}
              {previewId && (
                <div style={{ background: T.primaryLight, border: '1px solid #c7d2fe', borderRadius: 10, padding: '12px 16px' }}>
                  <div style={{ fontSize: 11, color: T.primary, fontWeight: 700, marginBottom: 4 }}>GENERATED ORDER ID</div>
                  <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 14, color: T.primaryDark, fontWeight: 500 }}>{previewId}</span>
                </div>
              )}

              {createErr && <div style={{ fontSize: 12, color: T.danger, fontWeight: 600, background: T.dangerBg, border: `1px solid ${T.dangerBorder}`, borderRadius: 8, padding: '8px 12px' }}>⚠ {createErr}</div>}
              <FlexRow justify="flex-end" gap={8} style={{ marginTop: 4 }}>
                <Btn variant="secondary" onClick={() => setShowC(false)}>Cancel</Btn>
                <Btn disabled={!f.masterOrderId || !f.buyerId || !f.product || !f.totalQty || !f.delivery || !mfrs[0].mid || !mfrs[0].qty || stages.filter(s => s.name.trim()).some(s => !s.startDate.trim() || !s.eta.trim()) || saving} onClick={create}>{saving ? 'Creating…' : 'Create Order'}</Btn>
              </FlexRow>
              </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Create Master Order Modal ── */}
      {showMO && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, backdropFilter: 'blur(2px)' }} onClick={e => e.target === e.currentTarget && (setShowMO(false), resetMoForm())}>
          <div style={{ background: '#fff', borderRadius: 14, border: `1px solid ${T.border}`, width: '100%', maxWidth: 560, boxShadow: '0 24px 64px rgba(0,0,0,0.18)' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '20px 24px 16px', borderBottom: `1px solid ${T.border}` }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 700, color: T.text }}>Create Master Order</div>
                <div style={{ fontSize: 12, color: T.textMuted, marginTop: 3 }}>A master order groups all products for a buyer's order</div>
              </div>
              <button onClick={() => { setShowMO(false); resetMoForm() }} style={{ background: '#f1f5f9', border: 'none', cursor: 'pointer', width: 28, height: 28, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, color: T.textMuted }}>×</button>
            </div>
            <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
              <Select label="Buyer *" value={mo.buyerId} onChange={e => setMo({ ...mo, buyerId: e.target.value })}>
                <option value="">Select buyer…</option>
                {buyerUsers.map(b => <option key={b.id} value={b.id}>{b.company} ({b.code})</option>)}
              </Select>
              <Input label="Order Name *" value={mo.orderName} onChange={e => setMo({ ...mo, orderName: e.target.value })} placeholder="e.g. Spring Collection 2026" />
              <Select label="Season" value={mo.season} onChange={e => setMo({ ...mo, season: e.target.value })}>
                {SEASONS.map(s => <option key={s}>{s}</option>)}
              </Select>
              <div>
                <label style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 8 }}>PO / RFQ Attachment (optional)</label>
                <FileUpload file={moFile} onFile={f => { setMoFile(f); setMoFileErr('') }} error={moFileErr} onError={setMoFileErr} />
              </div>
              {genMoId() && (
                <div style={{ background: T.primaryLight, border: '1px solid #c7d2fe', borderRadius: 8, padding: '8px 14px' }}>
                  <div style={{ fontSize: 10, color: T.primary, fontWeight: 700, marginBottom: 2 }}>GENERATED ID</div>
                  <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 13, color: T.primaryDark }}>{genMoId()}</span>
                </div>
              )}
              {moErr && <div style={{ fontSize: 12, color: T.danger, fontWeight: 600, background: T.dangerBg, border: `1px solid ${T.dangerBorder}`, borderRadius: 8, padding: '8px 12px' }}>⚠ {moErr}</div>}
              <FlexRow justify="flex-end" gap={8}>
                <Btn variant="secondary" onClick={() => { setShowMO(false); resetMoForm() }}>Cancel</Btn>
                <Btn disabled={!mo.buyerId || !mo.orderName.trim() || moSaving} onClick={async () => {
                  const moId = genMoId()
                  if (!moId) return
                  setMoErr('')
                  setMoSaving(true)
                  try {
                    await createMasterOrder({ id: moId, buyerId: mo.buyerId, orderName: mo.orderName.trim(), season: mo.season })
                    // Upload attached file as PO/RFQ linked to this master order
                    if (moFile) {
                      try {
                        await uploadDoc({
                          type: 'PO', name: `PO — ${moId}`, issuer: '', issueDate: new Date().toISOString().slice(0, 10),
                          expiryDate: null, orderId: null, mfrId: null,
                          ...fileUploadPayload(moFile),
                        })
                      } catch { /* ignore upload errors */ }
                    }
                    toast(`Master Order ${moId} created`, 'success')
                    setShowMO(false)
                    resetMoForm()
                  } catch (err) {
                    setMoErr(typeof err === 'string' ? err : (err?.message || 'Failed to create master order'))
                  } finally { setMoSaving(false) }
                }}>{moSaving ? 'Creating…' : 'Create Master Order'}</Btn>
              </FlexRow>
            </div>
          </div>
        </div>
      )}

      <PageHeader title="Order Management" subtitle="Create orders, assign manufacturers, and manage the full order lifecycle" action={
        <FlexRow gap={8}>
          <Btn variant="secondary" onClick={() => setShowMO(true)} icon="📁">New Master Order</Btn>
          <Btn onClick={() => setShowC(true)} icon="➕">Create Order</Btn>
        </FlexRow>
      } />

      <Card pad={false}>
        <div style={{ padding: '14px 18px', borderBottom: `1px solid ${T.border}`, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {/* Search with order-ID autocomplete */}
          {(() => {
            const sugg = q.trim().length > 0
              ? orders.filter(o =>
                  o.id.toLowerCase().includes(q.toLowerCase()) ||
                  o.product.toLowerCase().includes(q.toLowerCase())
                ).slice(0, 8)
              : []
            return (
              <div style={{ flex: 1, minWidth: 200, position: 'relative' }}>
                <input
                  value={q}
                  onChange={e => { setQ(e.target.value); setShowSugg(true) }}
                  onFocus={() => setShowSugg(true)}
                  onBlur={() => setTimeout(() => setShowSugg(false), 150)}
                  placeholder="🔍  Search by product or order ID…"
                  style={{ width: '100%', boxSizing: 'border-box', border: `1px solid ${T.border}`, borderRadius: 8, padding: '7px 12px', fontSize: 13, color: T.text, background: '#f8fafc', fontFamily: 'inherit' }}
                />
                {showSugg && sugg.length > 0 && (
                  <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.1)', zIndex: 200, overflow: 'hidden' }}>
                    {sugg.map((o, i) => (
                      <div key={o.id}
                        onMouseDown={() => { setQ(o.id); setShowSugg(false) }}
                        style={{ padding: '9px 14px', cursor: 'pointer', borderBottom: i < sugg.length - 1 ? `1px solid ${T.border}` : 'none', display: 'flex', gap: 10, alignItems: 'center', background: 'transparent' }}
                        onMouseEnter={e => e.currentTarget.style.background = '#f8fafc'}
                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                      >
                        <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 12, color: T.primary, fontWeight: 700, whiteSpace: 'nowrap' }}>{o.id}</span>
                        <span style={{ fontSize: 12, color: T.text, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.product}</span>
                        <span style={{ fontSize: 11, color: T.textLight, whiteSpace: 'nowrap' }}>{o.buyerCompany}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })()}
          <select value={sfilt} onChange={e => setSfilt(e.target.value)}
            style={{ border: `1px solid ${T.border}`, borderRadius: 8, padding: '7px 12px', fontSize: 13, color: T.text, background: T.surface, fontFamily: 'inherit' }}>
            <option value="All">All Statuses</option>
            {ORDER_STATUSES.map(s => <option key={s}>{s}</option>)}
          </select>
        </div>
        <div className="table-scroll">
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 700 }}>
            <thead>
              <tr style={{ background: '#f8fafc' }}>
                {[
                  { key: 'id', label: 'Order ID' },
                  { key: 'product', label: 'Product' },
                  { key: 'buyer', label: 'Buyer', sortable: true },
                  { key: 'manufacturer', label: 'Manufacturer(s)', sortable: true },
                  { key: 'qty', label: 'Qty' },
                  { key: 'status', label: 'Status' },
                  { key: 'delivery', label: 'Delivery', sortable: true },
                  { key: 'action', label: '' },
                ].map(h => (
                  <th key={h.key} onClick={h.sortable ? () => toggleSort(h.key) : undefined}
                    style={{ padding: '10px 16px', textAlign: 'left', fontSize: 10, fontWeight: 800, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.07em', whiteSpace: 'nowrap', cursor: h.sortable ? 'pointer' : 'default', userSelect: h.sortable ? 'none' : undefined }}>
                    {h.sortable ? (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 8px', borderRadius: 6, background: sortCol === h.key ? T.primaryLight : '#f1f5f9', color: sortCol === h.key ? T.primaryDark : T.textMuted, border: `1px solid ${sortCol === h.key ? '#fed7aa' : T.border}`, transition: 'all 0.15s' }}>
                        {h.label}
                        <span style={{ display: 'inline-flex', flexDirection: 'column', lineHeight: 1, fontSize: 8, gap: 0 }}>
                          <span style={{ color: sortCol === h.key && sortDir === 'asc' ? T.primaryDark : '#cbd5e1' }}>▲</span>
                          <span style={{ color: sortCol === h.key && sortDir === 'desc' ? T.primaryDark : '#cbd5e1' }}>▼</span>
                        </span>
                      </span>
                    ) : h.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.flatMap(o => {
                const visibleAsgns = sfilt === 'All'
                  ? (o.assignments.length > 0 ? o.assignments : [null])
                  : o.assignments.filter(a => a.status === sfilt)
                return visibleAsgns.map((a, ai) => (
                  <tr key={`${o.id}-${ai}`}
                    style={{ borderTop: `1px solid ${T.border}`, cursor: 'pointer' }}
                    onClick={() => onOpen(o.id, a?.mid)}
                    onMouseEnter={e => e.currentTarget.style.background = '#f8fafc'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  >
                    <td style={{ padding: '11px 16px' }}>
                      <Mono style={{ fontSize: 11 }}>{o.id}{a ? `-${a.sub}` : ''}</Mono>
                      {o.masterOrderId && <div style={{ fontSize: 9, color: T.textLight, marginTop: 2 }}>📁 {o.masterOrderId}</div>}
                    </td>
                    <td style={{ padding: '11px 16px', fontWeight: 600, color: T.text, fontSize: 13 }}>{o.product}</td>
                    <td style={{ padding: '11px 16px', color: T.textMuted, fontSize: 13 }}>{o.buyerCompany || '—'}</td>
                    <td style={{ padding: '11px 16px' }}>
                      {a ? (
                        <span style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{a.mfrCompany || '—'}</span>
                      ) : <span style={{ color: T.textMuted }}>—</span>}
                    </td>
                    <td style={{ padding: '11px 16px', color: T.textMuted, fontSize: 13 }}>{a ? a.qty?.toLocaleString() : o.totalQty?.toLocaleString()}</td>
                    <td style={{ padding: '11px 16px' }}>{a ? <Badge status={a.status} /> : '—'}</td>
                    <td style={{ padding: '11px 16px', color: T.textMuted, fontSize: 13 }}>{fmtDate(o.delivery)}</td>
                    <td style={{ padding: '11px 16px' }}>
                      <FlexRow gap={6}>
                        <Btn size="sm" onClick={(e) => { e.stopPropagation(); onOpen(o.id, a?.mid) }}>Manage →</Btn>
                        <Btn size="sm" variant="secondary" onClick={(e) => { e.stopPropagation(); setEditTarget(o) }}>Edit</Btn>
                        <button
                          onClick={(e) => { e.stopPropagation(); setDeleteTarget(o) }}
                          style={{ padding: '4px 10px', fontSize: 11, fontWeight: 700, borderRadius: 6, border: `1px solid ${T.dangerBorder}`, background: T.dangerBg, color: T.danger, cursor: 'pointer', fontFamily: 'inherit' }}
                        >Delete</button>
                      </FlexRow>
                    </td>
                  </tr>
                ))
              })}
              {filtered.length === 0 && <tr><td colSpan={8}><EmptyState icon="📦" title="No orders" desc="Create your first order above" /></td></tr>}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}
