import { T, seasonsFor } from '../constants.js'
import { Input, Select } from './ui.jsx'
import { useApp } from '../context.jsx'

/** Which master order the styles go under: one of this customer's, or a new one made here. */
export function MasterOrderPicker({ buyerId, value, onChange, newMo, setNewMo, suggested, label = 'Master order the styles go under *' }) {
  const { masterOrders, users } = useApp()
  const mine = (masterOrders || []).filter(m => String(m.buyerId) === String(buyerId))
  const buyer = (users || []).find(u => String(u.id) === String(buyerId))
  // A new master order starts in the season of this customer's latest one (the season becomes part of each style's ID).
  const latestSeason = [...mine].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)).find(m => m.season)?.season || ''
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Select label={label} value={newMo ? '__new__' : value} onChange={e => { if (e.target.value === '__new__') { setNewMo({ orderName: '', season: latestSeason }); onChange('') } else { setNewMo(null); onChange(e.target.value) } }}>
        <option value="">Choose a master order</option>
        {mine.map(m => <option key={m.id} value={m.id}>{m.orderName} ({m.id}){m.id === suggested ? ', where the styles are now' : ''}</option>)}
        <option value="__new__">+ New master order</option>
      </Select>
      {newMo && (
        <div className="form-grid-2" style={{ gap: 10 }}>
          <Input label="Order name *" value={newMo.orderName} onChange={e => setNewMo({ ...newMo, orderName: e.target.value })} placeholder="e.g. SS26 Replen" />
          <Select label="Season" value={newMo.season} onChange={e => setNewMo({ ...newMo, season: e.target.value })}>
            <option value="">No season</option>
            {seasonsFor(buyer).map(sn => <option key={sn}>{sn}</option>)}
          </Select>
        </div>
      )}
    </div>
  )
}

