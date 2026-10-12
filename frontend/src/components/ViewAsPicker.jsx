import { useEffect, useState } from 'react'
import { Eye } from '../icons.jsx'
import { viewAsApi } from '../api.js'
import { useApp } from '../context.jsx'
import { switchTo } from '../viewAsSwitch.js'
import { COMPANIES_CHANGED } from '../lib/companiesEvents.js'

// Quick switcher at the top of the sidebar for a master admin: jump from one company to another
// without going back to the directory. Only renders when the server says this user may view as
// (user.canViewAs). In the standalone product a company that switched Tradio's view access off is
// listed but cannot be opened.

const label = o => `${o.company}${o.tradioEnabled ? ' (Tradio managed)' : ''}${o.tradioCanView === false ? ' (private)' : ''}`

/** Dropdown at the top left of the sidebar. */
export function ViewAsPicker() {
  const { currentUser: user } = useApp()
  const [options, setOptions] = useState([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    if (!user?.canViewAs) return undefined
    const load = () => viewAsApi.options().then(setOptions).catch(() => setOptions([]))
    load()
    // The master admin changes companies from User Setup; the list must follow.
    window.addEventListener(COMPANIES_CHANGED, load)
    return () => window.removeEventListener(COMPANIES_CHANGED, load)
  }, [user?.canViewAs, user?.id])

  if (!user?.canViewAs) return null
  const group = role => options.filter(o => o.role === role)
  const standalone = user.platformMode === 'standalone'
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
      <select value="" onChange={onChange} disabled={busy} aria-label="View as another company"
        style={{ width: '100%', background: 'rgba(255,255,255,0.1)', color: '#fff', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 8, padding: '7px 8px', fontSize: 12, fontFamily: 'inherit', cursor: busy ? 'wait' : 'pointer' }}>
        <option value="" style={{ color: '#111' }}>{user.viewAsBy ? `Viewing ${user.company}` : 'Choose a company...'}</option>
        {user.viewAsBy && <option value="__exit__" style={{ color: '#111' }}>{standalone ? 'Back to companies' : 'Back to my admin view'}</option>}
        <optgroup label="Brands" style={{ color: '#111' }}>
          {group('buyer').map(o => <option key={o.id} value={o.id} disabled={standalone && o.tradioCanView === false} style={{ color: '#111' }}>{label(o)}</option>)}
        </optgroup>
        <optgroup label="Manufacturers" style={{ color: '#111' }}>
          {group('manufacturer').map(o => <option key={o.id} value={o.id} disabled={standalone && o.tradioCanView === false} style={{ color: '#111' }}>{label(o)}</option>)}
        </optgroup>
      </select>
      {err && <div style={{ fontSize: 11, color: '#fca5a5', marginTop: 4 }}>{err}</div>}
    </div>
  )
}
