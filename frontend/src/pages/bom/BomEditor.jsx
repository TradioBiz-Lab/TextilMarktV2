import { useMemo, useState } from 'react'
import { Plus, X, FileSpreadsheet } from '../../icons.jsx'
import { T } from '../../constants.js'
import { Btn, Card, Alert, Input, SectionLabel } from '../../components/ui.jsx'
import { SpreadsheetImport } from '../../components/SpreadsheetImport.jsx'
import {
  SECTIONS, blankLine, newKey, decimal, preview, alignPerSize, shareEvenly, num,
  gridOn, toGrid, fromGrid, setGridCell, addGridSize, removeGridSize, gridColumns, gridExample, sizeNamesUsable, coloursFromRows,
} from '../../lib/bomUi.js'
import { fmtQty } from '../../lib/procurement.js'

const COLS = 'minmax(190px, 3fr) 64px 84px 72px minmax(120px, 1.3fr) 84px 108px 34px'

/** "BLACK 2,783 · NAVY 2,783 · +1 more" for a line bought per colour. */
const colourSummary = c => {
  const parts = c.perColour.slice(0, 3).map(p => `${p.colour} ${fmtQty(p.orderQty)}`)
  return parts.join(' · ') + (c.perColour.length > 3 ? ` · +${c.perColour.length - 3} more` : '')
}

/**
 * The bill of materials as the factory edits it: the plan (order quantity, sizes with their ratio, colours
 * with their pieces) and the lines under each section. Quantities show live while typing, worked the way the
 * server will work them; the server's figures are the ones stored. `readOnly` shows a frozen version as text.
 * The parent owns the draft and what to do with it.
 */
export function BomEditor({ draft, setDraft, suppliers, readOnly, totalQty }) {
  const [perSizeOpen, setPerSizeOpen] = useState(() => new Set())
  const [importingGrid, setImportingGrid] = useState(false)
  const worked = useMemo(() => preview(draft, totalQty), [draft, totalQty])
  const computedOf = key => worked.lines.find(l => l.key === key)?.computed
  const supplierName = id => suppliers.find(s => s.id === id)?.name || ''
  const sizeNames = draft.plan.sizes.map(s => s.name || '?')

  const setPlan = patch => setDraft(d => ({ ...d, plan: { ...d.plan, ...patch } }))
  const setSize = (i, patch) => setPlan({ sizes: draft.plan.sizes.map((s, j) => (j === i ? { ...s, ...patch } : s)) })
  const addSize = () => setDraft(d => ({ plan: { ...d.plan, sizes: [...d.plan.sizes, { name: '', ratio: '1' }], colours: addGridSize(d.plan.colours) }, lines: alignPerSize(d.lines, d.plan.sizes.length + 1) }))
  const removeSize = i => setDraft(d => ({
    plan: { ...d.plan, sizes: d.plan.sizes.filter((_, j) => j !== i), colours: removeGridSize(d.plan.colours, i) },
    lines: d.lines.map(l => ({ ...l, perSize: l.perSize.filter((_, j) => j !== i) })),
  }))
  const grid = gridOn(draft.plan.colours)
  const setColour = (key, patch) => setPlan({ colours: draft.plan.colours.map(c => (c.key === key ? { ...c, ...patch } : c)) })
  const addColour = () => setPlan({ colours: [...draft.plan.colours, { key: newKey(), name: '', qty: grid ? '0' : '', sizes: grid ? draft.plan.sizes.map(() => '') : null }] })
  const removeColour = key => setPlan({ colours: draft.plan.colours.filter(c => c.key !== key) })
  const setCell = (key, i, value) => setPlan({ colours: setGridCell(draft.plan.colours, key, i, decimal(value).split('.')[0]) })
  const useGrid = () => setPlan({ colours: toGrid(draft.plan.colours, draft.plan.sizes.map(s => s.ratio)) })
  const useRatio = () => {
    if (!window.confirm('Go back to one size ratio for every colour? The pieces you gave for each size are dropped; each colour keeps its total.')) return
    setPlan({ colours: fromGrid(draft.plan.colours) })
  }
  const sizeTotals = draft.plan.sizes.map((_, i) => draft.plan.colours.reduce((t, c) => t + num(c.sizes?.[i]), 0))

  const setLine = (key, patch) => setDraft(d => ({ ...d, lines: d.lines.map(l => (l.key === key ? { ...l, ...patch } : l)) }))
  const addLine = section => setDraft(d => ({ ...d, lines: [...d.lines, { ...blankLine(section), perSize: d.plan.sizes.map(() => '') }] }))
  const removeLine = key => setDraft(d => ({ ...d, lines: d.lines.filter(l => l.key !== key) }))

  const colourTotal = draft.plan.colours.reduce((s, c) => s + num(c.qty), 0)
  const orderQty = num(draft.plan.totalQty)

  const planCard = (
    <Card>
      <SectionLabel>Quantity plan</SectionLabel>
      <div style={{ fontSize: 12, color: T.textLight, marginTop: 2, marginBottom: 10 }}>The pieces, split over sizes and colours: what every line below is worked from.</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 18 }}>
        <div>
          <Input label="Order quantity (pieces)" inputMode="numeric" value={draft.plan.totalQty} readOnly={readOnly} onChange={e => setPlan({ totalQty: decimal(e.target.value).split('.')[0] })} />
        </div>
        <div style={{ gridColumn: '1 / -1', order: 3 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 5 }}>Sizes and the ratio they sell in</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {draft.plan.sizes.map((s, i) => (
              <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'stretch', width: 64 }}>
                <input value={s.name} readOnly={readOnly} onChange={e => setSize(i, { name: e.target.value.slice(0, 12) })} aria-label={`Size ${i + 1} name`} placeholder="Size" style={{ border: `1px solid ${T.border}`, borderRadius: 8, padding: '8px 6px', fontSize: 13, fontWeight: 700, textAlign: 'center', fontFamily: 'inherit', minHeight: 40, boxSizing: 'border-box', width: '100%' }} />
                <input value={s.ratio} readOnly={readOnly} inputMode="decimal" onChange={e => setSize(i, { ratio: decimal(e.target.value) })} aria-label={`${s.name || 'Size'} ratio`} style={{ border: `1px solid ${T.border}`, borderRadius: 8, padding: '8px 6px', fontSize: 13, textAlign: 'center', fontFamily: 'inherit', minHeight: 40, boxSizing: 'border-box', width: '100%', background: '#f8fafc' }} />
                {!readOnly && draft.plan.sizes.length > 1 && <button type="button" onClick={() => removeSize(i)} aria-label={`Remove size ${s.name || i + 1}`} style={{ background: 'none', border: 'none', color: T.textLight, fontSize: 11, cursor: 'pointer', fontFamily: 'inherit', padding: 2 }}>remove</button>}
              </div>
            ))}
            {!readOnly && draft.plan.sizes.length < 12 && <button type="button" onClick={addSize} style={{ alignSelf: 'flex-start', width: 64, height: 40, border: `1px dashed ${T.border}`, borderRadius: 8, background: 'none', cursor: 'pointer', color: T.textMuted, fontSize: 18 }} aria-label="Add a size">+</button>}
          </div>
          <div style={{ fontSize: 11, color: T.textLight, marginTop: 6 }}>For example S 1, M 2, L 3, XL 2, XXL 1: of every 9 pieces, 3 are size L.</div>
        </div>
        <div style={grid ? { gridColumn: '1 / -1', order: 4 } : undefined}>
          <div style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 5 }}>{grid ? 'Colours and their pieces, size by size' : 'Colours and their pieces'}</div>
          {draft.plan.colours.map(c => (
            grid ? (
              <div key={c.key} style={{ border: `1px solid ${T.border}`, borderRadius: 10, padding: 10, marginBottom: 8, background: '#fcfcfd' }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8 }}>
                  <input value={c.name} readOnly={readOnly} onChange={e => setColour(c.key, { name: e.target.value.slice(0, 60) })} placeholder="Colour" aria-label="Colour name" style={{ flex: 1, minWidth: 0, border: `1px solid ${T.border}`, borderRadius: 8, padding: '8px 10px', fontSize: 13, fontWeight: 700, fontFamily: 'inherit', minHeight: 40, boxSizing: 'border-box' }} />
                  <div style={{ minWidth: 78, textAlign: 'right', fontSize: 13, fontWeight: 700, color: T.text }} aria-label={`${c.name || 'Colour'} pieces`}>{fmtQty(num(c.qty))} pcs</div>
                  {!readOnly && <button type="button" className="gl-remove" onClick={() => removeColour(c.key)} aria-label={`Remove colour ${c.name || ''}`}><X size={14} /></button>}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(52px, 1fr))', gap: 6 }}>
                  {draft.plan.sizes.map((s, i) => (
                    <label key={i} style={{ display: 'block', minWidth: 0 }}>
                      <span style={{ display: 'block', textAlign: 'center', fontSize: 11, fontWeight: 700, color: T.textMuted, marginBottom: 2 }}>{sizeNames[i]}</span>
                      <input value={c.sizes?.[i] ?? ''} readOnly={readOnly} inputMode="numeric" onChange={e => setCell(c.key, i, e.target.value)} aria-label={`${c.name || 'Colour'} ${sizeNames[i]} pieces`} style={{ width: '100%', border: `1px solid ${T.border}`, borderRadius: 8, padding: '8px 4px', fontSize: 13, textAlign: 'center', fontFamily: 'inherit', minHeight: 40, boxSizing: 'border-box' }} />
                    </label>
                  ))}
                </div>
              </div>
            ) : (
              <div key={c.key} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
                <input value={c.name} readOnly={readOnly} onChange={e => setColour(c.key, { name: e.target.value.slice(0, 60) })} placeholder="Colour" aria-label="Colour name" style={{ flex: 1, minWidth: 0, border: `1px solid ${T.border}`, borderRadius: 8, padding: '8px 10px', fontSize: 13, fontFamily: 'inherit', minHeight: 40, boxSizing: 'border-box' }} />
                <input value={c.qty} readOnly={readOnly} inputMode="numeric" onChange={e => setColour(c.key, { qty: decimal(e.target.value).split('.')[0] })} placeholder="Pieces" aria-label={`${c.name || 'Colour'} pieces`} style={{ width: 92, border: `1px solid ${T.border}`, borderRadius: 8, padding: '8px 10px', fontSize: 13, textAlign: 'right', fontFamily: 'inherit', minHeight: 40, boxSizing: 'border-box' }} />
                {!readOnly && <button type="button" className="gl-remove" onClick={() => removeColour(c.key)} aria-label={`Remove colour ${c.name || ''}`}><X size={14} /></button>}
              </div>
            )
          ))}
          {grid && draft.plan.colours.length > 1 && (
            <div style={{ fontSize: 12, color: T.textMuted, margin: '2px 0 8px', display: 'flex', gap: 10, flexWrap: 'wrap' }} aria-label="Pieces of each size over all colours">
              <strong style={{ color: T.text }}>All colours:</strong>
              {draft.plan.sizes.map((_, i) => <span key={i}>{sizeNames[i]} {fmtQty(sizeTotals[i])}</span>)}
            </div>
          )}
          {!readOnly && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
              <Btn variant="secondary" size="sm" icon={<Plus size={12} />} onClick={addColour}>Add colour</Btn>
              {!grid && draft.plan.colours.length > 1 && orderQty > 0 && <Btn variant="secondary" size="sm" onClick={() => setPlan({ colours: shareEvenly(draft.plan.colours, orderQty) })}>Share evenly</Btn>}
              {!grid && draft.plan.colours.length > 0 && draft.plan.sizes.length > 1 && <Btn variant="secondary" size="sm" onClick={useGrid}>Pieces for each size</Btn>}
              {grid && <Btn variant="secondary" size="sm" onClick={useRatio}>One ratio for all colours</Btn>}
              {sizeNamesUsable(draft.plan.sizes.map(s => s.name)) && <Btn variant="secondary" size="sm" icon={<FileSpreadsheet size={12} />} onClick={() => setImportingGrid(true)}>Import sizes and colours</Btn>}
            </div>
          )}
          {draft.plan.colours.length > 0 && <div style={{ fontSize: 11, marginTop: 6, color: orderQty && colourTotal !== orderQty ? T.warning : T.textLight }}>Colours add up to {fmtQty(colourTotal)} pieces{orderQty && colourTotal !== orderQty ? `, not ${fmtQty(orderQty)}` : ''}.</div>}
        </div>
      </div>
      {worked.warnings.length > 0 && <div style={{ marginTop: 14 }}><Alert type="warning">{worked.warnings.map((w, i) => <div key={i}>{w.message}</div>)}</Alert></div>}
    </Card>
  )

  const lineRow = (l, i) => {
    const c = computedOf(l.key)
    const open = perSizeOpen.has(l.key) || l.perSize.some(v => v !== '')
    const flagged = l.needsReview && !l.confirmed
    return (
      <div className={`gl-row${flagged ? ' gl-review' : ''}`} key={l.key} style={{ '--gl-cols': COLS }}>
        <div className="gl-main">
          <span className="gl-mlabel">Item</span>
          {readOnly ? <div className="gl-ro"><strong>{l.item}</strong>{l.spec ? <span className="gl-sub">{l.spec}</span> : null}</div> : (
            <>
              <input value={l.item} onChange={e => setLine(l.key, { item: e.target.value })} placeholder="Item" aria-label={`Line ${i + 1} item`} maxLength={200} />
              <input className="gl-spec" value={l.spec} onChange={e => setLine(l.key, { spec: e.target.value })} placeholder="Detail: size, colour rule, width (optional)" aria-label={`Line ${i + 1} detail`} maxLength={300} />
            </>
          )}
          {flagged && (
            <div style={{ marginTop: 6, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className="gl-chip" title={l.evidence}>From the tech pack, please check{l.confidence != null ? ` (${Math.round(l.confidence * 100)}% sure)` : ''}</span>
              {!readOnly && <button type="button" className="gl-link" onClick={() => setLine(l.key, { confirmed: true })}>Looks right</button>}
            </div>
          )}
          {flagged && l.evidence && <div style={{ fontSize: 11, color: T.textMuted, marginTop: 3 }}>{l.evidence}</div>}
          {!readOnly && (
            <div style={{ marginTop: 6, display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
              <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12, color: T.textMuted, cursor: 'pointer' }}><input type="checkbox" style={{ width: 16, height: 16 }} checked={l.perColour} onChange={e => setLine(l.key, { perColour: e.target.checked })} /> Order per colour</label>
              {!open && draft.plan.sizes.length > 1 && <button type="button" className="gl-link" onClick={() => setPerSizeOpen(s => new Set(s).add(l.key))}>Different for each size</button>}
            </div>
          )}
        </div>
        <label><span className="gl-mlabel">Unit</span>{readOnly ? <div className="gl-ro">{l.unit}</div> : <input value={l.unit} onChange={e => setLine(l.key, { unit: e.target.value })} maxLength={20} aria-label={`Line ${i + 1} unit`} />}</label>
        <label><span className="gl-mlabel">Per piece</span>{readOnly ? <div className="gl-ro gl-num">{l.consumption}</div> : <input inputMode="decimal" className="gl-num" value={l.consumption} onChange={e => setLine(l.key, { consumption: decimal(e.target.value) })} placeholder="0" aria-label={`Line ${i + 1} quantity per piece`} />}</label>
        <label><span className="gl-mlabel">Wastage %</span>{readOnly ? <div className="gl-ro gl-num">{l.wastagePct}</div> : <input inputMode="decimal" className="gl-num" value={l.wastagePct} onChange={e => setLine(l.key, { wastagePct: decimal(e.target.value) })} aria-label={`Line ${i + 1} wastage percent`} />}</label>
        <label><span className="gl-mlabel">Supplier</span>
          {readOnly ? <div className="gl-ro">{supplierName(l.supplierId) || <span style={{ color: T.textLight }}>None</span>}</div> : (
            <select value={l.supplierId} onChange={e => setLine(l.key, { supplierId: e.target.value, itemId: '' })} aria-label={`Line ${i + 1} supplier`}>
              <option value="">Choose a supplier</option>
              {suppliers.filter(s => s.isActive !== false).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          )}
        </label>
        <label><span className="gl-mlabel">Rate</span>{readOnly ? <div className="gl-ro gl-num">{l.rate}</div> : <input inputMode="decimal" className="gl-num" value={l.rate} onChange={e => setLine(l.key, { rate: decimal(e.target.value) })} placeholder="0.00" aria-label={`Line ${i + 1} rate`} />}</label>
        <div className="gl-out" aria-label={`Line ${i + 1} order quantity`}>
          <span className="gl-mlabel">To order</span>
          {c && c.orderQty > 0 ? `${fmtQty(c.orderQty)} ${l.unit}` : <span style={{ color: T.textLight, fontWeight: 500 }}>-</span>}
          {c && c.perColour?.length > 1 && <span className="gl-sub">{colourSummary(c)}</span>}
        </div>
        {!readOnly && <button type="button" className="gl-remove" onClick={() => removeLine(l.key)} aria-label={`Remove line ${i + 1}`}><X size={14} /></button>}
        {open && (
          <div className="gl-extra">
            <span style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, flexBasis: '100%' }}>Per piece for each size (blank uses the figure above)</span>
            {draft.plan.sizes.map((s, j) => (
              <label key={j} style={{ flex: '0 0 74px' }}><span className="gl-mlabel" style={{ display: 'block' }}>{sizeNames[j]}</span>
                {readOnly ? <div className="gl-ro gl-num">{l.perSize[j]}</div> : <input inputMode="decimal" className="gl-num" value={l.perSize[j] ?? ''} onChange={e => setLine(l.key, { perSize: draft.plan.sizes.map((_, k) => (k === j ? decimal(e.target.value) : (l.perSize[k] ?? ''))) })} aria-label={`Line ${i + 1} ${sizeNames[j]} per piece`} />}
              </label>
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div>
      {planCard}
      {SECTIONS.map(sec => {
        const lines = draft.lines.map((l, i) => ({ l, i })).filter(x => x.l.section === sec.id)
        if (readOnly && lines.length === 0) return null
        return (
          <div key={sec.id}>
            <div style={{ height: 14 }} />
            <Card>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                <div>
                  <SectionLabel>{sec.label}</SectionLabel>
                  <div style={{ fontSize: 12, color: T.textLight, marginTop: 2 }}>{sec.hint}</div>
                </div>
                {!readOnly && <Btn variant="secondary" size="sm" icon={<Plus size={13} />} onClick={() => addLine(sec.id)}>Add line</Btn>}
              </div>
              {lines.length === 0
                ? <div style={{ fontSize: 13, color: T.textMuted, padding: '8px 0' }}>None yet.</div>
                : (
                  <>
                    <div className="gl-head" aria-hidden="true" style={{ '--gl-cols': COLS }}>
                      <span>Item</span><span>Unit</span><span>Per piece</span><span>Wastage %</span><span>Supplier</span><span>Rate</span><span style={{ textAlign: 'right' }}>To order</span><span />
                    </div>
                    {lines.map(({ l, i }) => lineRow(l, i))}
                  </>
                )}
            </Card>
          </div>
        )
      })}
      {importingGrid && (
        <SpreadsheetImport title="Import sizes and colours" noun="colours" templateName="sizes-and-colours"
          columns={gridColumns(draft.plan.sizes.map(s => s.name.trim()))} example={gridExample(draft.plan.sizes.map(s => s.name.trim()), draft.plan.sizes.map(s => s.ratio))}
          onImport={async rows => {
            // The colours in the file replace the ones in the plan; nothing is saved until the person saves.
            const { colours, skipped } = coloursFromRows(rows, draft.plan.sizes.length)
            if (colours.length) setDraft(d => ({ ...d, plan: { ...d.plan, colours, totalQty: num(d.plan.totalQty) > 0 ? d.plan.totalQty : String(colours.reduce((t, c) => t + num(c.qty), 0)) } }))
            return { created: colours.length, skipped }
          }}
          onClose={() => setImportingGrid(false)} />
      )}
    </div>
  )
}
