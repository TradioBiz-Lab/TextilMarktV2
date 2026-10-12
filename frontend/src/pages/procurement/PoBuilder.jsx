import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Plus, X, Package, Eye, Send, AlertTriangle } from '../../icons.jsx'
import { T, getToday } from '../../constants.js'
import { Btn, Card, Modal, Alert, FlexRow, SectionLabel, LoadingScreen, Textarea, Input, Select, FileViewer, Mono, useToast } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'
import { suppliersApi, purchaseOrdersApi, orgsApi } from '../../api.js'
import { suppliersStore, posStore } from '../../stores/procurement.jsx'
import { computeTotals, moqWarnings } from '../../lib/poCalc.js'
import { taxModeFor } from '../../lib/gst.js'
import { rupees, fmtQty, materialsToBuy, reconcileLines, supplierForLines } from '../../lib/procurement.js'
import { SendPoModal } from './SendPoModal.jsx'

const DEFAULT_TERMS = 'Goods must match the approved sample and specification. Please quote this PO number on your delivery challan and invoice.'
const TAX_LABEL = { intra: 'CGST + SGST (same state)', inter: 'IGST (another state)', unknown: 'GST (state not set)' }

let keySeq = 0
const blankLine = (o = {}) => ({ key: ++keySeq, lineId: null, description: '', itemId: null, hsnCode: '', unit: 'pcs', qty: '', rate: '', discountPct: '', taxPct: '5', note: '', materialRef: null, expectedDate: null, ...o })
const fromServer = l => blankLine({
  lineId: l.lineId, description: l.description, itemId: l.itemId, hsnCode: l.hsnCode, unit: l.unit, qty: String(l.qty), rate: String(l.rate),
  discountPct: l.discountPct ? String(l.discountPct) : '', taxPct: String(l.taxPct), note: l.note, materialRef: l.materialRef, expectedDate: l.expectedDate,
})
const fromItem = (item, qty = '') => blankLine({ description: item.name, itemId: item.id, hsnCode: item.hsnCode, unit: item.unit || 'pcs', rate: item.defaultRate ? String(item.defaultRate) : '', taxPct: String(item.taxPct ?? 5), qty })
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const decimal = v => v.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1')

/** Raise a purchase order, or edit a draft. `poId` set means editing; `initialSupplier` starts a new one for that supplier. */
export function PoBuilder({ poId, initialSupplier, onBack, onNavigate }) {
  const toast = useToast()
  const { currentUser, orders } = useApp()
  const { items: suppliers } = suppliersStore.useStore()
  const { refresh } = posStore.useStore()

  const [loading, setLoading] = useState(!!poId)
  const [loadError, setLoadError] = useState('')
  const [existing, setExisting] = useState(null)
  const [org, setOrg] = useState(null)
  const [supplierId, setSupplierId] = useState(initialSupplier || '')
  const [supplier, setSupplier] = useState(null)             // the chosen supplier with its catalog
  const [expectedDate, setExpectedDate] = useState('')
  const [shipTo, setShipTo] = useState('')
  const [paymentTerms, setPaymentTerms] = useState('')
  const [terms, setTerms] = useState(DEFAULT_TERMS)
  const [internalNote, setInternalNote] = useState('')
  const [lines, setLines] = useState(() => [blankLine()])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [picker, setPicker] = useState(false)
  const [pdf, setPdf] = useState(null)
  const [sending, setSending] = useState(null)               // the saved PO, when "save and send" is open

  // Tells the stylesheet this page has a bar pinned to the bottom, so on phones the Kriyaa button moves above it.
  useEffect(() => {
    document.body.classList.add('has-action-bar')
    return () => document.body.classList.remove('has-action-bar')
  }, [])

  // Your own company's details decide the tax split and what the PDF header says.
  useEffect(() => { orgsApi.mine().then(setOrg).catch(() => {}) }, [])

  useEffect(() => {
    if (!poId) return
    let live = true
    purchaseOrdersApi.get(poId).then(po => {
      if (!live) return
      setExisting(po)
      setSupplierId(po.supplierId); setExpectedDate(po.expectedDate || ''); setShipTo(po.shipTo); setPaymentTerms(po.paymentTerms)
      setTerms(po.terms); setInternalNote(po.internalNote)
      setLines(po.lines.length ? po.lines.map(fromServer) : [blankLine()])
      setLoading(false)
    }).catch(e => { if (live) { setLoadError(e?.message || 'Could not load this purchase order'); setLoading(false) } })
    return () => { live = false }
  }, [poId])

  // The supplier's catalog and state, whenever the supplier changes.
  useEffect(() => {
    if (!supplierId) { setSupplier(null); return undefined }
    let live = true
    suppliersApi.get(supplierId).then(s => {
      if (!live) return
      setSupplier(s)
      if (!poId) setPaymentTerms(p => p || s.paymentTerms || '')
    }).catch(() => { if (live) setSupplier(null) })
    return () => { live = false }
  }, [supplierId, poId])

  // Lines already on the page meet the new supplier's catalog: stale ties dropped, blank rates filled in.
  useEffect(() => {
    if (!supplier) return
    setLines(ls => reconcileLines(ls, supplier.items || []))
  }, [supplier])

  const taxMode = taxModeFor(supplier?.stateCode, org?.profile?.stateCode)
  const calc = useMemo(() => computeTotals(lines.map(l => ({ qty: num(l.qty), rate: num(l.rate), discountPct: num(l.discountPct), taxPct: num(l.taxPct) })), taxMode), [lines, taxMode])
  const catalog = (supplier?.items || []).filter(i => i.isActive)
  const moq = moqWarnings(lines.map(l => ({ itemId: l.itemId, qty: num(l.qty), unit: l.unit })), catalog)
  const profileMissing = org && (!org.profile.gstin || !org.profile.stateCode || !org.profile.address)

  const setLine = (key, patch) => { setLines(ls => ls.map(l => (l.key === key ? { ...l, ...patch } : l))); setError('') }
  const removeLine = key => setLines(ls => (ls.length > 1 ? ls.filter(l => l.key !== key) : [blankLine()]))
  const meaningful = lines.filter(l => l.description.trim() || num(l.qty) > 0)

  const payload = () => ({
    supplierId, expectedDate: expectedDate || null, shipTo: shipTo.trim(), paymentTerms: paymentTerms.trim(), terms: terms.trim(), internalNote: internalNote.trim(),
    lines: meaningful.map(l => ({
      ...(l.lineId ? { lineId: l.lineId } : {}), description: l.description.trim(), ...(l.itemId ? { itemId: l.itemId } : {}), hsnCode: l.hsnCode, unit: l.unit.trim() || 'pcs',
      qty: num(l.qty), rate: num(l.rate), discountPct: num(l.discountPct), taxPct: num(l.taxPct), note: l.note.trim(),
      ...(l.expectedDate ? { expectedDate: l.expectedDate } : {}), ...(l.materialRef ? { materialRef: l.materialRef } : {}),
    })),
  })

  /** Save, and return the saved PO (or null with the reason on screen). */
  const save = async () => {
    if (!supplierId) { setError('Choose a supplier first'); return null }
    setSaving(true); setError('')
    try {
      const saved = existing ? await purchaseOrdersApi.update(existing.id, payload()) : await purchaseOrdersApi.create(payload())
      setExisting(saved)
      await refresh()
      return saved
    } catch (e) { setError(e?.message || 'Could not save the purchase order'); return null } finally { setSaving(false) }
  }

  const saveDraft = async () => { const po = await save(); if (po) { toast(`${po.id} saved as a draft`, 'success'); onNavigate('po_detail', { po: po.id }) } }
  const preview = async () => {
    const po = await save()
    if (!po) return
    try { setPdf(await purchaseOrdersApi.pdf(po.id)) } catch (e) { setError(e?.message || 'Could not open the PDF') }
  }
  const saveAndSend = async () => {
    if (meaningful.length === 0) { setError('Add at least one item before sending'); return }
    const po = await save()
    if (po) setSending(po)
  }

  const addMaterials = picked => {
    setLines(ls => {
      const kept = ls.filter(l => l.description.trim() || num(l.qty) > 0)
      const added = picked.map(m => {
        const item = catalog.find(i => i.name.toLowerCase() === m.name.toLowerCase())
        const base = item ? fromItem(item, String(m.remaining)) : blankLine({ description: m.name, unit: m.unit || 'pcs', qty: String(m.remaining) })
        return { ...base, unit: m.unit || base.unit, qty: String(m.remaining), materialRef: m.ref, description: item ? base.description : m.name }
      })
      return [...kept, ...added]
    })
    const planned = supplierForLines(picked)
    if (!supplierId && planned && suppliers.some(s => s.id === planned && s.isActive)) setSupplierId(planned)
    setPicker(false)
  }

  if (loading) return <LoadingScreen message="Loading purchase order..." />
  if (loadError) return <div><Btn variant="secondary" size="sm" onClick={onBack} icon={<ArrowLeft size={13} />}>Back</Btn><div style={{ height: 14 }} /><Alert type="danger">{loadError}</Alert></div>
  if (existing && existing.status !== 'draft') return <div><Btn variant="secondary" size="sm" onClick={onBack} icon={<ArrowLeft size={13} />}>Back</Btn><div style={{ height: 14 }} /><Alert type="warning">{existing.id} has been sent, so it cannot be edited. Cancel it and start a new one to change what was ordered.</Alert></div>

  const activeSuppliers = suppliers.filter(s => s.isActive)
  const t = calc.totals

  return (
    <div style={{ maxWidth: 1100 }}>
      <FlexRow gap={12} style={{ marginBottom: 14, flexWrap: 'wrap' }}>
        <Btn variant="secondary" size="sm" onClick={onBack} icon={<ArrowLeft size={13} />}>Back</Btn>
        <div style={{ fontSize: 20, fontWeight: 800, color: T.text }}>{existing ? 'Edit purchase order' : 'New purchase order'}</div>
        {existing && <Mono style={{ fontSize: 12, fontWeight: 700, color: T.primaryDeep }}>{existing.id}</Mono>}
      </FlexRow>

      {profileMissing && (
        <div style={{ marginBottom: 14 }}>
          <Alert type="warning">
            Your company's GSTIN, address and state are not filled in yet, so they will be missing from the PDF and the tax split may not be right.{' '}
            <button type="button" onClick={() => onNavigate('company')} style={{ background: 'none', border: 'none', padding: 0, color: 'inherit', fontWeight: 800, textDecoration: 'underline', cursor: 'pointer', fontFamily: 'inherit', fontSize: 'inherit' }}>Fill them in on the Company page</button>
          </Alert>
        </div>
      )}

      <Card>
        <SectionLabel>Supplier and delivery</SectionLabel>
        <div className="form-grid-2" style={{ marginTop: 10 }}>
          <Select label="Supplier *" value={supplierId} onChange={e => setSupplierId(e.target.value)}>
            <option value="">{activeSuppliers.length ? 'Choose a supplier' : 'No suppliers yet: add one first'}</option>
            {activeSuppliers.map(s => <option key={s.id} value={s.id}>{s.name}{s.city ? ` (${s.city})` : ''}</option>)}
          </Select>
          <Input label="Delivery by" type="date" min={getToday()} value={expectedDate} onChange={e => setExpectedDate(e.target.value)} />
        </div>
        {supplier && (
          <div style={{ fontSize: 12, color: T.textMuted, marginTop: 10, lineHeight: 1.6 }}>
            {[supplier.stateName && `${supplier.stateName}`, supplier.gstin && `GSTIN ${supplier.gstin}`, supplier.email].filter(Boolean).join(' · ') || 'No details on this supplier yet.'}
            {' '}<strong style={{ color: taxMode === 'unknown' ? T.warning : T.text }}>Tax: {TAX_LABEL[taxMode]}.</strong>
            {taxMode === 'unknown' && <span> Set the supplier's state (and your own) to split it into CGST and SGST or IGST.</span>}
          </div>
        )}
        <div className="form-grid-2" style={{ marginTop: 12 }}>
          <Input label="Payment terms" value={paymentTerms} onChange={e => setPaymentTerms(e.target.value)} placeholder="45 days from invoice" />
          <Textarea label="Deliver to (if not your factory address)" value={shipTo} onChange={e => setShipTo(e.target.value)} rows={2} placeholder="Leave blank to use your company address" />
        </div>
      </Card>

      <div style={{ height: 14 }} />
      <Card>
        <FlexRow justify="space-between" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
          <SectionLabel>Items</SectionLabel>
          <FlexRow gap={8} style={{ flexWrap: 'wrap' }}>
            {catalog.length > 0 && (
              <select aria-label="Add an item from this supplier's catalog" value="" onChange={e => { const it = catalog.find(i => i.id === e.target.value); if (it) setLines(ls => [...ls.filter(l => l.description.trim() || num(l.qty) > 0), fromItem(it)]) }}
                style={{ border: `1px solid ${T.border}`, borderRadius: 8, padding: '8px 10px', fontSize: 13, color: T.text, background: T.surface, fontFamily: 'inherit', cursor: 'pointer', maxWidth: 240 }}>
                <option value="">Add from catalog...</option>
                {catalog.map(i => <option key={i.id} value={i.id}>{i.name}{i.defaultRate ? ` (${rupees(i.defaultRate)}/${i.unit})` : ''}</option>)}
              </select>
            )}
            <Btn variant="secondary" size="sm" icon={<Package size={13} />} onClick={() => setPicker(true)}>From order materials</Btn>
            <Btn variant="secondary" size="sm" icon={<Plus size={13} />} onClick={() => setLines(ls => [...ls, blankLine()])}>Blank line</Btn>
          </FlexRow>
        </FlexRow>

        <div className="po-lines-head" aria-hidden="true">
          <span>Item</span><span>HSN</span><span>Qty</span><span>Unit</span><span>Rate</span><span>Disc %</span><span>GST %</span><span style={{ textAlign: 'right' }}>Amount</span><span />
        </div>
        {lines.map((l, i) => {
          const warn = moq.find(w => w.line === i)
          return (
            <div className="po-line" key={l.key}>
              <div className="po-desc">
                <span className="po-mlabel">Item</span>
                <input value={l.description} onChange={e => setLine(l.key, { description: e.target.value })} placeholder="Describe the item" aria-label={`Line ${i + 1} item`} maxLength={300} />
                {l.materialRef && <div className="po-chip">For order {l.materialRef.orderId}: {l.materialRef.name}</div>}
                {warn && <div className="po-chip po-chip-warn"><AlertTriangle size={11} /> Below this supplier's minimum of {fmtQty(warn.moq)} {warn.unit}</div>}
              </div>
              <label><span className="po-mlabel">HSN</span><input inputMode="numeric" value={l.hsnCode} onChange={e => setLine(l.key, { hsnCode: e.target.value.replace(/\D/g, '').slice(0, 8) })} aria-label={`Line ${i + 1} HSN code`} /></label>
              <label><span className="po-mlabel">Qty</span><input inputMode="decimal" value={l.qty} onChange={e => setLine(l.key, { qty: decimal(e.target.value) })} placeholder="0" aria-label={`Line ${i + 1} quantity`} className="po-num" /></label>
              <label><span className="po-mlabel">Unit</span><input value={l.unit} onChange={e => setLine(l.key, { unit: e.target.value })} aria-label={`Line ${i + 1} unit`} maxLength={20} /></label>
              <label><span className="po-mlabel">Rate</span><input inputMode="decimal" value={l.rate} onChange={e => setLine(l.key, { rate: decimal(e.target.value) })} placeholder="0.00" aria-label={`Line ${i + 1} rate`} className="po-num" /></label>
              <label><span className="po-mlabel">Disc %</span><input inputMode="decimal" value={l.discountPct} onChange={e => setLine(l.key, { discountPct: decimal(e.target.value) })} aria-label={`Line ${i + 1} discount percent`} className="po-num" /></label>
              <label><span className="po-mlabel">GST %</span><input inputMode="decimal" value={l.taxPct} onChange={e => setLine(l.key, { taxPct: decimal(e.target.value) })} aria-label={`Line ${i + 1} GST percent`} className="po-num" /></label>
              <div className="po-amount" aria-label={`Line ${i + 1} amount`}><span className="po-mlabel">Amount</span>{rupees(calc.lines[i]?.amount || 0)}</div>
              <button type="button" className="po-remove" onClick={() => removeLine(l.key)} aria-label={`Remove line ${i + 1}`}><X size={14} /></button>
            </div>
          )
        })}
        {moq.length > 0 && <div style={{ marginTop: 10 }}><Alert type="warning">{moq.map((w, i) => <div key={i}>{w.message}. You can still send it, but the supplier may refuse or charge more.</div>)}</Alert></div>}
      </Card>

      <div style={{ height: 14 }} />
      <Card>
        <SectionLabel>Terms and notes</SectionLabel>
        <div className="form-grid-2" style={{ marginTop: 10 }}>
          <Textarea label="Terms (printed on the PDF)" value={terms} onChange={e => setTerms(e.target.value)} rows={4} maxLength={2000} />
          <Textarea label="Your note (never printed or emailed)" value={internalNote} onChange={e => setInternalNote(e.target.value)} rows={4} maxLength={1000} placeholder="For your own reference" />
        </div>
      </Card>

      {error && <div style={{ marginTop: 14 }}><Alert type="danger">{error}</Alert></div>}

      <div className="po-totals-bar">
        <div className="po-totals-sum" aria-live="polite">
          <div><span>Taxable</span><strong>{rupees(t.taxable)}</strong></div>
          <div><span>{taxMode === 'intra' ? 'CGST + SGST' : taxMode === 'inter' ? 'IGST' : 'GST'}</span><strong>{rupees(t.taxTotal)}</strong></div>
          <div className="po-grand"><span>Total</span><strong>{rupees(t.grandTotal)}</strong></div>
        </div>
        <div className="po-totals-actions">
          <Btn variant="secondary" icon={<Eye size={13} />} onClick={preview} disabled={saving || !supplierId}><span className="po-long">Preview PDF</span><span className="po-short">Preview</span></Btn>
          <Btn variant="secondary" onClick={saveDraft} disabled={saving || !supplierId}>{saving ? 'Saving...' : 'Save draft'}</Btn>
          <Btn icon={<Send size={14} />} onClick={saveAndSend} disabled={saving || !supplierId}><span className="po-long">Save and send</span><span className="po-short">Send</span></Btn>
        </div>
      </div>

      {picker && <MaterialPicker orders={orders} partyId={currentUser.id} supplierId={supplierId} onClose={() => setPicker(false)} onAdd={addMaterials} />}
      {pdf && <FileViewer name={`Purchase order ${existing?.id || ''}`} fileName={pdf.fileName} dataUrl={pdf.dataUrl} onClose={() => setPdf(null)} />}
      {sending && <SendPoModal po={sending} onClose={() => { setSending(null); onNavigate('po_detail', { po: sending.id }) }} onSent={async (sent, notice) => {
        await refresh()
        if (notice.emailSkipped) toast('Marked as sent, but no email went out: email is not set up on this server', 'warning')
        else toast(`Sent to ${(notice.emailed || []).join(', ')}`, 'success')
        if (notice.unlinkedLines?.length) toast(`Could not link: ${notice.unlinkedLines.join(', ')}`, 'warning')
        onNavigate('po_detail', { po: sent.id })
      }} />}
    </div>
  )
}

/** Pick material lines from the factory's own orders that still need buying; each becomes a PO line linked to it. */
function MaterialPicker({ orders, partyId, supplierId, onClose, onAdd }) {
  const groups = useMemo(() => materialsToBuy(orders, partyId), [orders, partyId])
  const [chosen, setChosen] = useState({})
  const key = m => `${m.ref.orderId}|${m.ref.stageIndex}|${m.ref.materialIndex}`
  const all = groups.flatMap(g => g.lines)
  const picked = all.filter(m => chosen[key(m)])
  return (
    <Modal title="Materials your orders still need" subtitle="Tick the lines to buy. Each becomes an item on this PO, linked to its order." onClose={onClose} size="lg">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {groups.length === 0 && <div style={{ fontSize: 13, color: T.textMuted, padding: '10px 0', lineHeight: 1.55 }}>Nothing to buy. Material lines you add to a production step (for example Fabric Inhouse) show up here until they are ordered.</div>}
        {groups.map(g => (
          <div key={g.orderId}>
            <div style={{ fontSize: 12, fontWeight: 800, color: T.text, marginBottom: 4 }}>{g.product} <span style={{ fontWeight: 500, color: T.textLight }}>{g.buyerCompany ? `for ${g.buyerCompany}` : ''}</span></div>
            {g.lines.map(m => (
              <label key={key(m)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderTop: `1px solid ${T.border}`, cursor: 'pointer', minHeight: 44 }}>
                <input type="checkbox" checked={!!chosen[key(m)]} onChange={e => setChosen({ ...chosen, [key(m)]: e.target.checked })} style={{ width: 18, height: 18 }} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 14, fontWeight: 600, color: T.text }}>{m.name}</span>
                  <span style={{ display: 'block', fontSize: 12, color: T.textMuted }}>{m.stage} · need {fmtQty(m.required)} {m.unit}{m.ordered ? `, ${fmtQty(m.ordered)} already ordered` : ''}{m.supplier ? ` · planned with ${m.supplier}` : ''}</span>
                </span>
                <span style={{ fontSize: 14, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{fmtQty(m.remaining)} {m.unit}</span>
              </label>
            ))}
          </div>
        ))}
        <FlexRow justify="flex-end" gap={8}>
          <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
          <Btn disabled={picked.length === 0} onClick={() => onAdd(picked)}>{picked.length ? `Add ${picked.length} to this PO` : 'Add to this PO'}</Btn>
        </FlexRow>
        {supplierId === '' && groups.length > 0 && <div style={{ fontSize: 11, color: T.textLight }}>If the lines were planned with one supplier, it is chosen for you. Otherwise choose one on the PO and its catalog rates fill in.</div>}
      </div>
    </Modal>
  )
}
