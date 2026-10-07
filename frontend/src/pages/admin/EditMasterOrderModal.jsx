import { useState } from 'react'
import { AlertTriangle } from '../../icons.jsx'
import { T, SEASONS } from '../../constants.js'
import { Btn, FlexRow, Input, Select, Mono, Modal, Textarea, useToast } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'
import { DeleteOrderModal } from './DeleteOrderModal.jsx'

/**
 * Edit a master order: rename it, change its season, drop a style from it, or
 * (once it has no styles left) delete it. Dropping a style and deleting a master
 * order both keep a permanent record, see DroppedRecord on the backend.
 */
export function EditMasterOrderModal({ mo, onClose }) {
  const { orders, updateMasterOrder, deleteOrder, deleteMasterOrder } = useApp()
  const toast = useToast()
  const [name, setName] = useState(mo.orderName || '')
  const [season, setSeason] = useState(mo.season || '')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const [dropTarget, setDropTarget] = useState(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleteReason, setDeleteReason] = useState('')
  const [deleting, setDeleting] = useState(false)

  // Read live from the store, so a style disappears from this list the moment it is dropped.
  const styles = (orders || []).filter(o => o.masterOrderId === mo.id)
  const changed = name.trim() !== (mo.orderName || '') || season !== (mo.season || '')

  const save = async () => {
    setErr('')
    if (!name.trim()) { setErr('Give the master order a name.'); return }
    setSaving(true)
    try {
      await updateMasterOrder(mo.id, { orderName: name.trim(), season })
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
            {SEASONS.map(s => <option key={s} value={s}>{s}</option>)}
          </Select>

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
                  <FlexRow key={o.id} gap={10} style={{ padding: '10px 12px', borderTop: i ? `1px solid ${T.border}` : 'none', background: T.surface }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {o.product}{o.styleNumber ? ` (${o.styleNumber})` : ''}
                      </div>
                      <div style={{ fontSize: 11, color: T.textMuted }}><Mono style={{ fontSize: 11 }}>{o.id}</Mono> · {o.totalQty?.toLocaleString()} pcs</div>
                    </div>
                    <Btn size="sm" variant="secondary" onClick={() => setDropTarget(o)}>Drop</Btn>
                  </FlexRow>
                ))}
              </div>
            )}
            <div style={{ fontSize: 11.5, color: T.textMuted, marginTop: 6, lineHeight: 1.5 }}>
              Dropping a style removes it from every list. A full record of it is kept in the database.
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
