import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, Download, SealCheck, Pencil } from '../../icons.jsx'
import { T } from '../../constants.js'
import { Btn, Alert, Modal, FlexRow, Mono, LoadingScreen, FileViewer, useToast } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'
import { capsFor } from '../../caps.js'
import { costSheetsApi } from '../../api.js'
import { costSheetsStore } from '../../stores/costing.jsx'
import { costStatus } from '../../lib/costing.js'
import { rupees, fmtDay } from '../../lib/procurement.js'
import { Pill } from '../procurement/common.jsx'
import { CostSheetView } from './CostSheetView.jsx'
import { CostSheetEditor } from './CostSheetEditor.jsx'
import { CommentsThread } from './CommentsThread.jsx'
import { ShareCostSheetModal } from './ShareCostSheetModal.jsx'

/** One cost sheet version: the factory's editor while it is a draft, otherwise the sheet to read, with the talk about it. */
export function CostSheetPage({ costId, onBack, onNavigate }) {
  const toast = useToast()
  const { currentUser } = useApp()
  const caps = capsFor(currentUser)
  const brand = !caps.isMfr
  const { items: rows, refresh } = costSheetsStore.useStore()
  const [sheet, setSheet] = useState(null)
  const [error, setError] = useState('')
  const [sharing, setSharing] = useState(false)
  const [approving, setApproving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [pdf, setPdf] = useState(null)

  const load = useCallback(async () => {
    try { setSheet(await costSheetsApi.get(costId)); setError('') } catch (e) { setError(e?.message || 'Could not load this cost sheet') }
  }, [costId])
  useEffect(() => { load() }, [load])

  // Someone else on this sheet (the other side, or a teammate) moved it: the list store notices, and so do we.
  const row = sheet && rows.find(r => r.chainId === sheet.chainId && (brand || true))
  const signature = row ? `${row.id}|${row.status}|${row.version}|${row.updatedAt}` : ''
  useEffect(() => {
    if (!signature || !sheet) return
    if (row.id === sheet.id && (row.status !== sheet.status || new Date(row.updatedAt).getTime() !== new Date(sheet.updatedAt).getTime())) load()
  }, [signature]) // eslint-disable-line react-hooks/exhaustive-deps

  const changed = async next => { setSheet(next); await refresh() }

  if (error) return <div><Btn variant="secondary" size="sm" onClick={onBack} icon={<ArrowLeft size={13} />}>Back</Btn><div style={{ height: 14 }} /><Alert type="danger">{error}</Alert></div>
  if (!sheet) return <LoadingScreen message="Loading cost sheet..." />

  const status = costStatus(sheet.status, { brand })
  const isDraft = sheet.status === 'draft'
  const newest = sheet.versions[0]?.version === sheet.version
  const live = ['shared', 'commented', 'approved'].includes(sheet.status)
  const price = sheet.discountPct > 0 ? sheet.computed?.negotiated : sheet.computed?.price
  const factoryName = sheet.factoryName, brandName = sheet.brandName

  const showPdf = async () => {
    setBusy(true)
    try { setPdf(await costSheetsApi.pdf(sheet.id)) } catch (e) { toast(e?.message || 'Could not open the PDF', 'error') } finally { setBusy(false) }
  }
  const act = async (fn, okMessage) => {
    setBusy(true)
    try { const r = await fn(); if (okMessage) toast(okMessage, 'success'); return r } catch (e) { toast(e?.message || 'That did not work', 'error'); return null } finally { setBusy(false) }
  }
  const revise = async () => { const r = await act(() => costSheetsApi.revise(sheet.id), 'New version started'); if (r) { await refresh(); onNavigate('cost_sheet', { cost: r.id }) } }
  const approve = async () => { setApproving(false); const r = await act(() => costSheetsApi.approve(sheet.id), `Approved at ${rupees(price)} per piece`); if (r) await changed(r) }
  const comment = async (text, kind) => { try { await changed(await costSheetsApi.comment(sheet.id, text, kind)) } catch (e) { toast(e?.message || 'Could not post the comment', 'error'); throw e } }
  const remove = async () => { const r = await act(() => costSheetsApi.remove(sheet.id), 'Draft deleted'); if (r) { await refresh(); onBack() } }

  const banner = (() => {
    if (sheet.status === 'approved') return <Alert type="success"><strong>Approved</strong> by {sheet.approvedByName || brandName} on {fmtDay(sheet.approvedAt)} at {rupees(sheet.approvedPrice)} per piece.{!brand && newest ? ' To change the price, start a new version: it will need approving again.' : ''}</Alert>
    if (sheet.status === 'superseded') return <Alert type="info">A newer version replaced this one. <button type="button" className="gl-link" onClick={() => onNavigate('cost_sheet', { cost: sheet.versions[0].id })}>Open the latest</button></Alert>
    if (sheet.status === 'commented') return <Alert type="warning">{brand ? `You commented on this. ${factoryName} will reply or send a new version.` : `${brandName} commented. Reply below, or start a new version to change the prices.`}</Alert>
    if (sheet.status === 'shared') return <Alert type="info">{brand ? `${factoryName} shared this cost sheet for your review. Approve it, or comment to ask for changes.` : `Shared with ${brandName} on ${fmtDay(sheet.sharedAt)}. They have not responded yet.`}</Alert>
    return null
  })()

  return (
    <div style={{ maxWidth: 1100 }}>
      <FlexRow gap={10} style={{ marginBottom: 14, flexWrap: 'wrap' }}>
        <Btn variant="secondary" size="sm" onClick={onBack} icon={<ArrowLeft size={13} />}>Back</Btn>
      </FlexRow>

      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 14 }}>
        <div style={{ flex: '1 1 260px', minWidth: 0 }}>
          <FlexRow gap={10} style={{ flexWrap: 'wrap' }}>
            <div style={{ fontSize: 20, fontWeight: 800, color: T.text }}>{sheet.styleName}</div>
            <Pill tone={status.tone}>{status.label}</Pill>
          </FlexRow>
          <div style={{ fontSize: 13, color: T.textMuted, marginTop: 4 }}>
            <Mono style={{ fontSize: 12, fontWeight: 700, color: T.primaryDeep }}>{sheet.chainId} v{sheet.version}</Mono>
            {' · '}{brand ? `from ${factoryName}` : `for ${brandName}`}
            {price ? <span> · <strong style={{ color: T.text }}>{rupees(price)}</strong> per piece</span> : null}
          </div>
        </div>
        <FlexRow gap={8} style={{ flexWrap: 'wrap' }}>
          {sheet.status === 'draft' || <Btn variant="secondary" icon={<Download size={13} />} onClick={showPdf} disabled={busy}>View PDF</Btn>}
          {!brand && caps.manageCosting && live && newest && <Btn variant="secondary" icon={<Pencil size={13} />} onClick={revise} disabled={busy}>New version</Btn>}
          {brand && caps.approveCosting && ['shared', 'commented'].includes(sheet.status) && <Btn variant="success" icon={<SealCheck size={14} />} onClick={() => setApproving(true)} disabled={busy}>Approve</Btn>}
        </FlexRow>
      </div>

      {sheet.versions.length > 1 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }} aria-label="Versions">
          <span style={{ fontSize: 11, fontWeight: 800, color: T.textLight, textTransform: 'uppercase', letterSpacing: '0.07em' }}>Versions</span>
          {sheet.versions.map(v => (
            <button key={v.id} type="button" onClick={() => v.id !== sheet.id && onNavigate('cost_sheet', { cost: v.id })} aria-current={v.id === sheet.id ? 'true' : undefined}
              style={{ padding: '4px 12px', borderRadius: 16, fontSize: 12, fontWeight: 700, border: `1px solid ${v.id === sheet.id ? T.primary : T.border}`, background: v.id === sheet.id ? T.primaryLight : T.surface, color: v.id === sheet.id ? T.primaryDeep : T.textMuted, cursor: v.id === sheet.id ? 'default' : 'pointer', fontFamily: 'inherit' }}>
              v{v.version} {costStatus(v.status, { brand }).label.toLowerCase()}
            </button>
          ))}
        </div>
      )}

      {banner && <div style={{ marginBottom: 14 }}>{banner}</div>}

      {isDraft && !brand
        ? <CostSheetEditor key={sheet.id} sheet={sheet} tradioEnabled={!!currentUser?.tradioEnabled} onSaved={s => { setSheet(s); refresh() }} onShare={() => setSharing(true)} onDelete={remove} onReload={load} />
        : (
          <>
            <CostSheetView sheet={sheet} />
            <div style={{ height: 14 }} />
            <CommentsThread comments={sheet.comments} canComment={live && (caps.commentCosting)} canRequestChanges={brand && ['shared', 'commented'].includes(sheet.status)} onSend={comment} theirName={brand ? factoryName : brandName} />
          </>
        )}

      {sharing && <ShareCostSheetModal sheet={sheet} onClose={() => setSharing(false)} onShared={async r => {
        setSharing(false)
        if (r.emailSkipped) toast('Shared, but no email went out: email is not set up on this server', 'warning')
        else if (r.emailFailed?.length) toast(`Shared. Could not email: ${r.emailFailed.map(f => f.to).join(', ')}`, 'warning')
        else toast(`Shared with ${brandName}`, 'success')
        await changed(r.sheet)
      }} />}

      {approving && (
        <Modal title="Approve this cost sheet?" onClose={() => setApproving(false)} size="sm">
          <div style={{ fontSize: 14, color: T.text, lineHeight: 1.6 }}>You are approving <strong>{sheet.styleName}</strong> from {factoryName} at <strong>{rupees(price)} per piece</strong>. They will be told. If the price changes later they will send a new version for you to approve again.</div>
          <FlexRow justify="flex-end" gap={8} style={{ marginTop: 18 }}>
            <Btn variant="secondary" onClick={() => setApproving(false)}>Not yet</Btn>
            <Btn variant="success" icon={<SealCheck size={14} />} onClick={approve}>Approve at {rupees(price)}</Btn>
          </FlexRow>
        </Modal>
      )}

      {pdf && <FileViewer name={`Cost sheet ${sheet.chainId} v${sheet.version}`} fileName={pdf.fileName} dataUrl={pdf.dataUrl} onClose={() => setPdf(null)} />}
    </div>
  )
}
