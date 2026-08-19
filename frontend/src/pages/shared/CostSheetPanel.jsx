import { useState, useEffect, useCallback } from 'react'
import { T } from '../../constants.js'
import { Card, Btn, Input, FlexRow, Badge, useToast, LoadingScreen } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'
import { costSheetsApi } from '../../api.js'
import * as costMath from '../../lib/costMath.js'

// Renders as ONE cost sheet — one (order|project, manufacturer) pair. Role-
// conditional by construction (not two components): manufacturer sees their
// own content + actuals, never margin; master admin sees everything and owns
// the margin/approve actions; buyer (once approved) sees only the final
// price. This is exactly what the server already enforces — the UI just
// renders whatever enrichCostSheet actually sent, it never hides a field the
// server already stripped, and never assumes a field is safe to show because
// "this is the admin view."
export function CostSheetPanel({ scopeType, orderId, mfrProjectId, mfrId, orderQty, styleLabel }) {
  const { currentUser, getCostSheet, listCostSheets, saveCostSheet, setCostSheetMargin,
    saveCostSheetActuals, submitCostSheet, withdrawCostSheet, approveCostSheet, duplicateCostSheet, getMaterialRequirement } = useApp()
  const toast = useToast()
  const role = currentUser?.role
  const isMaster = role === 'admin' && currentUser?.adminType === 'master'
  const isOwner = role === 'manufacturer' && String(mfrId) === String(currentUser?.id)

  const [sheet, setSheet] = useState(null)
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState(null) // local edit buffer for content fields
  const [marginDraft, setMarginDraft] = useState(null)
  const [actualsDraft, setActualsDraft] = useState(null)
  const [busy, setBusy] = useState(false)
  const [showDuplicate, setShowDuplicate] = useState(false)
  const [dupTarget, setDupTarget] = useState({ targetId: '', styleRef: '' })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const list = await listCostSheets(scopeType === 'tradio_order' ? { orderId } : { mfrProjectId })
      const existing = list.find(s => String(s.mfrId) === String(mfrId))
      if (existing) {
        const full = await getCostSheet(existing.id)
        setSheet(full)
      } else {
        setSheet(null)
      }
    } catch (err) {
      toast(err.message || 'Failed to load cost sheet', 'error')
    } finally {
      setLoading(false)
    }
  }, [scopeType, orderId, mfrProjectId, mfrId])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    // Runs even when no sheet exists yet (sheet === null, first-ever save on
    // this scope) — draft must never stay null, or editing a brand-new sheet
    // throws the moment an onChange spreads a null draft.
    setDraft({
      fabricSource: sheet?.fabricSource || 'tradio',
      fabric: sheet?.fabric || { name: '', unit: '', consumption: '', rate: '', wastagePct: 0 },
      process: sheet?.process || [], trims: sheet?.trims || [], labelsPackaging: sheet?.labelsPackaging || [],
      extraLines: sheet?.extraLines || [],
      labour: sheet?.labour || { cuttingThreads: 0, making: 0, finishingPacking: 0 },
      overheadPct: sheet?.overheadPct ?? 5, rejectionPct: sheet?.rejectionPct ?? 3,
      mfrMarginPct: sheet?.mfrMarginPct ?? '',
    })
    setMarginDraft({ marginPct: sheet?.marginPct ?? '', tradioFeePct: sheet?.tradioFeePct ?? 10, finalNegotiatedPrice: sheet?.finalNegotiatedPrice ?? '', negotiatedDiscountPct: sheet?.negotiatedDiscountPct ?? '' })
    setActualsDraft({ actualFabricConsumption: sheet?.actualFabricConsumption ?? '', actualLabourCost: sheet?.actualLabourCost ?? '', actualRejectionValue: sheet?.actualRejectionValue ?? '' })
  }, [sheet])

  if (loading) return <LoadingScreen />

  const canEditContent = (isOwner || (isMaster)) && (!sheet || sheet.status === 'draft')
  const canWithdraw = isOwner && sheet?.status === 'submitted'
  const canSubmit = (isOwner || isMaster) && (!sheet || sheet.status === 'draft')
  const canSetMargin = isMaster && sheet && sheet.scopeType === 'tradio_order'
  const canApprove = sheet && (
    (sheet.scopeType === 'tradio_order' && isMaster && sheet.status === 'submitted') ||
    (sheet.scopeType === 'mfr_project' && isOwner && sheet.status === 'submitted')
  )
  const canRecordActuals = (isOwner || isMaster) && sheet && ['submitted', 'approved'].includes(sheet.status)

  async function handleSave() {
    setBusy(true)
    try {
      const body = {
        scopeType, ...(scopeType === 'tradio_order' ? { orderId } : { mfrProjectId }),
        mfrId, ...draft,
        fabric: {
          ...draft.fabric,
          consumption: draft.fabric.consumption === '' ? null : Number(draft.fabric.consumption),
          rate: draft.fabric.rate === '' ? null : Number(draft.fabric.rate),
          wastagePct: draft.fabric.wastagePct === '' || draft.fabric.wastagePct == null ? 0 : Number(draft.fabric.wastagePct),
        },
        mfrMarginPct: draft.mfrMarginPct === '' ? null : Number(draft.mfrMarginPct),
      }
      const saved = await saveCostSheet(body)
      setSheet(saved)
      toast('Cost sheet saved', 'success')
    } catch (err) { toast(err.message || 'Save failed', 'error') } finally { setBusy(false) }
  }

  // "Costing engine should speak to materials management" — pulls the
  // fabric-category requirement line's name/unit/supplier straight from
  // the linked MaterialRequirement instead of re-typing it, dividing its
  // (order-total) requiredQty into a per-unit consumption figure. Values
  // are copied, not linked — a planned fabric quantity typically already
  // bakes in a conservative efficiency adjustment and shouldn't silently
  // drift if the requirement changes later. Only the provenance ids are a
  // real reference, kept so the consumption sanity-check has a join key.
  async function handlePullFromRequirement() {
    setBusy(true)
    try {
      const req = await getMaterialRequirement(scopeType === 'tradio_order' ? { orderId } : { mfrProjectId })
      const lines = req.lines || []
      const fabricLine = lines.find(l => l.category === 'fabric' || l.category === 'fabric_primary')
      const trimLines = lines.filter(l => l.category === 'trim')
      const accessoryLines = lines.filter(l => l.category === 'accessory')

      if (!fabricLine && trimLines.length === 0 && accessoryLines.length === 0) {
        toast('No fabric, trim, or accessory lines found in the material requirement yet', 'error'); return
      }

      setDraft(d => {
        let next = { ...d }
        if (fabricLine) {
          const perUnit = orderQty ? fabricLine.requiredQty / orderQty : fabricLine.requiredQty
          next.fabric = {
            ...d.fabric, name: fabricLine.name, unit: fabricLine.unit, supplier: fabricLine.supplier || '',
            consumption: Number(perUnit.toFixed(4)), wastagePct: fabricLine.wastagePct || d.fabric.wastagePct || 0,
            materialRequirementId: req.id, materialRequirementLineId: fabricLine.id,
          }
        }
        if (trimLines.length > 0) {
          const existingLabels = new Set((d.trims || []).map(l => l.label))
          const newTrims = trimLines.filter(l => !existingLabels.has(l.name)).map(l => ({
            label: l.name, supplier: l.supplier || '', value: (l.rate && l.requiredQty) ? l.rate * l.requiredQty : 0,
          }))
          next.trims = [...(d.trims || []), ...newTrims]
        }
        if (accessoryLines.length > 0) {
          const existingLabels = new Set((d.extraLines || []).map(l => l.label))
          const newExtra = accessoryLines.filter(l => !existingLabels.has(l.name)).map(l => ({
            group: 'material', label: l.name, supplier: l.supplier || '', value: (l.rate && l.requiredQty) ? l.rate * l.requiredQty : 0,
          }))
          next.extraLines = [...(d.extraLines || []), ...newExtra]
        }
        return next
      })
      toast('Pulled from Materials Requirement — fabric, trims, and accessories', 'success')
    } catch (err) { toast(err.message || 'Pull failed', 'error') } finally { setBusy(false) }
  }

  // Real cost sheets get reused across similar style variants — copies
  // content onto a NEW scope of the same kind (another order, or another of
  // the manufacturer's own projects), never the margin/fee/negotiated-price
  // layer, and always resets to draft on the target.
  async function handleDuplicate() {
    if (!dupTarget.targetId.trim()) { toast('Enter a target order/project id', 'error'); return }
    setBusy(true)
    try {
      const body = scopeType === 'tradio_order'
        ? { targetOrderId: dupTarget.targetId.trim(), styleRef: dupTarget.styleRef }
        : { targetMfrProjectId: dupTarget.targetId.trim(), styleRef: dupTarget.styleRef }
      await duplicateCostSheet(sheet.id, body)
      toast('Cost sheet duplicated — open it from the new order/project to continue', 'success')
      setShowDuplicate(false)
      setDupTarget({ targetId: '', styleRef: '' })
    } catch (err) { toast(err.message || 'Duplicate failed', 'error') } finally { setBusy(false) }
  }

  async function handleAction(fn, successMsg) {
    setBusy(true)
    try {
      const updated = await fn()
      setSheet(updated)
      toast(successMsg, 'success')
    } catch (err) { toast(err.message || 'Action failed', 'error') } finally { setBusy(false) }
  }

  return (
    <Card>
      <FlexRow style={{ justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ fontWeight: 700, fontSize: 14 }}>{styleLabel || 'Cost Sheet'}</div>
        {sheet && <Badge status={sheet.status} />}
      </FlexRow>

      {sheet?.consumptionWarning && (
        <div style={{ background: T.warningBg, border: `1px solid ${T.warningBorder}`, borderRadius: 8, padding: '8px 12px', marginBottom: 12, fontSize: 12, color: T.warning }}>
          ⚠ Fabric consumption is {sheet.consumptionWarning.pctDiff > 0 ? '+' : ''}{sheet.consumptionWarning.pctDiff}% vs. the material requirement plan
          ({sheet.consumptionWarning.requiredPerUnit.toFixed(2)}/unit planned).
        </div>
      )}

      {role === 'buyer' ? (
        sheet?.status === 'approved'
          ? <div style={{ fontSize: 20, fontWeight: 800 }}>{sheet.currency} {sheet.finalNegotiatedPrice ?? '—'}</div>
          : <div style={{ color: T.textLight, fontSize: 13 }}>Price not yet available.</div>
      ) : (
        <>
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: T.textMuted }}>FABRIC SOURCE</label>
            <select disabled={!canEditContent} value={draft?.fabricSource} onChange={e => setDraft(d => ({ ...d, fabricSource: e.target.value }))}
              style={{ display: 'block', width: '100%', marginTop: 4, padding: '6px 8px', borderRadius: 6, border: `1px solid ${T.border}` }}>
              <option value="tradio">Tradio supplies fabric (Tradio bears consumption risk)</option>
              <option value="buyer">Buyer supplies fabric</option>
              <option value="manufacturer">Manufacturer sources fabric (manufacturer's own supply)</option>
            </select>
          </div>

          <SectionTable
            title="Fabric"
            action={canEditContent && <Btn size="sm" variant="secondary" disabled={busy} onClick={handlePullFromRequirement}>⤓ Pull from Requirement</Btn>}
            note={draft?.fabric.materialRequirementLineId ? 'Linked to a requirement line' : null}
            columns={['Name', 'Consumption/unit', 'Wastage %', 'Rate', 'Supplier', 'Value']}
          >
            <tr>
              <td style={tdStyle}><input disabled={!canEditContent} value={draft?.fabric.name || ''} onChange={e => setDraft(d => ({ ...d, fabric: { ...d.fabric, name: e.target.value } }))} style={cellInputStyle} /></td>
              <td style={tdStyle}><input type="number" disabled={!canEditContent} value={draft?.fabric.consumption ?? ''} onChange={e => setDraft(d => ({ ...d, fabric: { ...d.fabric, consumption: e.target.value } }))} style={cellInputStyle} /></td>
              <td style={tdStyle}><input type="number" min="0" disabled={!canEditContent} value={draft?.fabric.wastagePct ?? ''} onChange={e => setDraft(d => ({ ...d, fabric: { ...d.fabric, wastagePct: e.target.value } }))} style={cellInputStyle} /></td>
              <td style={tdStyle}><input type="number" disabled={!canEditContent} value={draft?.fabric.rate ?? ''} onChange={e => setDraft(d => ({ ...d, fabric: { ...d.fabric, rate: e.target.value } }))} style={cellInputStyle} /></td>
              <td style={tdStyle}><input disabled={!canEditContent} value={draft?.fabric.supplier || ''} onChange={e => setDraft(d => ({ ...d, fabric: { ...d.fabric, supplier: e.target.value } }))} style={cellInputStyle} /></td>
              <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 600 }}><Mono>{costMath.fabricValue(draft || {}).toFixed(2)}</Mono></td>
            </tr>
          </SectionTable>

          <DetailTable title="Process (Branding/Elastics/Transfer)" lines={draft?.process || []} disabled={!canEditContent}
            onChange={lines => setDraft(d => ({ ...d, process: lines }))} />
          <DetailTable title="Trims" lines={draft?.trims || []} disabled={!canEditContent}
            onChange={lines => setDraft(d => ({ ...d, trims: lines }))} />
          <DetailTable title="Labels/Tags + Packaging" lines={draft?.labelsPackaging || []} disabled={!canEditContent}
            onChange={lines => setDraft(d => ({ ...d, labelsPackaging: lines }))} />
          <DetailTable title="Extra line items" lines={draft?.extraLines || []} disabled={!canEditContent} withGroup
            onChange={lines => setDraft(d => ({ ...d, extraLines: lines }))} />

          <SectionTable title="Labour" columns={['Item', 'Value']}>
            <tr>
              <td style={tdStyle}>Cutting &amp; Threads</td>
              <td style={{ ...tdStyle, width: 120 }}><input type="number" disabled={!canEditContent} value={draft?.labour.cuttingThreads ?? 0} onChange={e => setDraft(d => ({ ...d, labour: { ...d.labour, cuttingThreads: Number(e.target.value) } }))} style={cellInputStyle} /></td>
            </tr>
            <tr>
              <td style={tdStyle}>Making</td>
              <td style={tdStyle}><input type="number" disabled={!canEditContent} value={draft?.labour.making ?? 0} onChange={e => setDraft(d => ({ ...d, labour: { ...d.labour, making: Number(e.target.value) } }))} style={cellInputStyle} /></td>
            </tr>
            <tr>
              <td style={tdStyle}>Finishing &amp; Packing</td>
              <td style={tdStyle}><input type="number" disabled={!canEditContent} value={draft?.labour.finishingPacking ?? 0} onChange={e => setDraft(d => ({ ...d, labour: { ...d.labour, finishingPacking: Number(e.target.value) } }))} style={cellInputStyle} /></td>
            </tr>
          </SectionTable>

          {draft && (() => {
            // Live-computed from the in-progress draft on every keystroke —
            // not just after Save. Mirrors backend/src/models/CostSheet.js
            // via frontend/src/lib/costMath.js; see that file's header for
            // why this duplication is deliberate.
            const rawMaterialTotal = costMath.rawMaterialTotal(draft)
            const labourTotal = costMath.labourTotal(draft)
            const totalLabourAndRawMaterial = costMath.totalLabourAndRawMaterial(draft)
            const overheadValue = costMath.overheadValue(draft)
            const rejectionValue = costMath.rejectionValue(draft)
            const baseCostVal = costMath.baseCost(draft)
            const mfrMarginValueVal = costMath.mfrMarginValue(draft)
            const mfrSellPriceVal = costMath.mfrSellPrice(draft)
            return (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 12 }}>
                <tbody>
                  <tr style={{ borderTop: `2px solid ${T.border}`, fontWeight: 700 }}>
                    <td style={tdStyle}>Raw Material Total</td><td style={{ ...tdStyle, textAlign: 'right' }}><Mono>{rawMaterialTotal.toFixed(2)}</Mono></td>
                  </tr>
                  <tr style={{ fontWeight: 700 }}>
                    <td style={tdStyle}>Labour Total</td><td style={{ ...tdStyle, textAlign: 'right' }}><Mono>{labourTotal.toFixed(2)}</Mono></td>
                  </tr>
                  <tr style={{ borderTop: `1px solid ${T.border}`, fontWeight: 700 }}>
                    <td style={tdStyle}>Total Labour &amp; Raw Material</td><td style={{ ...tdStyle, textAlign: 'right' }}><Mono>{totalLabourAndRawMaterial.toFixed(2)}</Mono></td>
                  </tr>
                  <tr><td style={tdStyle}>Overhead @{draft.overheadPct}%</td><td style={{ ...tdStyle, textAlign: 'right' }}><Mono>{overheadValue.toFixed(2)}</Mono></td></tr>
                  <tr><td style={tdStyle}>Rejection @{draft.rejectionPct}%</td><td style={{ ...tdStyle, textAlign: 'right' }}><Mono>{rejectionValue.toFixed(2)}</Mono></td></tr>
                  <tr style={{ borderTop: `2px solid ${T.border}`, fontWeight: 800 }}>
                    <td style={tdStyle}>Your Base Cost</td><td style={{ ...tdStyle, textAlign: 'right' }}><Mono>{baseCostVal.toFixed(2)}</Mono></td>
                  </tr>
                  {mfrMarginValueVal != null && (
                    <>
                      <tr><td style={tdStyle}>Your Margin @{draft.mfrMarginPct}%</td><td style={{ ...tdStyle, textAlign: 'right' }}><Mono>{mfrMarginValueVal.toFixed(2)}</Mono></td></tr>
                      <tr style={{ fontWeight: 800 }}>
                        <td style={tdStyle}>Your Price</td><td style={{ ...tdStyle, textAlign: 'right' }}><Mono>{mfrSellPriceVal.toFixed(2)}</Mono></td>
                      </tr>
                    </>
                  )}
                  {sheet?.price != null && (
                    <tr style={{ borderTop: `2px solid ${T.border}`, fontWeight: 800 }}>
                      <td style={tdStyle}>Price (internal, last saved)</td><td style={{ ...tdStyle, textAlign: 'right' }}><Mono>{sheet.price?.toFixed(2)}</Mono></td>
                    </tr>
                  )}
                </tbody>
              </table>
            )
          })()}

          {(canEditContent) && (
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: T.textMuted }}>YOUR MARGIN (optional)</label>
              <Input type="number" min="0" value={draft?.mfrMarginPct ?? ''} onChange={e => setDraft(d => ({ ...d, mfrMarginPct: e.target.value }))} placeholder="e.g. 15" />
            </div>
          )}

          {canEditContent && (
            <div style={{ marginBottom: 10 }}>
              <Btn onClick={handleSave} disabled={busy}>{sheet ? 'Save Changes' : 'Create Draft'}</Btn>
            </div>
          )}

          {canRecordActuals && (
            <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 10, marginBottom: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, marginBottom: 6 }}>ACTUALS (production complete)</div>
              <Input label="Actual fabric consumption/unit" type="number" value={actualsDraft?.actualFabricConsumption ?? ''} onChange={e => setActualsDraft(a => ({ ...a, actualFabricConsumption: e.target.value }))} />
              <div style={{ marginTop: 6 }}>
                <Btn size="sm" variant="secondary" disabled={busy}
                  onClick={() => handleAction(() => saveCostSheetActuals(sheet.id, { actualFabricConsumption: actualsDraft.actualFabricConsumption === '' ? null : Number(actualsDraft.actualFabricConsumption) }), 'Actuals recorded')}>
                  Save Actuals
                </Btn>
              </div>
            </div>
          )}

          {canSetMargin && (
            <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 10, marginBottom: 12, background: T.primaryLight, borderRadius: 8, padding: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, marginBottom: 6 }}>COMMERCIAL (master admin only)</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <Input label="Margin (Factory) %" type="number" value={marginDraft?.marginPct ?? ''} onChange={e => setMarginDraft(m => ({ ...m, marginPct: e.target.value }))} />
                <Input label="Tradio Fee %" type="number" value={marginDraft?.tradioFeePct ?? ''} onChange={e => setMarginDraft(m => ({ ...m, tradioFeePct: e.target.value }))} />
                <Input label="Final Negotiated Price" type="number" value={marginDraft?.finalNegotiatedPrice ?? ''} onChange={e => setMarginDraft(m => ({ ...m, finalNegotiatedPrice: e.target.value }))} />
                <Input label="Negotiated Discount %" type="number" value={marginDraft?.negotiatedDiscountPct ?? ''} onChange={e => setMarginDraft(m => ({ ...m, negotiatedDiscountPct: e.target.value }))} />
              </div>
              <div style={{ marginTop: 8 }}>
                <Btn size="sm" disabled={busy}
                  onClick={() => handleAction(() => setCostSheetMargin(sheet.id, {
                    marginPct: marginDraft.marginPct === '' ? null : Number(marginDraft.marginPct),
                    tradioFeePct: marginDraft.tradioFeePct === '' ? null : Number(marginDraft.tradioFeePct),
                    finalNegotiatedPrice: marginDraft.finalNegotiatedPrice === '' ? null : Number(marginDraft.finalNegotiatedPrice),
                    negotiatedDiscountPct: marginDraft.negotiatedDiscountPct === '' ? null : Number(marginDraft.negotiatedDiscountPct),
                  }), 'Margin set')}>
                  Save Margin
                </Btn>
              </div>
            </div>
          )}

          <FlexRow style={{ gap: 8, flexWrap: 'wrap' }}>
            {sheet && canSubmit && sheet.status === 'draft' && (
              <Btn size="sm" disabled={busy} onClick={() => handleAction(() => submitCostSheet(sheet.id), 'Submitted for review')}>Submit</Btn>
            )}
            {canWithdraw && (
              <Btn size="sm" variant="secondary" disabled={busy} onClick={() => handleAction(() => withdrawCostSheet(sheet.id), 'Withdrawn to draft')}>Withdraw</Btn>
            )}
            {canApprove && (
              <Btn size="sm" disabled={busy} onClick={() => handleAction(() => approveCostSheet(sheet.id), 'Approved')}>Approve</Btn>
            )}
            {sheet && (
              <a href={costSheetsApi.exportUrl(sheet.id, isMaster)} target="_blank" rel="noreferrer">
                <Btn size="sm" variant="secondary">⬇ Download Excel</Btn>
              </a>
            )}
            {sheet && (isOwner || isMaster) && (
              <Btn size="sm" variant="secondary" disabled={busy} onClick={() => setShowDuplicate(s => !s)}>⧉ Duplicate to…</Btn>
            )}
          </FlexRow>

          {showDuplicate && (
            <div style={{ marginTop: 10, border: `1px solid ${T.border}`, borderRadius: 8, padding: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, marginBottom: 8 }}>
                DUPLICATE TO {scopeType === 'tradio_order' ? 'ANOTHER ORDER' : 'ANOTHER PROJECT'}
              </div>
              <FlexRow style={{ gap: 8 }}>
                <input placeholder={scopeType === 'tradio_order' ? 'Target order ID' : 'Target project ID'} value={dupTarget.targetId}
                  onChange={e => setDupTarget(d => ({ ...d, targetId: e.target.value }))}
                  style={{ flex: 1, padding: '6px 8px', borderRadius: 6, border: `1px solid ${T.border}`, fontSize: 13 }} />
                <input placeholder="Style ref (optional)" value={dupTarget.styleRef}
                  onChange={e => setDupTarget(d => ({ ...d, styleRef: e.target.value }))}
                  style={{ flex: 1, padding: '6px 8px', borderRadius: 6, border: `1px solid ${T.border}`, fontSize: 13 }} />
                <Btn size="sm" disabled={busy} onClick={handleDuplicate}>Duplicate</Btn>
              </FlexRow>
            </div>
          )}
        </>
      )}
    </Card>
  )
}

function Mono({ children }) {
  return <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{children}</span>
}

const tdStyle = { padding: '6px 8px', borderBottom: `1px solid ${T.border}` }
const cellInputStyle = { width: '100%', padding: '5px 7px', borderRadius: 6, border: `1px solid ${T.border}`, fontSize: 13, boxSizing: 'border-box' }

// Wraps a fixed, non-repeating row set (Fabric, Labour) in a real <table> with
// a header row — a single-purpose section, as opposed to DetailTable's
// open-ended add/remove list below.
function SectionTable({ title, columns, action, note, children }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <FlexRow style={{ justifyContent: 'space-between', marginBottom: 6 }}>
        <label style={{ fontSize: 11, fontWeight: 700, color: T.textMuted }}>{title.toUpperCase()}</label>
        <FlexRow style={{ gap: 8 }}>
          {note && <span style={{ fontSize: 11, color: T.textMuted }}>{note}</span>}
          {action}
        </FlexRow>
      </FlexRow>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 480 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: T.textMuted, fontSize: 11, textTransform: 'uppercase' }}>
              {columns.map(c => <th key={c} style={{ padding: '4px 8px', borderBottom: `2px solid ${T.border}` }}>{c}</th>)}
            </tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
      </div>
    </div>
  )
}

// Open-ended add/remove line table, shared by the three fixed detail blocks
// (process/trims/labelsPackaging) and the free-form extraLines escape hatch.
// `withGroup` adds the material/labour rollup selector extraLines needs.
function DetailTable({ title, lines, onChange, disabled, withGroup }) {
  const subtotal = lines.reduce((sum, l) => sum + (Number(l.value) || 0), 0)

  function updateLine(i, patch) {
    onChange(lines.map((l, idx) => idx === i ? { ...l, ...patch } : l))
  }
  function removeLine(i) {
    onChange(lines.filter((_, idx) => idx !== i))
  }
  function addLine() {
    onChange([...lines, withGroup ? { group: 'material', label: '', supplier: '', value: 0 } : { label: '', supplier: '', value: 0 }])
  }

  return (
    <div style={{ marginBottom: 16 }}>
      <FlexRow style={{ justifyContent: 'space-between', marginBottom: 6 }}>
        <label style={{ fontSize: 11, fontWeight: 700, color: T.textMuted }}>{title.toUpperCase()}</label>
        <span style={{ fontSize: 12, color: T.textMuted }}>Subtotal: {subtotal.toFixed(2)}</span>
      </FlexRow>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: withGroup ? 560 : 480 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: T.textMuted, fontSize: 11, textTransform: 'uppercase' }}>
              {withGroup && <th style={{ padding: '4px 8px', borderBottom: `2px solid ${T.border}` }}>Group</th>}
              <th style={{ padding: '4px 8px', borderBottom: `2px solid ${T.border}` }}>Item</th>
              <th style={{ padding: '4px 8px', borderBottom: `2px solid ${T.border}` }}>Supplier</th>
              <th style={{ padding: '4px 8px', borderBottom: `2px solid ${T.border}` }}>Value</th>
              {!disabled && <th style={{ padding: '4px 8px', borderBottom: `2px solid ${T.border}`, width: 28 }}></th>}
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                {withGroup && (
                  <td style={tdStyle}>
                    <select disabled={disabled} value={l.group || 'material'} onChange={e => updateLine(i, { group: e.target.value })}
                      style={{ ...cellInputStyle, width: 'auto' }}>
                      <option value="material">Material</option>
                      <option value="labour">Labour</option>
                    </select>
                  </td>
                )}
                <td style={tdStyle}><input placeholder="Label" disabled={disabled} value={l.label || ''} onChange={e => updateLine(i, { label: e.target.value })} style={cellInputStyle} /></td>
                <td style={tdStyle}><input placeholder="Supplier" disabled={disabled} value={l.supplier || ''} onChange={e => updateLine(i, { supplier: e.target.value })} style={cellInputStyle} /></td>
                <td style={{ ...tdStyle, width: 110 }}><input type="number" disabled={disabled} value={l.value ?? 0} onChange={e => updateLine(i, { value: Number(e.target.value) })} style={cellInputStyle} /></td>
                {!disabled && (
                  <td style={tdStyle}>
                    <button type="button" onClick={() => removeLine(i)} style={{ border: 'none', background: 'transparent', color: T.danger, cursor: 'pointer', fontSize: 13, padding: '0 4px' }}>✕</button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!disabled && (
        <button type="button" onClick={addLine}
          style={{ marginTop: 6, border: `1px dashed ${T.border}`, background: 'transparent', color: T.textMuted, cursor: 'pointer', fontSize: 12, borderRadius: 6, padding: '4px 10px' }}>
          + Add line
        </button>
      )}
    </div>
  )
}
