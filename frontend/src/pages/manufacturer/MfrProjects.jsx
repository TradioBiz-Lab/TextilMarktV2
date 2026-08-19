import { useState, useEffect, useCallback } from 'react'
import { T } from '../../constants.js'
import { PageHeader, Modal, Input, Btn, Card, Badge, FlexRow, EmptyState, LoadingScreen, useToast } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'
import { CostSheetPanel } from '../shared/CostSheetPanel.jsx'

// Manufacturer's own non-Tradio business — Master Project → Project, mirroring
// AdminOrders.jsx's Master Order → Order flow one level up, but private
// (owner-only, zero admin override, per the plan's §1f privacy boundary) and
// margin-free. A project's material requirement is self-authored inline here
// (no push-to-stage mechanic — there's no TNA/stage system for these).
export function MfrProjects() {
  const {
    listMfrMasterProjects, createMfrMasterProject, deleteMfrMasterProject,
    listMfrProjects, createMfrProject, deleteMfrProject,
    getMaterialRequirement, addRequirementLine, updateRequirementLine, removeRequirementLine,
  } = useApp()
  const toast = useToast()

  const [masters, setMasters] = useState(null)
  const [projectsByMaster, setProjectsByMaster] = useState({}) // masterId|'_standalone' -> array
  const [selected, setSelected] = useState(null) // project object
  const [showNewMaster, setShowNewMaster] = useState(false)
  const [showNewProject, setShowNewProject] = useState(null) // mfrMasterProjectId or 'standalone' or null
  const [masterForm, setMasterForm] = useState({ buyerName: '', season: '', notes: '' })
  const [projectForm, setProjectForm] = useState({ styleName: '', buyerName: '', category: '', season: '', totalQty: '', delivery: '', colourways: '', notes: '' })
  const [busy, setBusy] = useState(false)

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

  async function submitMaster() {
    if (!masterForm.buyerName.trim()) { toast('Buyer name is required', 'error'); return }
    setBusy(true)
    try {
      await createMfrMasterProject(masterForm)
      setShowNewMaster(false)
      setMasterForm({ buyerName: '', season: '', notes: '' })
      await load()
      toast('Master project created', 'success')
    } catch (err) { toast(err.message || 'Failed to create', 'error') } finally { setBusy(false) }
  }

  async function submitProject() {
    if (!projectForm.styleName.trim()) { toast('Style name is required', 'error'); return }
    setBusy(true)
    try {
      const colourways = projectForm.colourways.split(',').map(s => s.trim()).filter(Boolean).map(name => ({ name, code: '' }))
      await createMfrProject({
        ...projectForm,
        mfrMasterProjectId: showNewProject === 'standalone' ? null : showNewProject,
        totalQty: projectForm.totalQty ? Number(projectForm.totalQty) : 0,
        delivery: projectForm.delivery || null,
        colourways,
      })
      setShowNewProject(null)
      setProjectForm({ styleName: '', buyerName: '', category: '', season: '', totalQty: '', delivery: '', colourways: '', notes: '' })
      await load()
      toast('Style added', 'success')
    } catch (err) { toast(err.message || 'Failed to create', 'error') } finally { setBusy(false) }
  }

  if (masters === null) return <LoadingScreen />

  if (selected) {
    return <ProjectDetail project={selected} onBack={() => setSelected(null)}
      getMaterialRequirement={getMaterialRequirement} addRequirementLine={addRequirementLine}
      updateRequirementLine={updateRequirementLine} removeRequirementLine={removeRequirementLine} />
  }

  return (
    <div>
      {showNewMaster && (
        <Modal title="New Master Project" onClose={() => setShowNewMaster(false)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Input label="Buyer / Client Name" value={masterForm.buyerName} onChange={e => setMasterForm(f => ({ ...f, buyerName: e.target.value }))} />
            <Input label="Season" value={masterForm.season} onChange={e => setMasterForm(f => ({ ...f, season: e.target.value }))} />
            <Input label="Notes" value={masterForm.notes} onChange={e => setMasterForm(f => ({ ...f, notes: e.target.value }))} />
            <FlexRow justify="flex-end" gap={8}>
              <Btn variant="secondary" onClick={() => setShowNewMaster(false)}>Cancel</Btn>
              <Btn disabled={busy} onClick={submitMaster}>Create</Btn>
            </FlexRow>
          </div>
        </Modal>
      )}

      {showNewProject && (
        <Modal title="Add Style" onClose={() => setShowNewProject(null)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Input label="Style Name" value={projectForm.styleName} onChange={e => setProjectForm(f => ({ ...f, styleName: e.target.value }))} />
            <Input label="Buyer / Client Name" value={projectForm.buyerName} onChange={e => setProjectForm(f => ({ ...f, buyerName: e.target.value }))} />
            <div className="form-grid-2">
              <Input label="Category" value={projectForm.category} onChange={e => setProjectForm(f => ({ ...f, category: e.target.value }))} />
              <Input label="Season" value={projectForm.season} onChange={e => setProjectForm(f => ({ ...f, season: e.target.value }))} />
            </div>
            <div className="form-grid-2">
              <Input label="Total Qty" type="number" value={projectForm.totalQty} onChange={e => setProjectForm(f => ({ ...f, totalQty: e.target.value }))} />
              <Input label="Delivery Date" type="date" value={projectForm.delivery} onChange={e => setProjectForm(f => ({ ...f, delivery: e.target.value }))} />
            </div>
            <Input label="Colourways (comma-separated)" value={projectForm.colourways} onChange={e => setProjectForm(f => ({ ...f, colourways: e.target.value }))} placeholder="Black, Navy, Charcoal" />
            <Input label="Notes" value={projectForm.notes} onChange={e => setProjectForm(f => ({ ...f, notes: e.target.value }))} />
            <FlexRow justify="flex-end" gap={8}>
              <Btn variant="secondary" onClick={() => setShowNewProject(null)}>Cancel</Btn>
              <Btn disabled={busy} onClick={submitProject}>Create</Btn>
            </FlexRow>
          </div>
        </Modal>
      )}

      <PageHeader title="My Projects" subtitle="Materials + costing for your own business — private, never visible to Tradio"
        action={<FlexRow gap={8}>
          <Btn variant="secondary" onClick={() => setShowNewProject('standalone')} icon="✚">Standalone Style</Btn>
          <Btn onClick={() => setShowNewMaster(true)} icon="✚">New Master Project</Btn>
        </FlexRow>} />

      {masters.length === 0 && (projectsByMaster._standalone || []).length === 0 && (
        <Card><EmptyState icon="🗂" title="No projects yet" subtitle="Create a master project to group styles for one buyer, or add a standalone style." /></Card>
      )}

      {masters.map(mp => (
        <Card key={mp.id} style={{ marginBottom: 14 }}>
          <FlexRow style={{ justifyContent: 'space-between', marginBottom: 10 }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 14 }}>{mp.buyerName}</div>
              <div style={{ fontSize: 12, color: T.textMuted }}>{mp.season || '—'}</div>
            </div>
            <FlexRow gap={6}>
              <Btn size="sm" variant="secondary" onClick={() => setShowNewProject(mp.id)}>+ Add Style</Btn>
              <Btn size="sm" variant="secondary" onClick={async () => { await deleteMfrMasterProject(mp.id); await load() }}>Delete</Btn>
            </FlexRow>
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

function ProjectDetail({ project, onBack, getMaterialRequirement, addRequirementLine, updateRequirementLine, removeRequirementLine }) {
  const { currentUser } = useApp()
  const toast = useToast()
  const [doc, setDoc] = useState(null)
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState({ category: 'fabric', name: '', requiredQty: '', unit: '', supplier: '' })
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try { setDoc(await getMaterialRequirement({ mfrProjectId: project.id })) }
    catch (err) { toast(err.message || 'Failed to load requirement', 'error') }
    finally { setLoading(false) }
  }, [project.id])

  useEffect(() => { load() }, [load])

  async function handleAdd() {
    if (!form.name.trim() || !form.requiredQty) { toast('Name and quantity required', 'error'); return }
    setBusy(true)
    try {
      const res = await addRequirementLine({ scopeType: 'mfr_project', mfrProjectId: project.id, ...form, requiredQty: Number(form.requiredQty) })
      setDoc(res)
      setForm({ category: 'fabric', name: '', requiredQty: '', unit: '', supplier: '' })
    } catch (err) { toast(err.message || 'Failed to add line', 'error') } finally { setBusy(false) }
  }

  async function handleStatus(lineId, status) {
    setBusy(true)
    try { setDoc(await updateRequirementLine(doc.id, lineId, { status })) }
    catch (err) { toast(err.message || 'Update failed', 'error') } finally { setBusy(false) }
  }

  return (
    <div>
      <FlexRow style={{ marginBottom: 12 }}>
        <Btn size="sm" variant="secondary" onClick={onBack}>← Back</Btn>
      </FlexRow>
      <PageHeader title={project.styleName} subtitle={`${project.buyerName || 'No buyer set'} · ${project.category || '—'}`} />

      <Card style={{ marginBottom: 16 }}>
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10 }}>Materials</div>
        {loading ? <LoadingScreen /> : (
          <>
            {(doc?.lines || []).length === 0
              ? <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 10 }}>No lines yet.</div>
              : (doc.lines.map(l => (
                <FlexRow key={l.id} style={{ justifyContent: 'space-between', padding: '6px 0', borderTop: `1px solid ${T.border}` }}>
                  <div style={{ fontSize: 13 }}>
                    <span style={{ fontWeight: 600 }}>{l.name}</span>
                    <span style={{ color: T.textMuted, marginLeft: 6 }}>{l.requiredQty} {l.unit}{l.supplier ? ` · ${l.supplier}` : ''}</span>
                  </div>
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
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr 1fr 1fr 1fr', gap: 6, marginTop: 12 }}>
              <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                style={{ padding: '6px 8px', borderRadius: 6, border: `1px solid ${T.border}`, fontSize: 12 }}>
                <option value="fabric">Fabric</option><option value="trim">Trim</option>
                <option value="accessory">Accessory</option><option value="other">Other</option>
              </select>
              <Input placeholder="Material name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
              <Input placeholder="Qty" type="number" value={form.requiredQty} onChange={e => setForm(f => ({ ...f, requiredQty: e.target.value }))} />
              <Input placeholder="Unit" value={form.unit} onChange={e => setForm(f => ({ ...f, unit: e.target.value }))} />
              <Btn size="sm" disabled={busy} onClick={handleAdd}>+ Add</Btn>
            </div>
          </>
        )}
      </Card>

      <CostSheetPanel scopeType="mfr_project" mfrProjectId={project.id} mfrId={currentUser.id} orderQty={project.totalQty} styleLabel="Cost Sheet" />
    </div>
  )
}
