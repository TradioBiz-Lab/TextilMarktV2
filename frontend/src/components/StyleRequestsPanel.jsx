import { useEffect, useState, useCallback } from 'react'
import { Inbox, Check, X, Clock } from '../icons.jsx'
import { T } from '../constants.js'
import { Card, FlexRow, useToast } from './ui.jsx'
import { styleRequestsApi } from '../api.js'
import { requestTitle, requestWhen, REQUEST_STATUS } from '../styleRequests.js'

// A customer's own requests to Tradio (a sheet of styles, a replen) and where each stands. Waiting ones can be cancelled;
// a decision shows its reason. Shown on the customer's Orders page. `reloadKey` makes it read again after a new request.
export function StyleRequestsPanel({ reloadKey }) {
  const toast = useToast()
  const [items, setItems] = useState([])
  const [busyId, setBusyId] = useState('')
  const load = useCallback(() => styleRequestsApi.list().then(setItems).catch(() => {}), [])
  useEffect(() => { load() }, [load, reloadKey])

  // What matters now: everything waiting, and what was decided in the last two weeks.
  const fortnightAgo = Date.now() - 14 * 86400000
  const shown = items.filter(r => r.status === 'pending' || (r.status !== 'cancelled' && new Date(r.decidedAt || r.createdAt).getTime() > fortnightAgo))
  if (!shown.length) return null
  const waiting = shown.filter(r => r.status === 'pending').length

  const cancel = async r => {
    setBusyId(r.id)
    try { await styleRequestsApi.cancel(r.id); toast('Request cancelled', 'success'); await load() }
    catch (e) { toast(e?.message || 'Could not cancel it.', 'error') }
    finally { setBusyId('') }
  }

  return (
    <Card style={{ marginBottom: 12 }}>
      <FlexRow gap={8} style={{ marginBottom: 8 }}>
        <Inbox size={15} color={T.textMuted} />
        <span style={{ fontSize: 13, fontWeight: 800, color: T.text }}>Your requests</span>
        {waiting > 0 && <span style={{ fontSize: 11, fontWeight: 800, color: '#92400e', background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: 999, padding: '1px 9px' }}>{waiting} waiting for Tradio</span>}
      </FlexRow>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {shown.map(r => {
          const st = REQUEST_STATUS[r.status]
          return (
            <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '8px 10px', border: `1px solid ${T.border}`, borderRadius: 8, background: '#fafbfc' }}>
              <span style={{ fontSize: 11, fontWeight: 800, color: st.fg, background: st.bg, border: `1px solid ${st.bd}`, borderRadius: 999, padding: '2px 10px', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                {r.status === 'approved' ? <Check size={11} /> : r.status === 'declined' ? <X size={11} /> : <Clock size={11} />}{st.label}
              </span>
              <div style={{ flex: 1, minWidth: 180 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{requestTitle(r)}</div>
                <div style={{ fontSize: 11.5, color: T.textMuted }}>
                  {requestWhen(r.createdAt)}{r.masterOrderName ? ` · ${r.masterOrderName}` : ''}
                  {r.status === 'declined' && r.decisionNote ? ` · Reason: ${r.decisionNote}` : ''}
                  {r.status === 'approved' && r.createdOrderIds.length ? ` · ${r.createdOrderIds.length} style${r.createdOrderIds.length !== 1 ? 's' : ''} added` : ''}
                </div>
              </div>
              {r.status === 'pending' && (
                <button onClick={() => cancel(r)} disabled={busyId === r.id} style={{ fontSize: 12, fontWeight: 700, color: T.textMuted, background: 'none', border: `1px solid ${T.border}`, borderRadius: 8, padding: '4px 10px', cursor: 'pointer', fontFamily: 'inherit' }}>
                  {busyId === r.id ? 'Cancelling…' : 'Cancel request'}
                </button>
              )}
            </div>
          )
        })}
      </div>
    </Card>
  )
}
