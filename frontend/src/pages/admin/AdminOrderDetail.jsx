import { useState, useMemo, Fragment } from 'react'
import Papa from 'papaparse'
import { Paperclip, Image as ImageIcon, AlertTriangle, Pencil, ShieldAlert, ClipboardEdit, Package, MessageCircle, Check, Plus, FileText, FileSpreadsheet, ArrowLeftRight, ArrowLeft, X, Download, ChevronRight } from 'lucide-react'
import {
  T, ORDER_STATUSES, STAGE_DOC_MAP, DOC_ICONS,
  stageKindOf, stageStatusOf, stageIsOverdue, stageVariance, stageActualVariance, isStageDone, effectiveEta,
  stagePct, stageProgressLabel, STAGE_STATUS_LABELS, dayNumber,
  PATTERN_FILE_PROPS, MEASUREMENTS_FILE_PROPS, resolveNamedColor,
} from '../../constants.js'
import { Modal, Select, Textarea, Btn, Card, Badge, Alert, FlexRow, Mono, Input, Tabs, StageTimeline, FileUpload, DocCard, SectionLabel, LoadingScreen, MfrProfileLink, StageDocGroup, EmptyState, useToast, dataUrlToBlobUrl, fileUploadPayload, ProductThumb, activateOnKey } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'
import { ordersApi } from '../../api.js'
import { EditOrderModal } from './EditOrderModal.jsx'
import { DeleteOrderModal } from './DeleteOrderModal.jsx'
import { QuickStageModal } from './QuickStageModal.jsx'

function fmtDate(d) {
  if (!d) return '—'
  const dt = new Date(d)
  const dd = String(dt.getDate()).padStart(2, '0')
  const mm = String(dt.getMonth() + 1).padStart(2, '0')
  return `${dd}-${mm}-${dt.getFullYear()}`
}

export function AdminOrderDetail({ orderId, initialMid, onBack }) {
  const { currentUser, orders, docs, users, loading, updateAssignment, updateStage, uploadDoc, getDocData, refreshOrders, editOrder, deleteOrder,
    addStageUpdate, addStageMaterial, updateStageMaterial, removeStageMaterial,
    addStageItem, updateStageItem, removeStageItem, addAssignment, insertStage } = useApp()
  const toast = useToast()
  const isMaster = currentUser?.adminType === 'master'

  const [showEdit, setShowEdit] = useState(false)
  const [showDelete, setShowDelete] = useState(false)

  const [tab, setTab] = useState('production')
  const [viewerBlob, setViewerBlob] = useState(null)
  const [viewerName, setViewerName] = useState('')
  const [viewerLoading, setViewerLoading] = useState(false)
  const closeViewer = () => { if (viewerBlob) { viewerBlob.revoke(); setViewerBlob(null) }; setViewerLoading(false) }
  // Shared by every stage-evidence/PO chip — factored out once so the keyboard
  // path (onKeyDown) can call the exact same logic as the click path, instead
  // of duplicating this async body a second time per chip.
  const openDocViewer = async (d) => {
    try {
      setViewerName(d.name)
      setViewerLoading(true)
      setViewerBlob(null)
      const data = await getDocData(d.id)
      if (!data?.dataUrl) { setViewerLoading(false); return }
      const blob = dataUrlToBlobUrl(data.dataUrl)
      if (!blob) { setViewerLoading(false); return }
      setViewerBlob(blob)
    } catch { setViewerLoading(false) }
  }

  // Status override modal
  const [showSt, setShowSt] = useState(false)
  const [stTarget, setStTarget] = useState(null) // mfrId
  const [stStatus, setStStatus] = useState('')
  const [stNote, setStNote] = useState('')

  // Stage override modal (master admin only — bypasses materials gating)
  const [showStage, setShowStage] = useState(false)
  const [sgTarget, setSgTarget] = useState(null) // mfrId
  const [sgIndex, setSgIndex] = useState(0)
  const [sgUnits, setSgUnits] = useState('')
  const [sgNote, setSgNote] = useState('')

  // Update Stage modal — opened by clicking a stage row. The same
  // QuickStageModal component the Order Management page's matrix cells
  // open, so the two entry points can never drift out of sync.
  const [quickStage, setQuickStage] = useState(null) // { mfrId, stageIndex } or null

  // Stage dates (start/end) adjustment modal
  const [showEta, setShowEta] = useState(false)
  const [etaTarget, setEtaTarget] = useState(null) // mfrId
  const [etaValues, setEtaValues] = useState([]) // array of end-date strings
  const [startValues, setStartValues] = useState([]) // array of start-date strings
  const [responsibleValues, setResponsibleValues] = useState([]) // array of responsibleId strings
  const [totalUnitsValues, setTotalUnitsValues] = useState([]) // array of target-qty strings — not every stage tracks the full order qty
  const [descriptionValues, setDescriptionValues] = useState([]) // array of stage description strings

  // Prompt to copy this save's responsibility changes to matching-named stages on
  // every other order under the same master order (offered only when there's a
  // sibling order to apply to, and only for stages whose responsible person changed).
  const [showApplyAll, setShowApplyAll] = useState(false)
  const [pendingRespChanges, setPendingRespChanges] = useState([]) // [{stageName, responsibleId}]

  // Per-stage updates thread + materials checklist (expand, in the stage grid)
  const [expandedStage, setExpandedStage] = useState(null) // `${mfrId}:${stageIndex}` or null
  const [updateDrafts, setUpdateDrafts] = useState({})
  const [materialDrafts, setMaterialDrafts] = useState({}) // keyed by `${mfrId}:${stageIndex}` -> new-line form

  // Doc upload modal
  const [showUp, setShowUp] = useState(false)
  const [uf, setUf] = useState({ type: 'PO', name: '', issuer: 'Tradio', issueDate: new Date().toISOString().slice(0, 10), expiryDate: '' })
  const [fileData, setFileData] = useState(null)
  const [fileErr, setFileErr] = useState('')

  // Stage doc upload modal
  const [showStageDocs, setShowStageDocs] = useState(false)
  const [sdMfrId, setSdMfrId] = useState(null)
  const [sdStageIdx, setSdStageIdx] = useState(0)
  const [sdItems, setSdItems] = useState([{ type: '', name: '', file: null, notes: '', fileErr: '' }])
  const [sdErr, setSdErr] = useState('')

  // Material PO attachment modal
  const [showMaterialPo, setShowMaterialPo] = useState(false)
  const [mpMfrId, setMpMfrId] = useState(null)
  const [mpStageIdx, setMpStageIdx] = useState(0)
  const [mpLineIdx, setMpLineIdx] = useState(0)
  const [mpFile, setMpFile] = useState(null)
  const [mpFileErr, setMpFileErr] = useState('')

  const [saving, setSaving] = useState(false)
  const [selectedMid, setSelectedMid] = useState(initialMid || null)

  // ── Unassigned style: "Add Manufacturer" + lightweight document upload ──
  const [newMfrId, setNewMfrId] = useState('')
  const [newMfrQty, setNewMfrQty] = useState('')
  const [addingMfr, setAddingMfr] = useState(false)
  const [refDocFiles, setRefDocFiles] = useState({ measurements: null, tech_pack: null, pattern: null })
  const [refDocErrs, setRefDocErrs] = useState({})
  const [refDocUploading, setRefDocUploading] = useState(null) // which type is mid-upload
  const [heroPhotoFile, setHeroPhotoFile] = useState(null)
  const [heroPhotoErr, setHeroPhotoErr] = useState('')
  const [heroPhotoUploading, setHeroPhotoUploading] = useState(false)
  const [expandedDocKey, setExpandedDocKey] = useState(null) // which pending checklist row is open for upload

  // ── Manual TNA builder — one stage at a time, for an assignment that has
  // none yet. Keyed by mfrId so each assignment card keeps its own draft.
  const [newStageDrafts, setNewStageDrafts] = useState({})
  const [addingStage, setAddingStage] = useState(null) // mfrId mid-add
  const newStageDraft = mid => newStageDrafts[mid] || { name: '', startDate: '', eta: '', kind: 'quantity' }
  const setNewStageDraft = (mid, patch) => setNewStageDrafts(p => ({ ...p, [mid]: { ...newStageDraft(mid), ...patch } }))

  // ── TNA builder mode + CSV import — alternative to the manual one-at-a-time
  // form above, for pasting in a whole plan at once. Keyed by mfrId.
  const [tnaCsvOpen, setTnaCsvOpen] = useState({}) // mid -> bool — always-available bulk upload, any TNA size
  const [tnaCsvRows, setTnaCsvRows] = useState({}) // mid -> parsed+validated rows
  const [tnaCsvErr, setTnaCsvErr] = useState({}) // mid -> file-level error
  const [tnaCsvImporting, setTnaCsvImporting] = useState(null) // mid mid-import
  const TNA_CSV_HEADERS = ['name', 'kind', 'start_date', 'end_date', 'target_qty', 'description', 'responsible_email']

  const downloadTnaCsvTemplate = () => {
    const sample = [
      ['Lab Dip Approval', 'checklist', '2026-01-05', '2026-01-12', '', 'Get lab dips approved for all colourways', ''],
      ['Material Sourcing', 'quantity', '2026-01-10', '2026-01-25', '', '', ''],
    ]
    const csv = [TNA_CSV_HEADERS, ...sample].map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'tna-template.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  const parseTnaCsv = (mid, file) => {
    Papa.parse(file, {
      header: true, skipEmptyLines: true,
      complete: (results) => {
        const rows = results.data.map((raw, i) => {
          const name = (raw.name || '').trim()
          const startDate = (raw.start_date || '').trim()
          const endDate = (raw.end_date || '').trim()
          const kind = (raw.kind || '').trim().toLowerCase() || 'quantity'
          const targetQty = (raw.target_qty || '').trim()
          const description = (raw.description || '').trim()
          const responsibleEmail = (raw.responsible_email || '').trim()
          const errors = []
          if (!name) errors.push('missing name')
          if (!startDate) errors.push('missing start_date')
          if (!endDate) errors.push('missing end_date')
          if (!['quantity', 'milestone', 'checklist'].includes(kind)) errors.push(`invalid kind "${kind}"`)
          let responsibleId = null
          if (responsibleEmail) {
            const u = users.find(x => (x.email || '').toLowerCase() === responsibleEmail.toLowerCase())
            if (!u) errors.push(`unknown responsible_email "${responsibleEmail}"`)
            else responsibleId = u.id
          }
          return { row: i + 2, name, kind, startDate, eta: endDate, targetQty, description, responsibleId, errors }
        }).filter(r => r.name || r.startDate || r.eta) // skip fully blank rows
        setTnaCsvRows(p => ({ ...p, [mid]: rows }))
      },
      error: (err) => setTnaCsvErr(p => ({ ...p, [mid]: err.message || 'Failed to read CSV' })),
    })
  }

  const importTnaCsv = async (mid) => {
    const rows = (tnaCsvRows[mid] || []).filter(r => r.errors.length === 0)
    if (rows.length === 0) return
    setTnaCsvImporting(mid)
    let imported = 0
    try {
      for (const r of rows) {
        await insertStage(order.id, mid, {
          name: r.name, kind: r.kind, startDate: r.startDate, eta: r.eta,
          totalUnits: r.targetQty || undefined, description: r.description || undefined,
          responsibleId: r.responsibleId || undefined,
        })
        imported++
      }
      toast(`${imported} stage${imported !== 1 ? 's' : ''} imported`, 'success')
      setTnaCsvRows(p => ({ ...p, [mid]: [] }))
      setTnaCsvOpen(p => ({ ...p, [mid]: false }))
    } catch (e) {
      toast(`Imported ${imported} of ${rows.length} before failing: ${typeof e === 'string' ? e : (e?.message || 'error')}`, 'error')
    } finally { setTnaCsvImporting(null) }
  }

  const order = (orders || []).find(o => o.id === orderId)

  const currentStageData = useMemo(() => {
    if (!sgTarget || !order) return null
    const asgn = order.assignments.find(a => String(a.mid) === String(sgTarget))
    return asgn?.stages?.[sgIndex] || null
  }, [order, sgTarget, sgIndex])

  if (loading) return <LoadingScreen />
  if (!order) return null

  const responsibleUsers = users.filter(u => (u.role === 'admin' || u.role === 'manufacturer') && u.isActive)

  const effectiveMid = selectedMid || (order.assignments?.length === 1 ? String(order.assignments[0]?.mid) : null)
  const selectedAsgn = order.assignments?.find(a => String(a.mid) === effectiveMid) || null

  const orderDocs = docs.filter(d => String(d.orderId) === String(order.id) && d.isActive !== false)
  const mfrDocs = docs.filter(d => d.mfrId && d.stageIndex == null && (order.assignments || []).some(a => String(a.mid) === String(d.mfrId)) && d.isActive !== false)
  const txnDocs = effectiveMid
    ? orderDocs.filter(d => d.stageIndex == null || String(d.mfrId || '') === effectiveMid)
    : orderDocs
  const stageDocs = effectiveMid
    ? orderDocs.filter(d => d.stageIndex != null && String(d.mfrId || '') === effectiveMid)
    : []

  const resetUpload = () => { setUf({ type: 'PO', name: '', issuer: 'Tradio', issueDate: new Date().toISOString().slice(0, 10), expiryDate: '' }); setFileData(null); setFileErr('') }

  // ── Stage Dates Adjustment ──
  const dateToInput = d => d === 'NA' ? 'NA' : (d ? new Date(d).toISOString().slice(0, 10) : '')

  const openEtaAdjust = (mfrId) => {
    const asgn = order.assignments.find(a => String(a.mid) === String(mfrId))
    setEtaTarget(mfrId)
    setStartValues((asgn?.stages || []).map(s => dateToInput(s.startDate)))
    setEtaValues((asgn?.stages || []).map(s => dateToInput(s.eta)))
    setResponsibleValues((asgn?.stages || []).map(s => s.responsibleId || ''))
    setTotalUnitsValues((asgn?.stages || []).map(s => s.totalUnits?.toString() || ''))
    setDescriptionValues((asgn?.stages || []).map(s => s.description || ''))
    setShowEta(true)
  }

  const submitEtaAdjust = async () => {
    setSaving(true)
    try {
      const asgn = order.assignments.find(a => String(a.mid) === String(etaTarget))
      const stageCount = asgn?.stages?.length || 0
      let changed = false
      const respChanges = []
      for (let i = 0; i < stageCount; i++) {
        const stage = asgn?.stages?.[i]
        const oldStart = dateToInput(stage?.startDate)
        const oldEta = dateToInput(stage?.eta)
        const oldResponsible = stage?.responsibleId || ''
        const oldTotalUnits = stage?.totalUnits?.toString() || ''
        const oldDescription = stage?.description || ''
        const startChanged = startValues[i] !== oldStart
        const etaChanged = etaValues[i] !== oldEta
        const responsibleChanged = (responsibleValues[i] || '') !== oldResponsible
        const totalUnitsChanged = (totalUnitsValues[i] || '') !== oldTotalUnits && (totalUnitsValues[i] || '').trim() !== ''
        const descriptionChanged = (descriptionValues[i] || '') !== oldDescription
        if (startChanged || etaChanged || responsibleChanged || totalUnitsChanged || descriptionChanged) {
          const dates = {}
          if (startChanged) dates.startDate = startValues[i] === 'NA' ? 'NA' : startValues[i] || null
          if (etaChanged) dates.eta = etaValues[i] === 'NA' ? 'NA' : etaValues[i] || null
          if (responsibleChanged) dates.responsibleId = responsibleValues[i] || null
          if (totalUnitsChanged) dates.totalUnits = parseInt(totalUnitsValues[i], 10)
          if (descriptionChanged) dates.description = descriptionValues[i] || ''
          await ordersApi.updateStageDates(order.id, etaTarget, i, dates)
          changed = true
          if (responsibleChanged && stage?.name) respChanges.push({ stageName: stage.name, responsibleId: responsibleValues[i] || null })
        }
      }
      if (changed) {
        await refreshOrders()
        toast('Stage dates updated successfully', 'success')
      } else {
        toast('No date changes to save', 'info')
      }
      setShowEta(false)

      // Offer to copy responsibility changes to matching-named stages on sibling
      // orders under the same master order, if any exist.
      if (respChanges.length > 0 && order.masterOrderId) {
        const hasSiblings = orders.some(o => o.masterOrderId === order.masterOrderId && o.id !== order.id)
        if (hasSiblings) {
          setPendingRespChanges(respChanges)
          setShowApplyAll(true)
        }
      }
    } catch (err) {
      toast(err?.message || 'Failed to update stage dates', 'error')
    } finally { setSaving(false) }
  }

  // Copies pendingRespChanges (this order's just-saved responsibility assignments)
  // onto every other order sharing the same master order, matched by stage name
  // (stage sets can differ per order/style, so index-matching would be unsafe).
  const applyResponsibilityToMasterOrder = async () => {
    setSaving(true)
    try {
      const siblings = orders.filter(o => o.masterOrderId === order.masterOrderId && o.id !== order.id)
      let updateCount = 0
      for (const sib of siblings) {
        for (const sAsgn of (sib.assignments || [])) {
          for (let idx = 0; idx < (sAsgn.stages || []).length; idx++) {
            const sStage = sAsgn.stages[idx]
            const match = pendingRespChanges.find(c => c.stageName.trim().toLowerCase() === (sStage.name || '').trim().toLowerCase())
            if (match && (sStage.responsibleId || null) !== (match.responsibleId || null)) {
              await ordersApi.updateStageDates(sib.id, sAsgn.mid, idx, { responsibleId: match.responsibleId })
              updateCount++
            }
          }
        }
      }
      await refreshOrders()
      toast(updateCount > 0 ? `Responsibility applied to ${updateCount} stage(s) across ${siblings.length} order(s)` : 'No matching stages found on other orders', 'success')
    } catch (err) {
      toast(err?.message || 'Failed to apply to other orders', 'error')
    } finally {
      setSaving(false)
      setShowApplyAll(false)
      setPendingRespChanges([])
    }
  }

  // ── Stage updates thread + materials checklist (expand row) ──
  const submitStageUpdateNote = async (mfrId, stageIndex) => {
    const key = `${mfrId}:${stageIndex}`
    const text = (updateDrafts[key] || '').trim()
    if (!text) return
    try {
      await addStageUpdate(order.id, mfrId, stageIndex, text)
      setUpdateDrafts(d => ({ ...d, [key]: '' }))
    } catch (err) {
      toast(err?.message || 'Failed to add update', 'error')
    }
  }

  // Checklist items — the deliverables a step actually produces (three lab dips,
  // one per colourway). Generating from the order's colourway list beats typing
  // the same colour names onto every per-colour step.
  const generateItemsFromColourways = async (mfrId, stageIndex, stageName) => {
    try {
      await addStageItem(order.id, mfrId, stageIndex, { name: stageName, fromColourways: true })
    } catch (err) {
      toast(err?.message || 'Could not create checklist items', 'error')
    }
  }

  const toggleStageItem = async (mfrId, stageIndex, lineIndex, current) => {
    try {
      await updateStageItem(order.id, mfrId, stageIndex, lineIndex, { status: current === 'done' ? 'pending' : 'done' })
    } catch (err) {
      toast(err?.message || 'Could not update item', 'error')
    }
  }

  const emptyMaterialDraft = { name: '', requiredQty: '', unit: '', supplier: '', poNumber: '', expectedDate: '' }
  const submitAddMaterial = async (mfrId, stageIndex) => {
    const key = `${mfrId}:${stageIndex}`
    const draft = materialDrafts[key] || emptyMaterialDraft
    if (!draft.name.trim() || !draft.requiredQty) return
    try {
      await addStageMaterial(order.id, mfrId, stageIndex, {
        name: draft.name.trim(), requiredQty: draft.requiredQty, unit: draft.unit,
        supplier: draft.supplier, poNumber: draft.poNumber, expectedDate: draft.expectedDate || null,
      })
      setMaterialDrafts(d => ({ ...d, [key]: emptyMaterialDraft }))
    } catch (err) {
      toast(err?.message || 'Failed to add material', 'error')
    }
  }

  const advanceMaterialStatus = async (mfrId, stageIndex, lineIndex, currentStatus) => {
    const next = currentStatus === 'pending' ? 'ordered' : currentStatus === 'ordered' ? 'received' : 'pending'
    try {
      await updateStageMaterial(order.id, mfrId, stageIndex, lineIndex, { status: next })
    } catch (err) {
      toast(err?.message || 'Failed to update material', 'error')
    }
  }

  const deleteMaterial = async (mfrId, stageIndex, lineIndex) => {
    try {
      await removeStageMaterial(order.id, mfrId, stageIndex, lineIndex)
    } catch (err) {
      toast(err?.message || 'Failed to delete material', 'error')
    }
  }

  // ── Material PO attachment ──
  const openMaterialPoUpload = (mfrId, stageIndex, lineIndex) => {
    setMpMfrId(mfrId)
    setMpStageIdx(stageIndex)
    setMpLineIdx(lineIndex)
    setMpFile(null)
    setMpFileErr('')
    setShowMaterialPo(true)
  }

  const submitMaterialPo = async () => {
    if (!mpFile) { setMpFileErr('Please select a file.'); return }
    setSaving(true)
    try {
      const asgn = order.assignments.find(a => String(a.mid) === String(mpMfrId))
      const material = asgn?.stages?.[mpStageIdx]?.materials?.[mpLineIdx]
      await uploadDoc({
        type: 'material_po', name: material?.name ? `${material.name} — PO` : 'Material PO',
        orderId: order.id, mfrId: mpMfrId, stageIndex: mpStageIdx, materialLineIndex: mpLineIdx,
        ...fileUploadPayload(mpFile),
      })
      toast('PO document attached', 'success')
      setShowMaterialPo(false)
    } catch (err) {
      toast(err?.message || 'Failed to attach PO document', 'error')
    } finally { setSaving(false) }
  }

  // ── Status Override ──
  const openStatusOverride = (mfrId, currentStatus) => {
    setStTarget(mfrId)
    setStStatus(currentStatus)
    setStNote('')
    setShowSt(true)
  }

  const submitStatusOverride = async () => {
    if (!stNote.trim()) return
    setSaving(true)
    try {
      await updateAssignment(order.id, stTarget, stStatus, `[Admin Override] ${stNote}`)
      toast(`Status updated to "${stStatus}"`, 'success')
      setShowSt(false)
    } catch {
      toast('Failed to update status', 'error')
    } finally { setSaving(false) }
  }

  // ── Stage Override ──
  const openStageOverride = (mfrId, stageIndex = 0) => {
    const asgn = order.assignments.find(a => String(a.mid) === String(mfrId))
    setSgTarget(mfrId)
    setSgIndex(stageIndex)
    setSgUnits(asgn?.stages?.[stageIndex]?.unitsDone?.toString() || '0')
    setSgNote('')
    setShowStage(true)
  }

  const submitStageOverride = async () => {
    if (!sgNote.trim()) return
    setSaving(true)
    try {
      const units = parseInt(sgUnits) || 0
      await updateStage(order.id, sgTarget, sgIndex, {
        unitsDone: units,
        note: `[Admin Override] ${sgNote}`,
        override: true,
      })
      toast('Stage progress updated', 'success')
      setShowStage(false)
    } catch (err) {
      toast(err?.message || 'Failed to update stage', 'error')
    } finally { setSaving(false) }
  }

  // ── Update Stage modal — opens the shared QuickStageModal ──
  const openUpdateStage = (mfrId, stageIndex) => setQuickStage({ mfrId, stageIndex })

  // ── Doc Upload ──
  const submitDoc = async () => {
    if (!fileData) { setFileErr('Please select a file.'); return }
    setSaving(true)
    try {
      await uploadDoc({ ...uf, expiryDate: uf.expiryDate || null, orderId: order.id, mfrId: null, ...fileUploadPayload(fileData) })
      toast('Document uploaded', 'success')
      setShowUp(false); resetUpload()
    } catch {
      toast('Failed to upload document', 'error')
    } finally { setSaving(false) }
  }

  // ── Stage Doc Upload ──
  // Document Name defaults to the stage's own name (e.g. "Lab Dip Approval")
  // rather than starting blank — before this, whatever the uploader typed
  // showed up as the evidence name, which drifted into inconsistent/"random"
  // names across otherwise-identical stages. Still freely editable.
  const stageNameFor = (mfrId, stageIdx) =>
    order.assignments.find(a => String(a.mid) === String(mfrId))?.stages?.[stageIdx]?.name || `Stage ${stageIdx + 1}`

  const openStageDocUpload = (mfrId, stageIdx) => {
    const types = STAGE_DOC_MAP[stageIdx] || []
    setSdMfrId(mfrId)
    setSdStageIdx(stageIdx)
    setSdItems([{ type: types[0]?.v || '', name: stageNameFor(mfrId, stageIdx), file: null, notes: '', fileErr: '' }])
    setSdErr('')
    setShowStageDocs(true)
  }

  const updateSdItem = (idx, patch) => setSdItems(prev => prev.map((item, i) => i === idx ? { ...item, ...patch } : item))

  const addSdItem = () => {
    const types = STAGE_DOC_MAP[sdStageIdx] || []
    setSdItems(prev => [...prev, { type: types[0]?.v || '', name: stageNameFor(sdMfrId, sdStageIdx), file: null, notes: '', fileErr: '' }])
  }

  const removeSdItem = (idx) => setSdItems(prev => prev.filter((_, i) => i !== idx))

  const submitStageDoc = async () => {
    // Stage evidence: file OR notes is sufficient (managed via SOP)
    let hasErr = false
    setSdItems(prev => prev.map(item => {
      if (!item.name.trim()) { hasErr = true; return { ...item, fileErr: 'Enter a document name.' } }
      if (!item.file && !item.notes?.trim()) { hasErr = true; return { ...item, fileErr: 'Attach a file or add notes.' } }
      return { ...item, fileErr: '' }
    }))
    if (hasErr) return
    setSaving(true)
    try {
      for (const item of sdItems) {
        await uploadDoc({
          type: item.type, name: item.name.trim(), issuer: null,
          issueDate: new Date().toISOString().slice(0, 10), expiryDate: null,
          orderId: order.id, mfrId: sdMfrId, stageIndex: sdStageIdx,
          notes: item.notes?.trim() || null,
          ...fileUploadPayload(item.file),
        })
      }
      toast(`${sdItems.length} stage evidence entr${sdItems.length > 1 ? 'ies' : 'y'} saved`, 'success')
      setShowStageDocs(false)
    } catch {
      toast('Failed to save stage evidence', 'error')
    } finally { setSaving(false) }
  }

  const orderDocTypes = [
    { v: 'PO', l: 'Purchase Order' }, { v: 'buyer_order', l: 'Buyer Order' },
    { v: 'tech_pack', l: 'Tech Pack' },
    { v: 'cost_sheet', l: 'Cost Sheet' }, { v: 'RFQ', l: 'RFQ' },
    { v: 'terms', l: 'Terms & Conditions' },
  ]

  const overallStatus = () => {
    if (order.assignments.some(a => a.status === 'Delayed')) return 'Delayed'
    if (order.assignments.some(a => a.status === 'On Hold')) return 'On Hold'
    if (order.assignments.length > 0 && order.assignments.every(a => a.status === 'Delivered')) return 'Delivered'
    return 'Processing'
  }

  const mfrUsers = users.filter(u => u.role === 'manufacturer' && u.isActive)
  const refDocLabels = { measurements: 'Measurements', tech_pack: 'Tech Pack', pattern: 'Patterns / DXF', lab_dip: 'Lab Dip Receipts', test_report: 'Test Reports (FPT/GPT)' }

  const uploadRefDoc = async (type) => {
    const file = refDocFiles[type]
    if (!file) return
    setRefDocUploading(type)
    try {
      await uploadDoc({
        type, name: `${refDocLabels[type]} — ${order.id}`, issuer: '', issueDate: new Date().toISOString().slice(0, 10),
        expiryDate: null, orderId: order.id, mfrId: null,
        ...fileUploadPayload(file),
      })
      setRefDocFiles(p => ({ ...p, [type]: null }))
      toast(`${refDocLabels[type]} uploaded`, 'success')
    } catch (e) {
      toast(typeof e === 'string' ? e : (e?.message || 'Upload failed'), 'error')
    } finally { setRefDocUploading(null) }
  }

  const uploadHeroPhoto = async () => {
    if (!heroPhotoFile) return
    setHeroPhotoUploading(true)
    try {
      const p = fileUploadPayload(heroPhotoFile)
      await editOrder(order.id, { imageDataUrl: p.dataUrl || null, imageUrl: p.externalUrl || null })
      setHeroPhotoFile(null)
      toast('Product image updated', 'success')
    } catch (e) {
      toast(typeof e === 'string' ? e : (e?.message || 'Upload failed'), 'error')
    } finally { setHeroPhotoUploading(false) }
  }

  // ── Amazon-PDP-style summary: hero (image / facts / actions), a spec
  // table, and a documents checklist that always shows Pending vs Uploaded.
  // Shared by the unassigned and assigned states so a style's own data never
  // disappears or gets reshuffled depending on whether a manufacturer exists.
  const renderSummary = ({ unassigned }) => {
    const heroImgUrl = order.imageDataUrl || order.imageUrl
    const checklist = [
      {
        key: 'image', label: 'Product Image', uploaded: !!heroImgUrl,
        preview: heroImgUrl ? <img src={heroImgUrl} alt="" style={{ width: 36, height: 36, borderRadius: 6, objectFit: 'cover' }} /> : null,
        file: heroPhotoFile, err: heroPhotoErr, uploading: heroPhotoUploading,
        onFile: f => { setHeroPhotoFile(f); setHeroPhotoErr('') }, onErr: setHeroPhotoErr, onUpload: uploadHeroPhoto,
      },
      ...Object.keys(refDocLabels).map(type => {
        const doc = orderDocs.find(d => d.type === type)
        const uploadProps = type === 'pattern' ? PATTERN_FILE_PROPS : type === 'measurements' ? MEASUREMENTS_FILE_PROPS : {}
        return {
          key: type, label: refDocLabels[type], uploaded: !!doc, doc, uploadProps,
          file: refDocFiles[type], err: refDocErrs[type], uploading: refDocUploading === type,
          onFile: f => setRefDocFiles(p => ({ ...p, [type]: f })),
          onErr: e => setRefDocErrs(p => ({ ...p, [type]: e })),
          onUpload: () => uploadRefDoc(type),
        }
      }),
    ]
    const pendingCount = checklist.filter(c => !c.uploaded).length

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* ── Page header: identity + actions ── */}
        <FlexRow style={{ flexWrap: 'wrap' }} gap={10}>
          <Btn variant="secondary" size="sm" onClick={onBack} icon={<ArrowLeft size={13} />}>Back</Btn>
          <div style={{ flex: 1 }} />
          {!unassigned && order.assignments?.length > 1 && (
            <Btn variant="secondary" size="sm" onClick={() => setSelectedMid(null)} icon={<ArrowLeftRight size={13} />}>Change Mfr</Btn>
          )}
          <Btn variant="secondary" size="sm" onClick={() => setShowEdit(true)} icon={<Pencil size={13} />}>Edit Style</Btn>
          <button
            onClick={() => setShowDelete(true)}
            style={{ padding: '7px 14px', fontSize: 12, fontWeight: 700, borderRadius: 8, border: `1px solid ${T.dangerBorder}`, background: T.dangerBg, color: T.danger, cursor: 'pointer', fontFamily: 'inherit' }}
          >Delete Style</button>
        </FlexRow>

        {/* ── Style spec sheet — modelled on the paper swatch/trim card that
            pins to a sample garment: photo + tear line, then a ruled spec
            table (mono labels, like a measurement chart) and real colour
            chips instead of a loose grid of stats. ── */}
        <Card pad={false}>
          <div style={{ display: 'flex', flexWrap: 'wrap' }}>
            {/* Photo + tear line */}
            <div style={{ display: 'flex', flexShrink: 0 }}>
              <div style={{ width: 128, padding: 18, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
                <div onClick={() => setShowEdit(true)} role="button" tabIndex={0} onKeyDown={activateOnKey(() => setShowEdit(true))}
                  title="Change photo"
                  style={{ width: 92, height: 92, borderRadius: 6, overflow: 'hidden', background: '#f8fafc', border: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                  {heroImgUrl ? (
                    <img src={heroImgUrl} alt={order.product} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  ) : (
                    <ImageIcon size={22} color={T.textLight} />
                  )}
                </div>
                {unassigned
                  ? <span style={{ fontSize: 10, fontWeight: 800, color: T.textLight, background: '#f1f5f9', padding: '2px 8px', borderRadius: 999, letterSpacing: '0.06em' }}>TBD</span>
                  : <Badge status={overallStatus()} />}
              </div>
              <div style={{ width: 0, borderLeft: `1px dashed ${T.border}`, margin: '18px 0' }} />
            </div>

            {/* Spec sheet */}
            <div style={{ flex: '1 1 420px', padding: '18px 22px', minWidth: 300 }}>
              <Mono style={{ fontSize: 11, color: T.textLight, letterSpacing: '0.04em' }}>{order.id}</Mono>
              <h1 style={{ fontSize: 26, fontWeight: 800, color: T.info, margin: '2px 0 2px', lineHeight: 1.15, letterSpacing: '-0.01em' }}>
                {order.product}
              </h1>
              {order.styleNumber && (
                <Mono style={{ fontSize: 12, color: T.textMuted }}>Style {order.styleNumber}</Mono>
              )}

              {/* Ruled spec table */}
              <div className="grid-responsive-2" style={{ gap: 0, marginTop: 16, border: `1px solid ${T.border}`, borderRadius: 8, overflow: 'hidden' }}>
                {[
                  ['Category', order.category || '—'],
                  ['Season', order.season || '—'],
                  ['Buyer', order.buyerCompany ? `${order.buyerCompany}${order.buyerCode ? ` (${order.buyerCode})` : ''}` : '—'],
                  ['Quantity', `${order.totalQty?.toLocaleString()} pcs`],
                  ['Delivery', fmtDate(order.delivery)],
                  ['Created', fmtDate(order.createdAt)],
                ].map(([label, value], i) => (
                  <div key={label} style={{ padding: '8px 12px', borderTop: i > 1 ? `1px solid ${T.border}` : 'none', borderLeft: i % 2 === 1 ? `1px solid ${T.border}` : 'none', background: i % 2 === 0 ? '#fbfcfe' : '#fff' }}>
                    <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 9, fontWeight: 700, color: T.textLight, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: T.text, marginTop: 2 }}>{value}</div>
                  </div>
                ))}
              </div>

              {(order.colourways || []).length > 0 && (
                <div style={{ marginTop: 16 }}>
                  <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 9, fontWeight: 700, color: T.textLight, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 7 }}>Colourways</div>
                  <FlexRow gap={8} style={{ flexWrap: 'wrap' }}>
                    {order.colourways.map(c => (
                      <span key={c.name} style={{ display: 'inline-flex', alignItems: 'stretch', fontSize: 12, fontWeight: 700, color: T.text, background: '#fff', border: `1px solid ${T.border}`, borderRadius: 6, overflow: 'hidden' }}>
                        <span style={{ width: 8, background: c.hex || resolveNamedColor(c.name) || '#cbd5e1', flexShrink: 0 }} />
                        <span style={{ padding: '5px 10px' }}>
                          {c.name}{c.code ? <span style={{ color: T.textLight, fontWeight: 500 }}> · {c.code}</span> : ''}
                        </span>
                      </span>
                    ))}
                  </FlexRow>
                </div>
              )}

              {(order.fabricDetails || []).length > 0 && (
                <div style={{ marginTop: 16 }}>
                  <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 9, fontWeight: 700, color: T.textLight, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 7 }}>Fabric</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                    {order.fabricDetails.map(fb => (
                      <div key={fb.name} style={{ fontSize: 12.5, color: T.text }}>
                        <span style={{ fontWeight: 700 }}>{fb.name}</span>
                        {[fb.composition, fb.gsm && `${fb.gsm} GSM`, fb.supplier].filter(Boolean).length > 0 && (
                          <span style={{ color: T.textMuted }}> — {[fb.composition, fb.gsm && `${fb.gsm} GSM`, fb.supplier].filter(Boolean).join(' · ')}</span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {order.ecommerceLink && (
                <a href={order.ecommerceLink} target="_blank" rel="noreferrer" style={{ display: 'inline-block', marginTop: 14, fontSize: 12, fontWeight: 600, color: T.primaryDeep }}>{order.ecommerceLink} ↗</a>
              )}
            </div>
          </div>
        </Card>

        {/* ── Documents & Assets — collapsed checklist; only the row you're
            working on expands, so 4 items cost 4 lines, not 4 dropzones. ── */}
        <Card>
          <FlexRow justify="space-between">
            <SectionLabel>Documents & Assets</SectionLabel>
            <span style={{ fontSize: 11, fontWeight: 700, color: pendingCount > 0 ? T.warning : T.successDeep }}>
              {pendingCount > 0 ? `${pendingCount} pending` : 'All uploaded'}
            </span>
          </FlexRow>
          <div className="grid-responsive-2" style={{ gap: 8, marginTop: 10 }}>
            {checklist.map(item => {
              const isOpen = expandedDocKey === item.key
              return (
                // Spans both grid columns once open — a DocCard's action row
                // (View/Download/Edit/Delete) needs real width; squeezed into
                // one ~280px column it overlapped its own text instead of
                // wrapping cleanly.
                <div key={item.key} style={{ gridColumn: isOpen ? '1 / -1' : undefined, border: `1px solid ${item.uploaded ? T.border : T.warningBorder}`, background: item.uploaded ? T.surface : T.warningBg, borderRadius: 8 }}>
                  <FlexRow justify="space-between" gap={10}
                    onClick={() => setExpandedDocKey(isOpen ? null : item.key)} role="button" tabIndex={0} onKeyDown={activateOnKey(() => setExpandedDocKey(isOpen ? null : item.key))}
                    style={{ padding: '9px 12px', cursor: 'pointer' }}>
                    <FlexRow gap={10}>
                      {item.preview}
                      <span style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{item.label}</span>
                    </FlexRow>
                    <FlexRow gap={8}>
                      <span style={{ fontSize: 11, fontWeight: 800, color: item.uploaded ? T.successDeep : T.warning, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        {item.uploaded ? <Check size={12} strokeWidth={3} /> : 'Pending'}
                      </span>
                      <ChevronRight size={14} color={T.textLight} style={{ transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }} />
                    </FlexRow>
                  </FlexRow>
                  {isOpen && (
                    <div style={{ padding: '0 12px 12px' }}>
                      {item.uploaded && item.doc ? (
                        <DocCard doc={item.doc} users={users} onGetData={getDocData} />
                      ) : (
                        <>
                          <FileUpload {...item.uploadProps} file={item.file} onFile={item.onFile} error={item.err} onError={item.onErr} />
                          {item.file && (
                            <Btn size="sm" style={{ marginTop: 6 }} disabled={item.uploading} onClick={item.onUpload}>
                              {item.uploading ? 'Uploading…' : `Upload ${item.label}`}
                            </Btn>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* Anything uploaded via "Upload Document" that isn't one of the four
              checklist types (PO, cost sheet, RFQ, terms, buyer order, …) —
              folded in here instead of a separate tab. */}
          {(() => {
            const otherDocs = orderDocs.filter(d => d.stageIndex == null && !Object.keys(refDocLabels).includes(d.type))
            return (
              <div style={{ borderTop: `1px solid ${T.border}`, marginTop: 10, paddingTop: 12 }}>
                <FlexRow justify="space-between">
                  <span style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Other Documents</span>
                  <Btn size="sm" variant="ghost" onClick={() => setShowUp(true)} icon={<Paperclip size={12} />}>Upload</Btn>
                </FlexRow>
                {otherDocs.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
                    {otherDocs.map(d => <DocCard key={d.id} doc={d} users={users} onGetData={getDocData} />)}
                  </div>
                )}
              </div>
            )
          })()}
        </Card>
      </div>
    )
  }

  // ── Unassigned style — no manufacturer/TNA yet. Same summary as the
  // assigned page, plus the one action that matters here.
  if ((order.assignments?.length || 0) === 0) {
    return (
      <div>
        {showEdit && (
          <EditOrderModal order={order} onClose={() => setShowEdit(false)}
            onSave={async (id, data) => { await editOrder(id, data); toast(`Style ${id} updated`, 'success'); setShowEdit(false) }} />
        )}
        {showDelete && (
          <DeleteOrderModal order={order} onClose={() => setShowDelete(false)}
            onConfirm={async (id) => { await deleteOrder(id); toast(`Style ${id} deleted`, 'success'); setShowDelete(false); onBack() }} />
        )}

        {renderSummary({ unassigned: true })}

        <div style={{ marginTop: 16 }}>
          <Card>
            <SectionLabel>Add Manufacturer</SectionLabel>
            <div style={{ fontSize: 12, color: T.textMuted, margin: '6px 0 12px' }}>
              This style has no manufacturer yet — production can't start until one is assigned. TNA (production stages) can be built or uploaded once it is.
            </div>
            <div className="form-grid-2" style={{ gap: 12, alignItems: 'flex-end' }}>
              <Select label="Manufacturer *" value={newMfrId} onChange={e => setNewMfrId(e.target.value)}>
                <option value="">Select manufacturer…</option>
                {mfrUsers.map(m => <option key={m.id} value={m.id}>{m.company} ({m.code})</option>)}
              </Select>
              <Input label="Quantity *" type="number" value={newMfrQty} onChange={e => setNewMfrQty(e.target.value)} placeholder={String(order.totalQty || '')} />
            </div>
            <FlexRow justify="flex-end" style={{ marginTop: 12 }}>
              <Btn
                disabled={!newMfrId || !newMfrQty || Number(newMfrQty) <= 0 || addingMfr}
                onClick={async () => {
                  setAddingMfr(true)
                  try {
                    await addAssignment(order.id, { mfrId: newMfrId, qty: Math.floor(Number(newMfrQty)) })
                    toast('Manufacturer assigned', 'success')
                  } catch (e) {
                    toast(typeof e === 'string' ? e : (e?.message || 'Failed to add manufacturer'), 'error')
                  } finally { setAddingMfr(false) }
                }}
              >{addingMfr ? 'Adding…' : 'Add Manufacturer'}</Btn>
            </FlexRow>
          </Card>
        </div>
      </div>
    )
  }

  // ── Assignment picker ──
  if (!effectiveMid && order.assignments?.length > 1) {
    return (
      <div>
        <FlexRow style={{ marginBottom: 20 }} gap={12}>
          <Btn variant="secondary" size="sm" onClick={onBack} icon={<ArrowLeft size={13} />}>Back</Btn>
          <ProductThumb order={order} size="lg" onClick={() => setShowEdit(true)} />
          <div style={{ flex: 1 }}>
            <FlexRow gap={10}>
              <Mono style={{ fontSize: 15 }}>{order.id}</Mono>
              <Badge status={overallStatus()} />
            </FlexRow>
            <div style={{ fontSize: 13, color: T.textMuted, marginTop: 3 }}>
              {order.product}{order.styleNumber ? ` — ${order.styleNumber}` : ''} · {order.buyerCompany || '—'} · {order.totalQty?.toLocaleString()} pcs · Due {fmtDate(order.delivery)}
            </div>
          </div>
          <Btn variant="secondary" onClick={() => setShowUp(true)} icon={<Paperclip size={13} />}>Upload Document</Btn>
        </FlexRow>
        <div style={{ marginBottom: 12, fontSize: 13, fontWeight: 600, color: T.textMuted }}>Select a manufacturer to manage that transaction:</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {order.assignments.map(a => {
            const stages = a.stages || []
            const totalDone = stages.reduce((s, st) => s + (st.unitsDone || 0), 0)
            const totalAll = stages.reduce((s, st) => s + (st.totalUnits || 0), 0)
            const pct = totalAll > 0 ? Math.round((totalDone / totalAll) * 100) : 0
            const completedStages = stages.filter(s => s.unitsDone >= s.totalUnits && s.totalUnits > 0).length
            const stageCnt = orderDocs.filter(d => d.stageIndex != null && String(d.mfrId || '') === String(a.mid)).length
            return (
              <div key={a.mid}
                onClick={() => setSelectedMid(String(a.mid))} role="button" tabIndex={0} onKeyDown={activateOnKey(() => setSelectedMid(String(a.mid)))}
                style={{ border: `1px solid ${a.status === 'Delayed' ? T.dangerBorder : a.status === 'On Hold' ? T.warningBorder : T.border}`, borderRadius: 12, padding: '16px 18px', cursor: 'pointer', background: a.status === 'Delayed' ? '#fff8f8' : a.status === 'On Hold' ? '#fefdf5' : T.surface, transition: 'all 0.15s' }}
                onMouseEnter={e => e.currentTarget.style.opacity = '0.85'}
                onMouseLeave={e => e.currentTarget.style.opacity = '1'}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                  <MfrProfileLink mfrId={a.mid} mfrName={a.mfrCompany || '—'} docs={docs} onGetData={getDocData} />
                  <span style={{ fontSize: 10, color: T.textLight, background: '#f1f5f9', padding: '1px 6px', borderRadius: 4 }}>{a.sub}</span>
                  <Badge status={a.status} />
                  <span style={{ marginLeft: 'auto', fontSize: 12, color: T.textMuted }}>{a.qty?.toLocaleString()} pcs</span>
                </div>
                <div style={{ height: 6, background: '#f1f5f9', borderRadius: 4, overflow: 'hidden', marginBottom: 6 }}>
                  <div style={{ height: 6, background: pct >= 100 ? T.success : T.primary, borderRadius: 4, width: `${pct}%`, transition: 'width 0.3s' }} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: T.textMuted }}>
                  <span>{pct}% · {completedStages}/{stages.length} stages</span>
                  {stageCnt > 0 && <span style={{ color: '#1d4ed8' }}>{stageCnt} stage evidence file{stageCnt !== 1 ? 's' : ''}</span>}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  const tabs = [
    { id: 'production', label: `Production` },
    { id: 'stage_evidence', label: <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><ImageIcon size={13} /> Stage Evidence ({stageDocs.length})</span> },
    { id: 'compliance', label: `Compliance (${mfrDocs.length})` },
  ]

  return (
    <div>
      {/* ── Edit Order Modal ── */}
      {showEdit && (
        <EditOrderModal
          order={order}
          onClose={() => setShowEdit(false)}
          onSave={async (id, data) => {
            await editOrder(id, data)
            toast(`Order ${id} updated`, 'success')
            setShowEdit(false)
          }}
        />
      )}

      {/* ── Delete Order Modal ── */}
      {showDelete && (
        <DeleteOrderModal
          order={order}
          onClose={() => setShowDelete(false)}
          onConfirm={async (id) => {
            await deleteOrder(id)
            toast(`Order ${id} deleted`, 'success')
            setShowDelete(false)
            onBack()
          }}
        />
      )}

      {/* ── Status Override Modal ── */}
      {showSt && stTarget && (
        <Modal title="Override Assignment Status" subtitle="Admin override — permanently logged in audit trail" onClose={() => setShowSt(false)}>
          <Alert type="warning" style={{ marginBottom: 14 }}>All admin overrides are permanently logged with your name and timestamp.</Alert>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Select label="New Status" value={stStatus} onChange={e => setStStatus(e.target.value)}>
              {ORDER_STATUSES.map(s => <option key={s}>{s}</option>)}
            </Select>
            <Textarea label="Reason for Override *" value={stNote} onChange={e => setStNote(e.target.value)} placeholder="Explain why this override is needed…" />
            <FlexRow justify="flex-end" gap={8}>
              <Btn variant="secondary" onClick={() => setShowSt(false)}>Cancel</Btn>
              <Btn disabled={!stNote.trim() || saving} onClick={submitStatusOverride}>{saving ? 'Saving…' : 'Override Status'}</Btn>
            </FlexRow>
          </div>
        </Modal>
      )}

      {/* ── Stage Override Modal ── */}
      {showStage && sgTarget && (
        <Modal title="Override Production Stage" subtitle="Master admin can force any stage as done, bypassing the materials-pending gate" size="lg" onClose={() => setShowStage(false)}>
          <Alert type="warning" style={{ marginBottom: 14 }}>Master-admin-only. Use this when a stage is marked done but isn't actually complete — it bypasses the materials-pending check and is logged in the audit trail. A mandatory comment is required.</Alert>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Select label="Stage" value={sgIndex} onChange={e => {
              const idx = parseInt(e.target.value)
              setSgIndex(idx)
              const asgn = order.assignments.find(a => String(a.mid) === String(sgTarget))
              setSgUnits(asgn?.stages?.[idx]?.unitsDone?.toString() || '0')
            }}>
              {(order.assignments.find(a => String(a.mid) === String(sgTarget))?.stages || []).map((s, i) => <option key={i} value={i}>{i + 1}. {s.name}</option>)}
            </Select>

            {currentStageData && (
              <div style={{ background: '#f8fafc', borderRadius: 10, border: `1px solid ${T.border}`, padding: '14px 16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{currentStageData.name}</span>
                  <span style={{ fontSize: 12, color: T.textMuted }}>
                    Current: {currentStageData.unitsDone} / {currentStageData.totalUnits} units
                  </span>
                </div>
                <div style={{ height: 6, background: '#e2e8f0', borderRadius: 3, overflow: 'hidden', marginBottom: 6 }}>
                  <div style={{ height: 6, background: T.primary, borderRadius: 3, width: `${currentStageData.totalUnits > 0 ? (currentStageData.unitsDone / currentStageData.totalUnits) * 100 : 0}%`, transition: 'width 0.3s' }} />
                </div>
                {currentStageData.startDate && currentStageData.startDate !== 'NA' && (
                  <div style={{ fontSize: 11, color: T.textMuted }}>Start: {fmtDate(currentStageData.startDate)}</div>
                )}
                {effectiveEta(currentStageData) && (
                  <div style={{ fontSize: 11, color: T.textMuted }}>ETA: {fmtDate(effectiveEta(currentStageData))}</div>
                )}
                {currentStageData.note && (
                  <div style={{ fontSize: 11, color: T.textMuted, marginTop: 4 }}>Last note: {currentStageData.note}</div>
                )}
              </div>
            )}

            <Input
              label={`Set Units Done (max ${currentStageData?.totalUnits || 0})`}
              type="number"
              value={sgUnits}
              onChange={e => setSgUnits(e.target.value)}
              placeholder="0"
            />

            {/* Preview progress bar */}
            {currentStageData && (
              <div>
                <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 4 }}>Preview: {sgUnits || 0} / {currentStageData.totalUnits} units ({currentStageData.totalUnits > 0 ? Math.round(((parseInt(sgUnits) || 0) / currentStageData.totalUnits) * 100) : 0}%)</div>
                <div style={{ height: 6, background: '#e2e8f0', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ height: 6, background: T.success, borderRadius: 3, width: `${currentStageData.totalUnits > 0 ? Math.min(100, ((parseInt(sgUnits) || 0) / currentStageData.totalUnits) * 100) : 0}%`, transition: 'width 0.3s' }} />
                </div>
              </div>
            )}

            <Textarea label="Reason for Override *" value={sgNote} onChange={e => setSgNote(e.target.value)} placeholder="Explain why this stage override is needed…" />

            <Alert type="info">
              Updating a stage will automatically reset all subsequent stages to 0 (sequential production model).
            </Alert>

            <FlexRow justify="flex-end" gap={8}>
              <Btn variant="secondary" onClick={() => setShowStage(false)}>Cancel</Btn>
              <Btn disabled={!sgNote.trim() || saving} onClick={submitStageOverride}>{saving ? 'Saving…' : 'Override Stage'}</Btn>
            </FlexRow>
          </div>
        </Modal>
      )}

      {quickStage && (
        <QuickStageModal
          orderId={order.id} mfrId={quickStage.mfrId} stageIndex={quickStage.stageIndex}
          onClose={() => setQuickStage(null)} showOpenOrderLink={false}
        />
      )}

      {/* ── Stage Dates Adjustment Modal ── */}
      {showEta && etaTarget && (
        <Modal title="Bulk Edit Stages" subtitle="Update dates, responsible person, target quantity, and description for every stage at once" size="xxl" onClose={() => setShowEta(false)}>
          <Alert type="info" style={{ marginBottom: 20 }}>Changes are logged in the audit trail.</Alert>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ background: '#f8fafc', borderRadius: 10, border: `1px solid ${T.border}`, padding: '12px 14px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {(order.assignments.find(a => String(a.mid) === String(etaTarget))?.stages || []).map((s, i, arr) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 12, borderBottom: i < arr.length - 1 ? `1px solid ${T.border}` : 'none' }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: T.text, width: 190, flexShrink: 0, whiteSpace: 'normal', wordBreak: 'break-word', lineHeight: 1.3 }}>{i + 1}. {s.name}</span>
                    <input
                      type={startValues[i] === 'NA' ? 'text' : 'date'}
                      value={startValues[i]}
                      onChange={e => setStartValues(prev => prev.map((v, j) => j === i ? e.target.value : v))}
                      placeholder="NA or start date"
                      style={{ width: 135, flexShrink: 0, border: `1px solid ${T.border}`, borderRadius: 6, padding: '5px 8px', fontSize: 12, fontFamily: 'inherit', color: startValues[i] === 'NA' ? T.textLight : T.text }}
                    />
                    <input
                      type={etaValues[i] === 'NA' ? 'text' : 'date'}
                      value={etaValues[i]}
                      onChange={e => setEtaValues(prev => prev.map((v, j) => j === i ? e.target.value : v))}
                      placeholder="NA or end date"
                      style={{ width: 135, flexShrink: 0, border: `1px solid ${T.border}`, borderRadius: 6, padding: '5px 8px', fontSize: 12, fontFamily: 'inherit', color: etaValues[i] === 'NA' ? T.textLight : T.text }}
                    />
                    <select
                      value={responsibleValues[i] || ''}
                      onChange={e => setResponsibleValues(prev => prev.map((v, j) => j === i ? e.target.value : v))}
                      style={{ width: 170, flexShrink: 0, border: `1px solid ${T.border}`, borderRadius: 6, padding: '5px 8px', fontSize: 12, fontFamily: 'inherit', color: responsibleValues[i] ? T.text : T.textLight, cursor: 'pointer' }}
                    >
                      <option value="">Unassigned</option>
                      {responsibleUsers.map(u => (
                        <option key={u.id} value={u.id}>{u.role === 'admin' ? 'Admin' : 'Mfr'}: {u.role === 'admin' ? u.name : u.company}</option>
                      ))}
                    </select>
                    <input
                      type="number"
                      min={1}
                      value={totalUnitsValues[i] || ''}
                      onChange={e => setTotalUnitsValues(prev => prev.map((v, j) => j === i ? e.target.value : v))}
                      placeholder="Target qty"
                      title="Target quantity for this stage — not every stage tracks the full order qty (e.g. Lab Dip Approval might target 3 dips, not 600 pieces)"
                      style={{ width: 90, flexShrink: 0, border: `1px solid ${T.border}`, borderRadius: 6, padding: '5px 8px', fontSize: 12, fontFamily: 'inherit' }}
                    />
                    <input
                      value={descriptionValues[i] || ''}
                      onChange={e => setDescriptionValues(prev => prev.map((v, j) => j === i ? e.target.value : v))}
                      placeholder="Description (optional)"
                      style={{ flex: 1, minWidth: 140, border: `1px solid ${T.border}`, borderRadius: 6, padding: '5px 8px', fontSize: 12, fontFamily: 'inherit' }}
                    />
                    <button
                      onClick={() => openStageDocUpload(etaTarget, i)}
                      title="Upload evidence document for this stage"
                      style={{ flexShrink: 0, background: '#fff', border: `1px solid ${T.border}`, borderRadius: 6, cursor: 'pointer', width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                    ><Paperclip size={13} /></button>
                  </div>
                ))}
              </div>
            </div>
            <FlexRow justify="flex-end" gap={8}>
              <Btn variant="secondary" onClick={() => setShowEta(false)}>Cancel</Btn>
              <Btn disabled={saving} onClick={submitEtaAdjust}>{saving ? 'Saving…' : 'Save Changes'}</Btn>
            </FlexRow>
          </div>
        </Modal>
      )}

      {/* ── Apply Responsibility to Master Order prompt ── */}
      {showApplyAll && (
        <Modal
          title="Apply to other orders too?"
          subtitle="This order belongs to a master order with other line items — apply the same responsibility assignment(s) to their matching stages (by stage name)?"
          onClose={() => { setShowApplyAll(false); setPendingRespChanges([]) }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 18 }}>
            {pendingRespChanges.map((c, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13, background: '#f8fafc', border: `1px solid ${T.border}`, borderRadius: 8, padding: '8px 12px' }}>
                <span style={{ color: T.text, fontWeight: 600 }}>{c.stageName}</span>
                <span style={{ color: T.textMuted }}>
                  {c.responsibleId ? (responsibleUsers.find(u => u.id === c.responsibleId)?.name || responsibleUsers.find(u => u.id === c.responsibleId)?.company || 'Unknown') : 'Unassigned'}
                </span>
              </div>
            ))}
          </div>
          <FlexRow justify="flex-end" gap={8}>
            <Btn variant="secondary" disabled={saving} onClick={() => { setShowApplyAll(false); setPendingRespChanges([]) }}>Just This Order</Btn>
            <Btn disabled={saving} onClick={applyResponsibilityToMasterOrder}>{saving ? 'Applying…' : 'Apply to All Orders'}</Btn>
          </FlexRow>
        </Modal>
      )}

      {/* ── Doc Upload Modal ── */}
      {showUp && (
        <Modal title="Upload Order Document" onClose={() => { setShowUp(false); resetUpload() }} size="lg">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div className="form-grid-2">
              <Select label="Document Type" value={uf.type} onChange={e => setUf({ ...uf, type: e.target.value })}>
                {orderDocTypes.map(t => <option key={t.v} value={t.v}>{t.l}</option>)}
              </Select>
              <Input label="Document Name" value={uf.name} onChange={e => setUf({ ...uf, name: e.target.value })} placeholder="Document title" />
            </div>
            <Input label="Issuing Authority" value={uf.issuer} onChange={e => setUf({ ...uf, issuer: e.target.value })} />
            <div className="form-grid-2">
              <Input label="Issue Date" type="date" value={uf.issueDate} onChange={e => setUf({ ...uf, issueDate: e.target.value })} />
              <Input label="Expiry Date (optional)" type="date" value={uf.expiryDate} onChange={e => setUf({ ...uf, expiryDate: e.target.value })} />
            </div>
            <Alert type="info">Document will be visible to the buyer and all assigned manufacturers.</Alert>
            <FileUpload file={fileData} onFile={f => { setFileData(f); setFileErr('') }} error={fileErr} onError={setFileErr} />
            <FlexRow justify="flex-end" gap={8}>
              <Btn variant="secondary" onClick={() => { setShowUp(false); resetUpload() }}>Cancel</Btn>
              <Btn disabled={!uf.name || !fileData || saving} onClick={submitDoc}>{saving ? 'Uploading…' : 'Upload Document'}</Btn>
            </FlexRow>
          </div>
        </Modal>
      )}

      {/* ── Stage Doc Upload Modal ── */}
      {showStageDocs && sdMfrId && (
        <Modal title="Upload Stage Evidence" subtitle={`${(order.assignments.find(a => String(a.mid) === String(sdMfrId))?.stages?.[sdStageIdx]?.name) || `Stage ${sdStageIdx + 1}`} — Evidence Documents`} onClose={() => setShowStageDocs(false)} size="lg">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <Alert type="info">
              Linked to the {(order.assignments.find(a => String(a.mid) === String(sdMfrId))?.stages?.[sdStageIdx]?.name) || `Stage ${sdStageIdx + 1}`} stage. Attach a file/link, or add SOP notes only — either is sufficient.
            </Alert>
            {sdItems.map((item, idx) => (
              <div key={idx} style={{ border: `1px solid ${T.border}`, borderRadius: 10, padding: '14px 16px', background: '#f8fafc', position: 'relative' }}>
                {sdItems.length > 1 && (
                  <button onClick={() => removeSdItem(idx)} style={{ position: 'absolute', top: 10, right: 10, background: '#fee2e2', border: 'none', borderRadius: 6, cursor: 'pointer', width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, color: T.danger }}>×</button>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <Input label="Document Name *" value={item.name} onChange={e => updateSdItem(idx, { name: e.target.value, fileErr: '' })} placeholder={`e.g. ${(order.assignments.find(a => String(a.mid) === String(sdMfrId))?.stages?.[sdStageIdx]?.name) || `Stage ${sdStageIdx + 1}`} GRN - Batch ${idx + 1}`} />
                  <FileUpload file={item.file} onFile={f => updateSdItem(idx, { file: f, fileErr: '' })} error={item.fileErr} onError={err => updateSdItem(idx, { fileErr: err })} />
                  <Textarea
                    label="Notes (optional — text evidence)"
                    value={item.notes}
                    onChange={e => updateSdItem(idx, { notes: e.target.value, fileErr: '' })}
                    placeholder="Add SOP context, observations, or text-only stage evidence…"
                    rows={3}
                  />
                </div>
              </div>
            ))}
            {sdErr && <div style={{ fontSize: 12, color: T.danger, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 5 }}><AlertTriangle size={12} /> {sdErr}</div>}
            <FlexRow justify="space-between" gap={8}>
              <Btn variant="secondary" size="sm" onClick={addSdItem}>+ Add Another Document</Btn>
              <FlexRow gap={8}>
                <Btn variant="secondary" onClick={() => setShowStageDocs(false)}>Cancel</Btn>
                <Btn disabled={saving} onClick={submitStageDoc}>{saving ? 'Uploading…' : `Upload ${sdItems.length > 1 ? `${sdItems.length} Documents` : 'Evidence'}`}</Btn>
              </FlexRow>
            </FlexRow>
          </div>
        </Modal>
      )}

      {/* ── Attach PO Document Modal ── */}
      {showMaterialPo && mpMfrId && (() => {
        const material = order.assignments.find(a => String(a.mid) === String(mpMfrId))?.stages?.[mpStageIdx]?.materials?.[mpLineIdx]
        return (
          <Modal title="Attach PO Document" subtitle={material?.name ? `${material.name} — attach the purchase order for this material line` : 'Attach a PO document for this material line'} onClose={() => setShowMaterialPo(false)}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <FileUpload file={mpFile} onFile={f => { setMpFile(f); setMpFileErr('') }} error={mpFileErr} onError={setMpFileErr} />
              <FlexRow justify="flex-end" gap={8}>
                <Btn variant="secondary" onClick={() => setShowMaterialPo(false)}>Cancel</Btn>
                <Btn disabled={!mpFile || saving} onClick={submitMaterialPo}>{saving ? 'Uploading…' : 'Attach PO'}</Btn>
              </FlexRow>
            </div>
          </Modal>
        )
      })()}

      {/* ── Inline document viewer ── */}
      {(viewerBlob || viewerLoading) && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.75)', zIndex: 2000, display: 'flex', flexDirection: 'column' }}
          onClick={e => e.target === e.currentTarget && closeViewer()}>
          <div style={{ height: 48, background: '#0f172a', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 16px', flexShrink: 0, gap: 12 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{viewerName}</span>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {viewerBlob && (
                <button onClick={() => { const a = document.createElement('a'); a.href = viewerBlob.url; a.download = viewerName; a.click() }}
                  style={{ background: '#1e293b', border: '1px solid #334155', color: '#e2e8f0', borderRadius: 7, padding: '0 12px', height: 32, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', display: 'inline-flex', alignItems: 'center', gap: 6 }}><Download size={13} /> Download</button>
              )}
              <button onClick={closeViewer}
                style={{ background: '#ef4444', border: 'none', color: '#fff', borderRadius: 7, width: 32, height: 32, fontSize: 18, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'inherit' }}>×</button>
            </div>
          </div>
          {viewerLoading && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, background: '#0f172a' }}>
              <div style={{ width: 40, height: 40, border: '3px solid #334155', borderTopColor: '#f97316', borderRadius: '50%', animation: 'tradio-spin 0.7s linear infinite' }} />
              <div style={{ fontSize: 13, fontWeight: 600, color: '#94a3b8' }}>Loading document…</div>
            </div>
          )}
          {viewerBlob && (
            viewerBlob.mimeType?.startsWith('image/') ? (
              <div style={{ flex: 1, overflow: 'auto', display: viewerLoading ? 'none' : 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
                <img src={viewerBlob.url} alt={viewerName} onLoad={() => setViewerLoading(false)} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
              </div>
            ) : (
              <iframe src={viewerBlob.url} title={viewerName}
                sandbox="allow-scripts allow-popups"
                referrerPolicy="no-referrer"
                onLoad={() => setViewerLoading(false)}
                style={{ flex: 1, border: 'none', width: '100%', minHeight: 0, display: viewerLoading ? 'none' : 'block' }} />
            )
          )}
        </div>
      )}

      {renderSummary({ unassigned: false })}

      {/* ── Tabs ── */}
      <Card pad={false} style={{ marginTop: 16 }}>
        <Tabs tabs={tabs} active={tab} onChange={setTab} />
        <div style={{ padding: '20px 22px' }}>

          {/* ── Production Tab ── */}
          {tab === 'production' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {order.assignments.filter(a => !effectiveMid || String(a.mid) === effectiveMid).map(a => {
                const stages = a.stages || []
                const completedStages = stages.filter(s => s.totalUnits > 0 && s.unitsDone >= s.totalUnits).length
                const overallPct = stages.length > 0
                  ? Math.round(stages.reduce((sum, s) => sum + (s.totalUnits > 0 ? (s.unitsDone / s.totalUnits) * 100 : 0), 0) / stages.length)
                  : 0

                return (
                  <div key={a.sub} style={{ border: `1px solid ${a.status === 'Delayed' ? T.dangerBorder : a.status === 'On Hold' ? T.warningBorder : T.border}`, borderRadius: 12, overflow: 'hidden', background: a.status === 'Delayed' ? '#fff8f8' : a.status === 'On Hold' ? '#fefdf5' : T.surface }}>
                    {/* Assignment header */}
                    <div style={{ padding: '12px 16px', borderBottom: `1px solid ${T.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 10 }}>
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>
                          <MfrProfileLink mfrId={a.mid} mfrName={a.mfrCompany || '—'} docs={docs} onGetData={getDocData} />
                          <span style={{ color: T.textLight, fontSize: 12 }}> ({a.sub})</span>
                        </div>
                        <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>
                          {a.qty?.toLocaleString()} pcs · Updated {fmtDate(a.updatedAt)}
                        </div>
                      </div>
                      <FlexRow gap={8}>
                        <Badge status={a.status} />
                        <Btn size="sm" variant="warning" onClick={() => openStatusOverride(a.mid, a.status)} icon={<Pencil size={12} />}>Status</Btn>
                        {currentUser?.adminType === 'master' && (
                          <Btn size="sm" variant="outline" onClick={() => openStageOverride(a.mid)} icon={<ShieldAlert size={12} />}>Override</Btn>
                        )}
                        <Btn size="sm" variant="secondary" onClick={() => openEtaAdjust(a.mid)} icon={<ClipboardEdit size={12} />}>Bulk Edit</Btn>
                        <Btn size="sm" variant="secondary" onClick={() => setTnaCsvOpen(p => ({ ...p, [a.mid]: !p[a.mid] }))} icon={<FileSpreadsheet size={12} />}>Upload CSV</Btn>
                      </FlexRow>
                    </div>

                    {/* Overall progress */}
                    <div style={{ padding: '12px 18px', borderBottom: `1px solid ${T.border}`, background: '#f8fafc' }}>
                      <FlexRow justify="space-between" style={{ marginBottom: 6 }}>
                        <span style={{ fontSize: 12, fontWeight: 600, color: T.text }}>Overall Progress</span>
                        <span style={{ fontSize: 12, color: T.textMuted }}>{completedStages}/{stages.length} stages · {overallPct}%</span>
                      </FlexRow>
                      <div style={{ height: 6, background: '#e2e8f0', borderRadius: 3, overflow: 'hidden' }}>
                        <div style={{ height: 6, background: overallPct === 100 ? T.success : T.primary, borderRadius: 3, width: `${overallPct}%`, transition: 'width 0.3s' }} />
                      </div>
                    </div>

                    {/* Bulk CSV import — always available, not just for an empty
                        plan, so more stages can be added to an existing TNA
                        the same way (appends after whatever's already there). */}
                    {tnaCsvOpen[a.mid] && (() => {
                      const csvRows = tnaCsvRows[a.mid] || []
                      const csvValid = csvRows.filter(r => r.errors.length === 0)
                      const csvInvalid = csvRows.filter(r => r.errors.length > 0)
                      return (
                        <div style={{ margin: '14px 18px 0', background: '#f8fafc', border: `1px dashed ${T.border}`, borderRadius: 10, padding: '14px 16px' }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: T.text, marginBottom: 2 }}>Upload CSV</div>
                          <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 10 }}>
                            {stages.length > 0 ? 'New rows are appended after the existing plan.' : 'Import a whole plan at once.'}
                          </div>
                          <FlexRow gap={10} style={{ marginBottom: 10 }}>
                            <label style={{ display: 'inline-flex', alignItems: 'center', padding: '4px 10px', fontSize: 11, fontWeight: 700, color: T.text, background: '#fff', border: `1px solid ${T.border}`, borderRadius: 8, cursor: 'pointer' }}>
                              Choose CSV file
                              <input type="file" accept=".csv" style={{ display: 'none' }}
                                onChange={e => { setTnaCsvErr(p => ({ ...p, [a.mid]: '' })); if (e.target.files[0]) parseTnaCsv(a.mid, e.target.files[0]) }} />
                            </label>
                            <button onClick={downloadTnaCsvTemplate} style={{ fontSize: 11, fontWeight: 700, color: T.primary, background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>Download template</button>
                          </FlexRow>
                          <div style={{ fontSize: 10, color: T.textLight, marginBottom: 8 }}>Columns: {TNA_CSV_HEADERS.join(', ')} — one row per stage, in order.</div>
                          {tnaCsvErr[a.mid] && <div style={{ fontSize: 11, color: T.danger, marginBottom: 8 }}>⚠ {tnaCsvErr[a.mid]}</div>}
                          {csvRows.length > 0 && (
                            <div>
                              <div style={{ fontSize: 11, fontWeight: 700, color: T.text, marginBottom: 6 }}>
                                {csvValid.length} ready to import{csvInvalid.length > 0 ? `, ${csvInvalid.length} with errors` : ''}
                              </div>
                              <div style={{ maxHeight: 180, overflowY: 'auto', border: `1px solid ${T.border}`, borderRadius: 6, background: '#fff' }}>
                                {csvRows.map((r, i) => (
                                  <div key={i} style={{ padding: '6px 10px', fontSize: 11, borderTop: i > 0 ? `1px solid ${T.border}` : 'none', color: r.errors.length ? T.danger : T.text }}>
                                    Row {r.row}: {r.name || '(no name)'} {r.errors.length > 0 && `— ${r.errors.join(', ')}`}
                                  </div>
                                ))}
                              </div>
                              <Btn size="sm" style={{ marginTop: 8 }} disabled={csvValid.length === 0 || tnaCsvImporting === a.mid} onClick={() => importTnaCsv(a.mid)}>
                                {tnaCsvImporting === a.mid ? 'Importing…' : `Import ${csvValid.length} Stage${csvValid.length !== 1 ? 's' : ''}`}
                              </Btn>
                            </div>
                          )}
                        </div>
                      )
                    })()}

                    {/* Stage timeline */}
                    <div style={{ padding: '14px 18px' }}>
                      {stages.length > 0 && <StageTimeline stages={stages} />}

                      {stages.length === 0 && !tnaCsvOpen[a.mid] && (
                        <div style={{ background: '#f8fafc', border: `1px dashed ${T.border}`, borderRadius: 10, padding: '14px 16px', marginBottom: 14 }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: T.text, marginBottom: 2 }}>No TNA yet</div>
                          <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 12 }}>Add stages one at a time below, or click "Upload CSV" above for a whole plan at once.</div>
                          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
                            <div style={{ flex: '2 1 160px' }}>
                              <label style={{ display: 'block', fontSize: 10, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Stage Name</label>
                              <input value={newStageDraft(a.mid).name} onChange={e => setNewStageDraft(a.mid, { name: e.target.value })}
                                placeholder="e.g. Lab Dip Approval"
                                style={{ width: '100%', border: `1px solid ${T.border}`, borderRadius: 6, padding: '6px 10px', fontSize: 12, fontFamily: 'inherit', boxSizing: 'border-box' }} />
                            </div>
                            <div style={{ flex: '1 1 120px' }}>
                              <label style={{ display: 'block', fontSize: 10, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Start Date</label>
                              <input type={newStageDraft(a.mid).startDate === 'NA' ? 'text' : 'date'} value={newStageDraft(a.mid).startDate} onChange={e => setNewStageDraft(a.mid, { startDate: e.target.value })}
                                style={{ width: '100%', border: `1px solid ${T.border}`, borderRadius: 6, padding: '6px 8px', fontSize: 12, fontFamily: 'inherit', boxSizing: 'border-box' }} />
                            </div>
                            <div style={{ flex: '1 1 120px' }}>
                              <label style={{ display: 'block', fontSize: 10, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>End Date</label>
                              <input type={newStageDraft(a.mid).eta === 'NA' ? 'text' : 'date'} value={newStageDraft(a.mid).eta} onChange={e => setNewStageDraft(a.mid, { eta: e.target.value })}
                                style={{ width: '100%', border: `1px solid ${T.border}`, borderRadius: 6, padding: '6px 8px', fontSize: 12, fontFamily: 'inherit', boxSizing: 'border-box' }} />
                            </div>
                            <div style={{ flex: '1 1 110px' }}>
                              <label style={{ display: 'block', fontSize: 10, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Kind</label>
                              <select value={newStageDraft(a.mid).kind} onChange={e => setNewStageDraft(a.mid, { kind: e.target.value })}
                                style={{ width: '100%', border: `1px solid ${T.border}`, borderRadius: 6, padding: '6px 6px', fontSize: 12, fontFamily: 'inherit', background: '#fff' }}>
                                <option value="quantity">Quantity</option>
                                <option value="milestone">Milestone</option>
                                <option value="checklist">Checklist</option>
                              </select>
                            </div>
                            <Btn
                              size="sm"
                              disabled={!newStageDraft(a.mid).name.trim() || !newStageDraft(a.mid).startDate || !newStageDraft(a.mid).eta || addingStage === a.mid}
                              onClick={async () => {
                                const draft = newStageDraft(a.mid)
                                setAddingStage(a.mid)
                                try {
                                  await insertStage(order.id, a.mid, { name: draft.name.trim(), startDate: draft.startDate, eta: draft.eta, kind: draft.kind })
                                  setNewStageDraft(a.mid, { name: '', startDate: '', eta: '', kind: 'quantity' })
                                } catch (e) {
                                  toast(typeof e === 'string' ? e : (e?.message || 'Failed to add stage'), 'error')
                                } finally { setAddingStage(null) }
                              }}
                            >{addingStage === a.mid ? 'Adding…' : '+ Add Stage'}</Btn>
                          </div>
                        </div>
                      )}

                      {/* TNA table — one row per step, the same shape as the plan
                          the team keeps in Excel: step, owner, planned vs revised
                          end date, slippage, state. Click a row to update it. */}
                      <div className="table-scroll" style={{ marginTop: 14 }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 860 }}>
                          <thead>
                            <tr style={{ background: '#f8fafc' }}>
                              {['#', 'Step', 'Owner', 'Start', 'Planned', 'Revised', 'Δ', 'Actual', 'State', 'Progress', ''].map(h => (
                                <th key={h} style={{ padding: '8px 10px', textAlign: 'left', fontSize: 10, fontWeight: 800, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', whiteSpace: 'nowrap' }}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                        {stages.map((s, i) => {
                          const pct = stagePct(s)
                          const done = isStageDone(s)
                          const isLate = stageIsOverdue(s)
                          const kind = stageKindOf(s)
                          const variance = stageVariance(s)
                          const etaStr = s.eta === 'NA' ? 'N/A' : (s.eta && s.eta === s.baselineEta) ? 'N/A' : s.eta ? fmtDate(s.eta) : '—'
                          const baseStr = s.baselineEta === 'NA' ? 'N/A' : s.baselineEta ? fmtDate(s.baselineEta) : '—'
                          const startStr = s.startDate === 'NA' ? 'N/A' : s.startDate ? fmtDate(s.startDate) : '—'
                          const rowKey = `${a.mid}:${i}`
                          const rowExpanded = expandedStage === rowKey
                          const stateTone = done ? { bg: T.successBg, fg: T.success, label: 'Done' }
                            : s.blocked ? { bg: T.dangerBg, fg: T.danger, label: 'Blocked' }
                            : isLate ? { bg: T.dangerBg, fg: T.danger, label: 'Late' }
                            : stageStatusOf(s) === 'in_progress' ? { bg: '#dbeafe', fg: '#1d4ed8', label: 'In progress' }
                            : { bg: '#f1f5f9', fg: T.textMuted, label: 'Upcoming' }
                          const receivedCount = (s.materials || []).filter(m => m.status === 'received').length
                          return (
                            <Fragment key={i}>
                            <tr onClick={() => openUpdateStage(a.mid, i)} role="button" tabIndex={0} onKeyDown={activateOnKey(() => openUpdateStage(a.mid, i))}
                              style={{ borderTop: `1px solid ${T.border}`, cursor: 'pointer', background: done ? T.successBg : (isLate || s.blocked) ? T.dangerBg : 'transparent' }}>
                              <td style={{ padding: '8px 10px', fontSize: 10, color: T.textLight }}>{i + 1}</td>
                              <td style={{ padding: '8px 10px', minWidth: 200 }}>
                                <div style={{ fontSize: 12, fontWeight: 600, color: T.text }}>{s.name}</div>
                                {s.description && <div style={{ fontSize: 10, color: T.textLight, fontStyle: 'italic' }}>{s.description}</div>}
                                <FlexRow gap={6} style={{ marginTop: 2, flexWrap: 'wrap' }}>
                                  {kind !== 'quantity' && <span style={{ fontSize: 9, fontWeight: 700, color: T.textLight, textTransform: 'uppercase' }}>{kind}</span>}
                                  {(s.materials || []).length > 0 && (
                                    <span style={{ fontSize: 9, fontWeight: 800, padding: '1px 5px', borderRadius: 3, background: receivedCount === s.materials.length ? T.successBg : T.warningBg, color: receivedCount === s.materials.length ? T.success : T.warning, display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                                      <Package size={9} /> {receivedCount}/{s.materials.length}
                                    </span>
                                  )}
                                  {(s.updates || []).length > 0 && <span style={{ fontSize: 9, color: T.textMuted, display: 'inline-flex', alignItems: 'center', gap: 2 }}><MessageCircle size={9} /> {s.updates.length}</span>}
                                </FlexRow>
                              </td>
                              <td style={{ padding: '8px 10px', fontSize: 11, color: T.textMuted, whiteSpace: 'nowrap' }}>
                                {s.responsibleName || '—'}
                                {s.responsibleRole === 'buyer' && <div style={{ fontSize: 9, color: T.textLight }}>buyer</div>}
                              </td>
                              <td style={{ padding: '8px 10px', fontSize: 11, color: T.textMuted, whiteSpace: 'nowrap', fontFamily: "'JetBrains Mono',monospace" }}>{startStr}</td>
                              <td style={{ padding: '8px 10px', fontSize: 11, color: T.textLight, whiteSpace: 'nowrap', fontFamily: "'JetBrains Mono',monospace" }}>{baseStr}</td>
                              <td style={{ padding: '8px 10px', fontSize: 11, fontWeight: isLate ? 700 : 500, color: isLate ? T.danger : T.text, whiteSpace: 'nowrap', fontFamily: "'JetBrains Mono',monospace" }}>{etaStr}</td>
                              <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
                                {variance == null || variance === 0
                                  ? <span style={{ fontSize: 10, color: T.textLight }}>—</span>
                                  : <span style={{ fontSize: 10, fontWeight: 800, color: variance > 0 ? T.danger : T.success }}>{variance > 0 ? '+' : ''}{variance}d</span>}
                              </td>
                              <td style={{ padding: '8px 10px', fontSize: 11, color: T.textMuted, whiteSpace: 'nowrap', fontFamily: "'JetBrains Mono',monospace" }}>
                                {s.actualEnd ? fmtDate(s.actualEnd) : '—'}
                                {(() => {
                                  const av = stageActualVariance(s)
                                  return av != null && av !== 0 ? (
                                    <span style={{ marginLeft: 4, fontWeight: 800, color: av > 0 ? T.danger : T.success }}>
                                      {av > 0 ? '+' : ''}{av}d
                                    </span>
                                  ) : null
                                })()}
                              </td>
                              <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
                                <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 4, background: stateTone.bg, color: stateTone.fg }}>{stateTone.label}</span>
                              </td>
                              <td style={{ padding: '8px 10px', minWidth: 120 }}>
                                <div style={{ fontSize: 10, color: T.textMuted, marginBottom: 3 }}>{stageProgressLabel(s)}</div>
                                <div style={{ height: 4, background: '#e2e8f0', borderRadius: 2, overflow: 'hidden' }}>
                                  <div style={{ height: 4, background: done ? T.success : isLate ? T.danger : T.primary, borderRadius: 2, width: `${pct}%` }} />
                                </div>
                              </td>
                              <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                                <button onClick={e => { e.stopPropagation(); setExpandedStage(rowExpanded ? null : rowKey) }}
                                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2 }}>
                                  <span style={{ color: T.textMuted, display: 'inline-flex', transition: 'transform 0.15s', transform: rowExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}><ChevronRight size={14} /></span>
                                </button>
                              </td>
                            </tr>
                            {rowExpanded && (
                              <tr>
                                <td colSpan={11} style={{ padding: 0, background: '#f8fafc', borderTop: `1px solid ${T.border}` }}>
                                <div onClick={e => e.stopPropagation()} style={{ padding: '12px 16px', cursor: 'default' }}>
                                  {s.blocked && s.blockedReason && (
                                    <div style={{ fontSize: 11, color: T.danger, background: T.dangerBg, borderRadius: 5, padding: '5px 9px', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 5 }}><AlertTriangle size={11} /> {s.blockedReason}</div>
                                  )}

                                  {kind === 'checklist' && (
                                    <>
                                      <div style={{ fontSize: 10, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>
                                        Checklist ({s.itemsDone || 0}/{s.itemsTotal || 0})
                                      </div>
                                      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 12 }}>
                                        {(s.items || []).length === 0 && (
                                          <FlexRow gap={6}>
                                            <div style={{ fontSize: 11, color: T.textLight }}>No items yet.</div>
                                            {(order.colourways || []).length > 0 && (
                                              <Btn size="sm" variant="secondary" onClick={() => generateItemsFromColourways(a.mid, i, s.name)}>
                                                + One per colourway ({order.colourways.length})
                                              </Btn>
                                            )}
                                          </FlexRow>
                                        )}
                                        {(s.items || []).map((it, ii) => {
                                          const itemVariance = it.plannedDate && it.dueDate && it.plannedDate !== 'NA' && it.dueDate !== 'NA'
                                            ? dayNumber(it.dueDate) - dayNumber(it.plannedDate) : null
                                          return (
                                          <FlexRow key={ii} gap={8} style={{ background: '#fff', borderRadius: 6, padding: '5px 9px', border: `1px solid ${T.border}` }}>
                                            <button
                                              onClick={() => toggleStageItem(a.mid, i, ii, it.status)}
                                              title={it.status === 'done' ? 'Mark pending' : 'Mark done'}
                                              style={{ cursor: 'pointer', border: `1px solid ${it.status === 'done' ? T.success : T.border}`, background: it.status === 'done' ? T.success : '#fff', color: '#fff', borderRadius: 4, width: 18, height: 18, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                                            >{it.status === 'done' ? <Check size={11} strokeWidth={3} /> : ''}</button>
                                            <span style={{ flex: 1, fontSize: 11, color: T.text, textDecoration: it.status === 'done' ? 'line-through' : 'none' }}>{it.name}</span>
                                            {it.dueDate && (
                                              <span style={{ fontSize: 9, color: T.textLight, fontFamily: "'JetBrains Mono',monospace", whiteSpace: 'nowrap' }} title={`Planned ${it.plannedDate === 'NA' ? 'N/A' : it.plannedDate ? fmtDate(it.plannedDate) : '—'}`}>
                                                {it.dueDate === 'NA' ? 'N/A' : fmtDate(it.dueDate)}{itemVariance != null && itemVariance !== 0 ? ` (${itemVariance > 0 ? '+' : ''}${itemVariance}d)` : ''}
                                              </span>
                                            )}
                                            {it.doneDate && (
                                              <span style={{ fontSize: 10, fontWeight: 700, color: T.success, fontFamily: "'JetBrains Mono',monospace", whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 2 }} title="Actual completion date">
                                                <Check size={10} strokeWidth={3} /> {fmtDate(it.doneDate)}
                                              </span>
                                            )}
                                            <button onClick={() => removeStageItem(order.id, a.mid, i, ii)} title="Remove"
                                              style={{ background: 'none', border: 'none', cursor: 'pointer', color: T.textLight, display: 'flex' }}><X size={12} /></button>
                                          </FlexRow>
                                          )
                                        })}
                                      </div>
                                    </>
                                  )}

                                  <div style={{ fontSize: 10, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>Updates</div>
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
                                    {(s.updates || []).length === 0 && <div style={{ fontSize: 11, color: T.textLight }}>No updates yet.</div>}
                                    {(s.updates || []).map((u, ui) => (
                                      <div key={ui} style={{ background: '#fff', borderRadius: 6, padding: '6px 10px', border: `1px solid ${T.border}` }}>
                                        <div style={{ fontSize: 11, color: T.text }}>{u.text}</div>
                                        <div style={{ fontSize: 9, color: T.textLight, marginTop: 2 }}>{u.byUserName || 'Someone'} · {fmtDate(u.at)}</div>
                                      </div>
                                    ))}
                                  </div>
                                  <FlexRow gap={6}>
                                    <input
                                      value={updateDrafts[rowKey] || ''}
                                      onChange={e => setUpdateDrafts(d => ({ ...d, [rowKey]: e.target.value }))}
                                      onKeyDown={e => { if (e.key === 'Enter') submitStageUpdateNote(a.mid, i) }}
                                      placeholder="Add a progress update…"
                                      style={{ flex: 1, border: `1px solid ${T.border}`, borderRadius: 6, padding: '6px 8px', fontSize: 11, fontFamily: 'inherit' }}
                                    />
                                    <Btn size="sm" disabled={!(updateDrafts[rowKey] || '').trim()} onClick={() => submitStageUpdateNote(a.mid, i)}>Post</Btn>
                                  </FlexRow>

                                  <div style={{ fontSize: 10, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.04em', margin: '12px 0 6px' }}>Materials / PO</div>
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                    {(s.materials || []).length === 0 && <div style={{ fontSize: 11, color: T.textLight }}>No materials tracked for this stage.</div>}
                                    {(s.materials || []).map((m, mi) => {
                                      const statusStyle = m.status === 'received' ? { bg: T.successBg, c: T.success, border: T.successBorder }
                                        : m.status === 'ordered' ? { bg: T.warningBg, c: T.warning, border: T.warningBorder }
                                        : { bg: '#f1f5f9', c: T.textMuted, border: T.border }
                                      return (
                                        <div key={mi} style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#fff', borderRadius: 6, padding: '6px 10px', border: `1px solid ${T.border}` }}>
                                          <div style={{ flex: 1, minWidth: 0 }}>
                                            <div style={{ fontSize: 11, fontWeight: 600, color: T.text }}>{m.name} — {m.requiredQty}{m.unit ? ` ${m.unit}` : ''}</div>
                                            <div style={{ fontSize: 10, color: T.textLight }}>{[m.supplier, m.poNumber, m.expectedDate].filter(Boolean).join(' · ') || '—'}</div>
                                          </div>
                                          <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: statusStyle.bg, color: statusStyle.c, border: `1px solid ${statusStyle.border}`, whiteSpace: 'nowrap' }}>
                                            {m.status}
                                          </span>
                                        </div>
                                      )
                                    })}
                                  </div>
                                </div>
                                </td>
                              </tr>
                            )}
                            </Fragment>
                          )
                        })}
                          </tbody>
                        </table>
                      </div>

                      {a.note && (
                        <div style={{ marginTop: 12, background: '#f8fafc', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: T.textMuted, border: `1px solid ${T.border}`, display: 'flex', alignItems: 'flex-start', gap: 7 }}>
                          <MessageCircle size={13} style={{ flexShrink: 0, marginTop: 2 }} /> {a.note}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {tab === 'stage_evidence' && (
            <div>
              {stageDocs.length === 0 ? (
                <EmptyState icon={<ImageIcon size={30} color={T.textLight} />} title="No stage evidence" desc="Images and docs uploaded for each production stage will appear here" />
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {(selectedAsgn?.stages || []).map((s, i) => {
                    const sDocs = stageDocs.filter(d => d.stageIndex === i)
                    if (sDocs.length === 0) return null
                    const pct = s.totalUnits > 0 ? Math.round((s.unitsDone / s.totalUnits) * 100) : 0
                    const done = pct >= 100
                    return (
                      <div key={i} style={{ border: `1px solid ${done ? T.successBorder : T.border}`, borderRadius: 12, overflow: 'hidden' }}>
                        <div style={{ padding: '10px 16px', background: done ? T.successBg : '#f8fafc', borderBottom: `1px solid ${done ? T.successBorder : T.border}`, display: 'flex', alignItems: 'center', gap: 10 }}>
                          <div style={{ width: 26, height: 26, borderRadius: '50%', background: done ? T.success : T.primary, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 800, flexShrink: 0 }}>
                            {done ? <Check size={12} strokeWidth={3} /> : i + 1}
                          </div>
                          <span style={{ fontSize: 13, fontWeight: 700, color: done ? T.success : T.text }}>{s.name}</span>
                          <span style={{ fontSize: 11, color: T.textMuted }}>{pct}%</span>
                          <FlexRow gap={8} style={{ marginLeft: 'auto' }}>
                            <span style={{ fontSize: 11, fontWeight: 700, color: '#1d4ed8', background: '#dbeafe', padding: '2px 8px', borderRadius: 10 }}>{sDocs.length} file{sDocs.length !== 1 ? 's' : ''}</span>
                            <Btn size="sm" variant="outline" style={{ fontSize: 10 }} onClick={() => openStageDocUpload(effectiveMid, i)} icon={<Paperclip size={10} />}>Add</Btn>
                          </FlexRow>
                        </div>
                        <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                          {sDocs.map(d => <DocCard key={d.id} doc={d} users={users} onGetData={getDocData} stageName={s.name} />)}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {/* ── Compliance Tab ── */}
          {tab === 'compliance' && (
            <div>
              <SectionLabel>Manufacturer Compliance Certificates</SectionLabel>
              {mfrDocs.length === 0 ? (
                <Alert type="info">No compliance certificates uploaded by manufacturers for this order.</Alert>
              ) : (
                mfrDocs.map(d => {
                  const asgn = order.assignments.find(a => String(a.mid) === String(d.mfrId))
                  return <DocCard key={d.id} doc={{ ...d, name: `${d.name} — ${asgn?.mfrCompany || '—'}` }} users={users} onGetData={getDocData} />
                })
              )}
            </div>
          )}

        </div>
      </Card>
    </div>
  )
}

function InfoRow({ label, value, mono, badge }) {
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 800, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>{label}</div>
      {badge ? (
        <Badge status={value} />
      ) : mono ? (
        <Mono style={{ fontSize: 13 }}>{value}</Mono>
      ) : (
        <div style={{ fontSize: 14, fontWeight: 600, color: T.text }}>{value}</div>
      )}
    </div>
  )
}
