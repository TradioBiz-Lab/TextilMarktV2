import { useEffect, useState } from 'react'
import { Folder, Package, ChevronDown } from '../../icons.jsx'
import { T } from '../../constants.js'
import { Card, Btn, FlexRow, Mono, useToast } from '../../components/ui.jsx'
import { droppedApi } from '../../api.js'

const fmt = d => {
  if (!d) return ''
  const dt = new Date(d)
  return `${String(dt.getDate()).padStart(2, '0')}-${String(dt.getMonth() + 1).padStart(2, '0')}-${dt.getFullYear()} ${dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
}

/**
 * The permanent record of dropped styles and master orders, newest first. Each row
 * can be downloaded as a JSON file holding the full copy that was kept at the time.
 */
export function DroppedRecords() {
  const toast = useToast()
  const [rows, setRows] = useState(null)
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState(false)
  const [busyId, setBusyId] = useState(null)

  useEffect(() => { droppedApi.list().then(setRows).catch(() => { setFailed(true); setRows([]) }) }, [])

  const download = async r => {
    setBusyId(r.id)
    try {
      const full = await droppedApi.get(r.id)
      const blob = new Blob([JSON.stringify(full, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = `dropped-${r.refId}.json`; a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      toast(e?.message || 'Could not download the record', 'error')
    } finally { setBusyId(null) }
  }

  if (rows === null) return null
  return (
    <Card pad={false} style={{ marginBottom: 16 }}>
      <button onClick={() => setOpen(o => !o)} aria-expanded={open}
        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}>
        <span style={{ color: T.textMuted, transform: open ? 'none' : 'rotate(-90deg)', display: 'inline-flex' }}><ChevronDown size={13} /></span>
        <span style={{ fontSize: 13, fontWeight: 800, color: T.text }}>Dropped styles and master orders</span>
        <span style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, background: '#f1f5f9', padding: '1px 8px', borderRadius: 10 }}>{rows.length}</span>
        <span style={{ fontSize: 11.5, color: T.textMuted, marginLeft: 'auto' }}>A full copy of each is kept in the database</span>
      </button>
      {open && (
        rows.length === 0 ? (
          <div style={{ padding: '4px 16px 14px', fontSize: 13, color: failed ? T.danger : T.textMuted }}>
            {failed ? 'Could not load the records. Reload the page to try again.' : 'Nothing has been dropped yet.'}
          </div>
        ) : (
          <div style={{ borderTop: `1px solid ${T.border}` }}>
            {rows.map(r => (
              <FlexRow key={r.id} gap={12} style={{ padding: '10px 16px', borderTop: `1px solid ${T.border}`, alignItems: 'flex-start' }}>
                <span style={{ color: T.textMuted, marginTop: 2 }}>{r.kind === 'master_order' ? <Folder size={14} /> : <Package size={14} />}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>
                    {r.label} <span style={{ fontSize: 10, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{r.kind === 'master_order' ? 'master order' : 'style'}</span>
                  </div>
                  <div style={{ fontSize: 11.5, color: T.textMuted, marginTop: 2 }}>
                    <Mono style={{ fontSize: 11 }}>{r.refId}</Mono>
                    {r.kind === 'style' && r.masterOrderId ? <> · in <Mono style={{ fontSize: 11 }}>{r.masterOrderId}</Mono></> : null}
                    {r.buyerCompany ? ` · ${r.buyerCompany}` : ''}
                    {r.documentCount ? ` · ${r.documentCount} document${r.documentCount !== 1 ? 's' : ''}` : ''}
                  </div>
                  {r.reason && <div style={{ fontSize: 12, color: T.text, marginTop: 4 }}>Reason: {r.reason}</div>}
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: T.text }}>{r.droppedByName || 'Unknown'}</div>
                  <div style={{ fontSize: 11, color: T.textMuted }}>{fmt(r.droppedAt)}</div>
                </div>
                <Btn size="sm" variant="secondary" disabled={busyId === r.id} onClick={() => download(r)}>{busyId === r.id ? '…' : 'Download'}</Btn>
              </FlexRow>
            ))}
          </div>
        )
      )}
    </Card>
  )
}
