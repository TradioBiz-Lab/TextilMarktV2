import { useEffect, useState } from 'react'
import { Eye } from '../icons.jsx'
import { viewAsApi, setAuthToken, setStoredToken } from '../api.js'
import { useApp } from '../context.jsx'
import { T } from '../constants.js'

// SANDBOX ONLY, TEMPORARY. Delete this file, its two uses in Shell.jsx, the
// viewAsApi block in api.js and backend/src/routes/viewAs.js when the feature
// is dropped. Only renders for a master admin when the server has
// ENABLE_VIEW_AS on (the server sets user.canViewAs).

// Swap the session (cookie set by the server), then reload so every page loads fresh as that user.
async function switchTo(call) {
  const { user, token } = await call()
  setStoredToken(user.id)
  setAuthToken(token)
  window.location.reload()
}

/** Dropdown at the top left of the sidebar. */
export function ViewAsPicker() {
  const { currentUser: user } = useApp()
  const [options, setOptions] = useState([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    if (!user?.canViewAs) return
    viewAsApi.options().then(setOptions).catch(() => setOptions([]))
  }, [user?.canViewAs, user?.id])

  if (!user?.canViewAs) return null
  const group = role => options.filter(o => o.role === role)
  const onChange = async e => {
    const v = e.target.value
    if (!v) return
    setBusy(true); setErr('')
    try { await switchTo(v === '__exit__' ? viewAsApi.exit : () => viewAsApi.start(v)) }
    catch (ex) { setErr(ex.message || 'Could not switch'); setBusy(false) }
  }
  return (
    <div style={{ marginTop: 10 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, fontWeight: 700, color: 'rgba(255,255,255,0.55)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
        <Eye size={11} /> View as
      </label>
      <select value="" onChange={onChange} disabled={busy} aria-label="View as another user"
        style={{ width: '100%', background: 'rgba(255,255,255,0.1)', color: '#fff', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 8, padding: '7px 8px', fontSize: 12, fontFamily: 'inherit', cursor: busy ? 'wait' : 'pointer' }}>
        <option value="" style={{ color: '#111' }}>{user.viewAsBy ? `Viewing as ${user.name}` : 'Choose a user...'}</option>
        {user.viewAsBy && <option value="__exit__" style={{ color: '#111' }}>Back to my admin view</option>}
        <optgroup label="Customers" style={{ color: '#111' }}>
          {group('buyer').map(o => <option key={o.id} value={o.id} style={{ color: '#111' }}>{o.company}</option>)}
        </optgroup>
        <optgroup label="Manufacturers" style={{ color: '#111' }}>
          {group('manufacturer').map(o => <option key={o.id} value={o.id} style={{ color: '#111' }}>{o.company}</option>)}
        </optgroup>
      </select>
      {err && <div style={{ fontSize: 11, color: '#fca5a5', marginTop: 4 }}>{err}</div>}
    </div>
  )
}
