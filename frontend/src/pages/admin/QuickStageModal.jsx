import { useState, useEffect, useRef } from 'react'
import { ArrowRight, X, AlertTriangle, Paperclip, Plus, Pencil } from '../../icons.jsx'
import { T, evidenceTypesFor, productDocForStep, kindForCustomerOwner, stageKindOf, stageStatusOf, stageVariance, stageActualVariance, STAGE_STATUS_LABELS, fmtStageDate, getToday, fmtDateTime } from '../../constants.js'
import { Modal, Select, Textarea, Btn, FlexRow, Input, FileUpload, DocCard, useToast, fileUploadPayload, SectionLabel } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'
import { capsFor, canWriteStage, canEditPlan, canManageStepLists } from '../../caps.js'
import { ordersApi, suppliersApi } from '../../api.js'

// 'YYYY-MM-DD' or 'NA' → the value a native <input type="date"> (or the 'NA'
// text fallback) expects — same helper as AdminOrderDetail's date-adjust modal.
function dateToInput(d) {
  if (d === 'NA') return 'NA'
  if (!d) return ''
  const t = new Date(d)
  return isNaN(t.getTime()) ? '' : t.toISOString().slice(0, 10) // a stored date that will not parse shows blank, not a crash
}


// A material line as the form holds it, and as the API takes it (lib/materialFields.js on the server).
// A standalone factory picks the supplier from its own supplier book (supplierId); the server then writes the name.
const BLANK_MATERIAL = { name: '', requiredQty: '', unit: '', supplier: '', supplierId: '', poNumber: '', expectedDate: '' }
const materialBody = d => ({
  name: d.name.trim(), requiredQty: parseFloat(d.requiredQty), unit: d.unit.trim(),
  ...(d.supplierId ? { supplierId: d.supplierId } : { supplier: d.supplier.trim() }),
  poNumber: d.poNumber.trim(), expectedDate: d.expectedDate || null,
})
const matInput = { width: '100%', boxSizing: 'border-box', border: `1px solid ${T.border}`, borderRadius: 6, padding: '5px 8px', fontSize: 11, fontFamily: 'inherit', minWidth: 0 }
function MaterialFields({ draft, setDraft, suppliers = null }) {
  const field = (k, props) => <input value={draft[k]} onChange={e => setDraft(d => ({ ...d, [k]: e.target.value }))} style={matInput} {...props} />
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 6 }}>
      <div style={{ gridColumn: '1 / -1' }}>{field('name', { placeholder: 'Material name', 'aria-label': 'Material name', maxLength: 200 })}</div>
      {field('requiredQty', { type: 'number', min: '0', placeholder: 'Qty', 'aria-label': 'Quantity' })}
      {field('unit', { placeholder: 'Unit (m, kg, pcs)', 'aria-label': 'Unit', maxLength: 30 })}
      {suppliers
        ? <select value={draft.supplierId} onChange={e => setDraft(d => ({ ...d, supplierId: e.target.value }))} aria-label="Supplier" style={{ ...matInput, background: T.surface, color: draft.supplierId ? T.text : T.textLight }}>
            <option value="">Supplier (optional)</option>
            {suppliers.map(sp => <option key={sp.id} value={sp.id}>{sp.name}</option>)}
          </select>
        : field('supplier', { placeholder: 'Supplier', 'aria-label': 'Supplier', maxLength: 200 })}
      {field('poNumber', { placeholder: 'PO number', 'aria-label': 'PO number', maxLength: 60 })}
      {field('expectedDate', { type: 'date', 'aria-label': 'Expected date', title: 'Expected date' })}
    </div>
  )
}

// The one stage-update modal, used from both the Order Management page
// (clicking a matrix date cell — no navigation, saving leaves you exactly
// where you were) and Order Detail (clicking a stage row) — a single
// component so the two entry points can never drift out of sync with each
// other again. showOpenOrderLink hides the "Open full order" shortcut when
// already on the full order page.
export function QuickStageModal({ orderId, mfrId, stageIndex, onClose, onOpenOrder, showOpenOrderLink = true }) {
  const { currentUser, orders, docs, users, updateStage, setDeliveredQty, addStageUpdate, addStageMaterial, updateStageMaterial, removeStageMaterial, refreshOrders, uploadDoc, getDocData } = useApp()
  const toast = useToast()
  const order = (orders || []).find(o => o.id === orderId)
  const asgn = order?.assignments.find(a => String(a.mid) === String(mfrId))
  const stage = asgn?.stages?.[stageIndex]
  // The same modal serves every role; what each may change follows the server's rules (caps.js).
  const caps = capsFor(currentUser)
  const isMaster = caps.isMaster
  const writable = canWriteStage(currentUser, asgn, stage)
  // Whether this user runs THIS split's calendar: Tradio staff, or the split's own manufacturer in
  // the standalone product. Asked per split, never from the role alone.
  const canPlan = canEditPlan(currentUser, asgn)

  const [description, setDescription] = useState(stage?.description || '')
  const [units, setUnits] = useState(String(stage?.unitsDone ?? 0))
  const [status, setStatus] = useState(stage ? stageStatusOf(stage) : 'not_started')
  const [etaDraft, setEtaDraft] = useState(dateToInput(stage?.eta))
  // Planned/Actual are normally system-managed (frozen baseline, auto-stamped
  // completion) — these two drafts exist only so the master admin can
  // directly correct them, a short-term escape hatch for getting real
  // historical dates into the system. See saveEta().
  const [baselineEtaDraft, setBaselineEtaDraft] = useState(dateToInput(stage?.baselineEta))
  const [actualEndDraft, setActualEndDraft] = useState(dateToInput(stage?.actualEnd))
  const [startDraft, setStartDraft] = useState(dateToInput(stage?.startDate))
  // The description is set once, so it sits at the bottom as text with an Edit link.
  const [editingDesc, setEditingDesc] = useState(false)
  // A customer's approval step is one decision: Approve, or Reject with the reason (it goes into the updates).
  const [rejecting, setRejecting] = useState(false)
  const [rejectReason, setRejectReason] = useState('')
  // Only Tradio marks a step blocked, with the reason everyone else reads on the plan.
  const [blocking, setBlocking] = useState(false)
  const [blockReason, setBlockReason] = useState('')
  const [updateText, setUpdateText] = useState('')
  const [matDraft, setMatDraft] = useState(BLANK_MATERIAL)
  const [matEditing, setMatEditing] = useState(null)   // the line whose details are open for editing
  const [matEdit, setMatEdit] = useState(BLANK_MATERIAL)
  // A factory in the standalone product picks a material's supplier from its own supplier book.
  const [suppliers, setSuppliers] = useState([])
  const wantsSuppliers = caps.manageProcurement && caps.manageMaterials
  useEffect(() => {
    if (!wantsSuppliers) return undefined
    let live = true
    suppliersApi.list().then(list => { if (live) setSuppliers(list) }).catch(() => {})
    return () => { live = false }
  }, [wantsSuppliers])
  const [saving, setSaving] = useState(false)
  const [savingEta, setSavingEta] = useState(false)
  const [savingOwner, setSavingOwner] = useState(false)
  const [savingType, setSavingType] = useState(false)
  // Delivery step only: how many pieces actually went out, against what was ordered.
  const [delQty, setDelQty] = useState(asgn?.deliveredQty == null ? '' : String(asgn.deliveredQty))
  const [savingQty, setSavingQty] = useState(false)

  // Who can own this step: the order's customer first (approvals like Lab Dip and PP Sample sit with
  // them), then Tradio admins and factories. The customer cannot own Delivery, which only Tradio or
  // the factory may close. A manufacturer running its own plan (standalone) never sees a user list:
  // its choices are the companies on this order, the only ones the server accepts.
  const customer = caps.isAdmin
    ? (users || []).find(u => u.role === 'buyer' && u.isActive && String(u.id) === String(order?.buyerId))
    : (order ? { id: String(order.buyerId), company: order.buyerCompany, name: order.buyerCompany } : null)
  const ownerOptions = [
    ...(customer && !stage?.isDelivery ? [{ value: customer.id, label: `Customer: ${customer.company || customer.name}` }] : []),
    ...(caps.isAdmin
      ? [
          ...(users || []).filter(u => u.isActive && u.role === 'admin').map(u => ({ value: u.id, label: `Tradio: ${u.name}` })),
          // The factory listed is the one making this split; another factory could not see the step it was given.
          ...(users || []).filter(u => u.isActive && u.role === 'manufacturer' && String(u.id) === String(mfrId)).map(u => ({ value: u.id, label: `Factory: ${u.company}` })),
        ]
      : (order?.assignments || []).filter(a => String(a.mid) === String(mfrId)).map(a => ({ value: String(a.mid), label: `Factory: ${a.mfrCompany}` }))),
  ]
  const saveOwner = async value => {
    if (savingOwner) return
    setSavingOwner(true)
    try {
      const toCustomer = !!customer && String(value) === String(customer.id)
      const extra = toCustomer ? kindForCustomerOwner(stage) : {}
      await ordersApi.updateStageDates(orderId, mfrId, stageIndex, { responsibleId: value || null, ...extra })
      await refreshOrders()
      toast(value
        ? `Assigned to ${ownerOptions.find(o => o.value === value)?.label || 'the new owner'}${extra.kind ? '. It is now a single approval step so they can close it.' : ''}`
        : 'Owner cleared', 'success')
    } catch (err) {
      toast(err?.message || 'Failed to change the owner', 'error')
    } finally { setSavingOwner(false) }
  }
  // Partial-completion entry is collapsed by default — Mark Stage Done is
  // the action almost everyone wants; the units form is there for the
  // minority of stages where partial progress matters, one click away.
  const [showPartial, setShowPartial] = useState(false)
  // Set right before markStageDone() writes — see its comment.
  const [preCloseUnits, setPreCloseUnits] = useState(null)

  // ── Stage evidence ──
  const [showStageDocs, setShowStageDocs] = useState(false)
  const [sdItems, setSdItems] = useState([{ type: '', name: '', file: null, notes: '', fileErr: '' }])
  const [sdErr, setSdErr] = useState('')

  const uploadedStageDocs = (docs || []).filter(d =>
    d.orderId === orderId && d.stageIndex === stageIndex && d.materialLineIndex == null && (!d.mfrId || String(d.mfrId) === String(mfrId)))   // Tradio-uploaded evidence has no manufacturer

  // Document Name defaults to the stage's own name (e.g. "Lab Dip Approval")
  // rather than starting blank.
  const openStageDocUpload = () => {
    const types = evidenceTypesFor(stageIndex, asgn?.stages)
    setSdItems([{ type: types[0]?.v || '', name: stage?.name || `Stage ${stageIndex + 1}`, file: null, notes: '', fileErr: '' }])
    setSdErr('')
    setShowStageDocs(true)
  }

  const updateSdItem = (idx, patch) => setSdItems(prev => prev.map((item, i) => i === idx ? { ...item, ...patch } : item))

  const addSdItem = () => {
    const types = evidenceTypesFor(stageIndex, asgn?.stages)
    setSdItems(prev => [...prev, { type: types[0]?.v || '', name: stage?.name || `Stage ${stageIndex + 1}`, file: null, notes: '', fileErr: '' }])
  }

  const removeSdItem = (idx) => setSdItems(prev => prev.filter((_, i) => i !== idx))

  const submitStageDoc = async () => {
    // Stage evidence: file OR notes is sufficient (managed via SOP)
    const checked = sdItems.map(item => {
      if (!item.name.trim()) return { ...item, fileErr: 'Enter a document name.' }
      if (!item.file && !item.notes?.trim()) return { ...item, fileErr: 'Attach a file or add notes.' }
      return { ...item, fileErr: '' }
    })
    setSdItems(checked)
    if (checked.some(i => i.fileErr)) return
    setSaving(true)
    let saved = 0
    try {
      for (const item of checked) {
        await uploadDoc({
          type: item.type, name: item.name.trim(), issuer: null,
          issueDate: getToday(), expiryDate: null,
          orderId, mfrId, stageIndex,
          notes: item.notes?.trim() || null,
          ...fileUploadPayload(item.file),
        })
        saved++
        setSdItems(prev => prev.filter(x => x.name !== item.name || x.notes !== item.notes || x.file !== item.file))
      }
      toast(`${saved} stage evidence entr${saved > 1 ? 'ies' : 'y'} saved`, 'success')
      setShowStageDocs(false)
    } catch (e) {
      toast(`${saved ? `Saved ${saved}, then stopped: ` : ''}${e?.message || 'Failed to save stage evidence'}${saved ? '. The saved ones are removed from the list.' : ''}`, 'error')
    } finally { setSaving(false) }
  }

  // Keep the form in step once a save round-trips fresh data back.
  // A field is only replaced when the person has not edited it: otherwise typing a new date or
  // description and then pressing "Mark Stage Done" (which re-renders with the new status) threw
  // the unsaved text away. `synced` remembers what each field last took from the server.
  const synced = useRef(null)
  useEffect(() => {
    if (!stage) return
    const next = {
      description: stage.description || '',
      units: String(stage.unitsDone ?? 0),
      status: stageStatusOf(stage),
      eta: dateToInput(stage.eta),
      baseline: dateToInput(stage.baselineEta),
      actualEnd: dateToInput(stage.actualEnd),
      start: dateToInput(stage.startDate),
    }
    const prev = synced.current
    const follow = (key, set) => set(cur => (!prev || cur === prev[key]) ? next[key] : cur)
    follow('description', setDescription)
    follow('units', setUnits)
    follow('status', setStatus)
    follow('eta', setEtaDraft)
    follow('baseline', setBaselineEtaDraft)
    follow('actualEnd', setActualEndDraft)
    follow('start', setStartDraft)
    synced.current = next
  }, [stage?.description, stage?.unitsDone, stage?.status, stage?.eta, stage?.baselineEta, stage?.actualEnd, stage?.startDate])

  if (!order || !asgn || !stage) return null
  const kind = stageKindOf(stage)
  const isDone = stageStatusOf(stage) === 'done'
  const notStarted = stageStatusOf(stage) === 'not_started' && !((stage.unitsDone || 0) > 0)
  const canEditPlanned = isMaster || (canPlan && notStarted)
  const datesDirty = (canPlan && !!startDraft && startDraft !== dateToInput(stage.startDate))
    || etaDraft !== dateToInput(stage.eta)
    || (canEditPlanned && baselineEtaDraft !== dateToInput(stage.baselineEta))
    || (isMaster && !!actualEndDraft && actualEndDraft !== dateToInput(stage.actualEnd))
  // A customer may only set status on a stage assigned to them, never close a quantity stage.
  const canProgress = writable && !(caps.isBuyer && kind === 'quantity')
  // A factory manages materials only on steps assigned to it; Tradio on any step.
  const canMaterials = caps.manageMaterials && canManageStepLists(currentUser, asgn, stage)
  const canEvidence = caps.uploadStageEvidence && writable

  const saveDescription = async () => {
    setSaving(true)
    try {
      await ordersApi.updateStageDates(orderId, mfrId, stageIndex, { description })
      await refreshOrders()
      toast('Description updated', 'success')
      setEditingDesc(false)
    } catch (err) {
      toast(err?.message || 'Failed to update description', 'error')
    } finally { setSaving(false) }
  }

  // Tradio or the split's own factory records what was delivered. A blank box clears it.
  const canRecordQty = currentUser?.role === 'admin' || (currentUser?.role === 'manufacturer' && String(asgn?.mid) === String(currentUser.id))
  const savedQty = asgn?.deliveredQty == null ? '' : String(asgn.deliveredQty)
  const qtyValid = delQty === '' || (/^\d+$/.test(delQty.trim()) && Number(delQty) <= 1e9)
  const qtyDirty = delQty.trim() !== savedQty
  const saveQty = async () => {
    if (!qtyValid || savingQty) return false
    setSavingQty(true)
    try {
      await setDeliveredQty(orderId, mfrId, delQty.trim() === '' ? null : Number(delQty))
      toast(delQty.trim() === '' ? 'Delivered quantity cleared' : 'Delivered quantity saved', 'success')
      return true
    } catch (err) {
      toast(err?.message || 'Failed to save the delivered quantity', 'error')
      return false
    } finally { setSavingQty(false) }
  }

  const saveStepType = async value => {
    if (savingType) return
    setSavingType(true)
    try {
      await ordersApi.updateStageDates(orderId, mfrId, stageIndex, { kind: value })
      await refreshOrders()
      toast(value === 'milestone' ? 'Now an approval step: one decision, done or not' : 'Now tracked by quantity', 'success')
    } catch (err) {
      toast(err?.message || 'Failed to change the step type', 'error')
    } finally { setSavingType(false) }
  }

  const saveProgress = async () => {
    // Closing Delivery with a quantity typed in saves the quantity too, so the two cannot get out of step.
    if (stage.isDelivery && status === 'done' && canRecordQty && qtyDirty && qtyValid && !(await saveQty())) return
    setSaving(true)
    try {
      const body = kind === 'quantity' ? { unitsDone: parseInt(units, 10) || 0 } : { status }
      const res = await updateStage(orderId, mfrId, stageIndex, body)
      if (res?.warnings?.length) toast(res.warnings[0], 'warning')
      else toast('Stage updated', 'success')
    } catch (err) {
      toast(err?.message || 'Failed to update stage', 'error')
    } finally { setSaving(false) }
  }

  // Quantity-kind close path — skips the units math entirely (see backend's
  // status:'done' handling in the stage-update route's quantity branch).
  // Remembers what unitsDone was right before closing, so Undo can restore
  // real partial progress instead of always dropping back to 0 — but only
  // for this modal session; a stage that was already done when this modal
  // opened has no such memory, so its Undo falls back to reopening at 0.
  const markStageDone = async () => {
    setSaving(true)
    try {
      setPreCloseUnits(stage.unitsDone || 0)
      const res = await updateStage(orderId, mfrId, stageIndex, { status: 'done' })
      if (res?.warnings?.length) toast(res.warnings[0], 'warning')
      else toast('Stage marked done', 'success')
    } catch (err) {
      toast(err?.message || 'Failed to close stage', 'error')
    } finally { setSaving(false) }
  }

  const undoMarkDone = async () => {
    setSaving(true)
    try {
      const res = await updateStage(orderId, mfrId, stageIndex, { unitsDone: preCloseUnits ?? 0 })
      if (res?.warnings?.length) toast(res.warnings[0], 'warning')
      else toast('Stage reopened', 'success')
    } catch (err) {
      toast(err?.message || 'Failed to reopen stage', 'error')
    } finally { setSaving(false) }
  }

  // The New/revised date goes through the same /eta route (and same
  // refreshOrders() refetch) that Order Detail's own date-adjustment modal
  // uses — one write path, so a date changed here is the same stage object
  // Order Detail renders, never a second copy that can drift out of sync.
  const saveEta = async () => {
    const dates = {}
    if (canPlan && startDraft && startDraft !== dateToInput(stage.startDate)) dates.startDate = startDraft
    if (etaDraft !== dateToInput(stage.eta)) dates.eta = etaDraft === 'NA' ? 'NA' : (etaDraft || null)
    // The planned end: whoever runs the plan until the step starts, the master admin at any time (the server checks the same).
    if (canEditPlanned && baselineEtaDraft !== dateToInput(stage.baselineEta)) {
      dates.baselineEta = baselineEtaDraft === 'NA' ? 'NA' : (baselineEtaDraft || null)
    }
    if (isMaster && actualEndDraft && actualEndDraft !== dateToInput(stage.actualEnd)) {
      dates.actualEnd = actualEndDraft
    }
    if (Object.keys(dates).length === 0) return
    setSavingEta(true)
    try {
      await ordersApi.updateStageDates(orderId, mfrId, stageIndex, dates)
      await refreshOrders()
      toast('Dates updated', 'success')
    } catch (err) {
      toast(err?.message || 'Failed to update date', 'error')
    } finally { setSavingEta(false) }
  }

  // Enter pressed twice (or Enter then a click) must post once; `saving` is state and has not
  // flipped yet when the second call arrives, so a ref does the guarding.
  const decide = async approve => {
    setSaving(true)
    try {
      if (approve) { await updateStage(orderId, mfrId, stageIndex, { status: 'done' }); toast('Approved', 'success') }
      else {
        await addStageUpdate(orderId, mfrId, stageIndex, `Rejected: ${rejectReason.trim()}`)
        if (stageStatusOf(stage) !== 'in_progress') await updateStage(orderId, mfrId, stageIndex, { status: 'in_progress' })
        toast('Sent back with your reason', 'success'); setRejecting(false); setRejectReason('')
      }
    } catch (err) { toast(err?.message || 'Could not save your decision', 'error') }
    finally { setSaving(false) }
  }
  const setBlocked = async on => {
    setSaving(true)
    try {
      await updateStage(orderId, mfrId, stageIndex, on ? { blocked: true, blockedReason: blockReason.trim() } : { blocked: false, blockedReason: '' })
      toast(on ? 'Marked blocked' : 'Unblocked', 'success'); setBlocking(false); setBlockReason('')
    } catch (err) { toast(err?.message || 'Could not change the blocked flag', 'error') }
    finally { setSaving(false) }
  }

  const postingRef = useRef(false)
  const postUpdate = async () => {
    if (!updateText.trim() || postingRef.current) return
    postingRef.current = true
    setSaving(true)
    try {
      await addStageUpdate(orderId, mfrId, stageIndex, updateText.trim())
      setUpdateText('')
    } catch (err) {
      toast(err?.message || 'Failed to post update', 'error')
    } finally { postingRef.current = false; setSaving(false) }
  }

  const addMaterial = async () => {
    if (!matDraft.name.trim() || !matDraft.requiredQty) return
    setSaving(true)
    try {
      await addStageMaterial(orderId, mfrId, stageIndex, materialBody(matDraft))
      setMatDraft(BLANK_MATERIAL)
    } catch (err) {
      toast(err?.message || 'Failed to add material', 'error')
    } finally { setSaving(false) }
  }

  const editMaterial = (mi, m) => {
    setMatEditing(mi)
    setMatEdit({ name: m.name || '', requiredQty: String(m.requiredQty ?? ''), unit: m.unit || '', supplier: m.supplier || '', supplierId: m.supplierId ? String(m.supplierId) : '', poNumber: m.poNumber || '', expectedDate: m.expectedDate || '' })
  }
  const saveMaterial = async mi => {
    if (!matEdit.name.trim() || matEdit.requiredQty === '') return
    setSaving(true)
    try { await updateStageMaterial(orderId, mfrId, stageIndex, mi, materialBody(matEdit)); setMatEditing(null) }
    catch (err) { toast(err?.message || 'Failed to save the material', 'error') }
    finally { setSaving(false) }
  }

  const advanceMaterial = async (mi, current) => {
    const next = current === 'pending' ? 'ordered' : current === 'ordered' ? 'received' : 'pending'
    try { await updateStageMaterial(orderId, mfrId, stageIndex, mi, { status: next }) }
    catch (err) { toast(err?.message || 'Failed to update material', 'error') }
  }

  const deleteMaterial = async mi => {
    try { await removeStageMaterial(orderId, mfrId, stageIndex, mi) }
    catch (err) { toast(err?.message || 'Failed to remove material', 'error') }
  }

  return (
    <>
    <Modal title={stage.name} subtitle={`${order.product} · ${asgn.mfrCompany || 'Manufacturer'}`} size="lg" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <SectionLabel>Dates</SectionLabel>
          {(() => {
            const field = { flex: 1, minWidth: 0, border: `1px solid ${T.border}`, borderRadius: 6, padding: '6px 8px', fontSize: 12, fontFamily: 'inherit', boxSizing: 'border-box' }
            const cell = (label, hint, draft, setDraft, editable, saved, { na = true } = {}) => (
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>{label}</div>
                {editable ? (
                  <FlexRow gap={4}>
                    <input type={draft === 'NA' ? 'text' : 'date'} value={draft} readOnly={draft === 'NA'} aria-label={label}
                      onChange={e => setDraft(e.target.value)} style={{ ...field, color: draft === 'NA' ? T.textLight : T.text }} />
                    {na && <button type="button" onClick={() => setDraft(draft === 'NA' ? '' : 'NA')}
                      style={{ flexShrink: 0, background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 10, fontWeight: 700, color: T.primary, padding: '0 2px' }}>{draft === 'NA' ? 'Set date' : 'N/A'}</button>}
                  </FlexRow>
                ) : (
                  <div style={{ fontSize: 13, fontWeight: 700, color: T.text, padding: '6px 0' }}>{fmtStageDate(saved)}</div>
                )}
                {hint && <div style={{ fontSize: 10, color: T.textLight, marginTop: 3 }}>{hint}</div>}
              </div>
            )
            const av = stageActualVariance(stage)
            return (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
                {cell('Start', 'From this day it shows in Action Items.', startDraft, setStartDraft, canPlan, stage.startDate)}
                {cell('Planned end', canEditPlanned ? (isMaster ? undefined : 'Can be corrected until the step starts.') : (canPlan ? 'Fixed once the step started. Use the revised end.' : undefined), baselineEtaDraft, setBaselineEtaDraft, canEditPlanned, stage.baselineEta)}
                {cell('Revised end', canPlan ? 'Move this when the plan slips.' : undefined, etaDraft, setEtaDraft, canPlan, stage.eta)}
                {cell(av != null && av !== 0 ? `Actual end (${av > 0 ? '+' : ''}${av}d)` : 'Actual end', isMaster ? undefined : 'Set when the step is done.', actualEndDraft, setActualEndDraft, isMaster, stage.actualEnd, { na: false })}
              </div>
            )
          })()}
          <FlexRow justify="space-between" style={{ marginTop: 10, alignItems: 'center' }}>
            {(() => {
              const v = stageVariance(stage)
              return v != null && v !== 0
                ? <span style={{ fontSize: 11, color: v > 0 ? T.danger : T.success, fontWeight: 700 }}>{v > 0 ? '+' : ''}{v}d against the planned end</span>
                : <span />
            })()}
            {canPlan && <Btn size="sm" disabled={savingEta || !datesDirty} onClick={saveEta}>{savingEta ? 'Saving…' : 'Save dates'}</Btn>}
          </FlexRow>
        </div>

        <div style={{ borderTop: `1px dashed ${T.border}`, paddingTop: 14 }}>
          <SectionLabel>Progress</SectionLabel>
          {stage.blocked && (
            <div style={{ marginBottom: 10, padding: '9px 12px', borderRadius: 8, background: T.dangerBg, border: `1px solid ${T.dangerBorder}`, fontSize: 12, color: T.danger, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ flex: 1, minWidth: 160 }}><b>Blocked</b>{stage.blockedReason ? `: ${stage.blockedReason}` : ''}</span>
              {currentUser?.role === 'admin' && <Btn size="sm" variant="secondary" disabled={saving} onClick={() => setBlocked(false)}>Unblock</Btn>}
            </div>
          )}
          {currentUser?.role === 'admin' && !stage.blocked && !isDone && (blocking ? (
            <div style={{ marginBottom: 10, display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 220px' }}><Input label="Why is it blocked? *" value={blockReason} onChange={e => setBlockReason(e.target.value)} placeholder="e.g. waiting on trims from the mill" /></div>
              <Btn size="sm" variant="secondary" disabled={saving} onClick={() => { setBlocking(false); setBlockReason('') }}>Cancel</Btn>
              <Btn size="sm" disabled={saving || !blockReason.trim()} onClick={() => setBlocked(true)}>Mark blocked</Btn>
            </div>
          ) : (
            <button type="button" onClick={() => setBlocking(true)} style={{ marginBottom: 8, background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11, fontWeight: 700, color: T.danger, padding: 0 }}>Mark blocked</button>
          ))}
          {stage.isDelivery && (
            <div style={{ marginBottom: 10, padding: '9px 12px', borderRadius: 8, background: '#f0fdf4', border: '1px solid #bbf7d0', fontSize: 12, lineHeight: 1.5, color: '#166534' }}>
              This is the mandatory Delivery step. Marking it done marks this order as delivered; reopening it puts the order back to Processing.
            </div>
          )}
          {stage.isDelivery && (
            <div style={{ marginBottom: 12, padding: '10px 12px', borderRadius: 8, background: '#f8fafc', border: `1px solid ${T.border}` }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Delivered quantity</div>
              {canRecordQty ? (
                <>
                  <FlexRow gap={8} style={{ alignItems: 'center', flexWrap: 'wrap' }}>
                    <input
                      type="number" min={0} inputMode="numeric" value={delQty} placeholder="Pieces delivered"
                      aria-label="Delivered quantity"
                      onChange={e => setDelQty(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') saveQty() }}
                      style={{ width: 150, border: `1px solid ${qtyValid ? T.border : T.danger}`, borderRadius: 6, padding: '6px 8px', fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box' }}
                    />
                    <span style={{ fontSize: 12, color: T.textMuted }}>of {(asgn.qty ?? 0).toLocaleString('en-IN')} ordered</span>
                    {delQty.trim() !== String(asgn.qty) && <button type="button" onClick={() => setDelQty(String(asgn.qty))} style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11, fontWeight: 700, color: T.primary, padding: 0 }}>Same as ordered</button>}
                    <Btn size="sm" variant="secondary" disabled={!qtyDirty || !qtyValid || savingQty} onClick={saveQty}>{savingQty ? 'Saving…' : 'Save quantity'}</Btn>
                  </FlexRow>
                  {qtyValid && delQty.trim() !== '' && Number(delQty) !== asgn.qty && (
                    <div style={{ marginTop: 6, fontSize: 12, fontWeight: 700, color: '#b45309' }}>
                      {Math.abs(Number(delQty) - asgn.qty).toLocaleString('en-IN')} pcs {Number(delQty) < asgn.qty ? 'short of' : 'over'} the order
                    </div>
                  )}
                  {!qtyValid && <div style={{ marginTop: 6, fontSize: 11, color: T.danger }}>Enter a whole number of pieces, 0 or more.</div>}
                </>
              ) : (
                <div style={{ fontSize: 13, color: asgn.deliveredQty == null ? T.textLight : T.text, fontWeight: 600 }}>
                  {asgn.deliveredQty == null ? 'Not recorded yet' : `${asgn.deliveredQty.toLocaleString('en-IN')} of ${(asgn.qty ?? 0).toLocaleString('en-IN')} pcs`}
                </div>
              )}
            </div>
          )}
          {kind === 'quantity' ? (
            <>
              <div style={{ background: '#f8fafc', borderRadius: 10, border: `1px solid ${T.border}`, padding: '10px 14px' }}>
                <FlexRow gap={12} style={{ alignItems: 'center' }}>
                  <div style={{ flex: 1, minWidth: 0, height: 6, background: '#e2e8f0', borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{ height: 6, background: T.primary, borderRadius: 3, width: `${stage.totalUnits > 0 ? (stage.unitsDone / stage.totalUnits) * 100 : 0}%`, transition: 'width 0.3s' }} />
                  </div>
                  {stage.totalUnits > 0 && (
                    <span style={{ fontSize: 11, color: T.textMuted, flexShrink: 0 }}>{Math.round(stage.unitsDone / stage.totalUnits * 100)}%</span>
                  )}
                  {canProgress && (isDone ? (
                    <Btn size="sm" variant="secondary" disabled={saving} onClick={undoMarkDone}>{saving ? 'Saving…' : 'Reopen Stage'}</Btn>
                  ) : (
                    <Btn size="sm" disabled={saving} onClick={markStageDone}>{saving ? 'Saving…' : 'Mark Stage Done'}</Btn>
                  ))}
                </FlexRow>
              </div>
              {canProgress && <button
                onClick={() => setShowPartial(p => !p)}
                style={{ marginTop: 8, background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11.5, fontWeight: 600, color: T.primary, padding: 0 }}
              >
                {showPartial ? 'Hide partial update' : 'Update partial completion'}
              </button>}
              {canProgress && showPartial && (
                <div style={{ marginTop: 10 }}>
                  <Input label={`Units Done (max ${stage.totalUnits})`} type="number" value={units} onChange={e => setUnits(e.target.value)} />
                  <FlexRow justify="flex-end" style={{ marginTop: 8 }}>
                    <Btn size="sm" variant="secondary" disabled={saving} onClick={saveProgress}>{saving ? 'Saving…' : 'Save partial progress'}</Btn>
                  </FlexRow>
                </div>
              )}
            </>
          ) : (
            caps.isBuyer && canProgress ? (
              isDone ? (
                <div style={{ fontSize: 12, fontWeight: 700, color: T.success }}>Approved</div>
              ) : rejecting ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <Textarea label="What needs to change? *" value={rejectReason} onChange={e => setRejectReason(e.target.value)} rows={2} placeholder="e.g. shade is too dark, please resubmit" />
                  <FlexRow justify="flex-end" gap={8}>
                    <Btn size="sm" variant="secondary" disabled={saving} onClick={() => { setRejecting(false); setRejectReason('') }}>Cancel</Btn>
                    <Btn size="sm" disabled={saving || !rejectReason.trim()} onClick={() => decide(false)}>Send back</Btn>
                  </FlexRow>
                </div>
              ) : (
                <FlexRow gap={8}>
                  <Btn size="sm" disabled={saving} onClick={() => decide(true)}>Approve</Btn>
                  <Btn size="sm" variant="secondary" disabled={saving} onClick={() => setRejecting(true)}>Reject</Btn>
                </FlexRow>
              )
            ) : canProgress ? (
              <>
                <Select label="Status" value={status} onChange={e => setStatus(e.target.value)}>
                  {Object.entries(STAGE_STATUS_LABELS).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                </Select>
                <FlexRow justify="flex-end" style={{ marginTop: 8 }}>
                  <Btn size="sm" disabled={saving} onClick={saveProgress}>{saving ? 'Saving…' : 'Save Progress'}</Btn>
                </FlexRow>
              </>
            ) : (
              <div style={{ fontSize: 12, color: T.text, fontWeight: 600 }}>{STAGE_STATUS_LABELS[stageStatusOf(stage)]}</div>
            )
          )}
        </div>

        <div style={{ borderTop: `1px dashed ${T.border}`, paddingTop: 14 }}>
          <SectionLabel>Updates</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8, maxHeight: 180, overflowY: 'auto' }}>
            {(stage.updates || []).length === 0 && <div style={{ fontSize: 11, color: T.textLight }}>No updates yet.</div>}
            {(stage.updates || []).slice().reverse().map((u, ui) => (
              <div key={ui} style={{ background: '#f8fafc', borderRadius: 6, padding: '6px 10px', border: `1px solid ${T.border}` }}>
                <div style={{ fontSize: 11, color: T.text }}>{u.text}</div>
                <div style={{ fontSize: 9, color: T.textLight, marginTop: 2 }}>{u.byUserName || 'Someone'} · {fmtDateTime(u.at)}</div>
              </div>
            ))}
          </div>
          {writable && <FlexRow gap={6}>
            <input
              value={updateText} onChange={e => setUpdateText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') postUpdate() }}
              placeholder="Add a progress update…"
              style={{ flex: 1, border: `1px solid ${T.border}`, borderRadius: 6, padding: '6px 8px', fontSize: 12, fontFamily: 'inherit' }}
            />
            <Btn size="sm" disabled={saving || !updateText.trim()} onClick={postUpdate}>Post</Btn>
          </FlexRow>}
        </div>

        <div style={{ borderTop: `1px dashed ${T.border}`, paddingTop: 14 }}>
          <SectionLabel>Evidence</SectionLabel>
          {uploadedStageDocs.length === 0 && <div style={{ fontSize: 11, color: T.textLight, marginBottom: 8 }}>No evidence uploaded yet.</div>}
          {uploadedStageDocs.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              {uploadedStageDocs.map(d => (
                <DocCard key={d.id} doc={d} users={users} onGetData={getDocData} stageName={stage?.name} />
              ))}
            </div>
          )}
          {canEvidence && <Btn size="sm" variant="outline" onClick={openStageDocUpload} icon={<Paperclip size={12} />}>Upload Evidence</Btn>}
        </div>

        {canPlan && (
          <div style={{ borderTop: `1px dashed ${T.border}`, paddingTop: 14 }}>
            <SectionLabel>Owner and type</SectionLabel>
            <div style={{ fontSize: 11, color: T.textMuted, margin: '2px 0 8px' }}>
              {stage.responsibleRole === 'buyer'
                ? 'With the customer: they approve or reject this step, and are told when it is assigned.'
                : 'Hand an approval step (Lab Dip, PP Sample) to the customer and they will see it in their action items. A quantity step becomes a single approval step.'}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
              <Select label="Owner" value={stage.responsibleId || ''} disabled={savingOwner} onChange={e => saveOwner(e.target.value)}>
                <option value="">Unassigned</option>
                {ownerOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </Select>
              {!stage.isDelivery && kind !== 'checklist' && (
                <Select label="Step type" value={kind} disabled={savingType} onChange={e => saveStepType(e.target.value)}>
                  <option value="quantity">Tracked by quantity</option>
                  <option value="milestone">Approval (one decision)</option>
                </Select>
              )}
            </div>
          </div>
        )}

        <div style={{ borderTop: `1px dashed ${T.border}`, paddingTop: 14 }}>
          <SectionLabel>Materials / PO</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
            {(stage.materials || []).length === 0 && <div style={{ fontSize: 11, color: T.textLight }}>No materials tracked for this stage.</div>}
            {(stage.materials || []).map((m, mi) => {
              const sStyle = m.status === 'received' ? { bg: T.successBg, c: T.success }
                : m.status === 'ordered' ? { bg: T.warningBg, c: T.warning }
                : { bg: '#f1f5f9', c: T.textMuted }
              return (
                matEditing === mi ? (
                  <div key={mi} style={{ background: '#fff', borderRadius: 6, padding: 8, border: `1px solid ${T.primary}` }}>
                    <MaterialFields draft={matEdit} setDraft={setMatEdit} suppliers={wantsSuppliers ? suppliers : null} />
                    <FlexRow justify="flex-end" gap={6} style={{ marginTop: 6 }}>
                      <Btn size="sm" variant="secondary" disabled={saving} onClick={() => setMatEditing(null)}>Cancel</Btn>
                      <Btn size="sm" disabled={saving || !matEdit.name.trim() || matEdit.requiredQty === ''} onClick={() => saveMaterial(mi)}>Save</Btn>
                    </FlexRow>
                  </div>
                ) :
                <FlexRow key={mi} gap={8} style={{ background: '#fff', borderRadius: 6, padding: '6px 10px', border: `1px solid ${T.border}` }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: T.text }}>{m.name} - {m.requiredQty}{m.unit ? ` ${m.unit}` : ''}</div>
                    {(m.supplier || m.poNumber || m.expectedDate || (m.poId && m.orderedQty)) && (
                      <div style={{ fontSize: 10.5, color: T.textMuted, marginTop: 2 }}>
                        {[m.supplier, m.poNumber && `PO ${m.poNumber}`, m.expectedDate && `expected ${fmtStageDate(m.expectedDate)}`, m.poId && m.orderedQty ? `${m.receivedQty || 0} of ${m.orderedQty} received` : ''].filter(Boolean).join(' · ')}
                      </div>
                    )}
                  </div>
                  {/* A line bought on a purchase order is moved, and described, by that PO; it is not edited by hand. */}
                  {canMaterials && !m.poId && <button onClick={() => editMaterial(mi, m)} aria-label={`Edit ${m.name}`} title="Edit details"
                    style={{ background: '#f1f5f9', border: 'none', borderRadius: 6, cursor: 'pointer', width: 20, height: 20, color: T.textMuted, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}><Pencil size={11} /></button>}
                  <button onClick={canMaterials && !m.poId ? () => advanceMaterial(mi, m.status) : undefined} disabled={!canMaterials || !!m.poId}
                    title={m.poId ? 'Updated from the purchase order' : undefined}
                    style={{ fontSize: 9, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: sStyle.bg, color: sStyle.c, border: 'none', cursor: m.poId || !canMaterials ? 'default' : 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
                    {m.status}
                  </button>
                  {canMaterials && <button onClick={() => deleteMaterial(mi)}
                    style={{ background: T.dangerBg, border: 'none', borderRadius: 6, cursor: 'pointer', width: 20, height: 20, color: T.danger, flexShrink: 0 }} aria-label="Close"><X size={12} /></button>}
                </FlexRow>
              )
            })}
          </div>
          {canMaterials && <div>
            <MaterialFields draft={matDraft} setDraft={setMatDraft} suppliers={wantsSuppliers ? suppliers : null} />
            <FlexRow justify="flex-end" style={{ marginTop: 6 }}>
              <Btn size="sm" disabled={saving || !matDraft.name.trim() || !matDraft.requiredQty} onClick={addMaterial} icon={<Plus size={12} />}>Add</Btn>
            </FlexRow>
          </div>}
        </div>

        <div style={{ borderTop: `1px dashed ${T.border}`, paddingTop: 14 }}>
          <FlexRow justify="space-between" style={{ alignItems: 'center' }}>
            <SectionLabel>Description</SectionLabel>
            {canPlan && !editingDesc && <button type="button" onClick={() => setEditingDesc(true)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11, fontWeight: 700, color: T.primary, padding: 0 }}>{stage.description ? 'Edit' : 'Add a description'}</button>}
          </FlexRow>
          {editingDesc ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="What does this step involve?" />
              <FlexRow justify="flex-end" gap={8}>
                <Btn size="sm" variant="secondary" disabled={saving} onClick={() => { setDescription(stage.description || ''); setEditingDesc(false) }}>Cancel</Btn>
                <Btn size="sm" disabled={saving} onClick={saveDescription}>{saving ? 'Saving…' : 'Save description'}</Btn>
              </FlexRow>
            </div>
          ) : (
            <div style={{ fontSize: 12, color: stage.description ? T.text : T.textLight }}>{stage.description || 'No description.'}</div>
          )}
        </div>

        <FlexRow justify="flex-end" gap={8}>
          {showOpenOrderLink && (
            <Btn variant="ghost" onClick={() => { onClose(); onOpenOrder(orderId, mfrId) }}>Open full order <ArrowRight size={13} style={{ marginLeft: -2 }} /></Btn>
          )}
          <Btn variant="secondary" onClick={onClose}>Close</Btn>
        </FlexRow>
      </div>
    </Modal>

    {showStageDocs && (
      <Modal title="Upload Stage Evidence" subtitle={`${stage?.name || `Stage ${stageIndex + 1}`} - Evidence Documents`} onClose={() => setShowStageDocs(false)} size="lg">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ fontSize: 12, color: T.textMuted, background: '#f0f7ff', border: `1px solid #dbeafe`, borderRadius: 8, padding: '8px 12px' }}>
            Linked to the {stage?.name || `Stage ${stageIndex + 1}`} stage. Attach a file/link, or add SOP notes only - either is sufficient.
            {productDocForStep(stage?.name) && ` It is also filed under "${productDocForStep(stage?.name).label}" in this product's documents, so there is no need to upload it again.`}
          </div>
          {sdItems.map((item, idx) => (
            <div key={idx} style={{ border: `1px solid ${T.border}`, borderRadius: 10, padding: '14px 16px', background: '#f8fafc', position: 'relative' }}>
              {sdItems.length > 1 && (
                <button onClick={() => removeSdItem(idx)} style={{ position: 'absolute', top: 10, right: 10, background: '#fee2e2', border: 'none', borderRadius: 6, cursor: 'pointer', width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, color: T.danger }} aria-label="Close"><X size={12} /></button>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <Input label="Document Name *" value={item.name} onChange={e => updateSdItem(idx, { name: e.target.value, fileErr: '' })} placeholder={`e.g. ${stage?.name || `Stage ${stageIndex + 1}`} GRN - Batch ${idx + 1}`} />
                <FileUpload file={item.file} onFile={f => updateSdItem(idx, { file: f, fileErr: '' })} error={item.fileErr} onError={err => updateSdItem(idx, { fileErr: err })} />
                <Textarea
                  label="Notes (optional - text evidence)"
                  value={item.notes}
                  onChange={e => updateSdItem(idx, { notes: e.target.value, fileErr: '' })}
                  placeholder="Add SOP context, observations, or text-only stage evidence…"
                  rows={3}
                />
              </div>
            </div>
          ))}
          {sdErr && <div style={{ fontSize: 12, color: T.danger, fontWeight: 500 }}><AlertTriangle size={12} style={{ verticalAlign: -2, marginRight: 4 }} /> {sdErr}</div>}
          <FlexRow justify="space-between" gap={8} style={{ flexWrap: 'wrap' }}>
            <Btn variant="secondary" size="sm" onClick={addSdItem} icon={<Plus size={12} />}>Add Another Document</Btn>
            <FlexRow gap={8}>
              <Btn variant="secondary" onClick={() => setShowStageDocs(false)}>Cancel</Btn>
              <Btn disabled={saving} onClick={submitStageDoc}>{saving ? 'Uploading…' : `Upload ${sdItems.length > 1 ? `${sdItems.length} Documents` : 'Evidence'}`}</Btn>
            </FlexRow>
          </FlexRow>
        </div>
      </Modal>
    )}
    </>
  )
}
