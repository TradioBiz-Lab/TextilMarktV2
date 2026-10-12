import { useEffect, useMemo, useState } from 'react'
import { Plus, X, Eye, Send, Trash2 } from '../../icons.jsx'
import { T } from '../../constants.js'
import { Btn, Card, Alert, Input, Textarea, SectionLabel, FileViewer, useToast } from '../../components/ui.jsx'
import { costSheetsApi } from '../../api.js'
import { BLOCKS, toForm, figures, payloadFrom, isDirty, blankMaterial, lineAmountOf, decimal } from '../../lib/costing.js'
import { rupees, fmtQty } from '../../lib/procurement.js'

const COLS = 'minmax(190px, 3fr) 84px 64px 92px 76px 104px 34px'

/**
 * The factory's working copy of a cost sheet: every block's lines, labour and the percentages, with the
 * price worked live as it is edited (the same arithmetic the server uses; the server's figures are the ones
 * saved and shared). Saving is explicit, so a half-finished edit is never sent and the rate limit is never
 * touched by typing.
 */
export function CostSheetEditor({ sheet, tradioEnabled, onSaved, onShare, onDelete, onReload }) {
  const toast = useToast()
  const [form, setForm] = useState(() => toForm(sheet))
  const [saved, setSaved] = useState(() => toForm(sheet))
  const [updatedAt, setUpdatedAt] = useState(sheet.updatedAt)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [stale, setStale] = useState(false)
  const [pdf, setPdf] = useState(null)
  const [landed, setLanded] = useState(() => new Set())     // lines whose freight and duty are open

  // A bar is pinned to the bottom of this page: on phones the Kriyaa button moves above it (see index.css).
  useEffect(() => {
    document.body.classList.add('has-action-bar')
    return () => document.body.classList.remove('has-action-bar')
  }, [])

  const calc = useMemo(() => figures(form), [form])
  const dirty = isDirty(form, saved)

  const set = patch => { setForm(f => ({ ...f, ...patch })); setError('') }
  const setLabour = patch => set({ labour: { ...form.labour, ...patch } })
  const setLine = (block, key, patch) => { setForm(f => ({ ...f, [block]: f[block].map(l => (l.key === key ? { ...l, ...patch } : l)) })); setError('') }
  const addLine = block => setForm(f => ({ ...f, [block]: [...f[block], blankMaterial(block)] }))
  const removeLine = (block, key) => setForm(f => ({ ...f, [block]: f[block].filter(l => l.key !== key) }))

  /** Save, and return the saved sheet (or null with the reason on screen). */
  const save = async () => {
    setSaving(true); setError('')
    try {
      const res = await costSheetsApi.save(sheet.id, payloadFrom(form, updatedAt))
      setSaved(form); setUpdatedAt(res.updatedAt); setStale(false)
      onSaved?.(res)
      return res
    } catch (e) {
      if (e?.code === 'STALE') setStale(true)
      setError(e?.message || 'Could not save the cost sheet')
      return null
    } finally { setSaving(false) }
  }

  const saveClick = async () => { const r = await save(); if (r) toast('Cost sheet saved', 'success') }
  const preview = async () => {
    if (dirty && !(await save())) return
    try { setPdf(await costSheetsApi.pdf(sheet.id)) } catch (e) { setError(e?.message || 'Could not open the PDF') }
  }
  const share = async () => { if (dirty && !(await save())) return; onShare() }
  const discard = () => { if (window.confirm('Delete this draft? This cannot be undone.')) onDelete() }

  const lineRow = (block, l, i) => {
    const open = landed.has(l.key) || l.freight || l.dutyPct
    return (
      <div className="gl-row" key={l.key} style={{ '--gl-cols': COLS }}>
        <div className="gl-main">
          <span className="gl-mlabel">Item</span>
          <input value={l.name} onChange={e => setLine(block, l.key, { name: e.target.value })} placeholder="Item" aria-label={`${block} line ${i + 1} item`} maxLength={120} />
          <input className="gl-spec" value={l.spec} onChange={e => setLine(block, l.key, { spec: e.target.value })} placeholder="Detail (optional)" aria-label={`${block} line ${i + 1} detail`} maxLength={200} />
          {block === 'fabric' && !open && <button type="button" className="gl-link" style={{ marginTop: 6 }} onClick={() => setLanded(s => new Set(s).add(l.key))}>Imported? add freight and duty</button>}
        </div>
        <label><span className="gl-mlabel">Qty per piece</span><input inputMode="decimal" className="gl-num" value={l.consumption} onChange={e => setLine(block, l.key, { consumption: decimal(e.target.value) })} placeholder="0" aria-label={`${block} line ${i + 1} quantity per piece`} /></label>
        <label><span className="gl-mlabel">Unit</span><input value={l.unit} onChange={e => setLine(block, l.key, { unit: e.target.value })} maxLength={20} aria-label={`${block} line ${i + 1} unit`} /></label>
        <label><span className="gl-mlabel">Rate</span><input inputMode="decimal" className="gl-num" value={l.rate} onChange={e => setLine(block, l.key, { rate: decimal(e.target.value) })} placeholder="0.00" aria-label={`${block} line ${i + 1} rate`} /></label>
        <label><span className="gl-mlabel">Wastage %</span><input inputMode="decimal" className="gl-num" value={l.wastagePct} onChange={e => setLine(block, l.key, { wastagePct: decimal(e.target.value) })} aria-label={`${block} line ${i + 1} wastage percent`} /></label>
        <div className="gl-out" aria-label={`${block} line ${i + 1} per piece`}><span className="gl-mlabel">Per piece</span>{rupees(lineAmountOf(l))}</div>
        <button type="button" className="gl-remove" onClick={() => removeLine(block, l.key)} aria-label={`Remove ${block} line ${i + 1}`}><X size={14} /></button>
        {open && (
          <div className="gl-extra">
            <label><span className="gl-mlabel" style={{ display: 'block' }}>Freight per {l.unit || 'unit'}</span><input inputMode="decimal" className="gl-num" value={l.freight} onChange={e => setLine(block, l.key, { freight: decimal(e.target.value) })} aria-label={`${block} line ${i + 1} freight`} /></label>
            <label><span className="gl-mlabel" style={{ display: 'block' }}>Duty %</span><input inputMode="decimal" className="gl-num" value={l.dutyPct} onChange={e => setLine(block, l.key, { dutyPct: decimal(e.target.value) })} aria-label={`${block} line ${i + 1} duty percent`} /></label>
            <span style={{ fontSize: 11, color: T.textMuted }}>Added to the rate before wastage</span>
          </div>
        )}
      </div>
    )
  }

  const sum = (label, value, strong) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '4px 0', fontSize: strong ? 14 : 13, fontWeight: strong ? 800 : 500, color: strong ? T.text : T.textMuted }}>
      <span>{label}</span><span style={{ fontVariantNumeric: 'tabular-nums', color: T.text }}>{rupees(value)}</span>
    </div>
  )

  return (
    <div style={{ maxWidth: 1100 }}>
      {stale && <div style={{ marginBottom: 14 }}><Alert type="warning">Someone else changed this cost sheet. <button type="button" className="gl-link" onClick={onReload}>Reload it</button> to see their changes (what you typed here will be lost).</Alert></div>}

      <Card>
        <SectionLabel>Style</SectionLabel>
        <div className="form-grid-2" style={{ marginTop: 10 }}>
          <Input label="Style name *" value={form.styleName} onChange={e => set({ styleName: e.target.value })} maxLength={120} />
          <Input label="Style code" value={form.styleCode} onChange={e => set({ styleCode: e.target.value })} maxLength={60} />
          <Input label="Quantity (pieces)" inputMode="numeric" value={form.qty} onChange={e => set({ qty: decimal(e.target.value).split('.')[0] })} hint="Used for the order value" />
          <Input label="Prepared for" value={sheet.brandName} readOnly disabled />
        </div>
      </Card>

      {BLOCKS.map(b => (
        <div key={b.key}>
          <div style={{ height: 14 }} />
          <Card>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
              <div>
                <SectionLabel>{b.label}</SectionLabel>
                <div style={{ fontSize: 12, color: T.textLight, marginTop: 2 }}>{b.hint}</div>
              </div>
              <Btn variant="secondary" size="sm" icon={<Plus size={13} />} onClick={() => addLine(b.key)}>Add line</Btn>
            </div>
            {form[b.key].length === 0
              ? <div style={{ fontSize: 13, color: T.textMuted, padding: '8px 0' }}>None yet.</div>
              : (
                <>
                  <div className="gl-head" aria-hidden="true" style={{ '--gl-cols': COLS }}>
                    <span>Item</span><span>Qty per piece</span><span>Unit</span><span>Rate</span><span>Wastage %</span><span style={{ textAlign: 'right' }}>Per piece</span><span />
                  </div>
                  {form[b.key].map((l, i) => lineRow(b.key, l, i))}
                </>
              )}
            <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: `1px solid ${T.border}`, paddingTop: 10, marginTop: 4, fontSize: 13, fontWeight: 700 }}>
              <span style={{ color: T.textMuted }}>Total {b.label.split(',')[0].toLowerCase()}</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>{rupees(calc[b.key])}</span>
            </div>
          </Card>
        </div>
      ))}

      <div style={{ height: 14 }} />
      <Card>
        <SectionLabel>Labour per piece</SectionLabel>
        <div className="form-grid-2" style={{ marginTop: 10 }}>
          <Input label="Cutting and threads" inputMode="decimal" value={form.labour.cuttingThreads} onChange={e => setLabour({ cuttingThreads: decimal(e.target.value) })} />
          <Input label="Making" inputMode="decimal" value={form.labour.making} onChange={e => setLabour({ making: decimal(e.target.value) })} />
          <Input label="Finishing and packing" inputMode="decimal" value={form.labour.finishingPacking} onChange={e => setLabour({ finishingPacking: decimal(e.target.value) })} />
        </div>
      </Card>

      <div style={{ height: 14 }} />
      <Card>
        <SectionLabel>Percentages</SectionLabel>
        <div className="form-grid-2" style={{ marginTop: 10 }}>
          <Input label="Overhead %" inputMode="decimal" value={form.overheadPct} onChange={e => set({ overheadPct: decimal(e.target.value) })} hint="Of materials and labour" />
          <Input label="Rejection %" inputMode="decimal" value={form.rejectionPct} onChange={e => set({ rejectionPct: decimal(e.target.value) })} hint="Of materials, labour and overhead" />
          <Input label="Margin %" inputMode="decimal" value={form.marginPct} onChange={e => set({ marginPct: decimal(e.target.value) })} hint="Of everything above it" />
          {tradioEnabled && <Input label="Tradio fee %" inputMode="decimal" value={form.tradioPct} onChange={e => set({ tradioPct: decimal(e.target.value) })} hint="Of materials and labour" />}
          <Input label="Negotiated discount %" inputMode="decimal" value={form.discountPct} onChange={e => set({ discountPct: decimal(e.target.value) })} hint="Taken off the price once you agree it" />
        </div>
      </Card>

      <div style={{ height: 14 }} />
      <Card>
        <SectionLabel>The price</SectionLabel>
        <div style={{ marginTop: 6 }}>
          {sum('Raw material', calc.materials)}
          {sum('Labour', calc.labour)}
          <div style={{ borderTop: `1px solid ${T.border}`, marginTop: 4, paddingTop: 4 }}>{sum('Total labour and raw material', calc.base, true)}</div>
          {sum(`Overhead (${fmtQty(form.overheadPct)}%)`, calc.overhead)}
          {sum(`Rejection (${fmtQty(form.rejectionPct)}%)`, calc.rejection)}
          {sum(`Margin (${fmtQty(form.marginPct)}%)`, calc.margin)}
          {tradioEnabled && Number(form.tradioPct) > 0 && sum(`Tradio fee (${fmtQty(form.tradioPct)}%)`, calc.tradio)}
          <div style={{ borderTop: `2px solid ${T.text}`, marginTop: 8, paddingTop: 6 }}>{sum('Price per piece', calc.price, true)}</div>
          {Number(form.discountPct) > 0 && sum('Negotiated price per piece', calc.negotiated, true)}
          {calc.orderValue ? sum(`Order value (${fmtQty(form.qty)} pcs)`, Number(form.discountPct) > 0 ? calc.negotiatedValue : calc.orderValue) : null}
        </div>
      </Card>

      <div style={{ height: 14 }} />
      <Card>
        <Textarea label="Your note (the customer never sees it)" value={form.internalNote} onChange={e => set({ internalNote: e.target.value })} rows={3} maxLength={1000} placeholder="For your own reference" />
        <div style={{ marginTop: 12 }}>
          <Btn variant="danger" size="sm" icon={<Trash2 size={12} />} onClick={discard}>Delete this draft</Btn>
        </div>
      </Card>

      {error && <div style={{ marginTop: 14 }}><Alert type="danger">{error}</Alert></div>}

      <div className="po-totals-bar">
        <div className="po-totals-sum" aria-live="polite">
          {Number(form.discountPct) > 0
            ? (<><div><span>Price</span><strong>{rupees(calc.price)}</strong></div><div className="po-grand"><span>Negotiated</span><strong>{rupees(calc.negotiated)}</strong></div></>)
            : <div className="po-grand"><span>Price per piece</span><strong>{rupees(calc.price)}</strong></div>}
        </div>
        <div className="po-totals-actions">
          <Btn variant="secondary" icon={<Eye size={13} />} onClick={preview} disabled={saving}><span className="po-long">Preview PDF</span><span className="po-short">Preview</span></Btn>
          <Btn variant="secondary" onClick={saveClick} disabled={saving || !dirty}>{saving ? 'Saving...' : dirty ? 'Save draft' : 'Saved'}</Btn>
          <Btn icon={<Send size={14} />} onClick={share} disabled={saving}><span className="po-long">Share with customer</span><span className="po-short">Share</span></Btn>
        </div>
      </div>

      {pdf && <FileViewer name={`Cost sheet ${sheet.chainId} v${sheet.version}`} fileName={pdf.fileName} dataUrl={pdf.dataUrl} onClose={() => setPdf(null)} />}
    </div>
  )
}
