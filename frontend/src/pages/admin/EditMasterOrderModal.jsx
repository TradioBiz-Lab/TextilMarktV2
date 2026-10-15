import { useState } from 'react'
import { AlertTriangle } from '../../icons.jsx'
import { T, seasonsFor, styleOnHold, moDetailsForm, moDetailsPayload } from '../../constants.js'
import { MasterOrderTermsFields } from './MasterOrderTermsFields.jsx'
import { Btn, FlexRow, Input, Select, Mono, Modal, Textarea, useToast } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'
import { DeleteOrderModal } from './DeleteOrderModal.jsx'

/**
 * Edit a master order: rename it, change its season, manage its styles (take one off hold, move one to another
 * master order of the same customer, drop one), or (once it has no styles left) delete it. Dropping a style and deleting a master
 * order both keep a permanent record, see DroppedRecord on the backend.
 */
// `onDeleted` is called after the master order is deleted (its own page then leaves, since there is nothing to show).
export function EditMasterOrderModal({ mo, onClose, onDeleted }) {
  const { orders, masterOrders, users, updateMasterOrder, deleteOrder, deleteMasterOrder, editOrder, updateAssignment } = useApp()
  const toast = useToast()
  const [name, setName] = useState(mo.orderName || '')
  const [season, setSeason] = useState(mo.season || '')
  const [details, setDetails] = useState(() => moDetailsForm(mo))
  const setDetail = k => e => setDetails(d => ({ ...d, [k]: e.target.value }))
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const [dropTarget, setDropTarget] = useState(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleteReason, setDeleteReason] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [busyId, setBusyId] = useState(null)   // the style a row action is running on
  // Where a style can move: the same customer's other master orders.
  const moveTargets = (masterOrders || []).filter(m => m.id !== mo.id && String(m.buyerId) === String(mo.buyerId))

  const rowAction = async (o, run, done) => {
    setErr(''); setBusyId(o.id)
    try { await run(); toast(done, 'success') }
    catch (e) { setErr(typeof e === 'string' ? e : (e?.message || 'Could not update the style')) }
    finally { setBusyId(null) }
  }
  const unhold = o => rowAction(o, async () => {
    for (const a of (o.assignments || []).filter(a => a.status === 'On Hold')) await updateAssignment(o.id, a.mid, 'Processing', 'Taken off hold from the master order')
  }, `${o.product} is back in production`)
  const moveTo = (o, targetId) => rowAction(o, () => editOrder(o.id, { masterOrderId: targetId }),
    `${o.product} moved to ${moveTargets.find(m => m.id === targetId)?.orderName || targetId}`)

  // Read live from the store, so a style disappears from this list the moment it is dropped.
  const styles = (orders || []).filter(o => o.masterOrderId === mo.id)
  const detailsChanged = Object.keys(moDetailsPayload(details, moDetailsForm(mo))).length > 0
  const changed = name.trim() !== (mo.orderName || '') || season !== (mo.season || '') || detailsChanged

  const save = async () => {
    setErr('')
    if (!name.trim()) { setErr('Give the master order a name.'); return }
    setSaving(true)
    try {
      // Only the fields that changed are sent, so the audit log records real changes.
      const top = Object.fromEntries(Object.entries({ orderName: name.trim(), season }).filter(([k, v]) => v !== (mo[k] || '')))
      await updateMasterOrder(mo.id, { ...top, ...moDetailsPayload(details, moDetailsForm(mo)) })
      toast('Master order updated', 'success')
      onClose()
    } catch (e) {
      setErr(typeof e === 'string' ? e : (e?.message || 'Could not save'))
    } finally { setSaving(false) }
  }

  const removeMasterOrder = async () => {
    setErr(''); setDeleting(true)
    try {
      await deleteMasterOrder(mo.id, deleteReason.trim())
      onDeleted?.()
      toast('Master order deleted', 'success')
      onClose()
    } catch (e) {
      setErr(typeof e === 'string' ? e : (e?.message || 'Could not delete'))
      setDeleting(false)
    }
  }

  return (
    <>
      <Modal title="Edit Master Order" subtitle={`${mo.buyerCompany || ''} · ${mo.id}`} onClose={onClose} size="md">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Input label="Order Name *" value={name} onChange={e => setName(e.target.value)} maxLength={200} />
          <Select label="Season" value={season} onChange={e => setSeason(e.target.value)}>
            <option value="">No season</option>
            {seasonsFor((users || []).find(u => u.id === mo.buyerId), mo.season).map(s => <option key={s} value={s}>{s}</option>)}
          </Select>
          <div className="form-grid-2" style={{ gap: 12 }}>
            <Input label="Customer PO number" value={details.poNumber} onChange={setDetail('poNumber')} maxLength={60} />
            <Input label="PO date" type="date" value={details.poDate} onChange={setDetail('poDate')} />
          </div>
          <Input label="Ship by" type="date" value={details.shipBy} onChange={setDetail('shipBy')} />
          <MasterOrderTermsFields details={details} setDetail={setDetail} />
          <Textarea label="Notes" value={details.notes} onChange={setDetail('notes')} rows={2} maxLength={2000} />

          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
              Styles in this master order ({styles.length})
            </div>
            {styles.length === 0 ? (
              <div style={{ fontSize: 13, color: T.textMuted, padding: '10px 12px', background: '#f8fafc', border: `1px solid ${T.border}`, borderRadius: 8 }}>
                No styles left in this master order.
              </div>
            ) : (
              <div style={{ border: `1px solid ${T.border}`, borderRadius: 10, overflow: 'hidden' }}>
                {styles.map((o, i) => (
                  <FlexRow key={o.id} gap={10} style={{ padding: '10px 12px', borderTop: i ? `1px solid ${T.border}` : 'none', background: T.surface, flexWrap: 'wrap' }}>
                    <div style={{ flex: '1 1 180px', minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {o.product}{o.styleNumber ? ` (${o.styleNumber})` : ''}
                      </div>
                      <div style={{ fontSize: 11, color: T.textMuted }}><Mono style={{ fontSize: 11 }}>{o.id}</Mono> · {o.totalQty?.toLocaleString()} pcs
                        {styleOnHold(o) && <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 800, color: '#475569', background: '#e2e8f0', borderRadius: 999, padding: '1px 7px' }}>On hold</span>}
                      </div>
                    </div>
                    {styleOnHold(o) && <Btn size="sm" variant="secondary" disabled={busyId === o.id} onClick={() => unhold(o)}>Unhold</Btn>}
                    {moveTargets.length > 0 && (
                      <select value="" disabled={busyId === o.id} onChange={e => e.target.value && moveTo(o, e.target.value)} aria-label={`Move ${o.product} to another master order`}
                        style={{ border: `1px solid ${T.border}`, borderRadius: 8, padding: '5px 8px', fontSize: 12, fontWeight: 600, fontFamily: 'inherit', color: T.text, background: T.surface, maxWidth: 150 }}>
                        <option value="">Move to...</option>
                        {moveTargets.map(m => <option key={m.id} value={m.id}>{m.orderName}{m.season ? ` (${m.season})` : ''}</option>)}
                      </select>
                    )}
                    <Btn size="sm" variant="secondary" disabled={busyId === o.id} onClick={() => setDropTarget(o)}>Drop</Btn>
                  </FlexRow>
                ))}
              </div>
            )}
            <div style={{ fontSize: 11.5, color: T.textMuted, marginTop: 6, lineHeight: 1.5 }}>
              Moving a style keeps everything on it. Dropping a style removes it from every list; a full record of it is kept.
            </div>
          </div>

          {err && (
            <div style={{ fontSize: 12, color: T.danger, fontWeight: 600, background: T.dangerBg, border: `1px solid ${T.dangerBorder}`, borderRadius: 8, padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 6 }}>
              <AlertTriangle size={13} /> {err}
            </div>
          )}

          <FlexRow justify="flex-end" gap={8}>
            <Btn variant="secondary" onClick={onClose} disabled={saving}>Close</Btn>
            <Btn onClick={save} disabled={!changed || !name.trim() || saving}>{saving ? 'Saving…' : 'Save Changes'}</Btn>
          </FlexRow>

          {styles.length === 0 && (
            <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 14 }}>
              {!confirmingDelete ? (
                <button onClick={() => setConfirmingDelete(true)}
                  style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 700, color: T.danger }}>
                  Delete this master order
                </button>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{ fontSize: 12.5, color: '#9f1239', lineHeight: 1.5 }}>
                    This deletes the empty master order <strong>{mo.orderName}</strong>. A record of it is kept in the database.
                  </div>
                  <Textarea label="Why? (optional)" value={deleteReason} onChange={e => setDeleteReason(e.target.value)} maxLength={500} rows={2} />
                  <FlexRow justify="flex-end" gap={8}>
                    <Btn variant="secondary" size="sm" onClick={() => setConfirmingDelete(false)} disabled={deleting}>Cancel</Btn>
                    <button onClick={removeMasterOrder} disabled={deleting}
                      style={{ padding: '6px 14px', fontSize: 12.5, fontWeight: 700, borderRadius: 8, border: 'none', background: deleting ? '#fca5a5' : T.danger, color: '#fff', cursor: deleting ? 'wait' : 'pointer', fontFamily: 'inherit' }}>
                      {deleting ? 'Deleting…' : 'Yes, delete it'}
                    </button>
                  </FlexRow>
                </div>
              )}
            </div>
          )}
        </div>
      </Modal>

      {dropTarget && (
        <DeleteOrderModal
          order={dropTarget}
          onClose={() => setDropTarget(null)}
          onConfirm={async (id, reason) => {
            await deleteOrder(id, reason)
            toast(`Style ${id} dropped`, 'success')
            setDropTarget(null)
          }}
        />
      )}
    </>
  )
}
