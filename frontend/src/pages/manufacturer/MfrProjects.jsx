import { useState, useEffect, useCallback } from 'react'
import { T, REQUIREMENT_CATEGORIES, REQUIREMENT_CATEGORY_LABEL } from '../../constants.js'
import { PageHeader, Input, Btn, Card, Badge, FlexRow, EmptyState, LoadingScreen, useToast, SupplierCombobox, Modal, Tabs } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'
import { CostSheetPanel } from '../shared/CostSheetPanel.jsx'
import { AiDraftModal } from '../shared/AiDraftModal.jsx'
import { MfrProjectStages } from './MfrProjectStages.jsx'

// Manufacturer's own non-Tradio business — Master Project → Project, mirroring
// AdminOrders.jsx's Master Order → Order flow one level up, but private
// (owner-only, zero admin override, per the plan's §1f privacy boundary) and
// margin-free. A project's material requirement is self-authored inline here
// (no push-to-stage mechanic — there's no TNA/stage system for these).
//
// Creation lives in the Order/Project Setup Wizard ('order_wizard' view) —
// this page is list + detail only; onNavigate opens the wizard.
export function MfrProjects({ onNavigate }) {
  const {
    listMfrMasterProjects, deleteMfrMasterProject,
    listMfrProjects, deleteMfrProject,
    getMaterialRequirement, addRequirementLine, updateRequirementLine, removeRequirementLine,
  } = useApp()
  const toast = useToast()

  const [masters, setMasters] = useState(null)
  const [projectsByMaster, setProjectsByMaster] = useState({}) // masterId|'_standalone' -> array
  const [selected, setSelected] = useState(null) // project object

  const load = useCallback(async () => {
    try {
      const [m, allProjects] = await Promise.all([listMfrMasterProjects(), listMfrProjects()])
      setMasters(m)
      const grouped = { _standalone: [] }
      m.forEach(mp => { grouped[mp.id] = [] })
      allProjects.forEach(p => {
        const key = p.mfrMasterProjectId || '_standalone'
        if (!grouped[key]) grouped[key] = []
        grouped[key].push(p)
      })
      setProjectsByMaster(grouped)
    } catch (err) { toast(err.message || 'Failed to load projects', 'error') }
  }, [])

  useEffect(() => { load() }, [load])

  if (masters === null) return <LoadingScreen />

  if (selected) {
    return <ProjectDetail project={selected} onBack={() => setSelected(null)}
      getMaterialRequirement={getMaterialRequirement} addRequirementLine={addRequirementLine}
      updateRequirementLine={updateRequirementLine} removeRequirementLine={removeRequirementLine} />
  }

  return (
    <div>
      <PageHeader title="My Projects" subtitle="Materials + costing for your own business — private, never visible to Tradio"
        action={<Btn onClick={() => onNavigate('order_wizard')} icon="✚">New Project</Btn>} />

      {masters.length === 0 && (projectsByMaster._standalone || []).length === 0 && (
        <Card><EmptyState icon="🗂" title="No projects yet" subtitle="Use New Project to set up a master project and add styles." /></Card>
      )}

      {masters.map(mp => (
        <Card key={mp.id} style={{ marginBottom: 14 }}>
          <FlexRow style={{ justifyContent: 'space-between', marginBottom: 10 }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 14 }}>{mp.buyerName}</div>
              <div style={{ fontSize: 12, color: T.textMuted }}>{mp.season || '—'}</div>
            </div>
            <Btn size="sm" variant="secondary" onClick={async () => { await deleteMfrMasterProject(mp.id); await load() }}>Delete</Btn>
          </FlexRow>
          {(projectsByMaster[mp.id] || []).length === 0
            ? <div style={{ fontSize: 12, color: T.textMuted }}>No styles yet.</div>
            : (projectsByMaster[mp.id] || []).map(p => <ProjectRow key={p.id} p={p} onOpen={() => setSelected(p)} onDelete={async () => { await deleteMfrProject(p.id); await load() }} />)}
        </Card>
      ))}

      {(projectsByMaster._standalone || []).length > 0 && (
        <Card>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10 }}>Standalone Styles</div>
          {(projectsByMaster._standalone || []).map(p => <ProjectRow key={p.id} p={p} onOpen={() => setSelected(p)} onDelete={async () => { await deleteMfrProject(p.id); await load() }} />)}
        </Card>
      )}
    </div>
  )
}

function ProjectRow({ p, onOpen, onDelete }) {
  return (
    <FlexRow style={{ justifyContent: 'space-between', padding: '8px 0', borderTop: `1px solid ${T.border}` }}>
      <div style={{ cursor: 'pointer' }} onClick={onOpen}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>{p.styleName}</div>
        <div style={{ fontSize: 11, color: T.textMuted }}>{p.category || '—'} · {p.totalQty?.toLocaleString() || 0} pcs</div>
      </div>
      <FlexRow gap={6}>
        <Btn size="sm" variant="secondary" onClick={onOpen}>Open</Btn>
        <Btn size="sm" variant="secondary" onClick={onDelete}>Delete</Btn>
      </FlexRow>
    </FlexRow>
  )
}

function ProjectDetail({ project: initialProject, onBack, getMaterialRequirement, addRequirementLine, updateRequirementLine, removeRequirementLine }) {
  const { currentUser, listSuppliers, duplicateRequirement, generateRequirementPO, listMfrProjects, docs } = useApp()
  const toast = useToast()
  const [project, setProject] = useState(initialProject)
  const [tab, setTab] = useState('materials')
  const [doc, setDoc] = useState(null)
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState({ category: 'fabric_primary', name: '', requiredQty: '', unit: '', supplier: '', wastagePct: '', rate: '' })
  const [busy, setBusy] = useState(false)
  const [suppliers, setSuppliers] = useState([])
  const [otherProjects, setOtherProjects] = useState([])
  const [showClone, setShowClone] = useState(false)
  const [cloneTargetId, setCloneTargetId] = useState('')
  const [showAiDraft, setShowAiDraft] = useState(false)
  const [selectedLineIds, setSelectedLineIds] = useState(new Set())

  const load = useCallback(async () => {
    setLoading(true)
    try { setDoc(await getMaterialRequirement({ mfrProjectId: project.id })) }
    catch (err) { toast(err.message || 'Failed to load requirement', 'error') }
    finally { setLoading(false) }
  }, [project.id])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    listSuppliers().then(setSuppliers).catch(() => {})
    listMfrProjects().then(list => setOtherProjects(list.filter(p => p.id !== project.id))).catch(() => {})
  }, [listSuppliers, listMfrProjects, project.id])

  async function handleAdd() {
    if (!form.name.trim() || !form.requiredQty) { toast('Name and quantity required', 'error'); return }
    setBusy(true)
    try {
      const res = await addRequirementLine({
        scopeType: 'mfr_project', mfrProjectId: project.id, ...form, requiredQty: Number(form.requiredQty),
        wastagePct: form.wastagePct ? Number(form.wastagePct) : undefined,
        rate: form.rate ? Number(form.rate) : undefined,
      })
      setDoc(res)
      setForm({ category: 'fabric_primary', name: '', requiredQty: '', unit: '', supplier: '', wastagePct: '', rate: '' })
    } catch (err) { toast(err.message || 'Failed to add line', 'error') } finally { setBusy(false) }
  }

  async function handleStatus(lineId, status) {
    setBusy(true)
    try { setDoc(await updateRequirementLine(doc.id, lineId, { status })) }
    catch (err) { toast(err.message || 'Update failed', 'error') } finally { setBusy(false) }
  }

  async function handleClone() {
    if (!doc?.id || !cloneTargetId) return
    setBusy(true)
    try {
      await duplicateRequirement(doc.id, { targetMfrProjectId: cloneTargetId })
      toast('BOM cloned to the selected style', 'success')
      setShowClone(false)
      setCloneTargetId('')
    } catch (err) { toast(err.message || 'Failed to clone', 'error') } finally { setBusy(false) }
  }

  function toggleLineSelection(lineId) {
    setSelectedLineIds(prev => { const next = new Set(prev); next.has(lineId) ? next.delete(lineId) : next.add(lineId); return next })
  }

  async function handleGeneratePO() {
    if (selectedLineIds.size === 0) return
    setBusy(true)
    try {
      const res = await generateRequirementPO(doc.id, { lineIds: [...selectedLineIds] })
      setDoc(res)
      setSelectedLineIds(new Set())
      toast('PO generated', 'success')
    } catch (err) { toast(err.message || 'Failed to generate PO', 'error') } finally { setBusy(false) }
  }

  const candidateDocs = (docs || []).filter(d => String(d.mfrProjectId) === String(project.id) && ['tech_pack', 'measurement_sheet', 'PO', 'buyer_order', 'RFQ'].includes(d.type))

  return (
    <div>
      {showAiDraft && (
        <AiDraftModal scopeType="mfr_project" mfrProjectId={project.id} candidateDocs={candidateDocs}
          onClose={() => setShowAiDraft(false)}
          onAccept={async (line) => {
            const res = await addRequirementLine({ scopeType: 'mfr_project', mfrProjectId: project.id, ...line, requiredQty: line.requiredQty ?? 0 })
            setDoc(res)
          }} />
      )}
      {showClone && (
        <Modal title="Clone BOM to Another Style" onClose={() => setShowClone(false)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <select value={cloneTargetId} onChange={e => setCloneTargetId(e.target.value)}
              style={{ padding: '8px 12px', borderRadius: 8, border: `1px solid ${T.border}`, fontSize: 13 }}>
              <option value="">Select target style…</option>
              {otherProjects.map(p => <option key={p.id} value={p.id}>{p.styleName}</option>)}
            </select>
            <FlexRow justify="flex-end" gap={8}>
              <Btn variant="secondary" onClick={() => setShowClone(false)}>Cancel</Btn>
              <Btn disabled={!cloneTargetId || busy} onClick={handleClone}>Clone</Btn>
            </FlexRow>
          </div>
        </Modal>
      )}

      <FlexRow style={{ marginBottom: 12 }}>
        <Btn size="sm" variant="secondary" onClick={onBack}>← Back</Btn>
      </FlexRow>
      <PageHeader title={project.styleName} subtitle={`${project.buyerName || 'No buyer set'} · ${project.category || '—'}`}
        action={<FlexRow gap={8}>
          <Btn size="sm" variant="secondary" onClick={() => setShowAiDraft(true)}>🤖 AI Draft</Btn>
          <Btn size="sm" variant="secondary" disabled={!doc?.id || (doc?.lines || []).length === 0} onClick={() => setShowClone(true)}>⧉ Clone to…</Btn>
        </FlexRow>} />

      <div style={{ marginBottom: 16 }}>
        <Tabs tabs={[{ id: 'materials', label: 'Materials' }, { id: 'costing', label: 'Costing' }, { id: 'tna', label: 'TNA' }]} active={tab} onChange={setTab} />
      </div>

      {tab === 'tna' && <MfrProjectStages project={project} onUpdated={setProject} />}

      {tab === 'materials' && <Card style={{ marginBottom: 16 }}>
        <FlexRow style={{ justifyContent: 'space-between', marginBottom: 10 }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>Materials</div>
          {selectedLineIds.size > 0 && <Btn size="sm" disabled={busy} onClick={handleGeneratePO}>Generate PO — {selectedLineIds.size} selected</Btn>}
        </FlexRow>
        {loading ? <LoadingScreen /> : (
          <>
            {(doc?.lines || []).length === 0
              ? <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 10 }}>No lines yet.</div>
              : (doc.lines.map(l => (
                <FlexRow key={l.id} style={{ justifyContent: 'space-between', padding: '6px 0', borderTop: `1px solid ${T.border}` }}>
                  <FlexRow gap={8}>
                    <input type="checkbox" checked={selectedLineIds.has(l.id)} onChange={() => toggleLineSelection(l.id)} />
                    <div style={{ fontSize: 13 }}>
                      <span style={{ fontSize: 10, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', marginRight: 6 }}>{REQUIREMENT_CATEGORY_LABEL[l.category] || l.category}</span>
                      <span style={{ fontWeight: 600 }}>{l.name}</span>
                      <span style={{ color: T.textMuted, marginLeft: 6 }}>{l.requiredQty} {l.unit}{l.supplier ? ` · ${l.supplier}` : ''}</span>
                      {l.wastagePct > 0 && <span style={{ color: T.warning, marginLeft: 6, fontSize: 11 }}>+{l.wastagePct}% wastage → order {l.qtyToOrder} {l.unit}</span>}
                      {l.rate != null && <span style={{ color: T.textMuted, marginLeft: 6, fontSize: 11 }}>@ ₹{l.rate}/{l.unit || 'unit'}</span>}
                      {l.poNumber && <span style={{ color: T.textMuted, marginLeft: 6, fontSize: 11 }}>PO {l.poNumber}</span>}
                    </div>
                  </FlexRow>
                  <FlexRow gap={6}>
                    <Badge status={l.status} />
                    <select value={l.status} disabled={busy} onChange={e => handleStatus(l.id, e.target.value)}
                      style={{ padding: '4px 6px', borderRadius: 6, border: `1px solid ${T.border}`, fontSize: 12 }}>
                      <option value="pending">Pending</option>
                      <option value="ordered">Ordered</option>
                      <option value="received">Received</option>
                    </select>
                  </FlexRow>
                </FlexRow>
              )))}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr 1fr 1fr', gap: 6, marginTop: 12 }}>
              <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                style={{ padding: '6px 8px', borderRadius: 6, border: `1px solid ${T.border}`, fontSize: 12 }}>
                {REQUIREMENT_CATEGORIES.map(c => <option key={c.v} value={c.v}>{c.l}</option>)}
              </select>
              <Input placeholder="Material name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
              <Input placeholder="Qty" type="number" value={form.requiredQty} onChange={e => setForm(f => ({ ...f, requiredQty: e.target.value }))} />
              <Input placeholder="Unit" value={form.unit} onChange={e => setForm(f => ({ ...f, unit: e.target.value }))} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, marginTop: 6 }}>
              <SupplierCombobox label="" suppliers={suppliers} value={form.supplier} onChange={v => setForm(f => ({ ...f, supplier: v }))} placeholder="Supplier (optional)" />
              <Input placeholder="Wastage % (optional)" type="number" min="0" value={form.wastagePct} onChange={e => setForm(f => ({ ...f, wastagePct: e.target.value }))} />
              <Input placeholder="Rate per unit (optional)" type="number" min="0" value={form.rate} onChange={e => setForm(f => ({ ...f, rate: e.target.value }))} />
            </div>
            <div style={{ marginTop: 8 }}><Btn size="sm" disabled={busy} onClick={handleAdd}>+ Add</Btn></div>
          </>
        )}
      </Card>}

      {tab === 'costing' && <CostSheetPanel scopeType="mfr_project" mfrProjectId={project.id} mfrId={currentUser.id} orderQty={project.totalQty} styleLabel="Cost Sheet" />}
    </div>
  )
}
