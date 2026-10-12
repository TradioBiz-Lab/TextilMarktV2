import { useCallback, useEffect, useMemo, useState } from 'react'
import { Sparkles, Plus, Calculator, Trash2, FileSpreadsheet } from '../../icons.jsx'
import { T } from '../../constants.js'
import { Btn, Card, Alert, LoadingScreen, EmptyState, FlexRow, useToast } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'
import { capsFor } from '../../caps.js'
import { bomsApi, specSheetsApi, costSheetsApi } from '../../api.js'
import { ProcurementProviders, suppliersStore } from '../../stores/procurement.jsx'
import { toDraft, payloadFrom, isDirty, reviewCount, num, BOM_COLUMNS, BOM_EXAMPLE, linesFromRows } from '../../lib/bomUi.js'
import { SpreadsheetImport } from '../../components/SpreadsheetImport.jsx'
import { Pill } from '../procurement/common.jsx'
import { BomEditor } from './BomEditor.jsx'
import { SpecSheetPanel } from './SpecSheetPanel.jsx'
import { TechPackModal } from './TechPackModal.jsx'

/**
 * The factory's bill of materials for one order, inside the order screen: read a tech pack into a draft (or
 * start blank), check the lines, set suppliers and rates, freeze it as the master list, and from there price
 * it (a cost sheet) and buy for it (the shopping list). Frozen versions are the record; a change is a new one.
 */
export function BomTab(props) {
  return <ProcurementProviders><BomTabInner {...props} /></ProcurementProviders>
}

function BomTabInner({ order, asgn, onNavigate }) {
  const toast = useToast()
  const { docs, currentUser } = useApp()
  const caps = capsFor(currentUser)
  const { items: suppliers } = suppliersStore.useStore()
  const [data, setData] = useState(null)        // { order, versions, current, seed }
  const [bom, setBom] = useState(null)          // the version shown, as the server describes it
  const [draft, setDraft] = useState(null)      // its editable state, when it is a draft
  const [saved, setSaved] = useState(null)      // what the draft looked like when last saved
  const [spec, setSpec] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [reading, setReading] = useState(false)
  const [note, setNote] = useState(null)        // what the tech pack reading said, kept until dismissed
  const [importing, setImporting] = useState(false)

  const packs = useMemo(() => (docs || []).filter(d => d.orderId === order.id && d.type === 'tech_pack' && d.isActive !== false), [docs, order.id])

  const show = useCallback(b => {
    setBom(b)
    if (b.status === 'draft') { const d = toDraft(b); setDraft(d); setSaved(d) } else { setDraft(null); setSaved(null) }
  }, [])

  const load = useCallback(async () => {
    try {
      const d = await bomsApi.forOrder(order.id)
      setData(d); setError('')
      if (d.current) show(d.current)
      specSheetsApi.forOrder(order.id).then(s => setSpec(s[0] || null)).catch(() => {})
    } catch (e) { setError(e?.message || 'Could not load the bill of materials') }
  }, [order.id, show])
  useEffect(() => { load() }, [load])

  const manage = caps.manageBom
  const dirty = !!(draft && saved && isDirty(draft, saved))
  const flagged = draft ? reviewCount(draft.lines) : 0
  const totalQty = draft ? num(draft.plan.totalQty) : bom?.plan?.totalQty || 0

  const act = async (fn, ok) => {
    setBusy(true)
    try { const r = await fn(); if (ok) toast(ok, 'success'); return r } catch (e) { toast(e?.message || 'That did not work', e?.code === 'STALE' ? 'warning' : 'error'); if (e?.code === 'STALE') load(); return null } finally { setBusy(false) }
  }

  const start = async ({ thenImport = false } = {}) => { const b = await act(() => bomsApi.create(order.id)); if (b) { await load(); if (thenImport) setImporting(true) } }
  const save = async ({ confirmAll = false } = {}) => {
    const b = await act(() => bomsApi.save(bom.id, payloadFrom(draft, bom.updatedAt, { confirmAll })), confirmAll ? 'All lines confirmed and saved' : 'Bill of materials saved')
    if (b) show(b)
    return b
  }
  const freeze = async () => {
    let current = bom
    if (dirty) { current = await save(); if (!current) return }
    const f = await act(() => bomsApi.freeze(current.id), 'Frozen. It is now the master list to buy from.')
    if (f) await load()
  }
  const revise = async () => { const b = await act(() => bomsApi.revise(bom.id), 'New version started'); if (b) await load() }
  const remove = async () => {
    if (!window.confirm('Delete this draft? This cannot be undone.')) return
    const r = await act(() => bomsApi.remove(bom.id), 'Draft deleted')
    if (r) { setBom(null); setDraft(null); setSaved(null); setNote(null); await load() }
  }
  const open = async id => { const b = await act(() => bomsApi.get(id)); if (b) show(b) }
  const read = r => {
    setReading(false)
    setNote(r.extraction)
    if (r.spec) setSpec(r.spec)
    toast(`Read the tech pack: ${r.extraction.lines} line${r.extraction.lines === 1 ? '' : 's'} to check${r.extraction.specPoints ? `, ${r.extraction.specPoints} measurements kept` : ''}`, 'success')
    load()
  }
  const toCosting = async () => {
    const s = await act(() => costSheetsApi.create({ brandId: order.buyerId, orderId: order.id, bomId: bom.id }), 'Cost sheet started from this bill of materials')
    if (s) onNavigate('cost_sheet', { cost: s.id })
  }

  if (error) return <Alert type="danger">{error}</Alert>
  if (!data) return <LoadingScreen message="Loading bill of materials..." />

  const frozen = bom?.status === 'frozen'
  const newest = !bom || data.versions[0]?.id === bom.id

  // Nothing yet: the two ways to begin.
  if (!bom) {
    return (
      <div>
        <EmptyState icon={<Sparkles size={28} color={T.textLight} />} title="No bill of materials yet"
          desc={manage ? 'Read the tech pack and the AI drafts the list of fabrics, trims and labels for you to check. Or bring your own list from Excel, or start with a blank one and type it in.' : 'The factory has not made a bill of materials for this order yet.'} />
        {manage && (
          <FlexRow justify="center" gap={10} style={{ marginTop: 6, flexWrap: 'wrap' }}>
            <Btn icon={<Sparkles size={14} />} onClick={() => setReading(true)}>Read the tech pack</Btn>
            <Btn variant="secondary" icon={<FileSpreadsheet size={14} />} onClick={() => start({ thenImport: true })} disabled={busy}>Import from Excel</Btn>
            <Btn variant="secondary" icon={<Plus size={14} />} onClick={() => start()} disabled={busy}>Start a blank list</Btn>
          </FlexRow>
        )}
        {reading && <TechPackModal orderId={order.id} packs={packs} onClose={() => setReading(false)} onRead={read} />}
      </div>
    )
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
        <FlexRow gap={8} style={{ flexWrap: 'wrap' }}>
          <Pill tone={frozen ? 'good' : 'warn'}>{frozen ? 'Frozen' : 'Draft'}</Pill>
          <span style={{ fontSize: 13, fontWeight: 700, color: T.text }}>Version {bom.version}</span>
          {frozen && <span style={{ fontSize: 12, color: T.textMuted }}>The master list: costed and bought from</span>}
          {dirty && <span style={{ fontSize: 12, color: T.warning, fontWeight: 600 }}>Unsaved changes</span>}
        </FlexRow>
        {data.versions.length > 1 && (
          <FlexRow gap={6} style={{ flexWrap: 'wrap' }}>
            {data.versions.map(v => (
              <button key={v.id} type="button" onClick={() => v.id !== bom.id && open(v.id)} aria-current={v.id === bom.id ? 'true' : undefined}
                style={{ padding: '3px 11px', borderRadius: 16, fontSize: 12, fontWeight: 700, border: `1px solid ${v.id === bom.id ? T.primary : T.border}`, background: v.id === bom.id ? T.primaryLight : T.surface, color: v.id === bom.id ? T.primaryDeep : T.textMuted, cursor: v.id === bom.id ? 'default' : 'pointer', fontFamily: 'inherit' }}>v{v.version} {v.status}</button>
            ))}
          </FlexRow>
        )}
        {manage && (
          <FlexRow gap={8} style={{ marginLeft: 'auto', flexWrap: 'wrap' }}>
            {!frozen && <Btn variant="secondary" size="sm" icon={<Sparkles size={13} />} onClick={() => setReading(true)} disabled={busy}>Read a tech pack</Btn>}
            {!frozen && <Btn variant="secondary" size="sm" icon={<FileSpreadsheet size={13} />} onClick={() => setImporting(true)} disabled={busy}>Import Excel</Btn>}
            {!frozen && flagged > 0 && <Btn variant="secondary" size="sm" onClick={() => save({ confirmAll: true })} disabled={busy}>Looks right: confirm all {flagged}</Btn>}
            {!frozen && <Btn variant="secondary" size="sm" onClick={() => save()} disabled={busy || !dirty}>{busy ? 'Saving...' : 'Save'}</Btn>}
            {!frozen && <Btn size="sm" onClick={freeze} disabled={busy || draft?.lines.every(l => !l.item.trim())}>Freeze</Btn>}
            {frozen && newest && <Btn variant="secondary" size="sm" onClick={revise} disabled={busy}>Start a new version</Btn>}
            {frozen && newest && caps.manageCosting && order.buyerId && <Btn size="sm" icon={<Calculator size={13} />} onClick={toCosting} disabled={busy}>Create a cost sheet</Btn>}
          </FlexRow>
        )}
      </div>

      {note && (
        <div style={{ marginBottom: 14 }}>
          <Alert type="info">
            <strong>Tech pack read</strong> ({Math.round((note.confidence || 0) * 100)}% overall confidence): {note.lines} line{note.lines === 1 ? '' : 's'} added{note.skipped ? `, ${note.skipped} skipped` : ''}. Nobody wrote a consumption on the pack, so fill in how much each line uses per piece, then choose suppliers and rates.
            {note.notes?.length > 0 && <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{note.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
            <div style={{ marginTop: 6 }}><button type="button" className="gl-link" onClick={() => setNote(null)}>Dismiss</button></div>
          </Alert>
        </div>
      )}
      {!frozen && flagged > 0 && <div style={{ marginBottom: 14 }}><Alert type="warning">{flagged} line{flagged === 1 ? '' : 's'} from the tech pack need{flagged === 1 ? 's' : ''} your check before you can freeze this. Edit what is wrong, then choose "Looks right".</Alert></div>}

      {draft
        ? <BomEditor draft={draft} setDraft={setDraft} suppliers={suppliers} readOnly={!manage} totalQty={totalQty} />
        : <BomEditor draft={toDraft(bom)} setDraft={() => {}} suppliers={suppliers} readOnly totalQty={bom.plan.totalQty} />}

      {spec && <><div style={{ height: 14 }} /><SpecSheetPanel spec={spec} /></>}

      {manage && !frozen && (
        <div style={{ marginTop: 18 }}>
          <Btn variant="danger" size="sm" icon={<Trash2 size={12} />} onClick={remove} disabled={busy}>Delete this draft</Btn>
        </div>
      )}
      {frozen && <div style={{ marginTop: 14 }}><Card pad={false}><div style={{ padding: '12px 16px', fontSize: 12, color: T.textMuted, lineHeight: 1.6 }}>A frozen bill of materials is the record and cannot be edited. To change something, start a new version: the lines and their ids carry over, so purchase orders already raised stay linked. Use the Shopping List to buy what is needed.</div></Card></div>}

      {reading && <TechPackModal orderId={order.id} packs={packs} onClose={() => setReading(false)} onRead={read} />}
      {importing && draft && (
        <SpreadsheetImport title="Import bill of materials lines" noun="lines" columns={BOM_COLUMNS} example={BOM_EXAMPLE} templateName="bill-of-materials"
          onImport={async rows => {
            // The lines join the draft for the person to look over; nothing is saved until they save.
            const { lines, skipped, unmatched } = linesFromRows(rows, suppliers, draft.plan.sizes.length)
            setDraft(d => ({ ...d, lines: [...d.lines, ...lines] }))
            return { created: lines.length, skipped, unmatched }
          }}
          onDone={a => toast(`${a.created} line${a.created === 1 ? '' : 's'} added${a.unmatched ? `, ${a.unmatched} with a supplier that is not in your book` : ''}. Check them, then save.`, 'success')}
          onClose={() => setImporting(false)} />
      )}
    </div>
  )
}
